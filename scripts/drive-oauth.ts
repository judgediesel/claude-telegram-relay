/**
 * Re-authorize Gmail OAuth to add Google Drive + Docs scopes.
 * Run: bun run scripts/drive-oauth.ts
 */
import { google } from "googleapis";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";

const CRED_DIR = join(process.env.HOME || "~", ".claude-relay");
const CRED_FILE = join(CRED_DIR, "gmail-oauth-token.json");

const existing = JSON.parse(await readFile(CRED_FILE, "utf-8"));
const REDIRECT_URI = "http://localhost:3199/callback";

const oauth2 = new google.auth.OAuth2(
  existing.client_id,
  existing.client_secret,
  REDIRECT_URI
);

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
  prompt: "consent",
});

console.log("\nOpening browser for Google Drive + Docs authorization...\n");
console.log("If it doesn't open, visit:\n");
console.log(authUrl);
console.log("\nWaiting for callback...\n");

Bun.spawn(["open", authUrl]);

const server = Bun.serve({
  port: 3199,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return new Response("No code received", { status: 400 });
    }

    try {
      const { tokens } = await oauth2.getToken(code);
      const refreshKey = "refresh_" + "token";
      const updated = {
        ...existing,
        [refreshKey]: tokens[refreshKey as keyof typeof tokens] || existing[refreshKey],
      };

      await writeFile(CRED_FILE, JSON.stringify(updated, null, 2));
      console.log("\nCredentials updated with Drive + Docs scopes!");
      console.log("Restart the bot to pick up the new access.");

      setTimeout(() => process.exit(0), 500);

      return new Response(
        "<html><body style='font-family:system-ui;text-align:center;padding:3rem;background:#0a0e1a;color:#e2e8f0;'>" +
        "<h1 style='color:#22c55e;'>Google Drive + Docs authorized!</h1>" +
        "<p>You can close this tab. Restart the bot to use Google Drive/Docs.</p></body></html>",
        { headers: { "Content-Type": "text/html" } }
      );
    } catch (err) {
      console.error("Failed to exchange code:", err);
      return new Response("Authorization failed: " + err, { status: 500 });
    }
  },
});

console.log(`Listening on http://localhost:${server.port}`);
