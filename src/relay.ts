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

// Daily briefing
const DAILY_BRIEFING_HOUR = parseInt(process.env.DAILY_BRIEFING_HOUR || "8", 10);

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
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendarClient = google.calendar({ version: "v3", auth });
  CALENDAR_ENABLED = true;
} catch {
  // Key file doesn't exist or is unreadable — calendar stays disabled
}

// Gmail — supports multiple accounts
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_OAUTH_TOKEN_FILE = join(RELAY_DIR, "gmail-oauth-token.json");

let GMAIL_ENABLED = false;
const gmailClients: Array<{ label: string; client: ReturnType<typeof google.gmail> }> = [];

// Workspace Gmail via service account
if (GMAIL_USER && CALENDAR_ENABLED) {
  try {
    const gmailAuth = new google.auth.JWT({
      keyFile: GOOGLE_CALENDAR_KEY_FILE,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
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
  }
} catch {
  // Personal Gmail token not found or invalid
}

// Twilio SMS/Voice
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const TWILIO_USER_PHONE = process.env.TWILIO_USER_PHONE || "";
const TWILIO_PUBLIC_URL = process.env.TWILIO_PUBLIC_URL || "";
const TWILIO_ENABLED = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER && TWILIO_USER_PHONE);

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
// TODOS (stored in memory table with type="todo")
// ============================================================

async function storeTodo(content: string, dueDate?: string): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, unknown> = { type: "todo", content };
    if (dueDate) row.deadline = dueDate;
    await supabase.from("memory").insert(row);
    console.log(`Stored todo: ${content.substring(0, 60)}`);
  } catch (error) {
    console.error("storeTodo error:", error);
  }
}

async function completeTodo(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: todos } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "todo")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!todos || todos.length === 0) {
      console.log(`No todo found matching: ${searchText}`);
      return;
    }

    await supabase
      .from("memory")
      .update({
        type: "completed_todo",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", todos[0].id);

    console.log(`Completed todo: ${todos[0].content.substring(0, 60)}`);
  } catch (error) {
    console.error("completeTodo error:", error);
  }
}

async function getTodoContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const { data: todos } = await supabase
      .from("memory")
      .select("content, deadline")
      .eq("type", "todo")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });

    if (!todos || todos.length === 0) return "";

    let context = "\nACTIVE TODOS:\n";
    context += todos
      .map((t) => {
        const due = t.deadline ? ` (due ${t.deadline})` : "";
        return `- ${t.content}${due}`;
      })
      .join("\n");

    return context;
  } catch (error) {
    console.error("getTodoContext error:", error);
    return "";
  }
}

// ============================================================
// HABITS (stored in memory table with type="habit")
// Uses: content=description, deadline=frequency, priority=streak, updated_at=last completion
// ============================================================

async function storeHabit(description: string, frequency = "daily"): Promise<void> {
  if (!supabase) return;
  try {
    // Deduplicate
    const { data: existing } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "habit")
      .ilike("content", `%${description}%`)
      .limit(1);

    if (existing && existing.length > 0) return;

    await supabase.from("memory").insert({
      type: "habit",
      content: description,
      deadline: frequency, // "daily" or "weekly"
      priority: 0, // streak count
    });
    console.log(`Stored habit: ${description} (${frequency})`);
  } catch (error) {
    console.error("storeHabit error:", error);
  }
}

async function completeHabit(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content, priority, updated_at")
      .eq("type", "habit")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!habits || habits.length === 0) {
      console.log(`No habit found matching: ${searchText}`);
      return;
    }

    const habit = habits[0];
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });

    // Check if already done today
    if (habit.updated_at) {
      const lastDone = new Date(habit.updated_at).toLocaleDateString("en-US", { timeZone: tz });
      if (lastDone === todayStr) {
        console.log(`Habit already done today: ${habit.content}`);
        return;
      }
    }

    // Calculate streak: was it done yesterday?
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString("en-US", { timeZone: tz });
    const lastDoneStr = habit.updated_at
      ? new Date(habit.updated_at).toLocaleDateString("en-US", { timeZone: tz })
      : "";

    const newStreak = lastDoneStr === yesterdayStr ? (habit.priority || 0) + 1 : 1;

    await supabase
      .from("memory")
      .update({
        priority: newStreak,
        updated_at: now.toISOString(),
      })
      .eq("id", habit.id);

    console.log(`Habit done: ${habit.content} (streak: ${newStreak})`);
  } catch (error) {
    console.error("completeHabit error:", error);
  }
}

async function removeHabit(searchText: string): Promise<void> {
  if (!supabase) return;
  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("id, content")
      .eq("type", "habit")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (!habits || habits.length === 0) return;

    await supabase.from("memory").delete().eq("id", habits[0].id);
    console.log(`Removed habit: ${habits[0].content}`);
  } catch (error) {
    console.error("removeHabit error:", error);
  }
}

