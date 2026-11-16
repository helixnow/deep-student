import { Service, type Context } from '@deepseek-ai/cordis';
import type {} from '../../../platform/settings/api.ts';
import type { PluginJobHandler, PluginJobInfo, PluginJobSchedule, PluginScheduleService } from '../api.ts';
import { callerPluginId } from './caller.ts';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const SCHEDULER_TICK_MS = 30_000;

/** Persisted per job: the last completed run, and when the job was first seen (the catch-up baseline). */
interface JobRecord {
  last: number | null;
  since: number;
}

export interface SchedulerStore {
  read(pluginId: string, jobId: string): JobRecord | null;
  write(pluginId: string, jobId: string, record: JobRecord): void;
}

export interface SchedulerClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SchedulerLog {
  warn(message: string): void;
}

interface Job {
  pluginId: string;
  id: string;
  schedule: PluginJobSchedule;
  handler: PluginJobHandler;
  record: JobRecord;
  running: Promise<void> | null;
  controller: AbortController;
  startupPending: boolean;
}

function parseTime(time: unknown): { hour: number; minute: number } {
  const match = typeof time === 'string' ? TIME.exec(time) : null;
  if (!match) throw new Error(`PLUGIN_SCHEDULE_INVALID: time must be "HH:MM" (24h), got ${JSON.stringify(time)}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function normalizeSchedule(schedule: PluginJobSchedule): PluginJobSchedule {
  switch (schedule?.kind) {
    case 'daily':
      parseTime(schedule.time);
      return { kind: 'daily', time: schedule.time };
    case 'weekly':
      parseTime(schedule.time);
      if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
        throw new Error('PLUGIN_SCHEDULE_INVALID: weekday must be an integer 0 (Sunday) … 6 (Saturday)');
      }
      return { kind: 'weekly', weekday: schedule.weekday, time: schedule.time };
    case 'interval':
      if (typeof schedule.minutes !== 'number' || !Number.isFinite(schedule.minutes) || schedule.minutes < 1) {
        throw new Error('PLUGIN_SCHEDULE_INVALID: minutes must be a number ≥ 1');
      }
      return { kind: 'interval', minutes: schedule.minutes };
    case 'startup':
      return { kind: 'startup' };
    default:
      throw new Error('PLUGIN_SCHEDULE_INVALID: kind must be daily, weekly, interval or startup');
  }
}

/** The most recent planned slot at or before `now` (local time); null for startup jobs. */
export function previousSlot(schedule: PluginJobSchedule, now: number, since: number): number | null {
  if (schedule.kind === 'startup') return null;
  if (schedule.kind === 'interval') {
    const period = schedule.minutes * MINUTE;
    return since + Math.floor((now - since) / period) * period;
  }
  const { hour, minute } = parseTime(schedule.time);
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  let slot = date.getTime();
  if (slot > now) slot -= DAY;
  if (schedule.kind === 'weekly') {
    while (new Date(slot).getDay() !== schedule.weekday) slot -= DAY;
  }
  return slot;
}

export function nextSlot(schedule: PluginJobSchedule, now: number, since: number): number | null {
  if (schedule.kind === 'startup') return null;
  if (schedule.kind === 'interval') return (previousSlot(schedule, now, since) ?? now) + schedule.minutes * MINUTE;
  const previous = previousSlot(schedule, now, since)!;
  const step = schedule.kind === 'weekly' ? 7 * DAY : DAY;
  // DST shifts move the wall-clock slot by an hour at most; recompute from the local date instead of adding a fixed step.
  const probe = previous + step + 2 * 60 * MINUTE;
  return previousSlot(schedule, probe, since)!;
}

/**
 * In-process scheduler behind `pluginSchedule`. One timer for every plugin job; a job runs at most once at a time,
 * and a daily / weekly slot missed while the app was closed runs once on the next start (`catchUp`).
 */
export class PluginScheduler {
  private readonly jobs = new Map<string, Job>();
  private timer: unknown = null;
  private readonly store: SchedulerStore;
  private readonly clock: SchedulerClock;
  private readonly log: SchedulerLog;

  constructor(store: SchedulerStore, clock: SchedulerClock, log: SchedulerLog) {
    this.store = store;
    this.clock = clock;
    this.log = log;
  }

  register(pluginId: string, id: string, schedule: PluginJobSchedule, handler: PluginJobHandler): () => void {
    if (typeof id !== 'string' || !JOB_ID.test(id)) {
      throw new Error('PLUGIN_SCHEDULE_INVALID: job id must be 1-64 letters, digits, ".", "_" or "-"');
    }
    if (typeof handler !== 'function') throw new Error('PLUGIN_SCHEDULE_INVALID: handler must be a function');
    const normalized = normalizeSchedule(schedule);
    const key = `${pluginId}\u0000${id}`;
    this.jobs.get(key)?.controller.abort();
    let record = this.safeRead(pluginId, id);
    if (!record) {
      record = { last: null, since: this.clock.now() };
      this.safeWrite(pluginId, id, record);
    }
    const job: Job = {
      pluginId, id, schedule: normalized, handler, record, running: null,
      controller: new AbortController(), startupPending: normalized.kind === 'startup',
    };
    this.jobs.set(key, job);
    this.ensureTimer();
    queueMicrotask(() => this.check(job));
    return () => {
      if (this.jobs.get(key) !== job) return;
      this.jobs.delete(key);
      job.controller.abort();
      if (this.jobs.size === 0) this.stopTimer();
    };
  }

  list(pluginId: string): PluginJobInfo[] {
    const now = this.clock.now();
    return [...this.jobs.values()].filter((job) => job.pluginId === pluginId).map((job) => ({
      id: job.id,
      schedule: job.schedule,
      lastRunAt: job.record.last,
      nextRunAt: nextSlot(job.schedule, now, job.record.since),
      running: job.running !== null,
    }));
  }

  async runNow(pluginId: string, id: string): Promise<void> {
    const job = this.jobs.get(`${pluginId}\u0000${id}`);
    if (!job) throw new Error(`PLUGIN_SCHEDULE_UNKNOWN: no job "${id}"`);
    if (job.running) await job.running;
    await this.run(job, this.clock.now(), false);
  }

  /** Runs every due job; called by the timer. */
  tick(): void {
    for (const job of [...this.jobs.values()]) this.check(job);
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    this.stopTimer();
  }

  private check(job: Job): void {
    if (job.running || job.controller.signal.aborted) return;
    const now = this.clock.now();
    if (job.schedule.kind === 'startup') {
      if (!job.startupPending) return;
      job.startupPending = false;
      void this.run(job, now, false);
      return;
    }
    const slot = previousSlot(job.schedule, now, job.record.since);
    if (slot === null) return;
    const baseline = job.record.last ?? job.record.since;
    if (slot <= baseline) return;
    // A slot more than one tick old was missed (the app was closed or asleep): this run catches it up.
    void this.run(job, slot, now - slot > SCHEDULER_TICK_MS * 2);
  }

  private run(job: Job, scheduledAt: number, catchUp: boolean): Promise<void> {
    const lastRunAt = job.record.last;
    const execute = async () => {
      try {
        await job.handler({ id: job.id, scheduledAt, lastRunAt, catchUp, signal: job.controller.signal });
      } catch (error) {
        this.log.warn(`plugin ${job.pluginId} job "${job.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        job.record = { ...job.record, last: Math.max(this.clock.now(), scheduledAt) };
        this.safeWrite(job.pluginId, job.id, job.record);
        job.running = null;
      }
    };
    // Start after `running` is set, so a handler that throws synchronously still clears it in `finally`.
    const running = Promise.resolve().then(execute);
    job.running = running;
    return running;
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => this.tick(), SCHEDULER_TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  private safeRead(pluginId: string, id: string): JobRecord | null {
    try {
      return this.store.read(pluginId, id);
    } catch (error) {
      this.log.warn(`cannot read schedule state of ${pluginId}/${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private safeWrite(pluginId: string, id: string, record: JobRecord): void {
    try {
      this.store.write(pluginId, id, record);
    } catch (error) {
      this.log.warn(`cannot save schedule state of ${pluginId}/${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Schedule state lives in app settings under `plugin.schedule.<pluginId>.<jobId>`. */
export function settingsSchedulerStore(settings: () => Context['settings'] | undefined): SchedulerStore {
  const key = (pluginId: string, jobId: string) => `plugin.schedule.${pluginId}.${jobId}`;
  return {
    read(pluginId, jobId) {
      const raw = settings()?.get(key(pluginId, jobId));
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<JobRecord>;
      if (typeof value.since !== 'number') return null;
      return { last: typeof value.last === 'number' ? value.last : null, since: value.since };
    },
    write(pluginId, jobId, record) {
      settings()?.save(key(pluginId, jobId), JSON.stringify(record));
    },
  };
}

/** `pluginSchedule`: the calling plugin's view of the shared scheduler; jobs go away when that plugin unloads. */
export class PluginSchedule extends Service implements PluginScheduleService {
  private readonly scheduler: PluginScheduler;

  constructor(ctx: Context, scheduler: PluginScheduler) {
    super(ctx, 'pluginSchedule');
    this.scheduler = scheduler;
  }

  register(id: string, schedule: PluginJobSchedule, handler: PluginJobHandler): () => void {
    const pluginId = callerPluginId(this.ctx, 'pluginSchedule');
    let cancel: () => void = () => {};
    // Registered on the caller's fiber: unloading the plugin cancels the job.
    const dispose = this.ctx.effect(() => {
      cancel = this.scheduler.register(pluginId, id, schedule, handler);
      return () => cancel();
    }, `pluginSchedule(${id})`);
    return () => { void dispose(); };
  }

  daily(id: string, time: string, handler: PluginJobHandler): () => void {
    return this.register(id, { kind: 'daily', time }, handler);
  }

  weekly(id: string, weekday: number, time: string, handler: PluginJobHandler): () => void {
    return this.register(id, { kind: 'weekly', weekday, time }, handler);
  }

  every(id: string, minutes: number, handler: PluginJobHandler): () => void {
    return this.register(id, { kind: 'interval', minutes }, handler);
  }

  onStartup(id: string, handler: PluginJobHandler): () => void {
    return this.register(id, { kind: 'startup' }, handler);
  }

  runNow(id: string): Promise<void> {
    return this.scheduler.runNow(callerPluginId(this.ctx, 'pluginSchedule'), id);
  }

  list(): PluginJobInfo[] {
    return this.scheduler.list(callerPluginId(this.ctx, 'pluginSchedule'));
  }
}
