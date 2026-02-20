/**
 * Search for all "Springboard" events in Google Calendar
 * Searches from 2024-01-01 through 2027-12-31 to catch past and future events
 */

import { google } from "googleapis";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const KEY_FILE = join(RELAY_DIR, "google-service-account.json");
const CALENDAR_ID = "mark@titanexclusive.com";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  // Search a wide range to find all Springboard events
  const timeMin = new Date("2024-01-01T00:00:00Z").toISOString();
  const timeMax = new Date("2027-12-31T23:59:59Z").toISOString();

  let allEvents: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
      q: "Springboard", // server-side text search
    });

    const events = res.data.items || [];
    allEvents.push(...events);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  // Filter client-side for case-insensitive match (belt and suspenders)
  const matches = allEvents.filter((ev) =>
    ev.summary?.toLowerCase().includes("springboard")
  );

  if (matches.length === 0) {
    console.log("No events matching 'Springboard' found.");
    return;
  }

  console.log(`Found ${matches.length} event(s) matching "Springboard":\n`);
  console.log("─".repeat(90));

  for (const ev of matches) {
    const start = ev.start?.dateTime || ev.start?.date || "unknown";
    const end = ev.end?.dateTime || ev.end?.date || "";
    const startDate = new Date(start);
    const formatted = startDate.toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    console.log(`  Title:    ${ev.summary}`);
    console.log(`  ID:       ${ev.id}`);
    console.log(`  Start:    ${formatted}`);
    console.log(`  Raw Date: ${start}`);
    if (ev.recurringEventId) {
      console.log(`  Recurring: Yes (series ID: ${ev.recurringEventId})`);
    }
    if (ev.location) {
      console.log(`  Location: ${ev.location}`);
    }
    console.log("─".repeat(90));
  }

  console.log(`\nTotal: ${matches.length} event(s)`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
