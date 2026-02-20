import { CALENDAR_ENABLED, calendarClient, getAllCalendarIds, resolveCalendarId, personalCalendarClient } from "./src/config";

function getClientForCalendar(calendarId: string) {
  const personal = resolveCalendarId("personal");
  if (personal && calendarId === personal && personalCalendarClient) return personalCalendarClient;
  return calendarClient;
}

if (!CALENDAR_ENABLED || !calendarClient) { console.log("Calendar not enabled"); process.exit(0); }

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(0,0,0,0);
const endTomorrow = new Date(tomorrow);
endTomorrow.setHours(23,59,59,999);

const calendarIds = getAllCalendarIds();
const allEvents: any[] = [];

for (const { id, name } of calendarIds) {
  const client = getClientForCalendar(id);
  if (!client) continue;
  try {
    const res = await client.events.list({
      calendarId: id,
      timeMin: tomorrow.toISOString(),
      timeMax: endTomorrow.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 15,
    });
    for (const ev of (res.data.items || [])) {
      allEvents.push({ ...ev, calendarName: name });
    }
  } catch (err) {
    console.error("Calendar error for " + name + ":", err);
  }
}

allEvents.sort((a: any, b: any) => {
  const aTime = a.start?.dateTime || a.start?.date || "";
  const bTime = b.start?.dateTime || b.start?.date || "";
  return aTime.localeCompare(bTime);
});

console.log("TOMORROW EVENTS (" + tomorrow.toDateString() + "):", JSON.stringify(allEvents.map((ev: any) => ({
  summary: ev.summary,
  start: ev.start,
  end: ev.end,
  location: ev.location,
  calendar: ev.calendarName,
})), null, 2));
process.exit(0);
