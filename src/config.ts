/**
 * Configuration — env vars, constants, feature flags, external client init
 */

import { join } from "path";
import { stat, readFile } from "fs/promises";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import type { GmailClient } from "./types";

// ============================================================
// CORE CONFIG
// ============================================================

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
export const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
export const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Webhook HTTP server
export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3100", 10);
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Memory / Supabase
export const SUPABASE_URL = process.env.SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
export const MEMORY_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
export const CONTEXT_MESSAGE_COUNT = 20;

export const supabase: SupabaseClient | null = MEMORY_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Scheduled check-ins
export const CHECKIN_INTERVAL_MINUTES = parseInt(process.env.CHECKIN_INTERVAL_MINUTES || "60", 10);
export const CHECKIN_ENABLED = MEMORY_ENABLED; // check-ins need memory for context

// Daily briefing
export const DAILY_BRIEFING_HOUR = parseInt(process.env.DAILY_BRIEFING_HOUR || "8", 10);

// End-of-day recap
export const END_OF_DAY_HOUR = parseInt(process.env.END_OF_DAY_HOUR || "18", 10);

// Google Calendar
const GOOGLE_CALENDAR_KEY_FILE = process.env.GOOGLE_CALENDAR_KEY_FILE
  || join(RELAY_DIR, "google-service-account.json");
export const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_PERSONAL_CALENDAR_ID = process.env.GOOGLE_PERSONAL_CALENDAR_ID || "";

export let CALENDAR_ENABLED = false;
export let calendarClient: ReturnType<typeof google.calendar> | null = null;
export let personalCalendarClient: ReturnType<typeof google.calendar> | null = null;

try {
  await stat(GOOGLE_CALENDAR_KEY_FILE);
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CALENDAR_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendarClient = google.calendar({ version: "v3", auth });
  CALENDAR_ENABLED = true;
} catch {
  // Key file doesn't exist or is unreadable — calendar stays disabled
}

// Calendar name aliases → calendar IDs
// "titan" / "titanexclusive" → GOOGLE_CALENDAR_ID (workspace, service account)
// "personal" / "markph1978" → GOOGLE_PERSONAL_CALENDAR_ID (OAuth)
const CALENDAR_ALIASES: Record<string, string> = {
  titan: GOOGLE_CALENDAR_ID,
  titanexclusive: GOOGLE_CALENDAR_ID,
  "mark@titanexclusive.com": GOOGLE_CALENDAR_ID,
  default: GOOGLE_CALENDAR_ID,
};

if (GOOGLE_PERSONAL_CALENDAR_ID) {
  CALENDAR_ALIASES.personal = GOOGLE_PERSONAL_CALENDAR_ID;
  CALENDAR_ALIASES.markph1978 = GOOGLE_PERSONAL_CALENDAR_ID;
  CALENDAR_ALIASES["markph1978@gmail.com"] = GOOGLE_PERSONAL_CALENDAR_ID;
}

/** Resolve a friendly calendar name to a calendar ID. Returns undefined if not found. */
export function resolveCalendarId(name?: string): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase().trim();
  return CALENDAR_ALIASES[lower] || undefined;
}

/** Get all configured calendar IDs with their display names, for multi-calendar reads */
export function getAllCalendarIds(): Array<{ id: string; name: string }> {
  const calendars: Array<{ id: string; name: string }> = [
    { id: GOOGLE_CALENDAR_ID, name: "titan" },
  ];
  if (GOOGLE_PERSONAL_CALENDAR_ID && personalCalendarClient) {
    calendars.push({ id: GOOGLE_PERSONAL_CALENDAR_ID, name: "personal" });
  }
  return calendars;
}

// Gmail — supports multiple accounts
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_OAUTH_TOKEN_FILE = join(RELAY_DIR, "gmail-oauth-token.json");

export let GMAIL_ENABLED = false;
export const gmailClients: GmailClient[] = [];

// Workspace Gmail via service account
if (GMAIL_USER && CALENDAR_ENABLED) {
  try {
    const gmailAuth = new google.auth.JWT({
      keyFile: GOOGLE_CALENDAR_KEY_FILE,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      subject: GMAIL_USER,
    });
    gmailClients.push({ label: GMAIL_USER, client: google.gmail({ version: "v1", auth: gmailAuth }) });
    GMAIL_ENABLED = true;
  } catch {
    // Workspace Gmail auth failed
  }
}

