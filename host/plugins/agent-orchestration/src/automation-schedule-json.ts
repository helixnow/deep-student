import { JsonReader } from '../../../platform/util/api.ts';
import type { AutomationSchedule, ScheduleKind } from './automation-schedule.ts';

const KINDS: readonly ScheduleKind[] = ['daily', 'weekly', 'weekdays', 'monthly', 'interval', 'once'];
const FIELDS = ['kind', 'time', 'weekday', 'weekdays', 'day_of_month', 'interval_minutes', 'date', 'timezone'] as const;

function readKind(r: JsonReader): ScheduleKind {
  const map = r.peekKind() === 'object';
  if (map) r.beginObject();
  const variant = map ? r.readEnumVariant() : r.readString('string or map');
  const kind = KINDS.find((name) => name === variant);
  if (kind === undefined) {
    throw r.error(`unknown variant \`${variant}\`, expected one of ${KINDS.map((name) => `\`${name}\``).join(', ')}`);
  }
  if (map) { r.readNull(); r.endEnumObject(); }
  return kind;
}

/** automations.rs:249–274 serde fields, independent of business validate_schedule. */
export function decodeAutomationSchedule(text: string): AutomationSchedule {
  const r = new JsonReader(text);
  let kind: ScheduleKind | undefined;
  let time = '';
  let weekday: number | null = null;
  let weekdays: number[] | null = null;
  let dayOfMonth: number | null = null;
  let intervalMinutes: number | null = null;
  let date: string | null = null;
  let timezone: string | null = null;
  const seen = new Set<string>();
  const readField = (field: typeof FIELDS[number]): void => {
    switch (field) {
      case 'kind': kind = readKind(r); break;
      case 'time': time = r.readString(); break;
      case 'weekday': weekday = r.readOptionNone() ? null : Number(r.readUnsigned('u8', 255n)); break;
      case 'weekdays': {
        if (r.readOptionNone()) { weekdays = null; break; }
        r.beginArray();
        weekdays = [];
        while (r.nextItem()) weekdays.push(Number(r.readUnsigned('u8', 255n)));
        break;
      }
      case 'day_of_month': dayOfMonth = r.readOptionNone() ? null : Number(r.readUnsigned('u8', 255n)); break;
      case 'interval_minutes': intervalMinutes = r.readOptionNone() ? null : Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
      case 'date': date = r.readOptionNone() ? null : r.readString(); break;
      case 'timezone': timezone = r.readOptionNone() ? null : r.readString(); break;
    }
  };
  if (r.peekKind() === 'array') {
    r.beginArray();
    let ended = false;
    for (let i = 0; i < FIELDS.length; i++) {
      if (!ended && !r.nextItem()) ended = true;
      if (ended) {
        // time and fields after weekday have #[serde(default)]. weekday's Option defaults
        // on map omission, but its positional slot is required by serde's sequence visitor.
        if (i === 0 || i === 2) throw r.error(`invalid length ${i}, expected struct AutomationSchedule with 8 elements`);
        continue;
      }
      readField(FIELDS[i]!);
    }
    if (!ended && r.nextItem()) throw r.error('trailing characters');
  } else {
    r.beginObject('struct AutomationSchedule');
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = FIELDS.find((name) => name === key);
      if (field === undefined) { r.skipValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
  }
  if (kind === undefined) throw r.error('missing field `kind`');
  r.end();
  return { kind, time, weekday, weekdays, day_of_month: dayOfMonth,
    interval_minutes: intervalMinutes, date, timezone };
}
