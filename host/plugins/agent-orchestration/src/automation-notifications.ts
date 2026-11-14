/**
 * automations.rs:2420–2506、3039–3219、5296–5380、3705–3744 —
 * 自动化 OS 通知文案、策略/窗口抑制、at-most-once 回执与补投。
 *
 * 平台没有单独的 notification 服务；F2 shell 暴露与 tauri-plugin-notification
 * 对应的 `plugin:notification|notify` 和 `plugin:window|*` 命令，本模块经
 * {@link NotificationShell} 注入，不直接依赖 Electron。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  listPendingNotificationRuns, loadRunDeliveries, setNotificationRetryAt, setRunDeliveryMarker,
  type PendingNotificationRun,
} from '../repository/automations.ts';
import { formatTimestampMillis } from './automation-schedule.ts';
import { errorMessage } from './automation-errors.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';

export const POLICY_SETTING_KEY = 'system-notification-policy';
export const NOTIFICATION_RETRY_DELAY_MS = 5 * 60_000;

export type SystemNotificationPolicy = 'background' | 'always' | 'never';
export type NotificationLang = 'zh' | 'en';

/**
 * F2 `systemNotification` 的公开消费面（`electron/api.ts`，main 已发布）。
 * 策略与投递归 F2；窗口活跃判断由本 lane 在预约前用公开窗口 shell 原语
 * 完成，以保持 Rust 的“先判窗口、再写 at-most-once 预约”顺序。
 */
export interface SystemNotificationRequest {
  id?: number;
  title: string;
  body: string;
  suppressIfWindowActive?: boolean;
}
export type SystemNotificationOutcome =
  | { delivered: true; suppressed: null; error: null }
  | { delivered: false; suppressed: 'policy' | 'window-active'; error: null }
  | { delivered: false; suppressed: null; error: string };
export interface SystemNotificationPort {
  policy(): SystemNotificationPolicy;
  notificationsDisabled(): boolean;
  notify(request: SystemNotificationRequest): Promise<SystemNotificationOutcome>;
}

export interface NotificationShell {
  request<R = unknown>(op: string, args?: unknown): Promise<R>;
}

export interface NotificationLogger {
  warn(message: string): void;
}

export interface NotificationDeps {
  db: DatabaseHandle;
  settings: Pick<SettingsStore, 'get'>;
  shell: NotificationShell;
  /** F2 provider 存在时优先消费其策略/窗口/投递结果；缺失时走 main 的 shell 原语。 */
  notification?: SystemNotificationPort;
  logger: NotificationLogger;
  now(): number;
}

export interface RunNotificationRequest {
  runId: string;
  attempt: number;
  status: string;
  title: string;
  body: string;
  suppressIfWindowActive: boolean;
}

export interface RunNotificationOutcome {
  /** Rust `RunNotificationOutcome::handled()`：非 Failed 即已妥善处理。 */
  handled: boolean;
  /** 本次调用是否真的发出了 OS 通知。 */
  deliveredOs: boolean;
}

/** system_notification.rs:26–45. */
export function policyFromRaw(raw: string | null): SystemNotificationPolicy {
  if (raw === 'always') return 'always';
  if (raw === 'never') return 'never';
  return 'background';
}

