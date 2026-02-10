/**
 * Gmail — email reading across multiple accounts
 */

import { GMAIL_ENABLED, gmailClients } from "./config";

export interface EmailDetail {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  hasICS: boolean;
  icsData: string | null;
  account: string;
}

export async function getEmailContext(): Promise<string> {
  if (!GMAIL_ENABLED || gmailClients.length === 0) return "";

  const sections: string[] = [];

  for (const { label, client } of gmailClients) {
    try {
      const res = await client.users.messages.list({
        userId: "me",
        q: "is:unread -category:promotions -category:social -category:updates",
        maxResults: 5,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) continue;

      const details = await Promise.all(
        messages.slice(0, 5).map(async (msg) => {
          const detail = await client.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });

          const headers = detail.data.payload?.headers || [];
          const from = headers.find((h) => h.name === "From")?.value || "Unknown";
          const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
          const snippet = detail.data.snippet || "";

          const fromClean = from.replace(/<.*>/, "").trim().replace(/"/g, "") || from;

          return `- From: ${fromClean} — ${subject}\n  ${snippet.substring(0, 100)}${snippet.length > 100 ? "..." : ""}`;
        })
      );

      const totalUnread = res.data.resultSizeEstimate || messages.length;
      sections.push(`${label} (${totalUnread} unread):\n${details.join("\n")}`);
    } catch (error) {
      console.error(`getEmailContext error (${label}):`, error);
    }
  }

  if (sections.length === 0) return "";
  return `\nUNREAD EMAILS:\n${sections.join("\n\n")}`;
}

// ============================================================
// FULL EMAIL BODY FETCHING (for email-to-calendar)
// ============================================================

/**
 * Fetch full email details including body and ICS attachments.
 * Used for scanning emails for calendar-worthy events.
 */
export async function getRecentEmailsFull(maxPerAccount = 10): Promise<EmailDetail[]> {
  if (!GMAIL_ENABLED || gmailClients.length === 0) return [];

  const allEmails: EmailDetail[] = [];

  for (const { label, client } of gmailClients) {
    try {
      // Look for unread emails that might contain events
      // Broader query — includes things that might be meetings, flights, bookings
      const res = await client.users.messages.list({
        userId: "me",
        q: "is:unread -category:promotions -category:social newer_than:3d",
        maxResults: maxPerAccount,
      });

      const messages = res.data.messages || [];
      if (messages.length === 0) continue;

      const emails = await Promise.all(
        messages.map(async (msg) => {
          try {
            const detail = await client.users.messages.get({
              userId: "me",
              id: msg.id!,
              format: "full",
            });

            const headers = detail.data.payload?.headers || [];
            const from = headers.find((h) => h.name === "From")?.value || "Unknown";
            const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
            const date = headers.find((h) => h.name === "Date")?.value || "";
            const fromClean = from.replace(/<.*>/, "").trim().replace(/"/g, "") || from;

            // Extract body text
            const body = extractBody(detail.data.payload);

            // Check for ICS calendar attachments
            const { hasICS, icsData } = extractICS(detail.data.payload);

            return {
              id: msg.id!,
              from: fromClean,
              subject,
              date,
              body: body.substring(0, 3000), // Cap at 3k chars to avoid token bloat
              hasICS,
              icsData,
              account: label,
            } as EmailDetail;
          } catch {
            return null;
          }
        })
      );

      allEmails.push(...emails.filter((e): e is EmailDetail => e !== null));
    } catch (error) {
      console.error(`getRecentEmailsFull error (${label}):`, error);
    }
  }

  return allEmails;
}

/** Recursively extract plain text body from a Gmail message payload */
function extractBody(payload: any): string {
  if (!payload) return "";

  // Direct body data
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — recurse into parts
  if (payload.parts) {
    // Prefer text/plain, fall back to text/html (stripped)
    const plainPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plainPart?.body?.data) {
      return decodeBase64Url(plainPart.body.data);
    }

    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return stripHtml(decodeBase64Url(htmlPart.body.data));
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  // Fallback: if body has data at top level
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

/** Look for ICS calendar attachments in email parts */
function extractICS(payload: any): { hasICS: boolean; icsData: string | null } {
  if (!payload) return { hasICS: false, icsData: null };

  // Check this part
  if (
    (payload.mimeType === "text/calendar" || payload.mimeType === "application/ics") &&
    payload.body?.data
  ) {
    return { hasICS: true, icsData: decodeBase64Url(payload.body.data) };
  }

  // Recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      // Check by filename too
      const filename = part.filename || "";
      if (
        part.mimeType === "text/calendar" ||
        part.mimeType === "application/ics" ||
        filename.endsWith(".ics")
      ) {
        if (part.body?.data) {
          return { hasICS: true, icsData: decodeBase64Url(part.body.data) };
        }
        // ICS might be an attachment that needs separate fetch — mark it
        return { hasICS: true, icsData: null };
      }

      const nested = extractICS(part);
      if (nested.hasICS) return nested;
    }
  }

  return { hasICS: false, icsData: null };
}

/** Decode Gmail's base64url encoding */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/** Strip HTML tags to get plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
