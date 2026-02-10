/**
 * Email-to-Calendar — scan emails for events, extract details, propose calendar entries
 *
 * Detects: meeting invites, flight bookings, hotel reservations, appointment confirmations,
 * ICS calendar attachments, and any email with a clear date/time.
 */

import { getRecentEmailsFull, type EmailDetail } from "./gmail";
import { createCalendarEvent } from "./calendar";
import { GMAIL_ENABLED, CALENDAR_ENABLED } from "./config";

export interface ProposedEvent {
  title: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  duration: number;   // minutes
  source: string;     // "email" | "ics"
  emailSubject: string;
  emailFrom: string;
  confidence: "high" | "medium" | "low";
  location?: string;
}

// Track which emails we've already scanned to avoid duplicates
const scannedEmailIds = new Set<string>();

/**
 * Scan recent emails for calendar-worthy events.
 * Returns a formatted string for Claude to present to the user for approval.
 */
export async function scanEmailsForEvents(): Promise<string> {
  if (!GMAIL_ENABLED || !CALENDAR_ENABLED) {
    return "Email-to-calendar requires both Gmail and Calendar to be enabled.";
  }

  try {
    const emails = await getRecentEmailsFull(10);

    if (emails.length === 0) {
      return "No recent unread emails to scan for events.";
    }

    // Filter out already-scanned emails
    const newEmails = emails.filter((e) => !scannedEmailIds.has(e.id));
    if (newEmails.length === 0) {
      return "Already scanned all recent emails — no new ones to check.";
    }

    // Mark these as scanned
    for (const email of newEmails) {
      scannedEmailIds.add(email.id);
    }

    // Parse ICS attachments first (highest confidence)
    const icsEvents = newEmails
      .filter((e) => e.hasICS && e.icsData)
      .map((e) => parseICS(e))
      .filter((e): e is ProposedEvent => e !== null);

    // Parse email bodies for event-like content
    const bodyEvents = newEmails
      .filter((e) => isEventLikeEmail(e))
      .map((e) => parseEmailForEvent(e))
      .filter((e): e is ProposedEvent => e !== null);

    const allEvents = [...icsEvents, ...bodyEvents];

    if (allEvents.length === 0) {
      return `Scanned ${newEmails.length} emails — no calendar events detected.`;
    }

    // Format for Claude to present to user
    const eventLines = allEvents.map((ev, i) => {
      const loc = ev.location ? ` | Location: ${ev.location}` : "";
      return `${i + 1}. **${ev.title}**\n   ${ev.date} at ${ev.time} (${ev.duration} min)${loc}\n   From: ${ev.emailFrom} — "${ev.emailSubject}"\n   Confidence: ${ev.confidence} | Source: ${ev.source}`;
    });

    // Store proposed events for approval
    pendingEvents = allEvents;

    return `Found ${allEvents.length} potential calendar event${allEvents.length > 1 ? "s" : ""} from your emails:\n\n${eventLines.join("\n\n")}\n\nReply with the numbers you want to add (e.g., "add 1, 3") or "add all" to create them all.`;
  } catch (error) {
    console.error("scanEmailsForEvents error:", error);
    return "Error scanning emails for events.";
  }
}

// Pending events waiting for user approval
let pendingEvents: ProposedEvent[] = [];

/**
 * Create approved events. Called when user confirms.
 * @param indices - 1-based indices of events to create, or "all"
 */
export async function approveEvents(indices: number[] | "all"): Promise<string> {
  if (pendingEvents.length === 0) {
    return "No pending events to approve. Ask me to scan your emails first.";
  }

  const toCreate = indices === "all"
    ? pendingEvents
    : indices
        .filter((i) => i >= 1 && i <= pendingEvents.length)
        .map((i) => pendingEvents[i - 1]);

  if (toCreate.length === 0) {
    return "No valid events selected. Use numbers from the list (e.g., 'add 1, 3').";
  }

  const results: string[] = [];

  for (const event of toCreate) {
    try {
      await createCalendarEvent(event.title, event.date, event.time, event.duration);
      results.push(`Added: ${event.title} on ${event.date} at ${event.time}`);
    } catch (error) {
      results.push(`Failed: ${event.title} — ${error}`);
    }
  }

  // Clear pending
  pendingEvents = [];

  return results.join("\n");
}

