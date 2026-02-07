/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, stat } from "fs/promises";
import { join, extname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { google } from "googleapis";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Webhook HTTP server
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3100", 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Memory / Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const MEMORY_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const CONTEXT_MESSAGE_COUNT = 20;

const supabase: SupabaseClient | null = MEMORY_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Scheduled check-ins
const CHECKIN_INTERVAL_MINUTES = parseInt(process.env.CHECKIN_INTERVAL_MINUTES || "30", 10);
const CHECKIN_ENABLED = MEMORY_ENABLED; // check-ins need memory for context

// Google Calendar
const GOOGLE_CALENDAR_KEY_FILE = process.env.GOOGLE_CALENDAR_KEY_FILE
  || join(RELAY_DIR, "google-service-account.json");
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

let CALENDAR_ENABLED = false;
let calendarClient: ReturnType<typeof google.calendar> | null = null;

try {
  await stat(GOOGLE_CALENDAR_KEY_FILE);
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CALENDAR_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  calendarClient = google.calendar({ version: "v3", auth });
  CALENDAR_ENABLED = true;
} catch {
  // Key file doesn't exist or is unreadable — calendar stays disabled
}

// Voice support
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_REPLIES_ENABLED = !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// MEMORY (Supabase)
// ============================================================

async function storeMessage(
  role: "user" | "assistant",
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    const truncated = content.length > 10000 ? content.substring(0, 10000) : content;
    await supabase.from("messages").insert({
      role,
      content: truncated,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("storeMessage error:", error);
  }
}

async function storeFact(content: string): Promise<void> {
  if (!supabase) return;
  try {
    // Deduplicate exact matches
    const { data: existing } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "fact")
      .eq("content", content)
      .limit(1);

    if (existing && existing.length > 0) return;

    await supabase.from("memory").insert({ type: "fact", content });
    console.log(`Stored fact: ${content.substring(0, 60)}`);
  } catch (error) {
    console.error("storeFact error:", error);
  }
}

async function storeGoal(content: string, deadline?: string): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, unknown> = { type: "goal", content };
    if (deadline) row.deadline = deadline;
    await supabase.from("memory").insert(row);
    console.log(`Stored goal: ${content.substring(0, 60)}`);
  } catch (error) {
    console.error("storeGoal error:", error);
  }
}

async function completeGoal(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: goals } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!goals || goals.length === 0) {
      console.log(`No goal found matching: ${searchText}`);
      return;
    }

    await supabase
      .from("memory")
      .update({
        type: "completed_goal",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", goals[0].id);

    console.log(`Completed goal: ${goals[0].content.substring(0, 60)}`);
  } catch (error) {
    console.error("completeGoal error:", error);
  }
}

async function getMemoryContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsRes, goalsRes, messagesRes] = await Promise.all([
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("created_at", { ascending: false }),
      supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("messages")
        .select("role, content, created_at")
        .order("created_at", { ascending: false })
        .limit(CONTEXT_MESSAGE_COUNT),
    ]);

    let context = "";

    const facts = factsRes.data || [];
    if (facts.length > 0) {
      context += "\nPERSISTENT MEMORY (facts you know about the user):\n";
      context += facts.map((f) => `- ${f.content}`).join("\n");
    }

    const goals = goalsRes.data || [];
    if (goals.length > 0) {
      context += "\n\nACTIVE GOALS:\n";
      context += goals
        .map((g) => {
          const dl = g.deadline ? ` (by ${g.deadline})` : "";
          return `- ${g.content}${dl}`;
        })
        .join("\n");
    }

    const messages = messagesRes.data || [];
    if (messages.length > 0) {
      context += "\n\nRECENT CONVERSATION HISTORY (newest first):\n";
      context += messages
        .map((m) => {
          const truncated =
            m.content.length > 300
              ? m.content.substring(0, 300) + "..."
              : m.content;
          return `[${m.role}]: ${truncated}`;
        })
        .join("\n");
    }

    return context;
  } catch (error) {
    console.error("getMemoryContext error:", error);
    return "";
  }
}