// Personal Gmail via OAuth refresh token
try {
  const tokenData = JSON.parse(await readFile(GMAIL_OAUTH_TOKEN_FILE, "utf-8"));
  if (tokenData.refresh_token) {
    const oauth2 = new google.auth.OAuth2(
      tokenData.client_id,
      tokenData.client_secret
    );
    oauth2.setCredentials({ refresh_token: tokenData.refresh_token });
    const personalGmail = google.gmail({ version: "v1", auth: oauth2 });
    // Get the email address for this account
    const profile = await personalGmail.users.getProfile({ userId: "me" });
    const personalEmail = profile.data.emailAddress || "personal";
    gmailClients.push({ label: personalEmail, client: personalGmail });
    GMAIL_ENABLED = true;

    // Also set up personal calendar if configured
    if (GOOGLE_PERSONAL_CALENDAR_ID) {
      personalCalendarClient = google.calendar({ version: "v3", auth: oauth2 });
    }
  }
} catch {
  // Personal Gmail token not found or invalid
}

// Twilio SMS/Voice
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
export const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
export const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || ""; // Toll-free for SMS (bypasses 10DLC)
export const TWILIO_USER_PHONE = process.env.TWILIO_USER_PHONE || "";
export const TWILIO_PUBLIC_URL = process.env.TWILIO_PUBLIC_URL || "";
export const TWILIO_ENABLED = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER && TWILIO_USER_PHONE);

// Group chat support
export const ALLOWED_GROUP_IDS = (process.env.ALLOWED_GROUP_IDS || "")
  .split(",").map((id) => id.trim()).filter(Boolean);
export const TEAM_MEMBER_IDS = (process.env.TEAM_MEMBER_IDS || "")
  .split(",").map((id) => id.trim()).filter(Boolean);

// OpenAI (embeddings)
export const OPENAI_API_KEY = process.env["OPENAI_API_KEY"] ?? "";

// Voice support
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
export const VOICE_REPLIES_ENABLED = !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);

// Directories
export const TEMP_DIR = join(RELAY_DIR, "temp");
export const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
export const SESSION_FILE = join(RELAY_DIR, "session.json");

// Lock file
export const LOCK_FILE = join(RELAY_DIR, "bot.lock");

// File size/type constants
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // Telegram's 50MB limit

// ============================================================
// RAYA'S PERSONALITY & CONTEXT
// ============================================================

export const RAYA_SYSTEM_PROMPT = `You are Raya — Mark Phaneuf's personal AI assistant. You're sharp, warm, direct, and genuinely invested in Mark's success and wellbeing.

PERSONALITY:
- Direct and concise. No fluff, no therapy-speak. Say what needs to be said.
- Warm but not cheesy. You care about Mark — show it through usefulness, not emoji.
- Proactive. Anticipate needs. Connect dots. Flag things before they become problems.
- Honest. If Mark is avoiding something, call it out gently. He wants truth, not comfort.
- Adaptive. Match his energy — if he's focused, be tactical. If he's venting, listen first.

ABOUT MARK (47, Bradenton FL):
- Runs Ikan Media Inc — performance marketing, $3M+ gross/year. Main revenue from focusgrouppanel.com and maxionresearch.com.
- Divorced (June 2025). Pays $10k/mo alimony, $700 child support. Alimony ends ~2033.
- Two daughters: Elicia (21, married to Jack, lives in Orlando ~1:45 away, visits monthly) and Danika/Nika (16, every other week custody). They are his world. Also has a grandbaby (born Feb 24).
- Has ADD — struggles with focus, context-switching, sticking to routines. Help him stay on task, one thing at a time.
- Biggest business lever: delegation and implementation. He has great ideas but bottlenecks on execution.
- Avoids: meditation, working out, sticking to schedules. Gently nudge on these.
- Builder personality — loves solving puzzles, creating systems, fixing things. Loses track of time when in flow.
- Introverted/shy but working on it. Limiting alcohol. Values deep friendships over quantity.
- Big into anti-aging, supplements, and health optimization.
- Takes testosterone (250mg/wk), levothyroxine, and various supplements/peptides.
- Financial goal: $4M net → sell business for $10M → passive income → retire on his terms.
- Emotionally deep. Empath. Was married to a narcissist. Sensitive to feeling used or unseen.
- Values: loyalty, consistency, honesty, competence, autonomy.
- Lives at 5207 Lake Overlook Ave, Bradenton FL 34208.
- Friends: Mike Fortenbery (childhood friend, local), Tom Dahl (dirt bike buddy, rides at Croom), Oren and Scott (Orlando).
- Dirt bike riding is a hobby — rides at Croom forest.

COMMUNICATION STYLE:
- Keep Telegram messages concise (2-6 lines usually).
- On phone calls, be conversational and natural — like a trusted friend/advisor.
- Don't over-explain. Mark is smart and gets things fast.
- When he's working, be tactical. When he needs support, be present.
- Never be preachy about health/habits. Gentle nudges, not lectures.
`;