async function getHabitContext(): Promise<string> {
  if (!supabase) return "";

  try {
    const { data: habits } = await supabase
      .from("memory")
      .select("content, deadline, priority, updated_at")
      .eq("type", "habit")
      .order("created_at", { ascending: true });

    if (!habits || habits.length === 0) return "";

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = new Date().toLocaleDateString("en-US", { timeZone: tz });

    let context = "\nHABITS:\n";
    context += habits
      .map((h) => {
        const streak = h.priority || 0;
        const lastDone = h.updated_at
          ? new Date(h.updated_at).toLocaleDateString("en-US", { timeZone: tz })
          : "";
        const doneToday = lastDone === todayStr;
        const status = doneToday ? "DONE" : "NOT YET";
        const streakStr = streak > 0 ? ` (${streak}-day streak)` : "";
        return `- [${status}] ${h.content} — ${h.deadline}${streakStr}`;
      })
      .join("\n");

    return context;
  } catch (error) {
    console.error("getHabitContext error:", error);
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

async function createCalendarEvent(
  title: string,
  date: string,
  time: string,
  durationMinutes = 60
): Promise<void> {
  if (!calendarClient) {
    console.log("Calendar not connected — cannot create event");
    return;
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Build end time by adding duration to start
    const [hh, mm] = time.split(":").map(Number);
    const totalMin = hh * 60 + mm + durationMinutes;
    const endHH = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const endMM = String(totalMin % 60).padStart(2, "0");
    const endTime = `${endHH}:${endMM}`;

    await calendarClient.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: title,
        start: { dateTime: `${date}T${time}:00`, timeZone: tz },
        end: { dateTime: `${date}T${endTime}:00`, timeZone: tz },
      },
    });

    console.log(`Created calendar event: ${title} on ${date} at ${time}`);
  } catch (error) {
    console.error("createCalendarEvent error:", error);
  }
}

// ============================================================
// GMAIL
// ============================================================

async function getEmailContext(): Promise<string> {
  if (!GMAIL_ENABLED || gmailClients.length === 0) return "";

  const sections: string[] = [];

  for (const { label, client } of gmailClients) {
    try {
      const res = await client.users.messages.list({
        userId: "me",
        q: "is:unread -category:promotions -category:social -category:updates",
        maxResults: 5,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) continue;

      const details = await Promise.all(
        messages.slice(0, 5).map(async (msg) => {
          const detail = await client.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });

          const headers = detail.data.payload?.headers || [];
          const from = headers.find((h) => h.name === "From")?.value || "Unknown";
          const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
          const snippet = detail.data.snippet || "";

          const fromClean = from.replace(/<.*>/, "").trim().replace(/"/g, "") || from;

          return `- From: ${fromClean} — ${subject}\n  ${snippet.substring(0, 100)}${snippet.length > 100 ? "..." : ""}`;
        })
      );

      const totalUnread = res.data.resultSizeEstimate || messages.length;
      sections.push(`${label} (${totalUnread} unread):\n${details.join("\n")}`);
    } catch (error) {
      console.error(`getEmailContext error (${label}):`, error);
    }
  }

  if (sections.length === 0) return "";
  return `\nUNREAD EMAILS:\n${sections.join("\n\n")}`;
}

// ============================================================
// RAYA'S PERSONALITY & CONTEXT
// ============================================================

const RAYA_SYSTEM_PROMPT = `You are Raya — Mark Phaneuf's personal AI assistant. You're sharp, warm, direct, and genuinely invested in Mark's success and wellbeing.

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

// ============================================================
// WEATHER CONTEXT
// ============================================================

async function getWeatherContext(): Promise<string> {
  if (!GEMINI_API_KEY) return "";

  try {
    const result = await searchWeb("current weather in Bradenton FL today");
    if (!result) return "";

    // Extract just the key info
    const lines = result.split("\n").filter(l => l.trim()).slice(0, 3);
    return `\nWEATHER (Bradenton, FL):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ============================================================
// WEB SEARCH (via Gemini with Google Search grounding)
// ============================================================

async function searchWeb(query: string): Promise<string> {
  if (!GEMINI_API_KEY) return "";

  try {
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
                  text: `Search the web and provide a concise, factual summary for: ${query}`,
                },
              ],
            },
          ],
          tools: [{ google_search: {} }],
        }),
      }
    );

    if (!response.ok) {
      console.error("Gemini search error:", response.status);
      return "";
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  } catch (error) {
    console.error("searchWeb error:", error);
    return "";
  }
}

async function callClaudeWithSearch(
  prompt: string,
  options?: { resume?: boolean }
): Promise<string> {
  const response = await callClaude(prompt, options);

  const searchMatch = response.match(/\[SEARCH:\s*(.+?)\]/i);
  if (!searchMatch || !GEMINI_API_KEY) return response;

  const query = searchMatch[1].trim();
  console.log(`Search requested: ${query}`);
  const searchResults = await searchWeb(query);

  if (!searchResults) {
    return response.replace(/\[SEARCH:\s*.+?\]/gi, "").trim();
  }

  // Re-prompt with search results
  const searchPrompt = `${prompt}\n\nWEB SEARCH RESULTS for "${query}":\n${searchResults}\n\nIncorporate these results naturally into your response. Do NOT use [SEARCH:] tags again.`;
  return await callClaude(searchPrompt, options);
}

