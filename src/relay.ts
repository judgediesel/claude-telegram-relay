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
import { callClaudeWithSearch, buildPrompt } from "./claude";

// Intent processing
import { processIntents } from "./intents";

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
} from "./checkin";

// Ads monitoring
import { checkAdPerformance, ADS_ENABLED, META_ADS_ENABLED, GOOGLE_ADS_ENABLED } from "./ads";

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
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

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
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  const voiceRequested = wantsVoiceReply(text);

  await ctx.replyWithChatAction("typing");
  storeMessage("user", text);

  const enableToolUse = wantsToolUse(text);
  if (enableToolUse) console.log("Tool use enabled for this message");

  const enrichedPrompt = await buildPrompt(text);
  const response = await callClaudeWithSearch(enrichedPrompt, { resume: true, enableToolUse });

  const { cleaned, intents, followUp } = processIntents(response);
  storeMessage("assistant", cleaned);
  await Promise.all(intents);

  // Send voice reply if requested and voice is enabled
  if (voiceRequested && VOICE_REPLIES_ENABLED) {
    const voicePath = await textToVoice(cleaned);
    if (voicePath) {
      await ctx.replyWithVoice(new InputFile(voicePath));
      await unlink(voicePath).catch(() => {});
    }
  }

  await sendResponse(ctx, cleaned);

  // Handle follow-up messages (e.g., email scan results)
  const followUpResult = await followUp;
  if (followUpResult) {
    storeMessage("assistant", followUpResult);
    await sendResponse(ctx, followUpResult);
  }

  // Auto-learn facts from this conversation (async, non-blocking)
  autoExtractFacts(text, cleaned).catch(() => {});
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  await ctx.replyWithChatAction("typing");

  if (!GEMINI_API_KEY) {
    await ctx.reply("Voice messages require GEMINI_API_KEY to be set in .env");
    return;
  }

  try {
    // Download voice file from Telegram
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    // Transcribe with Gemini
    const transcription = await transcribeAudio(audioBuffer);
    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    // Send to Claude
    storeMessage("user", `[Voice message]: ${transcription}`);
    const enrichedPrompt = await buildPrompt(`[Voice message]: ${transcription}`);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

    const { cleaned: cleanedVoice, intents: voiceIntents, followUp: voiceFollowUp } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedVoice);
    await Promise.all(voiceIntents);

    // Try voice reply if enabled
    const voicePath = await textToVoice(cleanedVoice);
    if (voicePath) {
      await ctx.replyWithVoice(new InputFile(voicePath));
      await unlink(voicePath).catch(() => {});
    }

    // Always send text too (voice can be hard to hear, and shows the transcription)
    await sendResponse(ctx, `> ${transcription}\n\n${cleanedVoice}`);

    // Handle follow-up messages (e.g., email scan results)
    const voiceFollowUpResult = await voiceFollowUp;
    if (voiceFollowUpResult) {
      storeMessage("assistant", voiceFollowUpResult);
      await sendResponse(ctx, voiceFollowUpResult);
    }

    // Auto-extract action items from voice memos (async, non-blocking)
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
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const photoUserMsg = `[Image: ${filePath}]\n\n${caption}`;
    storeMessage("user", `[Photo] ${caption}`);

    const enrichedPrompt = await buildPrompt(photoUserMsg);
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

    // Cleanup after processing
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
console.log(`Reminders: ${CALENDAR_ENABLED ? "enabled (15 min before events)" : "disabled (requires calendar)"}`);
console.log(`Check-ins: ${CHECKIN_ENABLED ? `enabled (every ${CHECKIN_INTERVAL_MINUTES} min)` : "disabled (requires memory)"}`);
console.log(`Weekly habit report: ${CHECKIN_ENABLED ? "enabled (Sundays 5 PM)" : "disabled (requires memory)"}`);
console.log(`Meta Ads: ${META_ADS_ENABLED ? "enabled" : "disabled (set META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS)"}`);
console.log(`Google Ads: ${GOOGLE_ADS_ENABLED ? "enabled" : "disabled (set GOOGLE_ADS_* env vars)"}`);
console.log(`Voice memos: ${GEMINI_API_KEY ? "enabled (auto-extract action items)" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Email-to-Calendar: ${GMAIL_ENABLED && CALENDAR_ENABLED ? "enabled (scan emails → create events)" : "disabled (requires Gmail + Calendar)"}`);

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

    // Proactive calendar reminders + post-meeting debrief: check every 5 minutes
    if (CALENDAR_ENABLED) {
      setInterval(checkUpcomingReminders, 5 * 60 * 1000);
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

    // Ad performance monitoring: check every 30 minutes
    if (ADS_ENABLED) {
      // Initial check after 2 minutes (let everything else start first)
      setTimeout(() => {
        checkAdPerformance();
        setInterval(checkAdPerformance, 30 * 60 * 1000);
      }, 2 * 60 * 1000);
    }
  },
});
