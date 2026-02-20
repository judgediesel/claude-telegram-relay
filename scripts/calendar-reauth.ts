/**
 * Re-authorize personal Gmail OAuth to add Google Calendar scope.
 * This enables reading/writing the markph1978@gmail.com calendar.
 *
 * Run: bun run scripts/calendar-reauth.ts
 *
 * After completing, add to .env:
 *   GOOGLE_PERSONAL_CALENDAR_ID=markph1978@gmail.com
 */
import { google } from "googleapis";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";

const OAUTH_FILE = join(
  process.env.HOME || "~",
  ".claude-relay",
  "gmail-oauth-token.json"
);

const raw = await readFile(OAUTH_FILE, "utf-8");
const cfg = JSON.parse(raw);
const REDIRECT = "http://localhost:3199/callback";

const auth = new google.auth.OAuth2(
  cfg["client_id"],
  cfg["client_secret"],
  REDIRECT
);

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

const link = auth.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
  prompt: "consent",
});

console.log("\nOpening browser for Gmail + Calendar authorization...\n");
console.log("If it doesn't open automatically, visit:\n");
console.log(link);
console.log("\nWaiting for callback...\n");

Bun.spawn(["open", link]);

const srv = Bun.serve({
  port: 3199,
  async fetch(req) {
    const parsed = new URL(req.url);
    if (parsed.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }

    const code = parsed.searchParams.get("code");
    if (!code) {
      return new Response("No code received", { status: 400 });
    }

    try {
      const result = await auth.getToken(code);
      const t = result.tokens;

      const updated = { ...cfg };
      if (t.refresh_token) updated["refresh_token"] = t.refresh_token;

      await writeFile(OAUTH_FILE, JSON.stringify(updated, null, 2));
      console.log("OAuth updated with calendar scope!");
      console.log("Add GOOGLE_PERSONAL_CALENDAR_ID=markph1978@gmail.com to .env");
      console.log("Then restart the bot.");

      setTimeout(() => process.exit(0), 500);

      return new Response(
        [
          "<html><body style='font-family:system-ui;text-align:center;padding:3rem;",
          "background:#0a0e1a;color:#e2e8f0;'>",
          "<h1 style='color:#22c55e;'>Calendar authorized!</h1>",
          "<p>Your markph1978 calendar is now connected.</p>",
          "<p>Add GOOGLE_PERSONAL_CALENDAR_ID=markph1978@gmail.com to .env</p>",
          "<p>Then restart the bot.</p>",
          "</body></html>",
        ].join(""),
        { headers: { "Content-Type": "text/html" } }
      );
    } catch (err) {
      console.error("Authorization failed:", err);
      return new Response("Failed: " + err, { status: 500 });
    }
  },
});

console.log("Listening on http://localhost:" + srv.port);
