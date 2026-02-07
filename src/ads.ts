/**
 * Ads — Meta Marketing API + Google Ads integration
 * Fetches spend/performance data, detects anomalies, provides context for Raya.
 */

import { GEMINI_API_KEY } from "./config";
import { sendTelegramText } from "./telegram";

// ============================================================
// CONFIG
// ============================================================

// Meta Marketing API
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Google Ads REST API
const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
const GOOGLE_ADS_CUSTOMER_IDS = (process.env.GOOGLE_ADS_CUSTOMER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GOOGLE_ADS_REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN || "";
const GOOGLE_ADS_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || "";
const GOOGLE_ADS_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
const GOOGLE_ADS_LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "";

export const META_ADS_ENABLED = !!(META_ACCESS_TOKEN && META_AD_ACCOUNT_IDS.length > 0);
export const GOOGLE_ADS_ENABLED = !!(
  GOOGLE_ADS_DEVELOPER_TOKEN &&
  GOOGLE_ADS_CUSTOMER_IDS.length > 0 &&
  GOOGLE_ADS_REFRESH_TOKEN &&
  GOOGLE_ADS_CLIENT_ID &&
  GOOGLE_ADS_CLIENT_SECRET
);
export const ADS_ENABLED = META_ADS_ENABLED || GOOGLE_ADS_ENABLED;

// Anomaly thresholds
const SPEND_SPIKE_THRESHOLD = 1.5;    // 50% above 7-day average
const SPEND_DROP_THRESHOLD = 0.3;     // 70% below 7-day average (could be paused)
const PERF_DROP_THRESHOLD = 0.7;      // 30% below average CTR/conversion rate

// ============================================================
// TYPES
// ============================================================

interface AdMetrics {
  platform: "meta" | "google";
  accountId: string;
  accountName?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number;
  cpm: number;
  ctr: number;
  conversionRate: number;
}

interface AnomalyAlert {
  platform: string;
  accountId: string;
  type: "spend_spike" | "spend_drop" | "zero_spend" | "perf_drop" | "perf_spike";
  metric: string;
  current: number;
  average: number;
  severity: "warning" | "critical";
  message: string;
}

// In-memory cache of latest metrics + history
let latestMetrics: AdMetrics[] = [];
let metricsHistory: Map<string, AdMetrics[]> = new Map(); // key: "platform:accountId"
let latestAlerts: AnomalyAlert[] = [];
let lastAdCheck: Date | null = null;

// ============================================================
// GOOGLE ADS: OAuth2 token refresh
// ============================================================

let googleAdsAccessToken = "";
let googleAdsTokenExpiry = 0;

async function getGoogleAdsToken(): Promise<string> {
  if (googleAdsAccessToken && Date.now() < googleAdsTokenExpiry) {
    return googleAdsAccessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_ADS_CLIENT_ID,
      client_secret: GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Google Ads token refresh error:", err);
    throw new Error("Failed to refresh Google Ads token");
  }

  const data = await res.json();
  googleAdsAccessToken = data.access_token;
  googleAdsTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return googleAdsAccessToken;
}

// ============================================================
// META MARKETING API
// ============================================================

async function fetchMetaInsights(accountId: string, datePreset: string): Promise<AdMetrics | null> {
  try {
    const fields = "spend,impressions,clicks,cpc,cpm,ctr,actions";
    const url = `https://graph.facebook.com/v21.0/act_${accountId}/insights?fields=${fields}&date_preset=${datePreset}&access_token=${META_ACCESS_TOKEN}`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error(`Meta API error (${accountId}):`, err);
      return null;
    }

    const data = await res.json();
    const row = data?.data?.[0];
    if (!row) return null;

    const conversions = (row.actions || [])
      .filter((a: { action_type: string }) =>
        ["offsite_conversion", "lead", "purchase", "complete_registration"].includes(a.action_type)
      )
      .reduce((sum: number, a: { value: string }) => sum + parseFloat(a.value || "0"), 0);

    const spend = parseFloat(row.spend || "0");
    const impressions = parseInt(row.impressions || "0");
    const clicks = parseInt(row.clicks || "0");

    return {
      platform: "meta",
      accountId,
      date: datePreset === "today" ? new Date().toISOString().split("T")[0] : datePreset,
      spend,
      impressions,
      clicks,
      conversions,
      cpc: parseFloat(row.cpc || "0"),
      cpm: parseFloat(row.cpm || "0"),
      ctr: parseFloat(row.ctr || "0"),
      conversionRate: clicks > 0 ? (conversions / clicks) * 100 : 0,
    };
  } catch (error) {
    console.error(`Meta fetch error (${accountId}):`, error);
    return null;
  }
}