// ============================================================
// CHECK-IN HELPERS
// ============================================================

async function logCheckin(
  decision: string,
  reason: string,
  message?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("logs").insert({
      event: "checkin",
      level: "info",
      message: message || reason,
      metadata: { decision, reason },
    });
  } catch (error) {
    console.error("logCheckin error:", error);
  }
}

async function getLastCheckinTime(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("logs")
      .select("created_at")
      .eq("event", "checkin")
      .contains("metadata", { decision: "YES" })
      .order("created_at", { ascending: false })
      .limit(1);

    return data?.[0]?.created_at ?? null;
  } catch (error) {
    console.error("getLastCheckinTime error:", error);
    return null;
  }
}

// ============================================================
// GOOGLE CALENDAR
// ============================================================

async function getCalendarContext(): Promise<string> {
  if (!CALENDAR_ENABLED || !calendarClient) return "";

  try {
    const now = new Date();

    // End of tomorrow morning (covers "rest of today" + "first thing tomorrow")
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);

    const res = await calendarClient.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 15,
    });

    const events = res.data.items;
    if (!events || events.length === 0) return "";

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayDate = now.toLocaleDateString("en-US", { timeZone: tz });

    const lines = events.map((ev) => {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime)
        : ev.start?.date
          ? new Date(ev.start.date + "T00:00:00")
          : null;

      const end = ev.end?.dateTime
        ? new Date(ev.end.dateTime)
        : null;

      if (!start) return `- ${ev.summary || "(no title)"}`;

      const isAllDay = !ev.start?.dateTime;
      const eventDate = start.toLocaleDateString("en-US", { timeZone: tz });
      const isTomorrow = eventDate !== todayDate;
      const prefix = isTomorrow ? "Tomorrow " : "";

      if (isAllDay) {
        return `- ${prefix}All day: ${ev.summary || "(no title)"}`;
      }

      const timeStr = start.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      });

      let duration = "";
      if (end) {
        const mins = Math.round((end.getTime() - start.getTime()) / 60000);
        duration = mins >= 60
          ? ` (${Math.floor(mins / 60)} hr${mins >= 120 ? "s" : ""}${mins % 60 ? ` ${mins % 60} min` : ""})`
          : ` (${mins} min)`;
      }

      const location = ev.location ? `, ${ev.location}` : "";

      return `- ${prefix}${timeStr}: ${ev.summary || "(no title)"}${duration}${location}`;
    });

    return `\nUPCOMING CALENDAR:\n${lines.join("\n")}`;
  } catch (error) {
    console.error("getCalendarContext error:", error);
    return "";
  }
}

// ============================================================
// INTENT DETECTION
// ============================================================

function processIntents(response: string): { cleaned: string; intents: Promise<void>[] } {
  let cleaned = response;
  const intents: Promise<void>[] = [];

  // [REMEMBER: fact text]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    intents.push(storeFact(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [GOAL: goal text | DEADLINE: optional]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    intents.push(storeGoal(match[1].trim(), match[2]?.trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [DONE: search text]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    intents.push(completeGoal(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // Clean up extra whitespace left by removed tags
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleaned, intents };
}

// ============================================================
// SCHEDULED CHECK-INS
// ============================================================

