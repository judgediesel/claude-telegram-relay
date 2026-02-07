/**
 * One-time OAuth2 flow for personal Gmail access.
 * Run: bun run scripts/gmail-oauth.ts
 *
 * Opens a browser for you to sign in with your personal Gmail.
 * Saves the refresh token to ~/.claude-relay/gmail-oauth-token.json
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CREDS_FILE = join(RELAY_DIR, "gmail-oauth-credentials.json");
const TOKEN_FILE = join(RELAY_DIR, "gmail-oauth-token.json");

const creds = JSON.parse(await readFile(CREDS_FILE, "utf-8"));
const { client_id, client_secret } = creds.installed || creds.web || {};

if (!client_id || !client_secret) {
  console.error("Invalid credentials file");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3199/callback";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;

console.log("\nOpening browser for Gmail authorization...\n");
console.log("If it doesn't open, visit this URL:\n");
console.log(authUrl + "\n");

// Open browser
const proc = Bun.spawn(["open", authUrl], { stdout: "ignore", stderr: "ignore" });
await proc.exited;

// Start local server to catch the callback
const server = Bun.serve({
  port: 3199,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return new Response("No code received. Try again.");
    }

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error("Token exchange failed:", tokens.error_description);
      return new Response(`Error: ${tokens.error_description}`);
    }

    await writeFile(TOKEN_FILE, JSON.stringify({
      client_id,
      client_secret,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
    }, null, 2));

    console.log("\nAuthorization successful!");
    console.log(`Token saved to: ${TOKEN_FILE}`);
    console.log("\nYou can close this browser tab.");

    // Shut down after a moment
    setTimeout(() => process.exit(0), 1000);

    return new Response("<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>", {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log("Waiting for authorization...");
