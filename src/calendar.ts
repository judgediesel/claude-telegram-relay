/**
 * Google Calendar — read events, create/update/delete events, event formatting
 */

import { CALENDAR_ENABLED, calendarClient, GOOGLE_CALENDAR_ID, resolveCalendarId, getAllCalendarIds, personalCalendarClient } from "./config";

/** Pick the right Google Calendar API client for a given calendar ID */
function getClientForCalendar(calendarId: string) {
  // If personalCalendarClient exists and the ID looks like the personal calendar, use it
  const personal = resolveCalendarId("personal");
  if (personal && calendarId === personal && personalCalendarClient) {
    return personalCalendarClient;
  }
  return calendarClient;
}

export async function getCalendarContext(): Promise<string> {
  if (!CALENDAR_ENABLED || !calendarClient) return "";

  try {
    const now = new Date();

    // End of tomorrow morning (covers "rest of today" + "first thing tomorrow")
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);

    // Fetch from all configured calendars
    const calendarIds = getAllCalendarIds();
    const allEvents: Array<{ summary?: string | null; start?: any; end?: any; location?: string | null; calendarName?: string }> = [];

    for (const { id, name } of calendarIds) {
      const client = getClientForCalendar(id);
      if (!client) continue;
      try {
        const res = await client.events.list({
          calendarId: id,
          timeMin: now.toISOString(),
          timeMax: tomorrow.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 15,
        });
        const items = res.data.items || [];
        for (const ev of items) {
          allEvents.push({ ...ev, calendarName: name });
        }
      } catch (err) {
        console.error(`getCalendarContext error for ${name}:`, err);
      }
    }

    if (allEvents.length === 0) return "";

    // Sort all events by start time
    allEvents.sort((a, b) => {
      const aTime = a.start?.dateTime || a.start?.date || "";
      const bTime = b.start?.dateTime || b.start?.date || "";
      return aTime.localeCompare(bTime);
    });

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayDate = now.toLocaleDateString("en-US", { timeZone: tz });

    const lines = allEvents.map((ev) => {
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
  durationMinutes = 60,
  calendarName?: string
): Promise<void> {
  const calId = resolveCalendarId(calendarName) || GOOGLE_CALENDAR_ID;
  const client = getClientForCalendar(calId);
  if (!client) {
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

    await client.events.insert({
      calendarId: calId,
      requestBody: {
        summary: title,
        start: { dateTime: `${date}T${time}:00`, timeZone: tz },
        end: { dateTime: `${date}T${endTime}:00`, timeZone: tz },
      },
    });

    console.log(`Created calendar event: ${title} on ${date} at ${time} [${calendarName || "default"}]`);
  } catch (error) {
    console.error("createCalendarEvent error:", error);
  }
}

/**
 * Find a calendar event by title (partial match) on a specific date.
 * Returns the first matching event's ID and details, or null.
 */
export async function findCalendarEvent(
  titleSearch: string,
  date: string,
  calendarName?: string
): Promise<{ eventId: string; title: string; start: string; end: string; calendarId: string } | null> {
  const calId = resolveCalendarId(calendarName) || GOOGLE_CALENDAR_ID;
  const client = getClientForCalendar(calId);
  if (!client) return null;

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayStart = `${date}T00:00:00`;
    const dayEnd = `${date}T23:59:59`;

    const res = await client.events.list({
      calendarId: calId,
      timeMin: new Date(`${dayStart}`).toISOString(),
      timeMax: new Date(`${dayEnd}`).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const events = res.data.items || [];
    const searchLower = titleSearch.toLowerCase();
    const match = events.find((ev) =>
      ev.summary?.toLowerCase().includes(searchLower)
    );

    if (!match || !match.id) return null;

    return {
      eventId: match.id,
      title: match.summary || "",
      start: match.start?.dateTime || match.start?.date || "",
      end: match.end?.dateTime || match.end?.date || "",
      calendarId: calId,
    };
  } catch (error) {
    console.error("findCalendarEvent error:", error);
    return null;
  }
}

/**
 * Update an existing calendar event's time. Finds by title + date, then patches.
 */
export async function updateCalendarEvent(
  titleSearch: string,
  date: string,
  newTime: string,
  newDuration?: number,
  calendarName?: string
): Promise<boolean> {
  const calId = resolveCalendarId(calendarName) || GOOGLE_CALENDAR_ID;
  const client = getClientForCalendar(calId);
  if (!client) {
    console.log("Calendar not connected — cannot update event");
    return false;
  }

  try {
    const found = await findCalendarEvent(titleSearch, date, calendarName);
    if (!found) {
      console.log(`No calendar event found matching "${titleSearch}" on ${date}`);
      return false;
    }

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [hh, mm] = newTime.split(":").map(Number);

    // Calculate duration from existing event if not provided
    let durationMinutes = newDuration || 60;
    if (!newDuration && found.start && found.end) {
      const origDuration = Math.round(
        (new Date(found.end).getTime() - new Date(found.start).getTime()) / 60000
      );
      if (origDuration > 0) durationMinutes = origDuration;
    }

    const totalMin = hh * 60 + mm + durationMinutes;
    const endHH = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const endMM = String(totalMin % 60).padStart(2, "0");

    await client.events.patch({
      calendarId: calId,
      eventId: found.eventId,
      requestBody: {
        start: { dateTime: `${date}T${newTime}:00`, timeZone: tz },
        end: { dateTime: `${date}T${endHH}:${endMM}:00`, timeZone: tz },
      },
    });

    console.log(`Updated calendar event: "${found.title}" → ${date} at ${newTime}`);
    return true;
  } catch (error) {
    console.error("updateCalendarEvent error:", error);
    return false;
  }
}

/**
 * Delete a calendar event by title + date.
 */
export async function deleteCalendarEvent(
  titleSearch: string,
  date: string,
  calendarName?: string
): Promise<boolean> {
  const calId = resolveCalendarId(calendarName) || GOOGLE_CALENDAR_ID;
  const client = getClientForCalendar(calId);
  if (!client) {
    console.log("Calendar not connected — cannot delete event");
    return false;
  }

  try {
    const found = await findCalendarEvent(titleSearch, date, calendarName);
    if (!found) {
      console.log(`No calendar event found matching "${titleSearch}" on ${date}`);
      return false;
    }

    await client.events.delete({
      calendarId: calId,
      eventId: found.eventId,
    });

    console.log(`Deleted calendar event: "${found.title}" on ${date}`);
    return true;
  } catch (error) {
    console.error("deleteCalendarEvent error:", error);
    return false;
  }
}