async function runCheckin(): Promise<void> {
  if (!CHECKIN_ENABLED) return;

  try {
    const [memoryContext, calendarContext] = await Promise.all([
      getMemoryContext(),
      getCalendarContext(),
    ]);
    const lastCheckin = await getLastCheckinTime();

    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const lastCheckinStr = lastCheckin
      ? new Date(lastCheckin).toLocaleString("en-US", {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Never";

    const prompt = `
You are Raya, a proactive AI assistant. You are considering whether to send a check-in message to the user via Telegram.

CURRENT TIME: ${timeStr}
LAST CHECK-IN: ${lastCheckinStr}
${memoryContext}
${calendarContext}

RULES:
1. Max 2-3 check-ins per day. If you've already checked in recently, say NO.
2. Only check in if there's a genuine REASON — a goal deadline approaching, it's been a long time since last contact, a meaningful follow-up, an upcoming calendar event worth a heads-up, or a natural time-of-day touchpoint (good morning, end of day).
3. Consider time of day. Late night or very early morning — probably NO.
4. Be brief, warm, and helpful. Not robotic. Not annoying.
5. If you have nothing meaningful to say, say NO.
6. Never mention that you're an AI deciding whether to check in. Just be natural.
7. If there are upcoming calendar events, you can mention them naturally (e.g. "heads up, you have a meeting in 30 min").

RESPOND IN THIS EXACT FORMAT (no extra text):
DECISION: YES or NO
REASON: [Why you decided this — one sentence]
MESSAGE: [Your message to the user if YES, or "none" if NO]
`.trim();

    console.log("Running scheduled check-in evaluation...");
    const response = await callClaude(prompt);

    // Parse structured response
    const decisionMatch = response.match(/DECISION:\s*(YES|NO)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)(?=\nMESSAGE:)/is);
    const messageMatch = response.match(/MESSAGE:\s*(.+)/is);

    const decision = decisionMatch?.[1]?.toUpperCase() || "NO";
    const reason = reasonMatch?.[1]?.trim() || "Could not parse reason";
    const message = messageMatch?.[1]?.trim() || "";

    console.log(`Check-in decision: ${decision} — ${reason}`);

    if (decision === "YES" && message && message.toLowerCase() !== "none") {
      const { cleaned, intents } = processIntents(message);
      await Promise.all(intents);
      await storeMessage("assistant", cleaned, { source: "checkin" });
      await sendTelegramText(cleaned);
      await logCheckin("YES", reason, cleaned);
      console.log(`Check-in sent: ${cleaned.substring(0, 80)}...`);
    } else {
      await logCheckin("NO", reason);
    }
  } catch (error) {
    console.error("runCheckin error:", error);
    // Never crash the bot — just log and continue
  }
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

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
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");
  storeMessage("user", text);

  const enrichedPrompt = await buildPrompt(text);
  const response = await callClaude(enrichedPrompt, { resume: true });

  const { cleaned, intents } = processIntents(response);
  storeMessage("assistant", cleaned);
  await Promise.all(intents);

  await sendResponse(ctx, cleaned);
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
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    const { cleaned: cleanedVoice, intents: voiceIntents } = processIntents(claudeResponse);
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
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    const { cleaned: cleanedAudio, intents: audioIntents } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedAudio);
    await Promise.all(audioIntents);

    await sendResponse(ctx, `> ${transcription}\n\n${cleanedAudio}`);
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
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const { cleaned: cleanedPhoto, intents: photoIntents } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedPhoto);
    await Promise.all(photoIntents);

    await sendResponse(ctx, cleanedPhoto);
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
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const { cleaned: cleanedDoc, intents: docIntents } = processIntents(claudeResponse);
    storeMessage("assistant", cleanedDoc);
    await Promise.all(docIntents);

    await sendResponse(ctx, cleanedDoc);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// VOICE HELPERS
// ============================================================