export function notificationLanguage(raw: string | null): NotificationLang {
  return raw !== null && rustTrim(raw).toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function notificationTitleRunning(lang: NotificationLang, name: string): string {
  return lang === 'zh' ? `自动化：${name}` : `Automation: ${name}`;
}

export function notificationTitleSuccess(lang: NotificationLang, name: string): string {
  return lang === 'zh' ? `自动化完成：${name}` : `Automation completed: ${name}`;
}

export function notificationTitleFailed(lang: NotificationLang, name: string): string {
  return lang === 'zh' ? `自动化失败：${name}` : `Automation failed: ${name}`;
}

export function notificationSuccessBody(
  lang: NotificationLang, summary: string, sessionId: string | null,
): string {
  if (sessionId === null) return summary;
  if (lang === 'zh') {
    return summary === '' ? `已完成，打开 Deep Student 查看会话（${sessionId}）` : `${summary}\n打开 Deep Student 查看完整会话`;
  }
  return summary === '' ? `Completed. Open Deep Student to view the session (${sessionId}).`
    : `${summary}\nOpen Deep Student to view the full session.`;
}

export function notificationFailedFallbackBody(lang: NotificationLang): string {
  return lang === 'zh' ? '自动化运行失败' : 'Automation run failed';
}

/** automations.rs:3705–3713. */
export function truncateForNotification(text: string, maxChars: number): string {
  const trimmed = rustTrim(text);
  const chars = [...trimmed];
  const preview = chars.slice(0, maxChars).join('');
  return chars.length > maxChars ? `${preview}…` : preview;
}

/** automations.rs:2495–2506. */
export function truncatePromptForNotification(prompt: string, lang: NotificationLang): string {
  const chars = [...prompt];
  const preview = chars.slice(0, 100).join('');
  const truncated = chars.length > 100;
  if (lang === 'zh') return `${preview}${truncated ? '…' : ''} 打开 Deep Student 执行此任务`;
  return `${preview}${truncated ? '…' : ''} Open Deep Student to run this task.`;
}

/** automations.rs:3715–3723：FNV-1a，保留给通知中心按 run 去重。 */
export function notificationIdForRun(runId: string): number {
  let hash = 2_166_136_261;
  for (const byte of encodeUtf8(runId)) {
    hash = Math.imul((hash ^ byte) >>> 0, 16_777_619) >>> 0;
  }
  return hash & 0x7fff_ffff;
}

/** automations.rs:3701–3703. */
export function heartbeatIsSilent(content: string): boolean {
  return rustTrim(content) === 'HEARTBEAT_OK';
}

async function queryWindowFlag(deps: NotificationDeps, op: string): Promise<boolean> {
  try {
    return await deps.shell.request<boolean>(op, { label: 'main' }) === true;
  } catch {
    // Rust `window.is_focused().unwrap_or(false)` 等：查询失败按不活跃处理。
    return false;
  }
}

/** automations.rs:3039–3047：窗口缺失/查询失败时按不活跃处理（宁多勿漏）。 */
export async function mainWindowIsActive(deps: NotificationDeps): Promise<boolean> {
  const focused = await queryWindowFlag(deps, 'plugin:window|is_focused');
  const visible = await queryWindowFlag(deps, 'plugin:window|is_visible');
  const minimized = await queryWindowFlag(deps, 'plugin:window|is_minimized');
  return focused && visible && !minimized;
}

/** Rust `current_policy`：设置读取失败按默认档 `background`。 */
function fallbackPolicy(deps: NotificationDeps): SystemNotificationPolicy {
  try {
    return policyFromRaw(deps.settings.get(POLICY_SETTING_KEY));
  } catch {
    return 'background';
  }
}

async function sendNotification(
  deps: NotificationDeps, runId: string, title: string, body: string,
): Promise<boolean> {
  try {
    await deps.shell.request('plugin:notification|notify', {
      options: { id: notificationIdForRun(runId), title, body },
    });
    return true;
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] notification failed for '${title}': ${errorMessage(error)}`);
    return false;
  }
}

/** Rust `let _ = set_run_delivery_marker(...)`：只是尽力清理，失败继续。 */
function clearNotificationMarker(
  deps: NotificationDeps, runId: string, attempt: number, status: string,
): void {
  try {
    setRunDeliveryMarker(deps.db, runId, attempt, status, 'notification_pending', false);
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] clear notification marker failed for '${runId}': ${errorMessage(error)}`);
  }
}

function clearNotificationPending(
  deps: NotificationDeps, runId: string, attempt: number, status: string,
): void {
  clearNotificationMarker(deps, runId, attempt, status);
  if (status === 'running') return;
  try {
    setNotificationRetryAt(deps.db, runId, attempt, status, null);
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] clear notification retry failed for '${runId}': ${errorMessage(error)}`);
  }
}

function releaseNotificationReservation(
  deps: NotificationDeps, runId: string, attempt: number, status: string,
): void {
  try {
    setRunDeliveryMarker(deps.db, runId, attempt, status, 'notification', false);
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] release notification reservation failed: ${errorMessage(error)}`);
  }
}