export function getPendingEvents(): ProposedEvent[] {
  return pendingEvents;
}

export function clearPendingEvents(): void {
  pendingEvents = [];
}

// ============================================================
// ICS PARSING
// ============================================================

function parseICS(email: EmailDetail): ProposedEvent | null {
  const ics = email.icsData;
  if (!ics) return null;

  try {
    const summary = ics.match(/SUMMARY:(.+)/i)?.[1]?.trim() || email.subject;
    const dtstart = ics.match(/DTSTART(?:;[^:]*)?:(\d{8}T\d{6}Z?)/i)?.[1];
    const dtend = ics.match(/DTEND(?:;[^:]*)?:(\d{8}T\d{6}Z?)/i)?.[1];
    const location = ics.match(/LOCATION:(.+)/i)?.[1]?.trim();

    if (!dtstart) return null;

    const start = parseICSDate(dtstart);
    if (!start) return null;

    let duration = 60;
    if (dtend) {
      const end = parseICSDate(dtend);
      if (end) {
        duration = Math.round((end.getTime() - start.getTime()) / 60000);
        if (duration <= 0) duration = 60;
      }
    }

    return {
      title: summary.replace(/\\,/g, ",").replace(/\\n/g, " "),
      date: formatDate(start),
      time: formatTime(start),
      duration,
      source: "ics",
      emailSubject: email.subject,
      emailFrom: email.from,
      confidence: "high",
      location: location?.replace(/\\,/g, ",").replace(/\\n/g, ", "),
    };
  } catch {
    return null;
  }
}

function parseICSDate(str: string): Date | null {
  // Format: 20260210T140000Z or 20260210T140000
  const match = str.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
  if (!match) return null;

  const [, y, m, d, hh, mm, ss] = match;
  const isUTC = str.endsWith("Z");

  if (isUTC) {
    return new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
  }
  return new Date(+y, +m - 1, +d, +hh, +mm, +ss);
}

// ============================================================
// EMAIL BODY PARSING
// ============================================================

/** Quick check if an email looks like it might contain an event */
function isEventLikeEmail(email: EmailDetail): boolean {
  const text = `${email.subject} ${email.body}`.toLowerCase();

  const eventPatterns = [
    /meeting\s+(with|at|on|scheduled)/,
    /you'?re?\s+invited/,
    /invitation\s+to/,
    /calendar\s+invite/,
    /appointment\s+(confirmed|scheduled|reminder)/,
    /booking\s+(confirmed|confirmation|reference)/,
    /reservation\s+(confirmed|confirmation|details)/,
    /flight\s+(confirmation|itinerary|booking|details)/,
    /hotel\s+(confirmation|reservation|booking)/,
    /check[- ]?in\s+(date|time)/,
    /departure|arrival/,
    /webinar|conference|event|workshop|seminar/,
    /join\s+(us|me|the)\s+(at|on|for)/,
    /rsvp/,
    /save\s+the\s+date/,
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b.*\b\d{1,2}:\d{2}\b/, // date + time pattern
  ];

  return eventPatterns.some((p) => p.test(text));
}

/** Extract event details from an email body using pattern matching */
function parseEmailForEvent(email: EmailDetail): ProposedEvent | null {
  const text = `${email.subject}\n${email.body}`;

  // Try to extract date
  const dateResult = extractDate(text);
  if (!dateResult) return null;

  // Try to extract time
  const timeResult = extractTime(text);
  if (!timeResult) return null;

  // Build title from subject (cleaned up)
  const title = cleanEventTitle(email.subject);

  // Try to detect duration from keywords
  const duration = extractDuration(text);

  // Try to detect location
  const location = extractLocation(text);

  return {
    title,
    date: dateResult,
    time: timeResult,
    duration,
    source: "email",
    emailSubject: email.subject,
    emailFrom: email.from,
    confidence: assessConfidence(text),
    location,
  };
}