async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const base64Audio = audioBuffer.toString("base64");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "audio/ogg",
                  data: base64Audio,
                },
              },
              {
                text: "Transcribe this audio exactly as spoken. Return only the transcription text, nothing else.",
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Gemini API error:", response.status, errorText);
    throw new Error(`Gemini transcription failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty transcription");
  }

  return text;
}

async function textToVoice(text: string): Promise<string | null> {
  if (!VOICE_REPLIES_ENABLED) return null;

  try {
    // Truncate for reasonable TTS length
    const ttsText = text.length > 2000 ? text.substring(0, 2000) + "..." : text;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: ttsText,
          model_id: "eleven_turbo_v2_5",
        }),
      }
    );

    if (!response.ok) {
      console.error("ElevenLabs API error:", response.status);
      return null;
    }

    const timestamp = Date.now();
    const mp3Path = join(TEMP_DIR, `voice_${timestamp}.mp3`);
    const oggPath = join(TEMP_DIR, `voice_${timestamp}.ogg`);

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(mp3Path, audioBuffer);

    // Convert MP3 to OGG Opus (required by Telegram for voice messages)
    const ffmpeg = spawn(
      ["ffmpeg", "-i", mp3Path, "-c:a", "libopus", "-b:a", "64k", "-y", oggPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    await ffmpeg.exited;

    // Cleanup MP3
    await unlink(mp3Path).catch(() => {});

    // Verify OGG was created
    try {
      await readFile(oggPath);
      return oggPath;
    } catch {
      console.error("ffmpeg conversion failed — is ffmpeg installed?");
      return null;
    }
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

// ============================================================
// FILE EXTRACTION & SENDING
// ============================================================

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // Telegram's 50MB limit

async function extractFiles(text: string): Promise<{ text: string; files: string[] }> {
  // Match absolute file paths — /path/to/file.ext
  const pathRegex = /(?:^|\s)(\/[\w./-]+\.\w+)/g;
  const files: string[] = [];
  let cleaned = text;

  for (const match of text.matchAll(pathRegex)) {
    const filePath = match[1];
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_SIZE) {
        console.log(`File too large for Telegram (${info.size} bytes): ${filePath}`);
        continue;
      }
      files.push(filePath);
      // Remove the file path from the text
      cleaned = cleaned.replace(filePath, "").replace(/\n{3,}/g, "\n\n");
    } catch {
      // Path doesn't exist on disk — leave text as-is
    }
  }

  return { text: cleaned.trim(), files };
}

async function sendFile(ctx: Context, filePath: string): Promise<void> {
  const ext = extname(filePath).toLowerCase();

  try {
    if (IMAGE_EXTS.has(ext)) {
      await ctx.replyWithPhoto(new InputFile(filePath));
    } else if (VIDEO_EXTS.has(ext)) {
      await ctx.replyWithVideo(new InputFile(filePath));
    } else {
      await ctx.replyWithDocument(new InputFile(filePath));
    }
  } catch (error) {
    console.error(`Failed to send file ${filePath}:`, error);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function buildPrompt(userMessage: string): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const [memoryContext, calendarContext] = await Promise.all([
    getMemoryContext(),
    getCalendarContext(),
  ]);

  const memoryInstructions = MEMORY_ENABLED
    ? `
MEMORY MANAGEMENT:
You have persistent memory. Use these tags when appropriate — they are processed automatically and stripped before the user sees your response.

- [REMEMBER: fact] — Store a genuinely useful long-term fact about the user (name, location, preferences, important context). Don't store trivia or things only relevant to the current message.
- [GOAL: goal text | DEADLINE: optional date] — When the user explicitly sets a goal or objective. Only for real goals, not passing comments.
- [DONE: search text] — When a previously tracked goal has been completed. Use a keyword that matches the stored goal.

Rules:
- Use tags sparingly. Most messages need zero tags.
- Never mention these tags to the user or explain the memory system.
- Place tags at the very end of your response, each on its own line.
`
    : "";

  return `
You are responding via Telegram. Keep responses concise.

Current time: ${timeStr}
${memoryContext}
${calendarContext}
${memoryInstructions}
User: ${userMessage}
`.trim();
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Extract and send any file attachments first
  const { text: cleanedText, files } = await extractFiles(response);

  for (const filePath of files) {
    await sendFile(ctx, filePath);
  }

  // Send text response (skip if empty after file extraction)
  if (!cleanedText) return;

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (cleanedText.length <= MAX_LENGTH) {
    await ctx.reply(cleanedText);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = cleanedText;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// TELEGRAM API HELPER (for sending without Grammy ctx)
// ============================================================

async function sendTelegram(
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

async function sendTelegramFile(filePath: string): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  let method: string;
  let field: string;

  if (IMAGE_EXTS.has(ext)) {
    method = "sendPhoto";
    field = "photo";
  } else if (VIDEO_EXTS.has(ext)) {
    method = "sendVideo";
    field = "video";
  } else {
    method = "sendDocument";
    field = "document";
  }

  const form = new FormData();
  form.append("chat_id", ALLOWED_USER_ID);

  const fileData = await readFile(filePath);
  const fileName = filePath.split("/").pop() || "file";
  form.append(field, new Blob([fileData]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram file upload error: ${JSON.stringify(data)}`);
}

