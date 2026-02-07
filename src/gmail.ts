/**
 * Gmail — email reading across multiple accounts
 */

import { GMAIL_ENABLED, gmailClients } from "./config";

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
