/**
 * Intent detection — parse action tags from Claude responses and execute side effects
 */

import { storeFact, storeGoal, completeGoal, storeTodo, completeTodo, storeHabit, completeHabit, removeHabit, storeContact } from "./memory";
import { createCalendarEvent } from "./calendar";
import { sendSMS, makeCall } from "./twilio";
import { validateIntent, auditIntent } from "./intent-security";
import { scanEmailsForEvents, approveEvents } from "./email-calendar";

export function processIntents(response: string): { cleaned: string; intents: Promise<void>[]; followUp: Promise<string | null> } {
  let cleaned = response;
  const intents: Promise<void>[] = [];
  let followUp: Promise<string | null> = Promise.resolve(null);

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
    const title = match[1].trim();
    const payload = `${title} on ${match[2].trim()} at ${match[3].trim()}`;
    const check = validateIntent("CALENDAR", payload);
    intents.push(
      auditIntent("CALENDAR", payload, check.allowed ? "allowed" : "blocked", check.reason).then(() => {
        if (check.allowed) {
          return createCalendarEvent(title, match[2].trim(), match[3].trim(), match[4] ? parseInt(match[4]) : 60);
        }
        console.log(`[Security] Blocked CALENDAR: ${check.reason}`);
      })
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
    const payload = match[1].trim();
    const check = validateIntent("SMS", payload);
    intents.push(
      auditIntent("SMS", payload, check.allowed ? "allowed" : "blocked", check.reason).then(() => {
        if (check.allowed) return sendSMS(payload);
        console.log(`[Security] Blocked SMS: ${check.reason}`);
      })
    );
    cleaned = cleaned.replace(match[0], "");
  }

  // [CALL: message text]
  for (const match of response.matchAll(/\[CALL:\s*(.+?)\]/gi)) {
    const payload = match[1].trim();
    const check = validateIntent("CALL", payload);
    intents.push(
      auditIntent("CALL", payload, check.allowed ? "allowed" : "blocked", check.reason).then(() => {
        if (check.allowed) return makeCall(payload);
        console.log(`[Security] Blocked CALL: ${check.reason}`);
      })
    );
    cleaned = cleaned.replace(match[0], "");
  }

  // [CONTACT: name | relationship | email | phone | notes]
  for (const match of response.matchAll(
    /\[CONTACT:\s*(.+?)(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.+?))?(?:\s*\|\s*(.+?))?\]/gi
  )) {
    intents.push(
      storeContact(
        match[1].trim(),
        match[2]?.trim(),
        match[3]?.trim(),
        match[4]?.trim(),
        match[5]?.trim()
      )
    );
    cleaned = cleaned.replace(match[0], "");
  }

  // [SCAN_EMAILS] — scan recent emails for calendar events
  if (/\[SCAN_EMAILS\]/i.test(response)) {
    followUp = scanEmailsForEvents();
    cleaned = cleaned.replace(/\[SCAN_EMAILS\]/gi, "");
  }

  // [APPROVE_EVENTS: all] or [APPROVE_EVENTS: 1, 3]
  const approveMatch = response.match(/\[APPROVE_EVENTS:\s*(.+?)\]/i);
  if (approveMatch) {
    const val = approveMatch[1].trim().toLowerCase();
    const indices = val === "all" ? "all" as const : val.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n));
    followUp = approveEvents(indices);
    cleaned = cleaned.replace(/\[APPROVE_EVENTS:\s*.+?\]/gi, "");
  }

  // [SEARCH: query] — handled by callClaudeWithSearch, but clean tag if it leaks through
  cleaned = cleaned.replace(/\[SEARCH:\s*.+?\]/gi, "");

  // Clean up extra whitespace left by removed tags
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleaned, intents, followUp };
}