async function sendTelegramText(text: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    await sendTelegram("sendMessage", { chat_id: ALLOWED_USER_ID, text });
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      await sendTelegram("sendMessage", { chat_id: ALLOWED_USER_ID, text: remaining });
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    await sendTelegram("sendMessage", {
      chat_id: ALLOWED_USER_ID,
      text: remaining.substring(0, splitIndex),
    });
    remaining = remaining.substring(splitIndex).trim();
  }
}

async function sendTelegramResponse(text: string): Promise<void> {
  const { text: cleaned, files } = await extractFiles(text);

  for (const filePath of files) {
    await sendTelegramFile(filePath);
  }

  if (cleaned) {
    await sendTelegramText(cleaned);
  }
}

// ============================================================
// WEBHOOK HTTP SERVER
// ============================================================

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

if (WEBHOOK_SECRET) {
  Bun.serve({
    port: WEBHOOK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // Health check — no auth required
      if (req.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      // All other routes require auth
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      if (req.method !== "POST") {
        return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
      }

      let json: unknown;
      try {
        json = await req.json();
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
      }

      try {
        // POST /send — forward a message (and optional files) to Telegram
        if (url.pathname === "/send") {
          const body = json as { text?: string; files?: string[] };

          if (!body.text && (!body.files || body.files.length === 0)) {
            return jsonResponse({ ok: false, error: "Provide text and/or files" }, 400);
          }

          if (body.files) {
            for (const filePath of body.files) {
              try {
                const info = await stat(filePath);
                if (!info.isFile()) continue;
                if (info.size > MAX_FILE_SIZE) {
                  console.log(`Webhook: file too large: ${filePath}`);
                  continue;
                }
                await sendTelegramFile(filePath);
              } catch (err) {
                console.error(`Webhook: could not send file ${filePath}:`, err);
              }
            }
          }

          if (body.text) {
            await sendTelegramText(body.text);
          }

          return jsonResponse({ ok: true });
        }

        // POST /ask — run prompt through Claude, send response to Telegram
        if (url.pathname === "/ask") {
          const body = json as { prompt?: string };

          if (!body.prompt) {
            return jsonResponse({ ok: false, error: "Provide a prompt" }, 400);
          }

          storeMessage("user", body.prompt, { source: "webhook" });
          const enrichedPrompt = await buildPrompt(body.prompt);
          const response = await callClaude(enrichedPrompt, { resume: true });

          const { cleaned: cleanedAsk, intents: askIntents } = processIntents(response);
          storeMessage("assistant", cleanedAsk, { source: "webhook" });
          await Promise.all(askIntents);

          await sendTelegramResponse(cleanedAsk);

          return jsonResponse({ ok: true });
        }

        return jsonResponse({ ok: false, error: "Not found" }, 404);
      } catch (err) {
        console.error("Webhook error:", err);
        return jsonResponse({ ok: false, error: "Internal server error" }, 500);
      }
    },
  });

  console.log(`Webhook server running on port ${WEBHOOK_PORT}`);
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Memory: ${MEMORY_ENABLED ? "enabled (Supabase)" : "disabled (set SUPABASE_URL + SUPABASE_ANON_KEY)"}`);
console.log(`Voice transcription: ${GEMINI_API_KEY ? "enabled" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Voice replies: ${VOICE_REPLIES_ENABLED ? "enabled" : "disabled (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)"}`);
console.log(`Webhook: ${WEBHOOK_SECRET ? `enabled on port ${WEBHOOK_PORT}` : "disabled (set WEBHOOK_SECRET)"}`);
console.log(`Calendar: ${CALENDAR_ENABLED ? "enabled (Google)" : "disabled (no service account key)"}`);
console.log(`Check-ins: ${CHECKIN_ENABLED ? `enabled (every ${CHECKIN_INTERVAL_MINUTES} min)` : "disabled (requires memory)"}`);

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
  },
});
