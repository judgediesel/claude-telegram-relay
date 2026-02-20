/**
 * Scheduled check-ins, daily briefing, end-of-day recap, reminders, post-meeting debrief
 */

import {
  CHECKIN_ENABLED,
  CALENDAR_ENABLED,
  TWILIO_ENABLED,
  TWILIO_PUBLIC_URL,
  DAILY_BRIEFING_HOUR,
  END_OF_DAY_HOUR,
  RAYA_SYSTEM_PROMPT,
  calendarClient,
  GOOGLE_CALENDAR_ID,
  getAllCalendarIds,
  personalCalendarClient,
  resolveCalendarId,
} from "./config";
import { getMemoryContext, getTodoContext, getHabitContext, getContactContext, logCheckin, getLastCheckinTime, storeMessage, getHabitAnalytics } from "./memory";
import { getCalendarContext } from "./calendar";
import { getEmailContext } from "./gmail";
import { getWeatherContext } from "./search";
import { getAdsContext, ADS_ENABLED } from "./ads";
import { callClaude } from "./claude";
import { processIntents } from "./intents";
import { sendTelegramText } from "./telegram";
import { makeCall } from "./twilio";
import { scanEmailsForEvents } from "./email-calendar";
import { GMAIL_ENABLED } from "./config";

// ============================================================
// SCHEDULED CHECK-INS
// ============================================================

// Hard cap: max 3 check-ins per day (code-enforced, not just prompt guidance)
let checkinCountToday = 0;
let checkinCountDate = "";