function releaseAndScheduleRetry(
  deps: NotificationDeps, runId: string, attempt: number, status: string,
): void {
  releaseNotificationReservation(deps, runId, attempt, status);
  if (status === 'running') return;
  const retryAt = formatTimestampMillis(deps.now() + NOTIFICATION_RETRY_DELAY_MS);
  try {
    setNotificationRetryAt(deps.db, runId, attempt, status, retryAt);
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] failed to schedule notification retry: ${errorMessage(error)}`);
  }
}

/**
 * automations.rs:3086–3219：先落 marker 再投递（at-most-once），
 * 并区分窗口活跃/策略 never 抑制与真正失败。
 *
 * 有 F2 `systemNotification` 时策略由它判定；窗口活跃判断必须像 Rust
 * 一样发生在 at-most-once 预约之前，因此先经公开窗口 shell 原语预检，
 * 再交给 F2 投递。本 lane 只在 `delivered:true` 时写送达回执，抑制时清
 * pending，失败时释放预约并补投。
 */
export async function deliverRunNotification(
  deps: NotificationDeps, request: RunNotificationRequest,
): Promise<RunNotificationOutcome> {
  const { runId, attempt, status, title, body } = request;
  const existing = loadRunDeliveries(deps.db, runId);
  if (existing.includes('notification')) {
    clearNotificationMarker(deps, runId, attempt, status);
    return { handled: true, deliveredOs: false };
  }

  if (deps.notification !== undefined) {
    if (deps.notification.notificationsDisabled()) {
      clearNotificationPending(deps, runId, attempt, status);
      return { handled: true, deliveredOs: false };
    }

    // Rust `automations.rs:3131–3147` checks the main window before the
    // at-most-once reservation, so a suppression never reserves a delivery.
    // F2 only reports `window-active` after `notify()`, hence use the same
    // public window shell ops as the fallback for the pre-reserve decision.
    if (request.suppressIfWindowActive && await mainWindowIsActive(deps)) {
      clearNotificationPending(deps, runId, attempt, status);
      return { handled: true, deliveredOs: false };
    }

    try {
      if (!setRunDeliveryMarker(deps.db, runId, attempt, status, 'notification', true)) {
        return { handled: false, deliveredOs: false };
      }
    } catch (error) {
      deps.logger.warn(`[AutomationScheduler] reserve notification failed: ${errorMessage(error)}`);
      return { handled: false, deliveredOs: false };
    }

    let outcome: SystemNotificationOutcome;
    try {
      outcome = await deps.notification.notify({
        id: notificationIdForRun(runId),
        title,
        body,
        // 窗口已在预约前按 Rust 顺序判定；避免 F2 二次查询把 Rust 的
        // “查询失败按不活跃继续”改成投递失败并补投。
        suppressIfWindowActive: false,
      });
    } catch (error) {
      outcome = { delivered: false, suppressed: null, error: errorMessage(error) };
    }

    if (outcome.delivered) {
      clearNotificationPending(deps, runId, attempt, status);
      return { handled: true, deliveredOs: true };
    }
    if (outcome.suppressed !== null) {
      // suppression was decided after our at-most-once reservation; undo it
      // so a later policy/window change can still deliver this run.
      releaseNotificationReservation(deps, runId, attempt, status);
      clearNotificationPending(deps, runId, attempt, status);
      return { handled: true, deliveredOs: false };
    }

    deps.logger.warn(`[AutomationScheduler] notification failed for '${title}': ${outcome.error}`);
    releaseAndScheduleRetry(deps, runId, attempt, status);
    return { handled: false, deliveredOs: false };
  }

  if (fallbackPolicy(deps) === 'never') {
    clearNotificationPending(deps, runId, attempt, status);
    return { handled: true, deliveredOs: false };
  }

  if (request.suppressIfWindowActive && await mainWindowIsActive(deps)) {
    clearNotificationPending(deps, runId, attempt, status);
    return { handled: true, deliveredOs: false };
  }

  try {
    if (!setRunDeliveryMarker(deps.db, runId, attempt, status, 'notification', true)) {
      return { handled: false, deliveredOs: false };
    }
  } catch (error) {
    deps.logger.warn(`[AutomationScheduler] reserve notification failed: ${errorMessage(error)}`);
    return { handled: false, deliveredOs: false };
  }

  if (await sendNotification(deps, runId, title, body)) {
    clearNotificationPending(deps, runId, attempt, status);
    return { handled: true, deliveredOs: true };
  }

  releaseAndScheduleRetry(deps, runId, attempt, status);
  return { handled: false, deliveredOs: false };
}

function pendingBody(lang: NotificationLang, candidate: PendingNotificationRun): string {
  if (candidate.status === 'success') {
    return notificationSuccessBody(lang, candidate.summary ?? '', candidate.session_id);
  }
  return candidate.error ?? candidate.summary ?? notificationFailedFallbackBody(lang);
}

/** automations.rs:5296–5380. */
export async function deliverPendingAgentNotifications(deps: NotificationDeps): Promise<number> {
  const lang = notificationLanguage(deps.settings.get('language'));
  let delivered = 0;
  for (const candidate of listPendingNotificationRuns(deps.db, deps.now())) {
    if (!candidate.delivered.includes('notification_pending')) continue;
    const successful = candidate.status === 'success';
    const outcome = await deliverRunNotification(deps, {
      runId: candidate.run_id,
      attempt: candidate.attempt,
      status: candidate.status,
      title: successful
        ? notificationTitleSuccess(lang, candidate.automation_name)
        : notificationTitleFailed(lang, candidate.automation_name),
      body: pendingBody(lang, candidate),
      suppressIfWindowActive: true,
    });
    if (outcome.handled) delivered += 1;
  }
  return delivered;
}
