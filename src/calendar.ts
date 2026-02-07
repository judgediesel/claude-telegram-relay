/**
 * Google Calendar — read events, create events, event formatting
 */

import { CALENDAR_ENABLED, calendarClient, GOOGLE_CALENDAR_ID } from "./config";

export async function getCalendarContext(): Promise<string> {
  if (!CALENDAR_ENABLED || !calendarClient) return "";

  try {
    const now = new Date();

    // End of tomorrow morning (covers "rest of today" + "first thing tomorrow")
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);

    const res = await calendarClient.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 15,
    });

    const events = res.data.items;
    if (!events || events.length === 0) return "";

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayDate = now.toLocaleDateString("en-US", { timeZone: tz });

    const lines = events.map((ev) => {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime)
        : ev.start?.date
          ? new Date(ev.start.date + "T00:00:00")
          : null;

      const end = ev.end?.dateTime
        ? new Date(ev.end.dateTime)
        : null;

      if (!start) return `- ${ev.summary || "(no title)"}`;

      const isAllDay = !ev.start?.dateTime;
      const eventDate = start.toLocaleDateString("en-US", { timeZone: tz });
      const isTomorrow = eventDate !== todayDate;
      const prefix = isTomorrow ? "Tomorrow " : "";

      if (isAllDay) {
        return `- ${prefix}All day: ${ev.summary || "(no title)"}`;
      }

      const timeStr = start.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      });

      let duration = "";
      if (end) {
        const mins = Math.round((end.getTime() - start.getTime()) / 60000);
        duration = mins >= 60
          ? ` (${Math.floor(mins / 60)} hr${mins >= 120 ? "s" : ""}${mins % 60 ? ` ${mins % 60} min` : ""})`
          : ` (${mins} min)`;
      }

      const location = ev.location ? `, ${ev.location}` : "";

      return `- ${prefix}${timeStr}: ${ev.summary || "(no title)"}${duration}${location}`;
    });

    return `\nUPCOMING CALENDAR:\n${lines.join("\n")}`;
  } catch (error) {
    console.error("getCalendarContext error:", error);
    return "";
  }
}

export async function createCalendarEvent(
  title: string,
  date: string,
  time: string,
  durationMinutes = 60
): Promise<void> {
  if (!calendarClient) {
    console.log("Calendar not connected — cannot create event");
    return;
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Build end time by adding duration to start
    const [hh, mm] = time.split(":").map(Number);
    const totalMin = hh * 60 + mm + durationMinutes;
    const endHH = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const endMM = String(totalMin % 60).padStart(2, "0");
    const endTime = `${endHH}:${endMM}`;

    await calendarClient.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: title,
        start: { dateTime: `${date}T${time}:00`, timeZone: tz },
        end: { dateTime: `${date}T${endTime}:00`, timeZone: tz },
      },
    });

    console.log(`Created calendar event: ${title} on ${date} at ${time}`);
  } catch (error) {
    console.error("createCalendarEvent error:", error);
  }
}
