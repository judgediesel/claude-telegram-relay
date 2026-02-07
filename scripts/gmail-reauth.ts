/**
 * Re-authorize Gmail OAuth with send scope.
 * Run: bun run scripts/gmail-reauth.ts
 */
import { google } from "googleapis";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";

const TOKEN_FILE = join(
  process.env.HOME || "~",
  ".claude-relay",
  "gmail-oauth-token.json"
);

const tokenData = JSON.parse(await readFile(TOKEN_FILE, "utf-8"));
const REDIRECT_URI = "http://localhost:3199/callback";

const oauth2 = new google.auth.OAuth2(
  tokenData.client_id,
  tokenData.client_secret,
  REDIRECT_URI
);

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
  prompt: "consent",
});

console.log("\nOpening browser for Gmail authorization...\n");
console.log("If it doesn't open, visit:\n");
console.log(authUrl);
console.log("\nWaiting for callback...\n");

// Open browser
Bun.spawn(["open", authUrl]);

// Start local server to catch the OAuth callback
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

      const updated = {
        ...tokenData,
        refresh_token: tokens.refresh_token || tokenData.refresh_token,
      };

      await writeFile(TOKEN_FILE, JSON.stringify(updated, null, 2));
      console.log("Token updated successfully!");
      console.log("Restart the bot to pick up the new credentials.");

      // Shut down after a brief delay
      setTimeout(() => process.exit(0), 500);

      return new Response(
        "<html><body style='font-family:system-ui;text-align:center;padding:3rem;background:#0a0e1a;color:#e2e8f0;'>" +
        "<h1 style='color:#22c55e;'>Gmail authorized!</h1>" +
        "<p>You can close this tab. Restart the bot to use email-to-SMS.</p></body></html>",
        { headers: { "Content-Type": "text/html" } }
      );
    } catch (err) {
      console.error("Failed to exchange code:", err);
      return new Response("Authorization failed: " + err, { status: 500 });
    }
  },
});

console.log(`Listening on http://localhost:${server.port}`);
