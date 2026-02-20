/**
 * One-time script to:
 * 1. Delete "Meeting with Jack Appleby" at 11:00 AM today
 * 2. Delete "Real Estate Continuing Education" events today
 * 3. Move Jack Appleby to 1:30 PM (already exists as "Meeting with Jack and List Owner")
 *
 * Run: bun run scripts/calendar-cleanup.ts
 */
import { google } from "googleapis";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const KEY_FILE = join(RELAY_DIR, "google-service-account.json");
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "mark@titanexclusive.com";

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

const now = new Date();
const todayStart = new Date(now);
todayStart.setHours(0, 0, 0, 0);
const todayEnd = new Date(now);
todayEnd.setHours(23, 59, 59, 999);

// Get all events today
const res = await calendar.events.list({
  calendarId: CALENDAR_ID,
  timeMin: todayStart.toISOString(),
  timeMax: todayEnd.toISOString(),
  singleEvents: true,
  orderBy: "startTime",
});

const events = res.data.items || [];
console.log(`Found ${events.length} events today:\n`);

for (const ev of events) {
  const time = ev.start?.dateTime
    ? new Date(ev.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "all-day";
  console.log(`  ${time} — ${ev.summary} (ID: ${ev.id})`);
}

// 1. Delete "Meeting with Jack Appleby" at 11:00
const jackMeeting = events.find(
  (ev) => ev.summary?.toLowerCase().includes("jack appleby") && ev.start?.dateTime?.includes("T11:")
);

if (jackMeeting) {
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: jackMeeting.id! });
  console.log(`\nDeleted: ${jackMeeting.summary}`);
} else {
  console.log("\nNo Jack Appleby 11:00 meeting found to delete.");
}

// 2. Delete RE class events (both 12pm and 6pm sessions)
const reEvents = events.filter(
  (ev) => ev.summary?.toLowerCase().includes("real estate") || ev.summary?.toLowerCase().includes("re class") || ev.summary?.toLowerCase().includes("continuing education")
);

for (const ev of reEvents) {
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id! });
  console.log(`Deleted: ${ev.summary}`);
}

if (reEvents.length === 0) {
  console.log("No RE class events found to delete.");
}

// 3. Check if "Meeting with Jack and List Owner" at 1:30 already exists
const jackListMeeting = events.find(
  (ev) => ev.summary?.toLowerCase().includes("jack") && ev.summary?.toLowerCase().includes("list") && ev.start?.dateTime?.includes("T13:30")
);

if (jackListMeeting) {
  console.log(`\n"Meeting with Jack and List Owner" at 1:30 already exists — no changes needed.`);
} else {
  console.log(`\nNote: "Meeting with Jack and List Owner" at 1:30 should already be on the calendar.`);
}

console.log("\nDone!");