// ============================================================
// TWILIO SMS / VOICE
// ============================================================

async function sendSMS(body: string, to?: string): Promise<void> {
  if (!TWILIO_ENABLED) return;

  const recipient = to || TWILIO_USER_PHONE;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: recipient,
          Body: body,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Twilio SMS error:", err);
      return;
    }

    console.log(`SMS sent to ${recipient}: ${body.substring(0, 60)}`);
  } catch (error) {
    console.error("sendSMS error:", error);
  }
}

async function makeCall(message: string, to?: string): Promise<void> {
  if (!TWILIO_ENABLED) return;

  const recipient = to || TWILIO_USER_PHONE;
  let twiml: string;

  // Try ElevenLabs voice → temp-hosted audio → Twilio <Play>
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      const audioRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: message,
            model_id: "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (audioRes.ok) {
        const audioBuffer = await audioRes.arrayBuffer();
        const tempPath = join(TEMP_DIR, `call-${Date.now()}.mp3`);
        await writeFile(tempPath, Buffer.from(audioBuffer));

        // Upload to temp host for a public URL
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("time", "1h");
        formData.append("fileToUpload", new Blob([audioBuffer], { type: "audio/mpeg" }), "call.mp3");

        const uploadRes = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
          method: "POST",
          body: formData,
        });

        if (uploadRes.ok) {
          const audioUrl = (await uploadRes.text()).trim();
          twiml = `<Response><Play>${escapeXml(audioUrl)}</Play><Pause length="1"/><Play>${escapeXml(audioUrl)}</Play></Response>`;
          console.log(`Call using ElevenLabs voice: ${audioUrl}`);
        } else {
          console.error("Audio upload error:", uploadRes.status);
          twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
        }

        // Clean up local temp file
        unlink(tempPath).catch(() => {});
      } else {
        console.error("ElevenLabs TTS error:", audioRes.status);
        twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
      }
    } catch (error) {
      console.error("ElevenLabs call error:", error);
      twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
    }
  } else {
    twiml = `<Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Pause length="1"/><Say voice="Polly.Matthew">${escapeXml(message)}</Say></Response>`;
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: recipient,
          Twiml: twiml,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Twilio Call error:", err);
      return;
    }

    console.log(`Call initiated to ${recipient}: ${message.substring(0, 60)}`);
  } catch (error) {
    console.error("makeCall error:", error);
  }
}