async function fetchMetaHistory(accountId: string): Promise<AdMetrics[]> {
  try {
    const fields = "spend,impressions,clicks,cpc,cpm,ctr,actions";
    const url = `https://graph.facebook.com/v21.0/act_${accountId}/insights?fields=${fields}&date_preset=last_7d&time_increment=1&access_token=${META_ACCESS_TOKEN}`;

    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    return (data?.data || []).map((row: Record<string, string | Array<{ action_type: string; value: string }>>) => {
      const conversions = (row.actions as Array<{ action_type: string; value: string }> || [])
        .filter((a) =>
          ["offsite_conversion", "lead", "purchase", "complete_registration"].includes(a.action_type)
        )
        .reduce((sum, a) => sum + parseFloat(a.value || "0"), 0);

      const spend = parseFloat((row.spend as string) || "0");
      const clicks = parseInt((row.clicks as string) || "0");

      return {
        platform: "meta" as const,
        accountId,
        date: row.date_start as string,
        spend,
        impressions: parseInt((row.impressions as string) || "0"),
        clicks,
        conversions,
        cpc: parseFloat((row.cpc as string) || "0"),
        cpm: parseFloat((row.cpm as string) || "0"),
        ctr: parseFloat((row.ctr as string) || "0"),
        conversionRate: clicks > 0 ? (conversions / clicks) * 100 : 0,
      };
    });
  } catch (error) {
    console.error(`Meta history error (${accountId}):`, error);
    return [];
  }
}

// ============================================================
// GOOGLE ADS API
// ============================================================

async function fetchGoogleAdsInsights(customerId: string, date: string): Promise<AdMetrics | null> {
  if (!GOOGLE_ADS_ENABLED) return null;

  try {
    const token = await getGoogleAdsToken();
    const cleanId = customerId.replace(/-/g, "");

    const query = `
      SELECT
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_per_click,
        metrics.ctr,
        metrics.conversions_from_interactions_rate
      FROM customer
      WHERE segments.date = '${date}'
    `;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": GOOGLE_ADS_DEVELOPER_TOKEN,
      "Content-Type": "application/json",
    };
    if (GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers["login-customer-id"] = GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
    }

    const res = await fetch(
      `https://googleads.googleapis.com/v17/customers/${cleanId}/googleAds:searchStream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`Google Ads API error (${customerId}):`, err);
      return null;
    }

    const data = await res.json();
    const results = data?.[0]?.results;
    if (!results || results.length === 0) return null;

    const m = results[0].metrics;
    const spend = (parseInt(m.costMicros || "0") / 1_000_000);
    const impressions = parseInt(m.impressions || "0");
    const clicks = parseInt(m.clicks || "0");
    const conversions = parseFloat(m.conversions || "0");

    return {
      platform: "google",
      accountId: customerId,
      date,
      spend,
      impressions,
      clicks,
      conversions,
      cpc: spend / Math.max(clicks, 1),
      cpm: (spend / Math.max(impressions, 1)) * 1000,
      ctr: parseFloat(m.ctr || "0") * 100,
      conversionRate: parseFloat(m.conversionsFromInteractionsRate || "0") * 100,
    };
  } catch (error) {
    console.error(`Google Ads fetch error (${customerId}):`, error);
    return null;
  }
}

async function fetchGoogleAdsHistory(customerId: string): Promise<AdMetrics[]> {
  if (!GOOGLE_ADS_ENABLED) return [];

  try {
    const token = await getGoogleAdsToken();
    const cleanId = customerId.replace(/-/g, "");

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const query = `
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_per_click,
        metrics.ctr,
        metrics.conversions_from_interactions_rate
      FROM customer
      WHERE segments.date BETWEEN '${startDate.toISOString().split("T")[0]}' AND '${endDate.toISOString().split("T")[0]}'
    `;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": GOOGLE_ADS_DEVELOPER_TOKEN,
      "Content-Type": "application/json",
    };
    if (GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers["login-customer-id"] = GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
    }

    const res = await fetch(
      `https://googleads.googleapis.com/v17/customers/${cleanId}/googleAds:searchStream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const results = data?.[0]?.results || [];

    return results.map((r: { segments: { date: string }; metrics: Record<string, string> }) => {
      const m = r.metrics;
      const spend = parseInt(m.costMicros || "0") / 1_000_000;
      const impressions = parseInt(m.impressions || "0");
      const clicks = parseInt(m.clicks || "0");
      const conversions = parseFloat(m.conversions || "0");

      return {
        platform: "google" as const,
        accountId: customerId,
        date: r.segments.date,
        spend,
        impressions,
        clicks,
        conversions,
        cpc: spend / Math.max(clicks, 1),
        cpm: (spend / Math.max(impressions, 1)) * 1000,
        ctr: parseFloat(m.ctr || "0") * 100,
        conversionRate: parseFloat(m.conversionsFromInteractionsRate || "0") * 100,
      };
    });
  } catch (error) {
    console.error(`Google Ads history error (${customerId}):`, error);
    return [];
  }
}

