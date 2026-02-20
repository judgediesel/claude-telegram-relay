/**
 * Claude Code Telegram Relay
 *
 * Entry point that wires all modules together and starts the bot.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, InputFile } from "grammy";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";

// Config & shared state
import {
  BOT_TOKEN,
  ALLOWED_USER_ID,
  ALLOWED_GROUP_IDS,
  TEAM_MEMBER_IDS,
  TEMP_DIR,
  UPLOADS_DIR,
  LOCK_FILE,
  MEMORY_ENABLED,
  CHECKIN_ENABLED,
  CHECKIN_INTERVAL_MINUTES,
  CALENDAR_ENABLED,
  GMAIL_ENABLED,
  TWILIO_ENABLED,
  TWILIO_SMS_NUMBER,
  TWILIO_PHONE_NUMBER,
  VOICE_REPLIES_ENABLED,
  GEMINI_API_KEY,
  WEBHOOK_SECRET,
  WEBHOOK_PORT,
  DAILY_BRIEFING_HOUR,
  END_OF_DAY_HOUR,
  gmailClients,
} from "./config";

// Memory
import { storeMessage, initEmbeddings, autoExtractFacts, autoExtractTodos } from "./memory";

// Claude CLI
import { callClaudeWithSearch, buildPrompt, type GroupChatInfo } from "./claude";

// Intent processing
import { processIntents } from "./intents";

// Strip all action tags except SEARCH for team members
function processIntentsForRole(response: string, role: UserRole) {
  if (role === "admin") return processIntents(response);

  // Team members: strip all sensitive tags, only allow SEARCH to pass through
  let cleaned = response;
  // Remove all tags except SEARCH
  cleaned = cleaned.replace(/\[REMEMBER:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[GOAL:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[DONE:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[TODO:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[TODO_DONE:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[HABIT:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[HABIT_DONE:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[HABIT_REMOVE:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[CALENDAR:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[SMS:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[CALL:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[CONTACT:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[SCAN_EMAILS\]/gi, "");
  cleaned = cleaned.replace(/\[APPROVE_EVENTS:\s*.+?\]/gi, "");
  // Let SEARCH tags pass through to callClaudeWithSearch
  cleaned = cleaned.replace(/\[SEARCH:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, intents: [] as Promise<void>[], followUp: Promise.resolve(null as string | null) };
}

// Voice
import { transcribeAudio, textToVoice } from "./voice";

// Telegram helpers
import { sendResponse } from "./telegram";

// Scheduled check-ins
import {
  runCheckin,
  checkUpcomingReminders,
  checkPostMeetingDebrief,
  checkDailyBriefing,
  checkEndOfDayRecap,
  checkWeeklyHabitReport,
  checkScheduledEmailScan,
} from "./checkin";

// Ads monitoring
import { checkAdPerformance, ADS_ENABLED, META_ADS_ENABLED, GOOGLE_ADS_ENABLED } from "./ads";
import { startUptimeMonitor } from "./uptime";

// Webhook HTTP server
import { startWebhookServer } from "./webhook";

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Initialize vector search embeddings
await initEmbeddings();

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Authorization with group chat support
// ============================================================

type ChatType = "private" | "group" | "supergroup" | "channel";
type UserRole = "admin" | "team" | "unauthorized";

interface ChatContext {
  chatType: ChatType;
  chatId: string;
  userId: string;
  username: string;
  firstName: string;
  userRole: UserRole;
  isGroup: boolean;
  isBotMentioned: boolean;
  isReplyToBot: boolean;
  shouldRespond: boolean;
}

// Store per-request chat context
const chatContextMap = new WeakMap<object, ChatContext>();

function getChatContext(ctx: any): ChatContext | undefined {
  return chatContextMap.get(ctx);
}

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString() || "";
  const chatType = (ctx.chat?.type || "private") as ChatType;
  const chatId = ctx.chat?.id.toString() || "";
  const isGroup = chatType === "group" || chatType === "supergroup";

  // Determine user role
  let userRole: UserRole = "unauthorized";
  if (ALLOWED_USER_ID && userId === ALLOWED_USER_ID) {
    userRole = "admin";
  } else if (TEAM_MEMBER_IDS.includes(userId)) {
    userRole = "team";
  }

  // Private chat: only admin allowed
  if (!isGroup) {
    if (userRole !== "admin") {
      console.log(`Unauthorized DM: ${userId}`);
      await ctx.reply("This bot is private.");
      return;
    }
  } else {
    // Group chat: must be an allowed group
    if (ALLOWED_GROUP_IDS.length > 0 && !ALLOWED_GROUP_IDS.includes(chatId)) {
      console.log(`Unauthorized group: ${chatId}`);
      return; // Silently ignore messages from non-allowed groups
    }

    // In groups, only admin and team members can interact
    if (userRole === "unauthorized") {
      console.log(`Unauthorized group user: ${userId} in ${chatId}`);
      return;
    }
  }

  // Check if bot is being addressed in group chats
  const botUsername = ctx.me?.username || "";
  const messageText = ctx.message?.text || ctx.message?.caption || "";
  const isBotMentioned = isGroup && botUsername
    ? new RegExp(`@${botUsername}\\b`, "i").test(messageText)
    : false;
  const isReplyToBot = isGroup && ctx.message?.reply_to_message?.from?.id === ctx.me?.id;

  // In groups, only respond when mentioned or replied to
  const shouldRespond = !isGroup || isBotMentioned || isReplyToBot;

  const chatContext: ChatContext = {
    chatType,
    chatId,
    userId,
    username: ctx.from?.username || "",
    firstName: ctx.from?.first_name || "",
    userRole,
    isGroup,
    isBotMentioned,
    isReplyToBot,
    shouldRespond,
  };

  chatContextMap.set(ctx, chatContext);

  await next();
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Detect if user is requesting a voice reply
function wantsVoiceReply(text: string): boolean {
  return /\b(voice\s*(message|reply|response|memo|note)|send.*voice|reply.*voice|talk\s*to\s*me|say\s*(it|that|this|something)\s*(out\s*loud|in\s*voice|as\s*voice|sexy|back)|speak\s*to\s*me|read\s*(it|that|this)\s*(out\s*loud|to\s*me|aloud)|use\s*your\s*voice)\b/i.test(text);
}

// Detect if user is requesting code editing / file operations
function wantsToolUse(text: string): boolean {
  return /\b(edit|create|write|update|fix|refactor|add|remove|delete|change|modify|implement|build|debug|deploy)\b.*\b(file|code|function|component|module|script|config|class|test|bug|feature|endpoint|route|page|style|css|html|ts|js|tsx|jsx|py|src|repo|codebase)\b/i.test(text)
    || /\b(file|code|function|component|module|script)\b.*\b(edit|create|write|update|fix|refactor|add|remove|delete|change|modify)\b/i.test(text)
    || /\b(commit|push|pull request|PR|merge|branch|git)\b/i.test(text)
    || /\b(npm|bun|pip|yarn)\s+(install|run|test|build)\b/i.test(text);
}

// Text messages
bot.on("message:text", async (ctx) => {
  const chatCtx = getChatContext(ctx);
  if (!chatCtx) return;

  // In group chats, only respond when mentioned or replied to
  if (!chatCtx.shouldRespond) return;

  let text = ctx.message.text;
  // Strip @bot mention from text before processing
  if (chatCtx.isGroup && ctx.me?.username) {
    text = text.replace(new RegExp(`@${ctx.me.username}\\b`, "gi"), "").trim();
  }

  console.log(`Message [${chatCtx.isGroup ? "group" : "DM"}/${chatCtx.userRole}]: ${text.substring(0, 50)}...`);

  const voiceRequested = wantsVoiceReply(text);

  await ctx.replyWithChatAction("typing");

  const groupInfo: GroupChatInfo = {
    isGroup: chatCtx.isGroup,
    userRole: chatCtx.userRole,
    senderName: chatCtx.firstName,
    senderUsername: chatCtx.username,
  };

  storeMessage("user", text, chatCtx.isGroup ? { source: "group", sender: chatCtx.username || chatCtx.firstName, chat_id: chatCtx.chatId } : undefined);

  const enrichedPrompt = await buildPrompt(text, groupInfo);
  // Only enable tool use for admin
  const response = await callClaudeWithSearch(enrichedPrompt, { resume: !chatCtx.isGroup, enableToolUse: chatCtx.userRole === "admin" });

  const { cleaned, intents, followUp } = processIntentsForRole(response, chatCtx.userRole);
  storeMessage("assistant", cleaned, chatCtx.isGroup ? { source: "group", chat_id: chatCtx.chatId } : undefined);
  await Promise.all(intents);

  // Voice replies only in DMs for admin
  if (voiceRequested && VOICE_REPLIES_ENABLED && !chatCtx.isGroup) {
    const voicePath = await textToVoice(cleaned);
    if (voicePath) {
      await ctx.replyWithVoice(new InputFile(voicePath));
      await unlink(voicePath).catch(() => {});
    }
  }

  await sendResponse(ctx, cleaned);

  // Handle follow-up messages (only for admin)
  if (chatCtx.userRole === "admin") {
    const followUpResult = await followUp;
    if (followUpResult) {
      storeMessage("assistant", followUpResult);
      await sendResponse(ctx, followUpResult);
    }
  }

  // Auto-learn only from admin conversations
  if (chatCtx.userRole === "admin") {
    autoExtractFacts(text, cleaned).catch(() => {});
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const chatCtx = getChatContext(ctx);
  if (!chatCtx) return;

  // In groups, voice messages only processed if replying to bot
  if (chatCtx.isGroup && !chatCtx.isReplyToBot) return;
  // Voice only for admin
  if (chatCtx.userRole !== "admin") return;

  console.log("Voice message received");
  await ctx.replyWithChatAction("typing");

  if (!GEMINI_API_KEY) {
    await ctx.reply("Voice messages require GEMINI_API_KEY to be set in .env");
    return;
  }

  try {
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribeAudio(audioBuffer);
    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    const groupInfo: GroupChatInfo = {
      isGroup: chatCtx.isGroup,
      userRole: chatCtx.userRole,
      senderName: chatCtx.firstName,
      senderUsername: chatCtx.username,
    };

    storeMessage("user", `[Voice message]: ${transcription}`);
    const enrichedPrompt = await buildPrompt(`[Voice message]: ${transcription}`, groupInfo);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: !chatCtx.isGroup });

    const { cleaned: cleanedVoice, intents: voiceIntents, followUp: voiceFollowUp } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedVoice);
    await Promise.all(voiceIntents);

    // Voice replies only in DMs
    if (!chatCtx.isGroup) {
      const voicePath = await textToVoice(cleanedVoice);
      if (voicePath) {
        await ctx.replyWithVoice(new InputFile(voicePath));
        await unlink(voicePath).catch(() => {});
      }
    }

    await sendResponse(ctx, `> ${transcription}\n\n${cleanedVoice}`);

    const voiceFollowUpResult = await voiceFollowUp;
    if (voiceFollowUpResult) {
      storeMessage("assistant", voiceFollowUpResult);
      await sendResponse(ctx, voiceFollowUpResult);
    }

    autoExtractTodos(transcription).then((items) => {
      if (items.length > 0) {
        const itemList = items.map((i) => `• ${i}`).join("\n");
        sendResponse(ctx, `📋 Action items captured:\n${itemList}`);
      }
    }).catch(() => {});

    autoExtractFacts(transcription, cleanedVoice).catch(() => {});
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  }
});

// Audio file attachments
bot.on("message:audio", async (ctx) => {
  const chatCtx = getChatContext(ctx);
  if (!chatCtx) return;
  if (chatCtx.isGroup) return; // Audio files only in DMs
  if (chatCtx.userRole !== "admin") return;

  console.log(`Audio file received: ${ctx.message.audio.file_name || "unknown"}`);
  await ctx.replyWithChatAction("typing");

  if (!GEMINI_API_KEY) {
    await ctx.reply("Audio transcription requires GEMINI_API_KEY to be set in .env");
    return;
  }

  try {
    const file = await ctx.api.getFile(ctx.message.audio.file_id);
    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribeAudio(audioBuffer);
    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    const caption = ctx.message.caption || "[Audio file]";
    const audioUserMsg = `${caption}: ${transcription}`;
    storeMessage("user", audioUserMsg);
    const enrichedPrompt = await buildPrompt(audioUserMsg);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

    const { cleaned: cleanedAudio, intents: audioIntents, followUp: audioFollowUp } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedAudio);
    await Promise.all(audioIntents);

    await sendResponse(ctx, `> ${transcription}\n\n${cleanedAudio}`);

    const audioFollowUpResult = await audioFollowUp;
    if (audioFollowUpResult) {
      storeMessage("assistant", audioFollowUpResult);
      await sendResponse(ctx, audioFollowUpResult);
    }

    autoExtractFacts(transcription, cleanedAudio).catch(() => {});
  } catch (error) {
    console.error("Audio error:", error);
    await ctx.reply("Could not process audio file.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const chatCtx = getChatContext(ctx);
  if (!chatCtx) return;
  if (chatCtx.isGroup) return; // Photos only in DMs
  if (chatCtx.userRole !== "admin") return;

  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";
    const photoUserMsg = `[Image: ${filePath}]\n\n${caption}`;
    storeMessage("user", `[Photo] ${caption}`);

    const enrichedPrompt = await buildPrompt(photoUserMsg);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const { cleaned: cleanedPhoto, intents: photoIntents, followUp: photoFollowUp } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedPhoto);
    await Promise.all(photoIntents);

    await sendResponse(ctx, cleanedPhoto);

    const photoFollowUpResult = await photoFollowUp;
    if (photoFollowUpResult) {
      storeMessage("assistant", photoFollowUpResult);
      await sendResponse(ctx, photoFollowUpResult);
    }
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const chatCtx = getChatContext(ctx);
  if (!chatCtx) return;
  if (chatCtx.isGroup) return; // Documents only in DMs
  if (chatCtx.userRole !== "admin") return;

  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const docUserMsg = `[File: ${filePath}]\n\n${caption}`;
    storeMessage("user", `[Document: ${doc.file_name}] ${caption}`);

    const enrichedPrompt = await buildPrompt(docUserMsg);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const { cleaned: cleanedDoc, intents: docIntents, followUp: docFollowUp } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedDoc);
    await Promise.all(docIntents);

    await sendResponse(ctx, cleanedDoc);

    const docFollowUpResult = await docFollowUp;
    if (docFollowUpResult) {
      storeMessage("assistant", docFollowUpResult);
      await sendResponse(ctx, docFollowUpResult);
    }
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// START WEBHOOK SERVER
// ============================================================

startWebhookServer();

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Memory: ${MEMORY_ENABLED ? "enabled (Supabase)" : "disabled (set SUPABASE_URL + SUPABASE_ANON_KEY)"}`);
console.log(`Voice transcription: ${GEMINI_API_KEY ? "enabled" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Voice replies: ${VOICE_REPLIES_ENABLED ? "enabled" : "disabled (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)"}`);
console.log(`Webhook: ${WEBHOOK_SECRET ? `enabled on port ${WEBHOOK_PORT}` : "disabled (set WEBHOOK_SECRET)"}`);
console.log(`Calendar: ${CALENDAR_ENABLED ? "enabled (read/write)" : "disabled (no service account key)"}`);
console.log(`Web search: ${GEMINI_API_KEY ? "enabled (Gemini)" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Todos: ${MEMORY_ENABLED ? "enabled" : "disabled (requires memory)"}`);
console.log(`Habits: ${MEMORY_ENABLED ? "enabled" : "disabled (requires memory)"}`);
console.log(`Gmail: ${GMAIL_ENABLED ? `enabled (${gmailClients.map(c => c.label).join(", ")})` : "disabled (set GMAIL_USER)"}`);
console.log(`Twilio SMS: ${TWILIO_ENABLED ? `enabled (${TWILIO_SMS_NUMBER || TWILIO_PHONE_NUMBER})` : "disabled (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER + TWILIO_USER_PHONE)"}`);
console.log(`Twilio Voice: ${TWILIO_ENABLED ? `enabled (${TWILIO_PHONE_NUMBER})` : "disabled"}`);
console.log(`Daily briefing: ${CHECKIN_ENABLED ? `enabled (${DAILY_BRIEFING_HOUR}:00)` : "disabled (requires memory)"}`);
console.log(`End-of-day recap: ${CHECKIN_ENABLED ? `enabled (${END_OF_DAY_HOUR}:00)` : "disabled (requires memory)"}`);
console.log(`Post-meeting debrief: ${CALENDAR_ENABLED && CHECKIN_ENABLED ? "enabled" : "disabled (requires calendar + memory)"}`);
console.log(`Reminders: ${CALENDAR_ENABLED ? "enabled (2 min before events)" : "disabled (requires calendar)"}`);
console.log(`Check-ins: ${CHECKIN_ENABLED ? `enabled (every ${CHECKIN_INTERVAL_MINUTES} min / hourly)` : "disabled (requires memory)"}`);
console.log(`Weekly habit report: ${CHECKIN_ENABLED ? "enabled (Sundays 5 PM)" : "disabled (requires memory)"}`);
console.log(`Meta Ads: ${META_ADS_ENABLED ? "enabled" : "disabled (set META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS)"}`);
console.log(`Google Ads: ${GOOGLE_ADS_ENABLED ? "enabled" : "disabled (set GOOGLE_ADS_* env vars)"}`);
console.log(`Voice memos: ${GEMINI_API_KEY ? "enabled (auto-extract action items)" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Email-to-Calendar: ${GMAIL_ENABLED && CALENDAR_ENABLED ? "enabled (scan emails → create events)" : "disabled (requires Gmail + Calendar)"}`);
console.log(`Group chats: ${ALLOWED_GROUP_IDS.length > 0 ? `enabled (${ALLOWED_GROUP_IDS.length} group(s))` : "disabled (set ALLOWED_GROUP_IDS)"}`);
console.log(`Team members: ${TEAM_MEMBER_IDS.length > 0 ? `${TEAM_MEMBER_IDS.length} configured` : "none (set TEAM_MEMBER_IDS)"}`);
console.log("Uptime monitor: enabled (4 sites, every 30 min)");

bot.start({
  onStart: () => {
    console.log("Bot is running!");

    // Schedule check-ins: initial 5-minute delay, then recurring interval
    if (CHECKIN_ENABLED) {
      setTimeout(() => {
        runCheckin();
        setInterval(runCheckin, CHECKIN_INTERVAL_MINUTES * 60 * 1000);
      }, 5 * 60 * 1000);
    }

    // Proactive calendar reminders: check every minute (2-min-before alerts)
    if (CALENDAR_ENABLED) {
      setInterval(checkUpcomingReminders, 60 * 1000);
      if (CHECKIN_ENABLED) {
        setInterval(checkPostMeetingDebrief, 5 * 60 * 1000);
      }
    }

    // Daily briefing + end-of-day recap + weekly habit report: check every minute
    if (CHECKIN_ENABLED) {
      setInterval(checkDailyBriefing, 60 * 1000);
      setInterval(checkEndOfDayRecap, 60 * 1000);
      setInterval(checkWeeklyHabitReport, 60 * 1000);
    }

    // Email-to-calendar scan: check every minute (runs at 7am, 9am, 11am, 1pm, 3pm)
    if (GMAIL_ENABLED && CALENDAR_ENABLED) {
      setInterval(checkScheduledEmailScan, 60 * 1000);
    }

    // Ad performance monitoring: check every 30 minutes
    if (ADS_ENABLED) {
      // Initial check after 2 minutes (let everything else start first)
      setTimeout(() => {
        checkAdPerformance();
        setInterval(checkAdPerformance, 30 * 60 * 1000);
      }, 2 * 60 * 1000);
    }

    // Uptime monitor: check 4 sites every 30 minutes, alert only on issues
    startUptimeMonitor();
  },
});
