/**
 * Script to find and delete the "Traffic Tuesdays" recurring event.
 * Uses service account to access mark@titanexclusive.com calendar.
 */

import { google } from "googleapis";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const CAL_ID = "mark@titanexclusive.com";

async function main() {
  const saAuth = new google.auth.GoogleAuth({
    keyFile: join(RELAY_DIR, "google-service-account.json"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  const calendar = google.calendar({ version: "v3", auth: saAuth });

  console.log("Searching for 'Traffic Tuesdays' on " + CAL_ID + "...\n");

  // Search for the event by name - get recurring event masters
  const res = await calendar.events.list({
    calendarId: CAL_ID,
    q: "Traffic Tuesdays",
    singleEvents: false,
    maxResults: 50,
  });

  const events = res.data.items;
  if (!events || events.length === 0) {
    console.log("No 'Traffic Tuesdays' events found.");
    return;
  }

  console.log("Found " + events.length + " matching event(s):\n");

  for (const ev of events) {
    console.log("  - ID: " + ev.id);
    console.log("    Summary: " + ev.summary);
    console.log("    Status: " + ev.status);
    console.log("    Recurrence: " + JSON.stringify(ev.recurrence));
    console.log("    Start: " + (ev.start?.dateTime || ev.start?.date));
    console.log("    recurringEventId: " + ev.recurringEventId);
    console.log();
  }

  // Delete each matching recurring event
  // Deleting the master event removes ALL instances (past and future)
  const deletedIds = new Set<string>();

  for (const ev of events) {
    if (!ev.id) continue;

    // Use the master recurring event ID if available
    const eventId = ev.recurringEventId || ev.id;

    // Skip if we already deleted this master
    if (deletedIds.has(eventId)) continue;

    console.log("Deleting recurring event: " + eventId + " ...");
    try {
      await calendar.events.delete({
        calendarId: CAL_ID,
        eventId: eventId,
      });
      deletedIds.add(eventId);
      console.log("  DELETED successfully.");
    } catch (err: any) {
      console.error("  Failed to delete: " + err.message);
    }
  }

  console.log("\nVerifying no remaining 'Traffic Tuesdays' events...");

  const verify = await calendar.events.list({
    calendarId: CAL_ID,
    q: "Traffic Tuesdays",
    singleEvents: true,
    timeMin: new Date().toISOString(),
    maxResults: 10,
  });

  if (!verify.data.items || verify.data.items.length === 0) {
    console.log("Confirmed: No remaining events found.");
  } else {
    console.log("WARNING: " + verify.data.items.length + " event(s) still remain:");
    for (const ev of verify.data.items) {
      console.log("  - " + ev.summary + " on " + (ev.start?.dateTime || ev.start?.date));
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