// ============================================================
// ANOMALY DETECTION
// ============================================================

function detectAnomalies(current: AdMetrics, history: AdMetrics[]): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];
  if (history.length < 2) return alerts; // Not enough data

  const avgSpend = history.reduce((s, h) => s + h.spend, 0) / history.length;
  const avgCtr = history.reduce((s, h) => s + h.ctr, 0) / history.length;
  const avgConvRate = history.reduce((s, h) => s + h.conversionRate, 0) / history.length;
  const platformLabel = current.platform === "meta" ? "Meta" : "Google Ads";

  // Zero spend when average is significant
  if (current.spend === 0 && avgSpend > 10) {
    alerts.push({
      platform: platformLabel,
      accountId: current.accountId,
      type: "zero_spend",
      metric: "spend",
      current: 0,
      average: avgSpend,
      severity: "critical",
      message: `${platformLabel} account ${current.accountId}: $0 spend today (avg: $${avgSpend.toFixed(0)}/day). Campaigns may be paused or billing issue.`,
    });
  }

  // Spend spike
  if (avgSpend > 0 && current.spend / avgSpend > SPEND_SPIKE_THRESHOLD) {
    alerts.push({
      platform: platformLabel,
      accountId: current.accountId,
      type: "spend_spike",
      metric: "spend",
      current: current.spend,
      average: avgSpend,
      severity: "warning",
      message: `${platformLabel} account ${current.accountId}: Spend is $${current.spend.toFixed(0)} today (${Math.round((current.spend / avgSpend) * 100)}% of avg $${avgSpend.toFixed(0)}/day).`,
    });
  }

  // Spend drop (but not zero — that's caught above)
  if (avgSpend > 10 && current.spend > 0 && current.spend / avgSpend < SPEND_DROP_THRESHOLD) {
    alerts.push({
      platform: platformLabel,
      accountId: current.accountId,
      type: "spend_drop",
      metric: "spend",
      current: current.spend,
      average: avgSpend,
      severity: "warning",
      message: `${platformLabel} account ${current.accountId}: Spend is only $${current.spend.toFixed(0)} today (avg: $${avgSpend.toFixed(0)}/day). Some campaigns may be underdelivering.`,
    });
  }

  // CTR drop (only if meaningful volume)
  if (avgCtr > 0.5 && current.impressions > 100 && current.ctr / avgCtr < PERF_DROP_THRESHOLD) {
    alerts.push({
      platform: platformLabel,
      accountId: current.accountId,
      type: "perf_drop",
      metric: "CTR",
      current: current.ctr,
      average: avgCtr,
      severity: "warning",
      message: `${platformLabel} account ${current.accountId}: CTR dropped to ${current.ctr.toFixed(2)}% (avg: ${avgCtr.toFixed(2)}%). Ads may be fatiguing.`,
    });
  }

  // Conversion rate drop
  if (avgConvRate > 0.5 && current.clicks > 20 && current.conversionRate / avgConvRate < PERF_DROP_THRESHOLD) {
    alerts.push({
      platform: platformLabel,
      accountId: current.accountId,
      type: "perf_drop",
      metric: "conversion rate",
      current: current.conversionRate,
      average: avgConvRate,
      severity: "warning",
      message: `${platformLabel} account ${current.accountId}: Conversion rate dropped to ${current.conversionRate.toFixed(2)}% (avg: ${avgConvRate.toFixed(2)}%).`,
    });
  }

  return alerts;
}

// ============================================================
// MAIN: Check all ad platforms
// ============================================================

export async function checkAdPerformance(): Promise<void> {
  if (!ADS_ENABLED) return;

  try {
    const today = new Date().toISOString().split("T")[0];
    const allMetrics: AdMetrics[] = [];
    const allAlerts: AnomalyAlert[] = [];

    // Meta accounts
    if (META_ADS_ENABLED) {
      for (const accountId of META_AD_ACCOUNT_IDS) {
        const [todayMetrics, history] = await Promise.all([
          fetchMetaInsights(accountId, "today"),
          fetchMetaHistory(accountId),
        ]);

        if (todayMetrics) {
          allMetrics.push(todayMetrics);
          metricsHistory.set(`meta:${accountId}`, history);
          allAlerts.push(...detectAnomalies(todayMetrics, history));
        }
      }
    }

    // Google Ads accounts
    if (GOOGLE_ADS_ENABLED) {
      for (const customerId of GOOGLE_ADS_CUSTOMER_IDS) {
        const [todayMetrics, history] = await Promise.all([
          fetchGoogleAdsInsights(customerId, today),
          fetchGoogleAdsHistory(customerId),
        ]);

        if (todayMetrics) {
          allMetrics.push(todayMetrics);
          metricsHistory.set(`google:${customerId}`, history);
          allAlerts.push(...detectAnomalies(todayMetrics, history));
        }
      }
    }

    latestMetrics = allMetrics;
    latestAlerts = allAlerts;
    lastAdCheck = new Date();

    // Send critical alerts via Telegram immediately
    const criticalAlerts = allAlerts.filter((a) => a.severity === "critical");
    if (criticalAlerts.length > 0) {
      const alertMsg = criticalAlerts.map((a) => `⚠️ ${a.message}`).join("\n\n");
      await sendTelegramText(`AD ALERT:\n\n${alertMsg}`);
      console.log(`Ad alerts sent: ${criticalAlerts.length} critical`);
    }

    const totalSpend = allMetrics.reduce((s, m) => s + m.spend, 0);
    console.log(
      `Ad check complete: ${allMetrics.length} accounts, $${totalSpend.toFixed(0)} total spend, ${allAlerts.length} alerts`
    );
  } catch (error) {
    console.error("checkAdPerformance error:", error);
  }
}