async function startConversationCall(to?: string): Promise<void> {
  if (!TWILIO_ENABLED || !TWILIO_PUBLIC_URL) {
    console.error("Conversation call requires TWILIO_PUBLIC_URL");
    return;
  }

  const recipient = to || TWILIO_USER_PHONE;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_PHONE_NUMBER,
          To: recipient,
          Url: `${TWILIO_PUBLIC_URL}/twilio/voice`,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Conversation call error:", err);
      return;
    }

    console.log(`Conversation call initiated to ${recipient}`);
  } catch (error) {
    console.error("startConversationCall error:", error);
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

  // [TODO: task text | DUE: optional date]
  for (const match of response.matchAll(
    /\[TODO:\s*(.+?)(?:\s*\|\s*DUE:\s*(.+?))?\]/gi
  )) {
    intents.push(storeTodo(match[1].trim(), match[2]?.trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [TODO_DONE: search text]
  for (const match of response.matchAll(/\[TODO_DONE:\s*(.+?)\]/gi)) {
    intents.push(completeTodo(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [CALENDAR: title | DATE: YYYY-MM-DD | TIME: HH:MM | DURATION: minutes]
  for (const match of response.matchAll(
    /\[CALENDAR:\s*(.+?)\s*\|\s*DATE:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*TIME:\s*(\d{2}:\d{2})(?:\s*\|\s*DURATION:\s*(\d+))?\]/gi
  )) {
    intents.push(
      createCalendarEvent(
        match[1].trim(),
        match[2].trim(),
        match[3].trim(),
        match[4] ? parseInt(match[4]) : 60
      )
    );
    cleaned = cleaned.replace(match[0], "");
  }

  // [HABIT: description | FREQ: daily/weekly]
  for (const match of response.matchAll(
    /\[HABIT:\s*(.+?)(?:\s*\|\s*FREQ:\s*(.+?))?\]/gi
  )) {
    intents.push(storeHabit(match[1].trim(), match[2]?.trim() || "daily"));
    cleaned = cleaned.replace(match[0], "");
  }

  // [HABIT_DONE: search text]
  for (const match of response.matchAll(/\[HABIT_DONE:\s*(.+?)\]/gi)) {
    intents.push(completeHabit(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [HABIT_REMOVE: search text]
  for (const match of response.matchAll(/\[HABIT_REMOVE:\s*(.+?)\]/gi)) {
    intents.push(removeHabit(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [SMS: message text]
  for (const match of response.matchAll(/\[SMS:\s*(.+?)\]/gi)) {
    intents.push(sendSMS(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [CALL: message text]
  for (const match of response.matchAll(/\[CALL:\s*(.+?)\]/gi)) {
    intents.push(makeCall(match[1].trim()));
    cleaned = cleaned.replace(match[0], "");
  }

  // [SEARCH: query] — handled by callClaudeWithSearch, but clean tag if it leaks through
  cleaned = cleaned.replace(/\[SEARCH:\s*.+?\]/gi, "");

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
    const [memoryContext, calendarContext, todoContext, habitContext, emailContext] = await Promise.all([
      getMemoryContext(),
      getCalendarContext(),
      getTodoContext(),
      getHabitContext(),
      getEmailContext(),
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
${RAYA_SYSTEM_PROMPT}
You are considering whether to send a check-in message to Mark via Telegram.

CURRENT TIME: ${timeStr}
LAST CHECK-IN: ${lastCheckinStr}
${memoryContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}

RULES:
1. Max 2-3 check-ins per day. If you've already checked in recently, say NO.
2. Only check in if there's a genuine REASON — a goal deadline approaching, a todo with an upcoming due date, a habit not yet done today, an important unread email, it's been a long time since last contact, a meaningful follow-up, an upcoming calendar event worth a heads-up, or a natural time-of-day touchpoint.
3. Consider time of day. Late night or very early morning — probably NO.
4. Be brief, warm, and direct. Not robotic. Not annoying. Sound like a trusted friend.
5. If you have nothing meaningful to say, say NO.
6. Never mention that you're an AI deciding whether to check in. Just be natural.
7. If there are upcoming calendar events, mention them naturally.
8. If a habit hasn't been done today, gently nudge — don't lecture.
9. Remember Mark has ADD — help him stay focused. If he has todos piling up, help prioritize.
10. URGENCY: If something is truly time-critical (meeting in <10 min, critical deadline today), set ESCALATE to CALL. Otherwise ESCALATE should be NONE.

RESPOND IN THIS EXACT FORMAT (no extra text):
DECISION: YES or NO
REASON: [Why you decided this — one sentence]
ESCALATE: NONE or CALL
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
      const escalateMatch = response.match(/ESCALATE:\s*(NONE|CALL)/i);
      const escalate = escalateMatch?.[1]?.toUpperCase() || "NONE";

      const { cleaned, intents } = processIntents(message);
      await Promise.all(intents);
      await storeMessage("assistant", cleaned, { source: "checkin" });
      await sendTelegramText(cleaned);
      await logCheckin("YES", reason, cleaned);
      console.log(`Check-in sent: ${cleaned.substring(0, 80)}...`);

      // Escalate to phone call for urgent items
      if (escalate === "CALL" && TWILIO_ENABLED && TWILIO_PUBLIC_URL) {
        console.log("Escalating check-in to phone call...");
        await makeCall(cleaned);
      }
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
  const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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
    const claudeResponse = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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

  // Detect "catch me up" type requests
  const isCatchUp = /catch me up|what did i miss|fill me in|bring me up to speed|what's new|summary of|recap/i.test(userMessage);

  const contextFetches: Promise<string>[] = [
    getMemoryContext(),
    getCalendarContext(),
    getTodoContext(),
    getHabitContext(),
    getEmailContext(),
  ];

  // Only fetch weather for catch-up requests or if they ask about weather
  if (isCatchUp || /weather|rain|umbrella|temperature|forecast/i.test(userMessage)) {
    contextFetches.push(getWeatherContext());
  } else {
    contextFetches.push(Promise.resolve(""));
  }

  const [memoryContext, calendarContext, todoContext, habitContext, emailContext, weatherContext] = await Promise.all(contextFetches);

  const tagInstructions = MEMORY_ENABLED
    ? `
ACTION TAGS:
You have persistent memory and action capabilities. Use these tags when appropriate — they are processed automatically and stripped before the user sees your response.

Memory:
- [REMEMBER: fact] — Store a genuinely useful long-term fact about the user.
- [GOAL: goal text | DEADLINE: optional date] — When the user explicitly sets a goal.
- [DONE: search text] — When a previously tracked goal has been completed.

Todos:
- [TODO: task text | DUE: optional date] — Add a task to the user's todo list.
- [TODO_DONE: search text] — Mark a todo as completed.

Habits:
- [HABIT: description | FREQ: daily or weekly] — Create a recurring habit to track.
- [HABIT_DONE: search text] — Mark a habit as done for today. Maintains streak count.
- [HABIT_REMOVE: search text] — Remove a habit the user no longer wants to track.

Calendar:${CALENDAR_ENABLED ? `
- [CALENDAR: event title | DATE: YYYY-MM-DD | TIME: HH:MM | DURATION: minutes] — Create a calendar event. Duration defaults to 60 if omitted.` : " (disabled)"}

Web Search:${GEMINI_API_KEY ? `
- [SEARCH: query] — Search the web for current information. Use when asked about news, weather, prices, current events, or anything you don't know.` : " (disabled)"}

SMS/Phone:${TWILIO_ENABLED ? `
- [SMS: message text] — Send an SMS to the user's phone. Use for urgent reminders or when the user asks you to text them.
- [CALL: message text] — Call the user's phone and speak a message. Use only for critical/emergency alerts or when the user explicitly asks.` : " (disabled)"}

Rules:
- Use tags sparingly. Most messages need zero tags.
- Never mention these tags to the user or explain the system.
- Place tags at the very end of your response, each on its own line.
`
    : "";

  return `
${RAYA_SYSTEM_PROMPT}
Current time: ${timeStr}
${memoryContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}
${weatherContext}
${tagInstructions}
${isCatchUp ? "\nThe user wants a full catch-up summary. Cover: calendar, todos, habits (streaks), emails, and anything notable. Be thorough but organized.\n" : ""}
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

      // Twilio incoming SMS webhook — no bearer auth (Twilio POSTs form data)
      if (req.method === "POST" && url.pathname === "/twilio/sms" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const from = formData.get("From")?.toString() || "";
          const body = formData.get("Body")?.toString() || "";

          // Only accept messages from the authorized user's phone
          if (from !== TWILIO_USER_PHONE) {
            console.log(`Twilio SMS from unknown number: ${from}`);
            return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
          }

          console.log(`Incoming SMS from ${from}: ${body.substring(0, 60)}`);

          // Process through Claude (async — respond to Twilio immediately)
          (async () => {
            try {
              await storeMessage("user", body, { source: "sms" });
              const enrichedPrompt = await buildPrompt(body);
              const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });
              const { cleaned, intents } = processIntents(response);
              await Promise.all(intents);
              await storeMessage("assistant", cleaned, { source: "sms" });

              // Reply via SMS (truncate to 1600 chars — SMS limit)
              const smsReply = cleaned.length > 1500
                ? cleaned.substring(0, 1500) + "..."
                : cleaned;
              await sendSMS(smsReply);

              // Also forward to Telegram for visibility
              await sendTelegramText(`[via SMS] ${from}: ${body}\n\nRaya: ${cleaned}`);
            } catch (error) {
              console.error("Incoming SMS processing error:", error);
            }
          })();

          // Respond to Twilio immediately with empty TwiML (we send reply via API)
          return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio webhook error:", error);
          return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
        }
      }

      // Twilio voice conversation — answer and start listening
      if (req.method === "POST" && url.pathname === "/twilio/voice" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const from = formData.get("From")?.toString() || "";
          const to = formData.get("To")?.toString() || "";

          // Outbound calls: From=Twilio, To=user. Inbound: From=user, To=Twilio.
          const isAuthorizedCall = from === TWILIO_USER_PHONE || to === TWILIO_USER_PHONE;
          if (!isAuthorizedCall) {
            return new Response("<Response><Say>Sorry, this number is not authorized.</Say><Hangup/></Response>", {
              headers: { "Content-Type": "text/xml" },
            });
          }

          console.log(`Voice call started from ${from}`);

          // Generate greeting with ElevenLabs voice
          let greetingTwiml: string;
          if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && TWILIO_PUBLIC_URL) {
            try {
              const audioRes = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
                {
                  method: "POST",
                  headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    text: "Hey Mark, what's up?",
                    model_id: "eleven_monolingual_v1",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                  }),
                }
              );

              if (audioRes.ok) {
                const audioBuffer = await audioRes.arrayBuffer();
                const fileName = `greet-${Date.now()}.mp3`;
                await writeFile(join(TEMP_DIR, fileName), Buffer.from(audioBuffer));
                const audioUrl = `${TWILIO_PUBLIC_URL}/voice/${fileName}`;
                greetingTwiml = `<Response>
                  <Play>${escapeXml(audioUrl)}</Play>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">I didn't hear anything. Goodbye!</Say>
                </Response>`;
                setTimeout(() => unlink(join(TEMP_DIR, fileName)).catch(() => {}), 2 * 60 * 1000);
              } else {
                greetingTwiml = `<Response>
                  <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                </Response>`;
              }
            } catch {
              greetingTwiml = `<Response>
                <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
                <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              </Response>`;
            }
          } else {
            greetingTwiml = `<Response>
              <Say voice="Polly.Matthew">Hey Mark, what's up?</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              <Say voice="Polly.Matthew">I didn't hear anything. Goodbye!</Say>
            </Response>`;
          }
          const twiml = greetingTwiml;

          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio voice error:", error);
          return new Response("<Response><Say>Something went wrong.</Say></Response>", {
            headers: { "Content-Type": "text/xml" },
          });
        }
      }

      // Serve voice audio files (no auth — Twilio needs direct access)
      if (req.method === "GET" && url.pathname.startsWith("/voice/") && url.pathname.endsWith(".mp3")) {
        try {
          const fileName = url.pathname.split("/").pop()!;
          const filePath = join(TEMP_DIR, fileName);
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file, { headers: { "Content-Type": "audio/mpeg" } });
          }
        } catch {}
        return new Response("Not found", { status: 404 });
      }

      // Twilio gather — process speech, respond, loop
      if (req.method === "POST" && url.pathname === "/twilio/gather" && TWILIO_ENABLED) {
        try {
          const formData = await req.formData();
          const speechResult = formData.get("SpeechResult")?.toString() || "";

          if (!speechResult) {
            return new Response(`<Response>
              <Say voice="Polly.Matthew">I didn't catch that. Try again.</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              <Say voice="Polly.Matthew">Still nothing. Goodbye!</Say>
            </Response>`, { headers: { "Content-Type": "text/xml" } });
          }

          console.log(`Voice input: ${speechResult}`);

          // Store message (don't await — not needed for response)
          storeMessage("user", speechResult, { source: "phone" }).catch(() => {});

          // Process through Claude
          const enrichedPrompt = await buildPrompt(speechResult);
          const response = await callClaude(enrichedPrompt, { resume: true });
          const { cleaned, intents } = processIntents(response);

          // Fire-and-forget: intents, storage, telegram forwarding
          Promise.all(intents).catch(() => {});
          storeMessage("assistant", cleaned, { source: "phone" }).catch(() => {});
          sendTelegramText(`[Phone call]\nMark: ${speechResult}\nRaya: ${cleaned}`).catch(() => {});

          // Generate ElevenLabs audio and serve locally via ngrok (no catbox upload)
          let twiml: string;
          if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && TWILIO_PUBLIC_URL) {
            try {
              const audioRes = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
                {
                  method: "POST",
                  headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    text: cleaned,
                    model_id: "eleven_monolingual_v1",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                  }),
                }
              );

              if (audioRes.ok) {
                const audioBuffer = await audioRes.arrayBuffer();
                const fileName = `reply-${Date.now()}.mp3`;
                await writeFile(join(TEMP_DIR, fileName), Buffer.from(audioBuffer));
                const audioUrl = `${TWILIO_PUBLIC_URL}/voice/${fileName}`;

                twiml = `<Response>
                  <Play>${escapeXml(audioUrl)}</Play>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">Are you still there?</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                  <Say voice="Polly.Matthew">Okay, goodbye!</Say>
                </Response>`;

                // Clean up after 2 minutes
                setTimeout(() => unlink(join(TEMP_DIR, fileName)).catch(() => {}), 2 * 60 * 1000);
              } else {
                twiml = `<Response>
                  <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
                  <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
                </Response>`;
              }
            } catch {
              twiml = `<Response>
                <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
                <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
              </Response>`;
            }
          } else {
            twiml = `<Response>
              <Say voice="Polly.Matthew">${escapeXml(cleaned)}</Say>
              <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
            </Response>`;
          }

          console.log(`Voice reply: ${cleaned.substring(0, 60)}`);
          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        } catch (error) {
          console.error("Twilio gather error:", error);
          return new Response(`<Response>
            <Say voice="Polly.Matthew">Sorry, I had an error. Let me try again.</Say>
            <Gather input="speech" speechTimeout="auto" action="/twilio/gather" method="POST"/>
          </Response>`, { headers: { "Content-Type": "text/xml" } });
        }
      }

      // Auth: Bearer token in header OR ?token= query param (for browser dashboard)
      const authHeader = req.headers.get("authorization");
      const tokenParam = url.searchParams.get("token");
      const isAuthed =
        authHeader === `Bearer ${WEBHOOK_SECRET}` ||
        tokenParam === WEBHOOK_SECRET;

      if (!isAuthed) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }

      // ---- Dashboard routes (GET) ----
      if (req.method === "GET") {
        if (url.pathname === "/dashboard") {
          try {
            const html = await readFile(join(import.meta.dir, "dashboard.html"), "utf-8");
            return new Response(html.replace("__TOKEN__", WEBHOOK_SECRET), {
              headers: { "Content-Type": "text/html" },
            });
          } catch {
            return new Response("Dashboard file not found", { status: 404 });
          }
        }

        if (url.pathname === "/api/memory" && supabase) {
          const [facts, goals, completedGoals] = await Promise.all([
            supabase.from("memory").select("*").eq("type", "fact").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "goal").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "completed_goal").order("completed_at", { ascending: false }).limit(10),
          ]);
          return jsonResponse({ facts: facts.data, goals: goals.data, completedGoals: completedGoals.data });
        }

        if (url.pathname === "/api/todos" && supabase) {
          const [active, completed] = await Promise.all([
            supabase.from("memory").select("*").eq("type", "todo").order("created_at", { ascending: false }),
            supabase.from("memory").select("*").eq("type", "completed_todo").order("completed_at", { ascending: false }).limit(10),
          ]);
          return jsonResponse({ active: active.data, completed: completed.data });
        }

        if (url.pathname === "/api/habits" && supabase) {
          const { data } = await supabase.from("memory").select("*").eq("type", "habit").order("created_at", { ascending: true });
          return jsonResponse({ habits: data });
        }

        if (url.pathname === "/api/logs" && supabase) {
          const { data } = await supabase.from("logs").select("*").order("created_at", { ascending: false }).limit(50);
          return jsonResponse({ logs: data });
        }

        if (url.pathname === "/api/messages" && supabase) {
          const { data } = await supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(30);
          return jsonResponse({ messages: data });
        }

        if (url.pathname === "/api/stats" && supabase) {
          const [facts, goals, todos, habits, messages] = await Promise.all([
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "fact"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "goal"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "todo"),
            supabase.from("memory").select("id", { count: "exact" }).eq("type", "habit"),
            supabase.from("messages").select("id", { count: "exact" }),
          ]);
          return jsonResponse({
            facts: facts.count,
            goals: goals.count,
            todos: todos.count,
            habits: habits.count,
            messages: messages.count,
            calendar: CALENDAR_ENABLED,
            uptime: Math.round(process.uptime()),
          });
        }

        return jsonResponse({ ok: false, error: "Not found" }, 404);
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
          const response = await callClaudeWithSearch(enrichedPrompt, { resume: true });

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
// PROACTIVE CALENDAR REMINDERS
// ============================================================

const remindedEvents = new Set<string>();

async function checkUpcomingReminders(): Promise<void> {
  if (!CALENDAR_ENABLED || !calendarClient) return;

  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 15 * 60000); // 15 min from now

    const res = await calendarClient.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: soon.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items || [];
    for (const ev of events) {
      const eventId = ev.id!;
      if (remindedEvents.has(eventId)) continue;

      const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
      if (!start) continue;

      const minsUntil = Math.round((start.getTime() - now.getTime()) / 60000);
      if (minsUntil <= 15 && minsUntil > 0) {
        remindedEvents.add(eventId);
        const location = ev.location ? ` at ${ev.location}` : "";
        await sendTelegramText(
          `Heads up — "${ev.summary}" starts in ${minsUntil} minute${minsUntil === 1 ? "" : "s"}${location}`
        );
        console.log(`Reminder sent: ${ev.summary} in ${minsUntil} min`);
      }
    }
  } catch (error) {
    console.error("checkUpcomingReminders error:", error);
  }
}

