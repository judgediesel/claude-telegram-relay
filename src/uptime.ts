/**
 * Uptime Monitor — checks critical sites every 30 minutes
 * Only alerts via Telegram when a site is DOWN or recovers.
 * Silent when everything is healthy.
 */

import { sendTelegramText } from "./telegram";

// Sites to monitor
const MONITORED_SITES = [
  "https://focusgrouppanel.com",
  "https://enroll.focusgrouppanel.com",
  "https://maxionresearch.com",
  "https://enroll.maxionresearch.com",
];

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REQUEST_TIMEOUT_MS = 15_000; // 15 second timeout per request

// Track which sites are currently down (to avoid repeat alerts)
const downSites = new Set<string>();

async function checkSite(url: string): Promise<{ url: string; ok: boolean; status?: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "RayaUptimeMonitor/1.0" },
    });

    clearTimeout(timeout);

    // Accept any 2xx or 3xx as "up"
    if (res.status >= 200 && res.status < 400) {
      return { url, ok: true, status: res.status };
    }
    return { url, ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, ok: false, error: message };
  }
}

async function runUptimeChecks(): Promise<void> {
  const results = await Promise.all(MONITORED_SITES.map(checkSite));

  const newlyDown: string[] = [];
  const recovered: string[] = [];

  for (const result of results) {
    if (!result.ok) {
      // Site is down
      if (!downSites.has(result.url)) {
        // First time detecting this outage
        newlyDown.push(`${result.url} — ${result.error}`);
        downSites.add(result.url);
      }
      // If already in downSites, stay silent (already alerted)
    } else {
      // Site is up
      if (downSites.has(result.url)) {
        // Was down, now recovered
        recovered.push(result.url);
        downSites.delete(result.url);
      }
    }
  }

  // Alert on new outages
  if (newlyDown.length > 0) {
    const msg = `SITE DOWN ALERT\n\n${newlyDown.join("\n")}\n\nChecking again in 30 min.`;
    try {
      await sendTelegramText(msg);
    } catch (err) {
      console.error("Failed to send uptime alert:", err);
    }
  }

  // Notify recovery
  if (recovered.length > 0) {
    const msg = `Sites back up:\n${recovered.join("\n")}`;
    try {
      await sendTelegramText(msg);
    } catch (err) {
      console.error("Failed to send recovery alert:", err);
    }
  }

  // Log to console regardless
  const downCount = results.filter((r) => !r.ok).length;
  if (downCount > 0) {
    console.log(`[uptime] ${downCount}/${results.length} sites down: ${results.filter((r) => !r.ok).map((r) => r.url).join(", ")}`);
  } else {
    console.log(`[uptime] All ${results.length} sites healthy`);
  }
}

/** Start the uptime monitor — runs immediately, then every 30 minutes */
export function startUptimeMonitor(): void {
  console.log(`[uptime] Monitoring ${MONITORED_SITES.length} sites every 30 min`);

  // First check after 1 minute (let bot finish starting)
  setTimeout(() => {
    runUptimeChecks();
    setInterval(runUptimeChecks, CHECK_INTERVAL_MS);
  }, 60 * 1000);
}