function getCheckinDate(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

export async function runCheckin(): Promise<void> {
  if (!CHECKIN_ENABLED) return;

  // Reset counter at midnight
  const today = getCheckinDate();
  if (today !== checkinCountDate) {
    checkinCountToday = 0;
    checkinCountDate = today;
  }

  // Hard cap: no more than 3 check-ins per day
  if (checkinCountToday >= 3) {
    console.log(`Check-in skipped: already sent ${checkinCountToday} today (max 3)`);
    return;
  }

  try {
    const [memoryContext, calendarContext, todoContext, habitContext, emailContext] = await Promise.all([
      getMemoryContext(),
      getCalendarContext(),
      getTodoContext(),
      getHabitContext(),
      getEmailContext(),
    ]);
    const adsContext = ADS_ENABLED ? getAdsContext() : "";
    const lastCheckin = await getLastCheckinTime();

    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const lastCheckinStr = lastCheckin
      ? new Date(lastCheckin).toLocaleString("en-US", {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Never";

    const prompt = `
${RAYA_SYSTEM_PROMPT}
You are considering whether to send a check-in message to Mark via Telegram.

CURRENT TIME: ${timeStr}
LAST CHECK-IN: ${lastCheckinStr}
CHECK-INS SENT TODAY: ${checkinCountToday} of 3 max
${memoryContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}
${adsContext}

RULES:
1. STRICT MAX: Only 3 check-ins per day. You've already sent ${checkinCountToday} today. If you've sent 2+, you need a VERY strong reason for another. Default to NO.
2. Do NOT send schedule/calendar updates as check-ins. Mark already gets a morning briefing with the full schedule and 2-minute-before meeting alerts. Only mention calendar events if something changed unexpectedly or needs action.
3. Only check in if there's a genuine REASON — a goal deadline approaching, a todo with an upcoming due date, a habit not yet done today, an important unread email, a meaningful follow-up, or something truly noteworthy. NOT just "here's what's coming up."
4. Consider time of day. Late night or very early morning — probably NO.
5. Be brief, warm, and direct. Not robotic. Not annoying. Sound like a trusted friend.
6. If you have nothing NEW or ACTIONABLE to say, say NO. Repeating the same schedule info is not a reason.
7. Never mention that you're an AI deciding whether to check in. Just be natural.
8. If a habit hasn't been done today, gently nudge — don't lecture.
9. Remember Mark has ADD — help him stay focused. If he has todos piling up, help prioritize.
10. URGENCY: If something is truly time-critical (meeting in <10 min, critical deadline today), set ESCALATE to CALL. Otherwise ESCALATE should be NONE.
11. If ad performance data is available, flag anomalies — zero spend, spend spikes, or major performance drops are worth mentioning.

RESPOND IN THIS EXACT FORMAT (no extra text):
DECISION: YES or NO
REASON: [Why you decided this — one sentence]
ESCALATE: NONE or CALL
MESSAGE: [Your message to the user if YES, or "none" if NO]
`.trim();

    console.log("Running scheduled check-in evaluation...");
    const response = await callClaude(prompt);

    // Parse structured response
    const decisionMatch = response.match(/DECISION:\s*(YES|NO)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)(?=\nMESSAGE:)/is);
    const messageMatch = response.match(/MESSAGE:\s*(.+)/is);

    const decision = decisionMatch?.[1]?.toUpperCase() || "NO";
    const reason = reasonMatch?.[1]?.trim() || "Could not parse reason";
    const message = messageMatch?.[1]?.trim() || "";

    console.log(`Check-in decision: ${decision} — ${reason}`);

    if (decision === "YES" && message && message.toLowerCase() !== "none") {
      const escalateMatch = response.match(/ESCALATE:\s*(NONE|CALL)/i);
      const escalate = escalateMatch?.[1]?.toUpperCase() || "NONE";

      checkinCountToday++;
      const { cleaned, intents } = processIntents(message);
      await Promise.all(intents);
      await storeMessage("assistant", cleaned, { source: "checkin" });
      await sendTelegramText(cleaned);
      await logCheckin("YES", reason, cleaned);
      console.log(`Check-in sent (${checkinCountToday}/3 today): ${cleaned.substring(0, 80)}...`);

      // Escalate to phone call for urgent items
      if (escalate === "CALL" && TWILIO_ENABLED && TWILIO_PUBLIC_URL) {
        console.log("Escalating check-in to phone call...");
        await makeCall(cleaned);
      }
    } else {
      await logCheckin("NO", reason);
    }
  } catch (error) {
    console.error("runCheckin error:", error);
    // Never crash the bot — just log and continue
  }
}

// ============================================================
// PROACTIVE CALENDAR REMINDERS
// ============================================================

const remindedEvents = new Set<string>();

/** Get the calendar client for a given calendar ID */
function getClientForCalendar(calendarId: string) {
  const personal = resolveCalendarId("personal");
  if (personal && calendarId === personal && personalCalendarClient) {
    return personalCalendarClient;
  }
  return calendarClient;
}

export async function checkUpcomingReminders(): Promise<void> {
  if (!CALENDAR_ENABLED || !calendarClient) return;

  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 60000); // 3 min from now (catch 2-min window)

    // Check all configured calendars for upcoming events
    for (const { id } of getAllCalendarIds()) {
      const client = getClientForCalendar(id);
      if (!client) continue;

      try {
        const res = await client.events.list({
          calendarId: id,
          timeMin: now.toISOString(),
          timeMax: soon.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = res.data.items || [];
        for (const ev of events) {
          const eventId = ev.id!;
          if (remindedEvents.has(eventId)) continue;

          const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
          if (!start) continue;

          const minsUntil = Math.round((start.getTime() - now.getTime()) / 60000);
          if (minsUntil <= 2 && minsUntil > 0) {
            remindedEvents.add(eventId);
            const location = ev.location ? ` at ${ev.location}` : "";
            await sendTelegramText(
              `Heads up — "${ev.summary}" starts in ${minsUntil} minute${minsUntil === 1 ? "" : "s"}${location}`
            );
            console.log(`Reminder sent: ${ev.summary} in ${minsUntil} min`);
          }
        }
      } catch (err) {
        console.error(`checkUpcomingReminders error for ${id}:`, err);
      }
    }
  } catch (error) {
    console.error("checkUpcomingReminders error:", error);
  }
}

// ============================================================
// POST-MEETING DEBRIEF
// ============================================================

const debriefedEvents = new Set<string>();

export async function checkPostMeetingDebrief(): Promise<void> {
  if (!CALENDAR_ENABLED || !calendarClient || !CHECKIN_ENABLED) return;

  try {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60000);

    // Check all configured calendars for recently ended events
    for (const { id } of getAllCalendarIds()) {
      const client = getClientForCalendar(id);
      if (!client) continue;

      try {
        const res = await client.events.list({
          calendarId: id,
          timeMin: tenMinAgo.toISOString(),
          timeMax: now.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = res.data.items || [];
        for (const ev of events) {
          const eventId = ev.id!;
          if (debriefedEvents.has(eventId)) continue;

          const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
          if (!end) continue;

          // Only debrief events that actually ended (not ones still running)
          if (end.getTime() > now.getTime()) continue;

          const minsAgo = Math.round((now.getTime() - end.getTime()) / 60000);
          if (minsAgo <= 10 && minsAgo >= 0) {
            debriefedEvents.add(eventId);
            await sendTelegramText(
              `How did "${ev.summary}" go? Anything worth noting or following up on?`
            );
            console.log(`Post-meeting debrief: ${ev.summary}`);
          }
        }
      } catch (err) {
        console.error(`checkPostMeetingDebrief error for ${id}:`, err);
      }
    }
  } catch (error) {
    console.error("checkPostMeetingDebrief error:", error);
  }
}

// ============================================================
// END-OF-DAY RECAP
// ============================================================

let lastRecapDate = "";

export async function checkEndOfDayRecap(): Promise<void> {
  if (!CHECKIN_ENABLED) return;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });
  const hour = now.getHours();

  if (lastRecapDate === todayStr || hour !== END_OF_DAY_HOUR) return;
  if (now.getMinutes() > 30) return;

  lastRecapDate = todayStr;

  try {
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const [memoryContext, todoContext, habitContext, recapEmailContext] = await Promise.all([
      getMemoryContext(),
      getTodoContext(),
      getHabitContext(),
      getEmailContext(),
    ]);

    const adsContext = ADS_ENABLED ? getAdsContext() : "";

    const prompt = `
${RAYA_SYSTEM_PROMPT}
Send Mark his end-of-day recap via Telegram.

CURRENT TIME: ${timeStr}
${memoryContext}
${todoContext}
${habitContext}
${recapEmailContext}
${adsContext}

Include:
- Quick wins — what got done today based on conversation history
- Any todos still pending — help him decide: tackle tonight or defer to tomorrow?
- Habits done/not done today — acknowledge effort, note streaks
- Flag any important unread emails
- Ad performance wrap-up if available — total spend, conversions, any issues flagged today
- Tomorrow's first calendar event (if any) so he can prep
- A warm, genuine sign-off. You know Mark — be real, not generic.
- Keep it concise — 5-10 lines max
- If it was a productive day, celebrate it. If not, no judgment — just help him reset.
`.trim();

    console.log("Sending end-of-day recap...");
    const response = await callClaude(prompt);

    const { cleaned, intents } = processIntents(response);
    await Promise.all(intents);
    await storeMessage("assistant", cleaned, { source: "recap" });
    await sendTelegramText(cleaned);
    await logCheckin("YES", "End-of-day recap", cleaned);
    console.log("End-of-day recap sent");
  } catch (error) {
    console.error("End-of-day recap error:", error);
  }
}

// ============================================================
// DAILY BRIEFING
// ============================================================

let lastBriefingDate = "";

export async function checkDailyBriefing(): Promise<void> {
  if (!CHECKIN_ENABLED) return; // needs memory for context

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayStr = now.toLocaleDateString("en-US", { timeZone: tz });
  const hour = now.getHours();

  // Already sent today, or not briefing hour yet
  if (lastBriefingDate === todayStr || hour !== DAILY_BRIEFING_HOUR) return;

  // Only send within the first 30 min of the hour
  if (now.getMinutes() > 30) return;

  lastBriefingDate = todayStr;

  try {
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const [memoryContext, calendarContext, todoContext, habitContext, emailContext] = await Promise.all([
      getMemoryContext(),
      getCalendarContext(),
      getTodoContext(),
      getHabitContext(),
      getEmailContext(),
    ]);

    const weatherContext = await getWeatherContext();
    const adsContext = ADS_ENABLED ? getAdsContext() : "";

    const prompt = `
${RAYA_SYSTEM_PROMPT}
Send Mark his morning briefing via Telegram.

CURRENT TIME: ${timeStr}
${memoryContext}
${calendarContext}
${todoContext}
${habitContext}
${emailContext}
${weatherContext}
${adsContext}

Include:
- A warm, natural greeting — you know Mark. Be real, not generic.
- Weather outlook if notable (rain, extreme heat, etc.)
- Today's calendar events (if any)
- Top priority todos or goals — help him focus on what matters most today
- Habits and current streaks — brief encouragement
- Flag any important unread emails
- Ad performance summary if available — spend pacing, any alerts (this is his $3M+ business, it matters)
- If it's going to be a heavy day, acknowledge it. If it's light, say so.
- Keep it concise — 5-10 lines max
- Don't list sections if there's nothing to list
- Remember he has ADD — help him prioritize, don't overwhelm
`.trim();

    console.log("Sending daily briefing...");
    const response = await callClaude(prompt);

    const { cleaned, intents } = processIntents(response);
    await Promise.all(intents);
    await storeMessage("assistant", cleaned, { source: "briefing" });
    await sendTelegramText(cleaned);
    await logCheckin("YES", "Daily briefing", cleaned);
    console.log("Daily briefing sent");
  } catch (error) {
    console.error("Daily briefing error:", error);
  }
}

// ============================================================
// WEEKLY HABIT REPORT (Sunday evenings)
// ============================================================

let lastWeeklyReportWeek = "";

export async function checkWeeklyHabitReport(): Promise<void> {
  if (!CHECKIN_ENABLED) return;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const hour = now.getHours();

  // Only send on Sunday between 5-6 PM
  if (dayOfWeek !== 0 || hour !== 17) return;
  if (now.getMinutes() > 30) return;

  // Deduplicate by week number
  const weekNum = `${now.getFullYear()}-W${Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))}`;
  if (lastWeeklyReportWeek === weekNum) return;
  lastWeeklyReportWeek = weekNum;

  try {
    const analytics = await getHabitAnalytics();
    if (analytics.length === 0) return;

    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    // Build structured data for Claude
    const habitData = analytics.map((h) => {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const weekViz = h.weekHistory.map((done, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        return `${days[d.getDay()]}: ${done ? "✓" : "✗"}`;
      }).reverse().join(", ");

      return `- ${h.content} (${h.frequency}): ${h.completionRate7d}% this week | streak: ${h.currentStreak} (best: ${h.bestStreak}) | ${weekViz}${h.optimalHour !== null ? ` | usually done around ${h.optimalHour}:00` : ""}`;
    }).join("\n");

    const avgRate = Math.round(analytics.reduce((s, h) => s + h.completionRate7d, 0) / analytics.length);

    const prompt = `
${RAYA_SYSTEM_PROMPT}
Send Mark his weekly habit report. Today is ${timeStr}.

HABIT PERFORMANCE THIS WEEK:
${habitData}

OVERALL: ${avgRate}% average completion rate across ${analytics.length} habits

Write a brief, warm weekly habit report (5-8 lines). Include:
- Overall score and how this week went
- Call out wins — any strong streaks or consistent habits
- Gently flag habits that need attention (low completion rate)
- If a habit has an optimal time pattern, mention it as a tip
- If a best streak was broken, acknowledge it without guilt
- End with a motivating thought for next week
- Remember Mark has ADD — frame it as progress, not perfection
- Don't be preachy about health/habits. Celebrate effort.
`.trim();

    console.log("Sending weekly habit report...");
    const response = await callClaude(prompt);

    const { cleaned, intents } = processIntents(response);
    await Promise.all(intents);
    await storeMessage("assistant", cleaned, { source: "weekly_habit_report" });
    await sendTelegramText(cleaned);
    await logCheckin("YES", "Weekly habit report", cleaned);
    console.log("Weekly habit report sent");
  } catch (error) {
    console.error("Weekly habit report error:", error);
  }
}

// ============================================================
// SCHEDULED EMAIL-TO-CALENDAR SCAN
// Runs at 7am, 9am, 11am, 1pm, 3pm — scans emails for events
// ============================================================

const EMAIL_SCAN_HOURS = [7, 9, 11, 13, 15];
let lastEmailScanHour = -1;

export async function checkScheduledEmailScan(): Promise<void> {
  if (!GMAIL_ENABLED || !CALENDAR_ENABLED) return;

  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Only run during scan hours, within first 5 minutes of the hour
  if (!EMAIL_SCAN_HOURS.includes(hour)) return;
  if (minute > 5) return;
  if (lastEmailScanHour === hour) return;

  lastEmailScanHour = hour;

  try {
    console.log(`Scheduled email scan (${hour}:00)...`);
    const result = await scanEmailsForEvents();

    // Only notify if we found events
    if (result.includes("potential calendar event")) {
      await storeMessage("assistant", result, { source: "email_scan" });
      await sendTelegramText(result);
      console.log("Email scan: events found and sent to Telegram");
    } else {
      console.log(`Email scan: ${result}`);
    }
  } catch (error) {
    console.error("Scheduled email scan error:", error);
  }
}
