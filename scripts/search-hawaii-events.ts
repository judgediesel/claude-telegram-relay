/**
 * Search Google Calendars for Hawaii / CEO AI Mastermind events
 * Run: bun run scripts/search-hawaii-events.ts
 */
import { google } from "googleapis";
import { join } from "path";
import { readFile } from "fs/promises";

const RELAY_DIR = join(process.env.HOME || "~", ".claude-relay");
const KEY_FILE = join(RELAY_DIR, "google-service-account.json");
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || "mark@titanexclusive.com";
const OAUTH_FILE = join(RELAY_DIR, "gmail-oauth-token.json");

const TERMS = ["hawaii", "honolulu", "ceo ai", "mastermind"];

// 6 months back, 12 months forward
const tMin = new Date();
tMin.setMonth(tMin.getMonth() - 6);
const tMax = new Date();
tMax.setFullYear(tMax.getFullYear() + 1);

console.log("Searching for: " + TERMS.join(", "));
console.log("Range: " + tMin.toISOString().split("T")[0] + " to " + tMax.toISOString().split("T")[0]);
console.log("");

interface FoundEvent {
  summary: string;
  start: string;
  end: string;
  location: string;
  desc: string;
  cal: string;
}

const all: FoundEvent[] = [];

async function doSearch(client: any, calId: string, label: string) {
  for (const term of TERMS) {
    try {
      const res = await client.events.list({
        calendarId: calId,
        timeMin: tMin.toISOString(),
        timeMax: tMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
        q: term,
      });
      for (const ev of res.data.items || []) {
        const k = (ev.summary || "") + "|" + (ev.start?.dateTime || ev.start?.date || "");
        if (all.find((r) => r.summary + "|" + r.start === k)) continue;
        all.push({
          summary: ev.summary || "(no title)",
          start: ev.start?.dateTime || ev.start?.date || "",
          end: ev.end?.dateTime || ev.end?.date || "",
          location: ev.location || "",
          desc: ev.description || "",
          cal: label,
        });
      }
    } catch (err: any) {
      console.error("  Err [" + label + "/" + term + "]: " + err.message);
    }
  }
}

// 1. Titan (service account)
console.log("--- TITAN calendar (mark@titanexclusive.com) ---");
const titanAuth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
});
const titanCal = google.calendar({ version: "v3", auth: titanAuth });
await doSearch(titanCal, CAL_ID, "titan");
console.log("  Found: " + all.filter((r) => r.cal === "titan").length);

// 2. Personal (OAuth)
console.log("");
console.log("--- PERSONAL calendar (markph1978@gmail.com) ---");
try {
  const oauthData = JSON.parse(await readFile(OAUTH_FILE, "utf-8"));
  const oauth2 = new google.auth.OAuth2(oauthData["client_id"], oauthData["client_secret"]);
  oauth2.setCredentials({ refresh_token: oauthData["refresh_token"] });
  const pCal = google.calendar({ version: "v3", auth: oauth2 });
  await doSearch(pCal, "primary", "personal");
  console.log("  Found: " + all.filter((r) => r.cal === "personal").length);
} catch (err: any) {
  console.error("  Personal calendar err: " + err.message);
}

// Print results
console.log("");
console.log("========== RESULTS ==========");
console.log("");

if (all.length === 0) {
  console.log("No matching events found.");
} else {
  all.sort((a, b) => a.start.localeCompare(b.start));
  for (const ev of all) {
    const d = new Date(ev.start);
    const dateStr = d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });
    const timeStr = ev.start.includes("T")
      ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
      : "All day";
    console.log("[" + ev.cal.toUpperCase() + "] " + ev.summary);
    console.log("  When: " + dateStr + " at " + timeStr);
    if (ev.location) console.log("  Where: " + ev.location);
    if (ev.desc) console.log("  Notes: " + ev.desc.substring(0, 250));
    console.log("");
  }
  console.log("Total: " + all.length + " event(s)");
}
