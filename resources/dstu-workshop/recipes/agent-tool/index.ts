// Recipe: teach the Agent one tool ("以后我说『查课表』，就去读我学校的教务日历").
//
// - The tool is DECLARED in package.json#deepStudent.agentTools (name, title, description, parameters) together
//   with the "agent:tools" permission. The user sees the title on the confirmation card.
// - The method with the SAME NAME on the primary service runs it: (args, tool) => JSON.
// - Network: only tool.fetch(url), HTTPS GET, and only hosts declared as "net:<host>" permissions. No imports, no
//   global fetch / process / require in a tool plugin.
// - The address is the user's, not the code's: propose the work with settings
//   [{ "key": "calendarUrl", "title": "课表日历地址（.ics）", "kind": "ics-url" }]. The card asks the user for it, the Host
//   reads it once (it must be a real calendar), declares "net:<its host>" and stores it as this plugin's config, which
//   arrives as the second argument of apply. Never hard-code it.
// - Return plain JSON. Throw an Error with a message the user can act on when something fails.

/** This plugin's config: the values the user entered on the workshop card. */
interface Config { calendarUrl?: string }

interface ToolContext {
  signal: AbortSignal;
  fetch(url: string): Promise<{ status: number; ok: boolean; contentType: string | null; text: string }>;
}
interface CalendarEvent { start: Date; end: Date; summary: string; location: string; description: string; rule: string }
interface Lesson { start: string; end: string; course: string; room: string; teacher: string }

const pad = (value: number) => String(value).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const unescapeText = (value: string) => value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

/** `20261116T080000`, `20261116T000000Z` or `20261116` → local Date. */
function parseTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(index => Number(match[index] ?? 0));
  return match[7]
    ? new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!))
    : new Date(year!, month! - 1, day!, hour!, minute!, second!);
}

function parseCalendar(text: string): CalendarEvent[] {
  // RFC 5545: a line starting with a space or tab continues the previous one.
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: CalendarEvent[] = [];
  let fields: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { fields = {}; continue; }
    if (line === 'END:VEVENT') {
      const start = parseTime(fields?.DTSTART ?? ''), end = parseTime(fields?.DTEND ?? fields?.DTSTART ?? '');
      if (fields && start && end) {
        events.push({ start, end, summary: unescapeText(fields.SUMMARY ?? ''), location: unescapeText(fields.LOCATION ?? ''),
          description: unescapeText(fields.DESCRIPTION ?? ''), rule: fields.RRULE ?? '' });
      }
      fields = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (fields && colon > 0) fields[line.slice(0, colon).split(';')[0]!.toUpperCase()] = line.slice(colon + 1);
  }
  return events;
}

/** Does the event happen on `day`? Single events, plus the weekly repetition school timetables use. */
function occursOn(event: CalendarEvent, day: Date): boolean {
  const first = new Date(event.start.getFullYear(), event.start.getMonth(), event.start.getDate());
  const days = Math.round((day.getTime() - first.getTime()) / 86_400_000);
  if (days === 0) return true;
  const rule = Object.fromEntries(event.rule.split(';').filter(Boolean).map(part => part.split('=') as [string, string]));
  if (days < 0 || rule.FREQ !== 'WEEKLY' || days % 7 !== 0) return false;
  const week = days / 7, interval = Number(rule.INTERVAL ?? 1) || 1;
  if (week % interval !== 0) return false;
  if (rule.COUNT && week / interval >= Number(rule.COUNT)) return false;
  const until = rule.UNTIL ? parseTime(rule.UNTIL) : null;
  return !until || day.getTime() <= until.getTime();
}

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', provides: ['__SERVICE__'] },
  apply(ctx: { provide(name: string, service: unknown): void }, config?: Config) {
    const calendarUrl = typeof config?.calendarUrl === 'string' ? config.calendarUrl.trim() : '';
    ctx.provide('__SERVICE__', {
      async lookup_timetable(args: { date?: string }, tool: ToolContext) {
        const day = args.date ? parseTime(args.date.replaceAll('-', '')) : new Date();
        if (!day) throw new Error('日期要写成 YYYY-MM-DD');
        day.setHours(0, 0, 0, 0);
        if (!calendarUrl) throw new Error('还没有设置课表日历地址：在插件工坊卡片上填写 .ics 地址后再试');
        const response = await tool.fetch(calendarUrl);
        if (!response.ok) throw new Error(`教务日历暂时读不到（HTTP ${response.status}）`);
        const lessons: Lesson[] = parseCalendar(response.text)
          .filter(event => occursOn(event, day))
          .map(event => ({ start: clock(event.start), end: clock(event.end), course: event.summary, room: event.location, teacher: event.description }))
          .sort((a, b) => a.start.localeCompare(b.start));
        return { date: dayKey(day), count: lessons.length, lessons };
      },
    });
  },
};