// ============================================================
// POST-MEETING DEBRIEF
// ============================================================

const debriefedEvents = new Set<string>();

async function checkPostMeetingDebrief(): Promise<void> {
  if (!CALENDAR_ENABLED || !calendarClient || !CHECKIN_ENABLED) return;

  try {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60000);

    // Find events that ended in the last 10 minutes
    const res = await calendarClient.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: tenMinAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items || [];
    for (const ev of events) {
      const eventId = ev.id!;
      if (debriefedEvents.has(eventId)) continue;

      const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
      if (!end) continue;

      // Only debrief events that actually ended (not ones still running)
      if (end.getTime() > now.getTime()) continue;

      const minsAgo = Math.round((now.getTime() - end.getTime()) / 60000);
      if (minsAgo <= 10 && minsAgo >= 0) {
        debriefedEvents.add(eventId);
        await sendTelegramText(
          `How did "${ev.summary}" go? Anything worth noting or following up on?`
        );
        console.log(`Post-meeting debrief: ${ev.summary}`);
      }
    }
  } catch (error) {
    console.error("checkPostMeetingDebrief error:", error);
  }
}

// ============================================================
// END-OF-DAY RECAP
// ============================================================

const END_OF_DAY_HOUR = parseInt(process.env.END_OF_DAY_HOUR || "18", 10);
let lastRecapDate = "";

