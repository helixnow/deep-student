import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import { addSeconds, range, totalSeconds } from '../repository/study-time.ts';
import { parseDate, validateAdd } from '../src/study-time.ts';
import { storageFixture } from './storage.ts';

const fixtures: ReturnType<typeof storageFixture>[] = [];
const migration = readFileSync('resources/app/migrations/vfs/V20261006__study_time.sql', 'utf8');
function setup() { const f = storageFixture(); fixtures.push(f); f.db.exec(migration); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
it('migration_is_idempotent', () => { setup().db.exec(migration); });
it('add_accumulates_per_day_and_caps_at_one_day', () => {
  const { db } = setup();
  expect(addSeconds(db, '2026-10-04', 30, 1).seconds).toBe(30);
  expect(addSeconds(db, '2026-10-04', 15, 2).seconds).toBe(45);
  expect(addSeconds(db, '2026-10-05', 10, 3).seconds).toBe(10);
  for (let i = 0; i < 30; i++) addSeconds(db, '2026-10-05', 3600, 4);
  expect(addSeconds(db, '2026-10-05', 1, 5).seconds).toBe(86400);
  expect(db.pluck("SELECT updated_at FROM study_time_daily WHERE date='2026-10-04'")).toBe(2);
});
it('range_is_inclusive_sorted_and_skips_empty_days', () => {
  const { db } = setup();
  for (const [date, seconds] of [['2026-10-03', 60], ['2026-10-01', 120], ['2026-09-30', 5], ['2026-10-05', 7]] as const) addSeconds(db, date, seconds, 1);
  expect(range(db, '2026-10-01', '2026-10-05')).toEqual([
    { date: '2026-10-01', seconds: 120 }, { date: '2026-10-03', seconds: 60 }, { date: '2026-10-05', seconds: 7 },
  ]);
  expect(totalSeconds(db, '2026-10-01', '2026-10-05')).toBe(187);
  expect(totalSeconds(db, '2027-01-01', '2027-01-02')).toBe(0);
});
it('validation_rejects_bad_seconds_and_far_dates', () => {
  for (const date of ['2026-10-04', '2026-10-03', '2026-10-06']) expect(() => validateAdd(15, date, '2026-10-04')).not.toThrow();
  for (const seconds of [0, -5, 3601]) expect(() => validateAdd(seconds, '2026-10-04', '2026-10-04')).toThrow();
  expect(() => validateAdd(15, '2026-09-01', '2026-10-04')).toThrow();
  expect(() => parseDate('date', '2026/10/04')).toThrow();
  expect(parseDate('date', '2026-10-04')).toBe('2026-10-04');
});
it('study time commands load in Host, preserve AppError and inclusive range contracts', async () => {
  const { storage } = setup();
  const host = await createTestHost({ plugins: [review], provide: { storage } });
  try {
    await expect(host.invoke('study_time_add', { seconds: 0 })).rejects.toEqual({ error_type: 'Validation', message: 'seconds must be within 1..=3600, got 0', details: null });
    const day = await host.invoke('study_time_add', { seconds: 30 }) as { date: string; seconds: number };
    expect(day.seconds).toBe(30);
    await expect(host.invoke('study_time_range', { from: day.date, to: day.date })).resolves.toEqual([day]);
    await expect(host.invoke('study_time_range', { from: '2026-10-05', to: '2026-10-04' })).rejects.toEqual({ error_type: 'Validation', message: 'to must not be earlier than from', details: null });
    await expect(host.invoke('study_time_range', { from: '2000-01-01', to: '2026-10-04' })).rejects.toEqual({ error_type: 'Validation', message: 'range must not exceed 3700 days', details: null });
  } finally { await host.dispose(); }
});