// ============================================================
// CONTEXT: For buildPrompt and check-ins
// ============================================================

export function getAdsContext(): string {
  if (!ADS_ENABLED || latestMetrics.length === 0) return "";

  const lines: string[] = [];
  lines.push("\nAD PERFORMANCE (today so far):");

  for (const m of latestMetrics) {
    const platform = m.platform === "meta" ? "Meta" : "Google Ads";
    lines.push(
      `- ${platform} (${m.accountId}): $${m.spend.toFixed(0)} spend | ${m.impressions.toLocaleString()} impr | ${m.clicks} clicks | ${m.conversions.toFixed(0)} conv | ${m.ctr.toFixed(2)}% CTR | $${m.cpc.toFixed(2)} CPC`
    );
  }

  const totalSpend = latestMetrics.reduce((s, m) => s + m.spend, 0);
  const totalConv = latestMetrics.reduce((s, m) => s + m.conversions, 0);
  if (latestMetrics.length > 1) {
    lines.push(`- TOTAL: $${totalSpend.toFixed(0)} spend | ${totalConv.toFixed(0)} conversions`);
  }

  if (latestAlerts.length > 0) {
    lines.push("");
    lines.push("AD ALERTS:");
    for (const a of latestAlerts) {
      const icon = a.severity === "critical" ? "🔴" : "🟡";
      lines.push(`${icon} ${a.message}`);
    }
  }

  if (lastAdCheck) {
    const minsAgo = Math.round((Date.now() - lastAdCheck.getTime()) / 60000);
    lines.push(`(Last checked ${minsAgo} min ago)`);
  }

  return lines.join("\n");
}

// ============================================================
// SMART SUMMARY: Use Gemini for natural-language ad analysis
// ============================================================

export async function getAdsSummary(): Promise<string> {
  if (!ADS_ENABLED || latestMetrics.length === 0 || !GEMINI_API_KEY) {
    return getAdsContext(); // Fall back to raw metrics
  }

  try {
    const metricsJson = JSON.stringify(latestMetrics, null, 2);
    const alertsJson = JSON.stringify(latestAlerts, null, 2);

    // Get history for comparison
    const historyLines: string[] = [];
    for (const [key, history] of metricsHistory) {
      if (history.length > 0) {
        const avgSpend = history.reduce((s, h) => s + h.spend, 0) / history.length;
        const avgConv = history.reduce((s, h) => s + h.conversions, 0) / history.length;
        historyLines.push(`${key}: avg $${avgSpend.toFixed(0)}/day, ${avgConv.toFixed(1)} conv/day (7-day)`);
      }
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a performance marketing analyst. Summarize these ad metrics in 3-5 concise bullet points. Focus on what matters: spend pacing, performance vs average, any alerts, and actionable insights.

TODAY'S METRICS:
${metricsJson}

7-DAY AVERAGES:
${historyLines.join("\n")}

ALERTS:
${alertsJson}

Be direct and business-focused. Use dollars and percentages. No fluff.`,
            }],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
        }),
      }
    );

    if (!res.ok) return getAdsContext();

    const data = await res.json();
    const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return summary ? `\nAD PERFORMANCE SUMMARY:\n${summary}` : getAdsContext();
  } catch {
    return getAdsContext();
  }
}

// ============================================================
// API DATA: For dashboard
// ============================================================

export function getAdsData(): {
  metrics: AdMetrics[];
  alerts: AnomalyAlert[];
  lastCheck: string | null;
  metaEnabled: boolean;
  googleEnabled: boolean;
} {
  return {
    metrics: latestMetrics,
    alerts: latestAlerts,
    lastCheck: lastAdCheck?.toISOString() || null,
    metaEnabled: META_ADS_ENABLED,
    googleEnabled: GOOGLE_ADS_ENABLED,
  };
}