async function checkEndOfDayRecap(): Promise<void> {
  if (!CHECKIN_ENABLED) return;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });
  const hour = now.getHours();

  if (lastRecapDate === todayStr || hour !== END_OF_DAY_HOUR) return;
  if (now.getMinutes() > 30) return;

  lastRecapDate = todayStr;

  try {
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const [memoryContext, todoContext, habitContext] = await Promise.all([
      getMemoryContext(),
      getTodoContext(),
      getHabitContext(),
    ]);

    const prompt = `
${RAYA_SYSTEM_PROMPT}
Send Mark his end-of-day recap via Telegram.

CURRENT TIME: ${timeStr}
${memoryContext}
${todoContext}
${habitContext}
${emailContext}

Include:
- Quick wins — what got done today based on conversation history
- Any todos still pending — help him decide: tackle tonight or defer to tomorrow?
- Habits done/not done today — acknowledge effort, note streaks
- Flag any important unread emails
- Tomorrow's first calendar event (if any) so he can prep
- A warm, genuine sign-off. You know Mark — be real, not generic.
- Keep it concise — 5-10 lines max
- If it was a productive day, celebrate it. If not, no judgment — just help him reset.
`.trim();

    console.log("Sending end-of-day recap...");
    const response = await callClaude(prompt);

    const { cleaned, intents } = processIntents(response);
    await Promise.all(intents);
    await storeMessage("assistant", cleaned, { source: "recap" });
    await sendTelegramText(cleaned);
    await logCheckin("YES", "End-of-day recap", cleaned);
    console.log("End-of-day recap sent");
  } catch (error) {
    console.error("End-of-day recap error:", error);
  }
}

