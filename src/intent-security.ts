/**
 * Intent security — rate limiting and validation for SMS, CALL, and CALENDAR intents
 */

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

const AUDIT_DIR = join(process.env.HOME || "~", ".claude-relay");
const AUDIT_LOG = join(AUDIT_DIR, "intent-audit.log");

// Daily rate limits
const RATE_LIMITS: Record<string, number> = {
  SMS: 3,
  CALL: 1,
  CALENDAR: 10,
};

// In-memory daily counters: { "SMS:2026-02-09": 2 }
const counters = new Map<string, number>();

function todayKey(type: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${type}:${today}`;
}

// Suspicious patterns to flag
const SUSPICIOUS_PATTERNS = [
  /https?:\/\/[^\s]+/i,         // URLs in SMS body
  /[A-Za-z0-9+/]{40,}={0,2}/,  // Base64-encoded strings
  /\b\d{16}\b/,                 // Credit card-like numbers
  /\bpassword\b/i,              // Password mentions
  /\bssn\b/i,                   // SSN mentions
  /\b\d{3}-\d{2}-\d{4}\b/,     // SSN format
];

export interface IntentCheckResult {
  allowed: boolean;
  reason?: string;
}

export function validateIntent(
  type: string,
  payload: string
): IntentCheckResult {
  const key = todayKey(type);
  const current = counters.get(key) || 0;
  const limit = RATE_LIMITS[type];

  // Rate limit check
  if (limit !== undefined && current >= limit) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${current}/${limit} ${type} today`,
    };
  }

  // Content checks for SMS
  if (type === "SMS") {
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(payload)) {
        return {
          allowed: false,
          reason: `Suspicious content in SMS: matches ${pattern.source}`,
        };
      }
    }
  }

  // Content checks for CALL
  if (type === "CALL") {
    if (payload.length > 500) {
      return {
        allowed: false,
        reason: "Call message too long (>500 chars)",
      };
    }
  }

  // Increment counter
  counters.set(key, current + 1);

  return { allowed: true };
}

export async function auditIntent(
  type: string,
  payload: string,
  result: "allowed" | "blocked",
  reason?: string
): Promise<void> {
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${result.toUpperCase()} type=${type} reason="${reason || "ok"}" payload="${payload.substring(0, 100)}"\n`;
    await appendFile(AUDIT_LOG, entry);
  } catch (error) {
    console.error("Intent audit log error:", error);
  }
}