/** Extract a date from text, returning YYYY-MM-DD */
function extractDate(text: string): string | null {
  const now = new Date();
  const currentYear = now.getFullYear();

  // Pattern: February 10, 2026 / Feb 10, 2026
  const monthNameMatch = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[.,]?\s+(\d{1,2})(?:st|nd|rd|th)?[.,]?\s*(\d{4})?\b/i
  );
  if (monthNameMatch) {
    const month = parseMonth(monthNameMatch[1]);
    const day = parseInt(monthNameMatch[2]);
    const year = monthNameMatch[3] ? parseInt(monthNameMatch[3]) : currentYear;
    if (month >= 0 && day >= 1 && day <= 31) {
      return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Pattern: 02/10/2026 or 2/10/26
  const slashMatch = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (slashMatch) {
    let month = parseInt(slashMatch[1]);
    let day = parseInt(slashMatch[2]);
    let year = parseInt(slashMatch[3]);
    if (year < 100) year += 2000;

    // Validate
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Pattern: 2026-02-10 (ISO)
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return isoMatch[0];
  }

  // Relative dates
  const lower = text.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    const tmrw = new Date(now);
    tmrw.setDate(tmrw.getDate() + 1);
    return formatDate(tmrw);
  }
  if (/\btoday\b/.test(lower)) {
    return formatDate(now);
  }

  return null;
}

/** Extract time from text, returning HH:MM (24h) */
function extractTime(text: string): string | null {
  // Pattern: 2:00 PM, 14:00, 2:30pm
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?\b/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const ampm = timeMatch[3]?.toLowerCase();

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  // Pattern: 2 PM, 2PM
  const hourOnlyMatch = text.match(/\b(\d{1,2})\s*(am|pm|AM|PM)\b/);
  if (hourOnlyMatch) {
    let hours = parseInt(hourOnlyMatch[1]);
    const ampm = hourOnlyMatch[2].toLowerCase();

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    return `${String(hours).padStart(2, "0")}:00`;
  }

  return null;
}

/** Try to detect event duration from text */
function extractDuration(text: string): number {
  const lower = text.toLowerCase();

  // "1 hour", "2 hours", "1.5 hours"
  const hourMatch = lower.match(/(\d+(?:\.\d+)?)\s*hours?\b/);
  if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);

  // "30 minutes", "90 min"
  const minMatch = lower.match(/(\d+)\s*(?:minutes?|mins?)\b/);
  if (minMatch) return parseInt(minMatch[1]);

  // Flight durations tend to be longer
  if (/flight|departure|arrival/i.test(lower)) return 180;

  // Default
  return 60;
}

/** Try to extract a location */
function extractLocation(text: string): string | undefined {
  // "Location: ..." or "Where: ..."
  const locMatch = text.match(/(?:location|where|venue|place|address):\s*(.+?)(?:\n|$)/i);
  if (locMatch) return locMatch[1].trim().substring(0, 100);

  // "at [Place Name]" — only if it looks like a proper noun
  const atMatch = text.match(/\bat\s+([A-Z][A-Za-z\s]+(?:Hotel|Center|Centre|Office|Airport|Room|Suite|Building|Conference|Hall|Studio))/);
  if (atMatch) return atMatch[1].trim();

  return undefined;
}

/** Clean email subject into an event title */
function cleanEventTitle(subject: string): string {
  return subject
    .replace(/^(re:|fwd?:|fw:)\s*/gi, "")
    .replace(/\[.*?\]\s*/g, "")
    .trim()
    .substring(0, 80);
}

/** Assess confidence level based on content patterns */
function assessConfidence(text: string): "high" | "medium" | "low" {
  const lower = text.toLowerCase();

  // High confidence: explicit calendar/meeting language
  if (/calendar\s*invite|\.ics|invitation\s+to\s+.*meeting|you'?re\s+invited/i.test(lower)) {
    return "high";
  }

  // High confidence: booking confirmations with ref numbers
  if (/(?:booking|reservation|confirmation)\s*(?:#|number|ref|code)/i.test(lower)) {
    return "high";
  }

  // Medium: has both a date and time clearly
  if (/\d{1,2}:\d{2}/.test(text) && /\b\d{4}\b/.test(text)) {
    return "medium";
  }

  return "low";
}

// ============================================================
// HELPERS
// ============================================================

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

function parseMonth(name: string): number {
  return MONTHS[name.toLowerCase()] ?? -1;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
