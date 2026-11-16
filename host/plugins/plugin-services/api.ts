/**
 * 插件专属服务与应用事件（docs/plugins/SDK.md §3.6–§3.9）。
 *
 * 由 `dstu.plugin-services` 提供，社区插件与工坊作品在清单 `permissions` 里声明 `service:<服务名>` 后 `inject` 使用：
 *
 * | 服务 | 用途 |
 * |---|---|
 * | `pluginSecrets` | 按插件隔离的密钥（用户的 API key 等），存进系统安全存储 |
 * | `pluginNotify` | 系统通知；用户点开时打开插件的视图 |
 * | `pluginSchedule` | 每天 / 每周 / 每隔 N 分钟 / 启动时运行插件的函数；错过的那次在下次启动时补跑一次 |
 * | `studyData` | 笔记、卡片、题库、复习、待办、资料库的读 / 搜 / 新建 / 修改（见 `StudyDataService`） |
 *
 * 数据都按调用方插件 id 划分（`host/kernel/plugin-caller.ts`），插件之间互不可见。
 *
 * 应用事件是普通 Cordis 事件，不需要声明：`ctx.on('study/note-saved', (event) => …)`（见 {@link StudyEvents}）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { StudyDataService } from './src/study-data-types.ts';

export type * from './src/study-data-types.ts';

// ------------------------------------------------------------------ pluginSecrets

export interface PluginSecretsService {
  /** 读取本插件的密钥；没有时返回 null。`key` 是 1–64 位的字母、数字、`.`、`_`、`-`。 */
  get(key: string): Promise<string | null>;
  /** 写入（覆盖）本插件的密钥；空字符串等同删除。 */
  set(key: string, value: string): Promise<void>;
  /** 删除；原本就没有时返回 false。 */
  delete(key: string): Promise<boolean>;
}

/** 插件密钥在应用设置里的键（`settings.saveSecret` / `getSecret`）；卡片里「密钥」类设置的值写到这里。 */
export function pluginSecretSettingsKey(pluginId: string, key: string): string {
  return `secret.plugin.${pluginId}.${key}`;
}

export const PLUGIN_SECRET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ------------------------------------------------------------------ pluginNotify

export interface PluginNotification {
  title: string;
  body: string;
  /** 点开通知时打开的视图 id（插件用 `ctx.ui.views.register` 登记的）；缺省为插件登记的第一个视图。 */
  view?: string;
  /** 交给视图的导航参数（纯 JSON）。 */
  params?: Record<string, unknown>;
  silent?: boolean;
}

export interface PluginNotifyResult {
  delivered: boolean;
  /** 没送达的原因：`policy`（用户在设置里关了通知）、`unavailable`（没有系统通知）或系统报错。 */
  reason?: string;
}

export interface PluginNotifyService {
  notify(notification: PluginNotification): Promise<PluginNotifyResult>;
}

// ------------------------------------------------------------------ pluginSchedule

/** 定时任务被调用时拿到的信息。 */
export interface PluginJobRun {
  /** 任务 id。 */
  id: string;
  /** 这一次的计划时间（毫秒时间戳）；启动时任务为应用启动时间。 */
  scheduledAt: number;
  /** 上一次运行完成的时间；从未运行过为 null。 */
  lastRunAt: number | null;
  /** 补跑：计划时间已过（应用当时没开），这次是启动后补的。 */
  catchUp: boolean;
  /** 插件卸载或任务被取消时中止。 */
  signal: AbortSignal;
}

export type PluginJobHandler = (run: PluginJobRun) => unknown;

export type PluginJobSchedule =
  /** 每天 `time`（本地时间 `HH:MM`）。 */
  | { kind: 'daily'; time: string }
  /** 每周 `weekday`（0 = 周日 … 6 = 周六）的 `time`。 */
  | { kind: 'weekly'; weekday: number; time: string }
  /** 每隔 `minutes` 分钟（至少 1 分钟）。 */
  | { kind: 'interval'; minutes: number }
  /** 每次应用启动（或插件装上）后运行一次。 */
  | { kind: 'startup' };

