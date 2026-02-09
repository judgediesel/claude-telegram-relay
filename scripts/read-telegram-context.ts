#!/usr/bin/env bun
/**
 * Read recent Telegram conversation from Supabase messages table.
 * Used by Claude Code to see what Mark and Raya were discussing.
 *
 * Usage: bun run scripts/read-telegram-context.ts [count]
 *   count: number of recent messages to fetch (default: 20)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY required in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const count = parseInt(process.argv[2] || "20", 10);

const { data, error } = await supabase
  .from("messages")
  .select("role, content, channel, created_at")
  .eq("channel", "telegram")
  .order("created_at", { ascending: false })
  .limit(count);

if (error) {
  console.error("Error:", error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log("No recent Telegram messages found.");
  process.exit(0);
}

// Print in chronological order
const messages = data.reverse();
console.log(`=== Last ${messages.length} Telegram messages ===\n`);

for (const msg of messages) {
  const time = new Date(msg.created_at).toLocaleString();
  const role = msg.role === "user" ? "Mark" : "Raya";
  const content = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
  console.log(`[${time}] ${role}: ${content}\n`);
}
