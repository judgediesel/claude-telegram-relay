/**
 * Summarize Springboard events — group by title and recurring series
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
      q: "Springboard",
    });

    const events = res.data.items || [];
    allEvents.push(...events);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  const matches = allEvents.filter((ev) =>
    ev.summary?.toLowerCase().includes("springboard")
  );

  // Group by title
  const byTitle = new Map<string, any[]>();
  for (const ev of matches) {
    const title = ev.summary || "(no title)";
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title)!.push(ev);
  }

  console.log(`Total Springboard events: ${matches.length}\n`);
  console.log("BY TITLE:");
  console.log("─".repeat(70));
  for (const [title, events] of byTitle.entries()) {
    const dates = events.map((e: any) => e.start?.dateTime || e.start?.date || "");
    const earliest = dates.sort()[0];
    const latest = dates.sort().at(-1);
    console.log(`  "${title}": ${events.length} event(s)`);
    console.log(`    Range: ${new Date(earliest).toLocaleDateString("en-US")} → ${new Date(latest!).toLocaleDateString("en-US")}`);
    
    // Get unique recurring series IDs
    const seriesIds = new Set(events.filter((e: any) => e.recurringEventId).map((e: any) => {
      // Extract base series ID (before any _R suffix)
      const rid = e.recurringEventId;
      return rid.includes("_R") ? rid.split("_R")[0] : rid;
    }));
    if (seriesIds.size > 0) {
      console.log(`    Recurring series IDs: ${[...seriesIds].join(", ")}`);
    }
    const nonRecurring = events.filter((e: any) => !e.recurringEventId);
    if (nonRecurring.length > 0) {
      console.log(`    Non-recurring: ${nonRecurring.length} event(s)`);
    }
    console.log();
  }

  // Count future vs past
  const now = new Date();
  const futureEvents = matches.filter((ev) => {
    const start = new Date(ev.start?.dateTime || ev.start?.date || "");
    return start > now;
  });
  const pastEvents = matches.length - futureEvents.length;
  
  console.log("─".repeat(70));
  console.log(`Past events: ${pastEvents}`);
  console.log(`Future events: ${futureEvents.length}`);
  console.log(`Total: ${matches.length}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
