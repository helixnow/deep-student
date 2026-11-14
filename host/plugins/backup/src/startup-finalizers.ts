/**
 * V09-P1-3：每个 Host（root 上下文）对每个名字只登记一个转发钩子，
 * 用 registry 的 signal 在插件卸载时真正注销，并移除 slot 缓存：
 * - 卸载后 registry 不再持有该实例的钩子；重装重新登记新实例；
 * - finalizer 已跑过则不再补跑恢复动作；
 * - finalizer 已开始后才首次安装：默认跳过启动收尾并记 warn。恢复激活必须先于业务插件打开数据库，
 *   晚补会在已打开的连接下切换数据，比不做更危险。自动备份调度器这类只需“启动后开始”的项传
 *   `late: 'run'`：首次安装晚于 finalizer、或重装时该项已执行过，都在安装时立即执行一次。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { StartupFinalizerOptions } from '../../../platform/storage/api.ts';

type Finalizer = () => void | Promise<void>;

export interface BindStartupFinalizerOptions extends StartupFinalizerOptions {
  /** 本 Host 的启动收尾已越过这一项时：`skip`（默认）不补跑；`run` 在安装时立即执行。 */
  late?: 'skip' | 'run';
}

interface Slot { current: Finalizer | null; ran: boolean; controller: AbortController }

const slotsByHost = new WeakMap<object, Map<string, Slot>>();

function isLateRegistration(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'FINALIZER_LATE_REGISTRATION';
}

function runLate(ctx: Context, name: string, fn: Finalizer): void {
  const warn = (error: unknown): void => {
    ctx.logger('backup').warn(`[DataGovernance] 启动收尾 ${name} 补跑失败: ${error instanceof Error ? error.message : String(error)}`);
  };
  try { void Promise.resolve(fn()).catch(warn); }
  catch (error) { warn(error); }
}

/** 把本插件实例的启动收尾回调绑定到 `name`，生命周期跟随 `ctx`。返回是否已绑定。 */
export function bindStartupFinalizer(
  ctx: Context,
  name: string,
  fn: Finalizer,
  options: BindStartupFinalizerOptions = {},
): boolean {
  const { late = 'skip', ...registerOptions } = options;
  const slots = slotsByHost.get(ctx.root) ?? new Map<string, Slot>();
  slotsByHost.set(ctx.root, slots);
  let slot = slots.get(name);
  if (!ctx.storage.finalizerNames().includes(name)) {
    // 新 Host 或 storage 被替换（新 registry）：登记新的转发钩子。
    const fresh: Slot = { current: null, ran: false, controller: new AbortController() };
    const registration: StartupFinalizerOptions & { readonly signal: AbortSignal } = { ...registerOptions, signal: fresh.controller.signal };
    try {
      ctx.storage.registerFinalizer(name, () => {
        fresh.ran = true;
        return fresh.current?.();
      }, registration);
    } catch (error) {
      if (!isLateRegistration(error)) throw error;
      if (late === 'run') {
        runLate(ctx, name, fn);
      } else {
        ctx.logger('backup').warn(`[DataGovernance] 启动收尾已开始，跳过 ${name}：本次安装不执行这一项`);
      }
      return false;
    }
    slots.set(name, slot = fresh);
  } else if (slot === undefined) {
    ctx.logger('backup').warn(`[DataGovernance] 启动收尾 ${name} 已由其他实例登记，保留首个登记`);
    return false;
  }
  const bound = slot;
  bound.current = fn;
  ctx.effect(() => () => {
    if (bound.current !== fn) return;
    bound.current = null;
    bound.controller.abort();
    if (slots.get(name) === bound) slots.delete(name);
  });
  if (bound.ran && late === 'run') runLate(ctx, name, fn);
  return true;
}
