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
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

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

  // Add any context you want here
  const enrichedPrompt = buildPrompt(text);

  const response = await callClaude(enrichedPrompt, { resume: true });
  await sendResponse(ctx, response);
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
    const enrichedPrompt = buildPrompt(`[Voice message]: ${transcription}`);
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    // Try voice reply if enabled
    const voicePath = await textToVoice(claudeResponse);
    if (voicePath) {
      await ctx.replyWithVoice(new InputFile(voicePath));
      await unlink(voicePath).catch(() => {});
    }

    // Always send text too (voice can be hard to hear, and shows the transcription)
    await sendResponse(ctx, `> ${transcription}\n\n${claudeResponse}`);
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
    const enrichedPrompt = buildPrompt(
      `${caption}: ${transcription}`
    );
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    await sendResponse(ctx, `> ${transcription}\n\n${claudeResponse}`);
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
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
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
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
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
// HELPERS
// ============================================================

function buildPrompt(userMessage: string): string {
  // Add context to every prompt
  // Customize this for your use case

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

  return `
You are responding via Telegram. Keep responses concise.

Current time: ${timeStr}

User: ${userMessage}
`.trim();
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

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
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Voice transcription: ${GEMINI_API_KEY ? "enabled" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Voice replies: ${VOICE_REPLIES_ENABLED ? "enabled" : "disabled (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
