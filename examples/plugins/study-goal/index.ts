/**
 * Host 半：提供 exampleStudyGoal 服务，按日期累计学习分钟数，经 meta.remote 开放 log / day 给 UI 半。
 * 参数不合法时抛 CommandError：UI 半经 plugin:host|call 收到的就是构造时给的值（这里是 AppError 形状）。
 *
 * 记录存在插件自己的 SQLite 文件 `<数据目录>/plugins/example.study-goal/study-goal.db` 里，Host 重启后还在
 * （docs/plugins/SDK.md §7.2）：清单声明 `service:storage`（不隐式授予），`inject: ['storage']`，用 `ctx.storage.openFile`
 * 打开，`ctx.effect` 登记关闭。不打开应用的注册库（`ctx.storage.database(...)`），schema 用 `PRAGMA user_version` 自己管。
 */
import { CommandError, definePlugin } from '../../../host/kernel/api.ts';
import { pluginEventName } from '../../../host/kernel/plugin-id.ts';
import type { DatabaseHandle } from '../../../host/platform/storage/api.ts';
import { TODAY_EVENT, type StudyDay } from './day.ts';

const ID = 'example.study-goal';
/** 一天最多记 24 小时。 */
export const MAX_MINUTES_PER_DAY = 24 * 60;
/** 本插件数据库文件名（在 `<数据目录>/plugins/<id>/` 下）。 */
export const DATABASE_FILE = 'study-goal.db';
const SCHEMA_VERSION = 1;

export interface ExampleStudyGoalService {
  /** 给 `date`（YYYY-MM-DD）加 `minutes` 分钟，返回当天累计。 */
  log(date: string, minutes: number): Promise<StudyDay>;
  /** 当天累计；没有记录时为 0。 */
  day(date: string): StudyDay;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleStudyGoal: ExampleStudyGoalService;
  }
}

function invalid(message: string): CommandError {
  return new CommandError({ error_type: 'Validation', message, details: null });
}

function checkDate(date: unknown): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  return date;
}

function migrate(db: DatabaseHandle): void {
  if (db.pluck<number>('PRAGMA user_version') === SCHEMA_VERSION) return;
  db.exec(`CREATE TABLE IF NOT EXISTS study_minutes (date TEXT PRIMARY KEY, minutes INTEGER NOT NULL CHECK (minutes > 0));
    PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export default definePlugin({
  meta: {
    id: ID,
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['exampleStudyGoal'],
    ui: './dist/ui.js',
    remote: { exampleStudyGoal: ['log', 'day'] },
  },
  inject: ['storage'],
  apply(ctx) {
    const log = ctx.logger(ID);
    const db = ctx.storage.openFile(`${ctx.app.dataDir}/plugins/${ID}/${DATABASE_FILE}`, { label: ID });
    ctx.effect(() => () => ctx.storage.close(db));
    migrate(db);
    const minutesOn = (date: string) => db.pluck<number>('SELECT minutes FROM study_minutes WHERE date = ?', [date]) ?? 0;

    ctx.provide('exampleStudyGoal', {
      async log(date, minutes) {
        const key = checkDate(date);
        if (!Number.isInteger(minutes) || minutes <= 0) throw invalid(`minutes must be a positive integer, got ${JSON.stringify(minutes)}`);
        // 异步代码写库用 write（等写者槽 + BEGIN IMMEDIATE）；回调同步执行，抛错即回滚并原样抛出。
        const total = await db.write((tx) => {
          const next = (tx.pluck<number>('SELECT minutes FROM study_minutes WHERE date = ?', [key]) ?? 0) + minutes;
          if (next > MAX_MINUTES_PER_DAY) throw invalid(`${key} would exceed ${MAX_MINUTES_PER_DAY} minutes`);
          tx.run('INSERT INTO study_minutes (date, minutes) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET minutes = excluded.minutes', [key, next]);
          return next;
        });
        log.debug(`${key}: +${minutes} min, ${total} min total`);
        // 提交之后才通知：UI 半拿到的 `minutes` 与库里一致，读库也读得到。载荷是纯 JSON（date + 整数）。
        ctx.uiEvents.emit(pluginEventName(ID, TODAY_EVENT), { date: key, minutes: total });
        return { date: key, minutes: total };
      },
      day(date) {
        const key = checkDate(date);
        return { date: key, minutes: minutesOn(key) };
      },
    });
  },
});