// ============================================================
// DAILY BRIEFING
// ============================================================

let lastBriefingDate = "";

async function checkDailyBriefing(): Promise<void> {
  if (!CHECKIN_ENABLED) return; // needs memory for context

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });
  const hour = now.getHours();

  // Already sent today, or not briefing hour yet
  if (lastBriefingDate === todayStr || hour !== DAILY_BRIEFING_HOUR) return;

  // Only send within the first 30 min of the hour
  if (now.getMinutes() > 30) return;

  lastBriefingDate = todayStr;

  try {
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const [memoryContext, calendarContext, todoContext, habitContext, emailContext] = await Promise.all([
      getMemoryContext(),
      getCalendarContext(),
      getTodoContext(),
      getHabitContext(),
      getEmailContext(),
    ]);

    const weatherContext = await getWeatherContext();

    const prompt = `
${RAYA_SYSTEM_PROMPT}
Send Mark his morning briefing via Telegram.

CURRENT TIME: ${timeStr}
${memoryContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}
${weatherContext}

Include:
- A warm, natural greeting — you know Mark. Be real, not generic.
- Weather outlook if notable (rain, extreme heat, etc.)
- Today's calendar events (if any)
- Top priority todos or goals — help him focus on what matters most today
- Habits and current streaks — brief encouragement
- Flag any important unread emails
- If it's going to be a heavy day, acknowledge it. If it's light, say so.
- Keep it concise — 5-10 lines max
- Don't list sections if there's nothing to list
- Remember he has ADD — help him prioritize, don't overwhelm
`.trim();

    console.log("Sending daily briefing...");
    const response = await callClaude(prompt);

    const { cleaned, intents } = processIntents(response);
    await Promise.all(intents);
    await storeMessage("assistant", cleaned, { source: "briefing" });
    await sendTelegramText(cleaned);
    await logCheckin("YES", "Daily briefing", cleaned);
    console.log("Daily briefing sent");
  } catch (error) {
    console.error("Daily briefing error:", error);
  }
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
console.log(`Calendar: ${CALENDAR_ENABLED ? "enabled (read/write)" : "disabled (no service account key)"}`);
console.log(`Web search: ${GEMINI_API_KEY ? "enabled (Gemini)" : "disabled (set GEMINI_API_KEY)"}`);
console.log(`Todos: ${MEMORY_ENABLED ? "enabled" : "disabled (requires memory)"}`);
console.log(`Habits: ${MEMORY_ENABLED ? "enabled" : "disabled (requires memory)"}`);
console.log(`Gmail: ${GMAIL_ENABLED ? `enabled (${gmailClients.map(c => c.label).join(", ")})` : "disabled (set GMAIL_USER)"}`);
console.log(`Twilio SMS: ${TWILIO_ENABLED ? `enabled (${TWILIO_PHONE_NUMBER})` : "disabled (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER + TWILIO_USER_PHONE)"}`);
console.log(`Daily briefing: ${CHECKIN_ENABLED ? `enabled (${DAILY_BRIEFING_HOUR}:00)` : "disabled (requires memory)"}`);
console.log(`End-of-day recap: ${CHECKIN_ENABLED ? `enabled (${END_OF_DAY_HOUR}:00)` : "disabled (requires memory)"}`);
console.log(`Post-meeting debrief: ${CALENDAR_ENABLED && CHECKIN_ENABLED ? "enabled" : "disabled (requires calendar + memory)"}`);
console.log(`Reminders: ${CALENDAR_ENABLED ? "enabled (15 min before events)" : "disabled (requires calendar)"}`);
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

    // Proactive calendar reminders + post-meeting debrief: check every 5 minutes
    if (CALENDAR_ENABLED) {
      setInterval(checkUpcomingReminders, 5 * 60 * 1000);
      if (CHECKIN_ENABLED) {
        setInterval(checkPostMeetingDebrief, 5 * 60 * 1000);
      }
    }

    // Daily briefing + end-of-day recap: check every minute
    if (CHECKIN_ENABLED) {
      setInterval(checkDailyBriefing, 60 * 1000);
      setInterval(checkEndOfDayRecap, 60 * 1000);
    }
  },
});