export interface PluginJobInfo {
  id: string;
  schedule: PluginJobSchedule;
  lastRunAt: number | null;
  /** 下一次计划时间；启动时任务为 null。 */
  nextRunAt: number | null;
  running: boolean;
}

export interface PluginScheduleService {
  /**
   * 登记一个定时任务，返回取消函数；插件卸载时自动取消。同一插件内 `id` 唯一（重复登记替换旧的）。
   * 每天 / 每周的任务错过了（那个时间应用没开），下次启动后补跑一次（`run.catchUp === true`）。
   * 任务抛错只记日志，下次照常运行；同一个任务不会并发运行。
   */
  register(id: string, schedule: PluginJobSchedule, handler: PluginJobHandler): () => void;
  daily(id: string, time: string, handler: PluginJobHandler): () => void;
  weekly(id: string, weekday: number, time: string, handler: PluginJobHandler): () => void;
  every(id: string, minutes: number, handler: PluginJobHandler): () => void;
  onStartup(id: string, handler: PluginJobHandler): () => void;
  /** 立刻运行一次（不改变计划；正在运行时等它结束）。 */
  runNow(id: string): Promise<void>;
  /** 本插件登记的任务。 */
  list(): PluginJobInfo[];
}

// ------------------------------------------------------------------ 应用事件

export interface NoteSavedEvent {
  noteId: string;
  title: string;
  /** 新建为 true，修改为 false。 */
  created: boolean;
  updatedAt?: string;
}

export interface CardReviewedEvent {
  /** 复习队列里的卡片 id。 */
  cardStateId: string;
  /** 卡片内容 id（`studyData.cards.get`）。 */
  cardId: string | null;
  /** 1 = 重来，2 = 困难，3 = 良好，4 = 简单。 */
  rating: number;
  reviewedAt: string;
}

export interface AnswerFinishedEvent {
  sessionId: string;
  messageId: string;
  /** 助手回答的正文（Markdown）。 */
  content: string;
  /** 用户这一轮的输入。 */
  question: string;
  durationMs: number;
}

export interface CardsCreatedEvent {
  cardIds: string[];
  /** 生成卡片的文档 / 任务 id。 */
  documentId: string | null;
}

/** 官方插件在动作完成后发出的应用事件（`ctx.on(name, handler)` 订阅，插件卸载时自动退订）。 */
export interface StudyEvents {
  /** 笔记新建或保存（编辑器保存、AI 改写、插件写入都会触发）。 */
  'study/note-saved'(event: NoteSavedEvent): void;
  /** 复习界面给一张卡打了分。 */
  'study/card-reviewed'(event: CardReviewedEvent): void;
  /** 学习助手回答完一轮（成功结束，不含取消与出错）。 */
  'study/answer-finished'(event: AnswerFinishedEvent): void;
  /** 新卡片存进卡片库。 */
  'study/cards-created'(event: CardsCreatedEvent): void;
}

export type StudyEventName = keyof StudyEvents;

/**
 * 官方插件发出应用事件：放到微任务里发，监听者的耗时与异常都不影响发出方的命令；监听者异常只记日志。
 */
export function emitStudyEvent<K extends StudyEventName>(ctx: Context, name: K, payload: Parameters<StudyEvents[K]>[0]): void {
  const report = (error: unknown) => {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    for (const reason of reasons) {
      ctx.logger('study-events').warn(`listener of ${name} threw: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  queueMicrotask(() => {
    try {
      // `parallel` calls every listener even when one throws, and collects the failures.
      void (ctx.parallel as unknown as (name: string, payload: unknown) => Promise<void>).call(ctx, name, payload).catch(report);
    } catch (error) {
      report(error);
    }
  });
}

export const pluginSecretsService = { name: 'pluginSecrets', version: '1.0.0' } as const;
export const pluginNotifyService = { name: 'pluginNotify', version: '1.0.0' } as const;
export const pluginScheduleService = { name: 'pluginSchedule', version: '1.0.0' } as const;
export const studyDataService = { name: 'studyData', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginSecrets: PluginSecretsService;
    pluginNotify: PluginNotifyService;
    pluginSchedule: PluginScheduleService;
    studyData: StudyDataService;
  }
  interface Events extends StudyEvents {}
}
