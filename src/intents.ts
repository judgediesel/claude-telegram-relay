/**
 * Intent detection — parse action tags from Claude responses and execute side effects
 */

import { storeFact, storeGoal, completeGoal, storeTodo, completeTodo, storeHabit, completeHabit, removeHabit } from "./memory";
import { createCalendarEvent } from "./calendar";
import { sendSMS, makeCall } from "./twilio";

export function processIntents(response: string): { cleaned: string; intents: Promise<void>[] } {
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
