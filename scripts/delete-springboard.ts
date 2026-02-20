/**
 * Delete ALL Springboard events from Google Calendar.
 * Run: bun run scripts/delete-springboard.ts
 */

import { google } from "googleapis";
import { join } from "path";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const SA_PATH = join(RELAY_DIR, "google-service-account.json");
const CALENDAR_ID = "mark@titanexclusive.com";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_PATH,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const cal = google.calendar({ version: "v3", auth });
  let totalDeleted = 0;
  const deletedIds = new Set<string>();

  // Pass 1: Delete recurring event masters
  console.log("PASS 1: Finding recurring event masters...");

  const masterRes = await cal.events.list({
    calendarId: CALENDAR_ID,
    q: "Springboard",
    singleEvents: false,
    maxResults: 250,
  });

  const masters = (masterRes.data.items || []).filter((ev) =>
    ev.summary?.toLowerCase().includes("springboard")
  );

  console.log("Found " + masters.length + " event(s) in master search.");

  const masterIds = new Set<string>();
  for (const ev of masters) {
    const mid = ev.recurringEventId || ev.id;
    if (mid) masterIds.add(mid);
  }

  console.log("Unique master IDs: " + masterIds.size);

  for (const eid of masterIds) {
    if (deletedIds.has(eid)) continue;
    try {
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId: eid });
      deletedIds.add(eid);
      totalDeleted++;
      console.log("  Deleted master: " + eid);
      await delay(100);
    } catch (err: any) {
      if (err.code === 410 || err.code === 404) {
        console.log("  Already gone: " + eid);
      } else {
        console.error("  Failed: " + eid + " -- " + err.message);
      }
    }
  }

  console.log("Pass 1 done: " + totalDeleted + " master(s) deleted.\n");

  // Pass 2: Delete remaining individual events
  console.log("PASS 2: Finding remaining individual events...");

  const tMin = new Date("2024-01-01T00:00:00Z").toISOString();
  const tMax = new Date("2027-12-31T23:59:59Z").toISOString();

  let remaining: any[] = [];
  let pToken: string | undefined;

  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: tMin,
      timeMax: tMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken: pToken,
      q: "Springboard",
    });

    remaining.push(...(res.data.items || []));
    pToken = res.data.nextPageToken || undefined;
  } while (pToken);

  remaining = remaining.filter((ev) =>
    ev.summary?.toLowerCase().includes("springboard")
  );

  console.log("Found " + remaining.length + " remaining event(s).");

  // Group by title
  const byTitle = new Map<string, number>();
  for (const ev of remaining) {
    const t = ev.summary || "(no title)";
    byTitle.set(t, (byTitle.get(t) || 0) + 1);
  }
  for (const [t, c] of byTitle.entries()) {
    console.log('  "' + t + '": ' + c);
  }

  let pass2Count = 0;
  for (const ev of remaining) {
    if (!ev.id) continue;
    try {
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
      pass2Count++;
      totalDeleted++;
      if (pass2Count % 25 === 0) {
        console.log("  ...deleted " + pass2Count + "/" + remaining.length);
      }
      if (pass2Count % 50 === 0) {
        await delay(2000);
      } else {
        await delay(100);
      }
    } catch (err: any) {
      if (err.code === 410 || err.code === 404) {
        // already gone
      } else {
        console.error("  Failed: " + ev.summary + " -- " + err.message);
      }
    }
  }

  console.log("Pass 2 done: " + pass2Count + " individual event(s) deleted.\n");

  // Verify
  console.log("VERIFICATION...");
  await delay(2000);

  let verify: any[] = [];
  pToken = undefined;
  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: tMin,
      timeMax: tMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken: pToken,
      q: "Springboard",
    });
    verify.push(...(res.data.items || []));
    pToken = res.data.nextPageToken || undefined;
  } while (pToken);

  verify = verify.filter((ev) =>
    ev.summary?.toLowerCase().includes("springboard")
  );

  if (verify.length === 0) {
    console.log("Confirmed: ZERO Springboard events remain.");
  } else {
    console.log("WARNING: " + verify.length + " event(s) still remain.");
  }

  console.log("\nSUMMARY:");
  console.log("  Masters deleted: " + deletedIds.size);
  console.log("  Individual deleted: " + pass2Count);
  console.log("  Total: " + totalDeleted);
  console.log("  Remaining: " + verify.length);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
