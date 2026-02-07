/**
 * Claude CLI — invocation, session management, prompt building
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import {
  CLAUDE_PATH,
  SESSION_FILE,
  MEMORY_ENABLED,
  CALENDAR_ENABLED,
  GEMINI_API_KEY,
  TWILIO_ENABLED,
  RAYA_SYSTEM_PROMPT,
} from "./config";
import { getMemoryContext, getConversationContext, getTodoContext, getHabitContext, getContactContext } from "./memory";
import { getCalendarContext } from "./calendar";
import { getEmailContext } from "./gmail";
import { getWeatherContext, searchWeb } from "./search";
import type { SessionState } from "./types";

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
// CORE: Call Claude CLI
// ============================================================

export async function callClaude(
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

export async function callClaudeWithSearch(
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
// PROMPT BUILDING
// ============================================================

export async function buildPrompt(userMessage: string): Promise<string> {
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
    getMemoryContext(userMessage),
    getCalendarContext(),
    getTodoContext(),
    getHabitContext(),
    getEmailContext(),
    getContactContext(userMessage),
  ];

  // Only fetch weather for catch-up requests or if they ask about weather
  if (isCatchUp || /weather|rain|umbrella|temperature|forecast/i.test(userMessage)) {
    contextFetches.push(getWeatherContext());
  } else {
    contextFetches.push(Promise.resolve(""));
  }

  const [memoryContext, calendarContext, todoContext, habitContext, emailContext, contactContext, weatherContext] = await Promise.all(contextFetches);

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

Contacts:
- [CONTACT: name | relationship | email | phone | notes] — Save or update a contact. Only name is required, others are optional. Use when Mark mentions someone new or shares contact details.

SMS/Phone:${TWILIO_ENABLED ? `
- [SMS: message text] — Send an SMS to the user's phone. Use for urgent reminders or when the user asks you to text them.
- [CALL: message text] — Call the user's phone and speak a message. Use only for critical/emergency alerts or when the user explicitly asks.` : " (disabled)"}

Rules:
- Use tags sparingly. Most messages need zero tags.
- Never mention these tags to the user or explain the system.
- Place tags at the very end of your response, each on its own line.
`
    : "";

  const conversationContext = getConversationContext();

  return `
${RAYA_SYSTEM_PROMPT}
Current time: ${timeStr}
${memoryContext}
${conversationContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}
${contactContext}
${weatherContext}
${tagInstructions}
${isCatchUp ? "\nThe user wants a full catch-up summary. Cover: calendar, todos, habits (streaks), emails, and anything notable. Be thorough but organized.\n" : ""}
User: ${userMessage}
`.trim();
}
