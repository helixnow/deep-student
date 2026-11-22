/**
 * Milkdown Ctx 跨模块实例兼容桥。
 *
 * Milkdown 的 SliceType / TimerType 内部用 `Symbol(...)` 做容器键。
 * 在 Vite 开发态依赖预构建（`@milkdown/crepe` 与懒加载的 `@milkdown/kit/*` / `@milkdown/core`
 * / `@milkdown/utils` 分批优化）或重复解析同一包的不同副本时，插件侧持有的 `schemaTimerCtx`、
 * `nodesCtx`、`SchemaReady` 等键会与 `Crepe` 内部 `Editor` 注入的 Symbol 不同，导致初始化时
 * 抛出 `MilkdownError: Context "schemaTimer" not found, do you forget to inject it?` 并白屏。
 *
 * 本桥在 `crepe.create()` 前轻量包裹 `editor.ctx`：
 * - 正常单实例路径走原 Symbol 查表（零额外开销、语义完全不变）；
 * - 仅当 Symbol 未命中时，按 `slice.name`（Milkdown Container 原生支持字符串查找）与
 *   `timer.name`（记录的 TimerType 按名索引 + 核心 timer slice 兜底）回退到当前编辑器实例的真值。
 */

interface NamedKey {
  name?: unknown;
}

interface MilkdownCtxLike {
  isInjected?: (slice: unknown) => boolean;
  use?: (slice: unknown) => { get: () => unknown };
  remove?: (slice: unknown) => unknown;
  record?: (timer: unknown) => unknown;
  clearTimer?: (timer: unknown) => unknown;
  isRecorded?: (timer: unknown) => boolean;
  timer?: (timer: unknown) => unknown;
  produce?: (meta?: unknown) => unknown;
}

const CORE_TIMER_SLICE_NAMES = [
  'initTimer',
  'schemaTimer',
  'parserTimer',
  'serializerTimer',
  'commandsTimer',
  'keymapTimer',
  'pasteRulesTimer',
  'editorStateTimer',
  'editorViewTimer',
] as const;

const patchedContexts = new WeakSet<object>();

function getKeyName(key: unknown): string | null {
  if (!key || typeof key !== 'object') return null;
  const name = (key as NamedKey).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export function installMilkdownCtxCompat(
  rawCtx: unknown,
  sharedTimersByName?: Map<string, unknown>,
): void {
  if (!rawCtx || typeof rawCtx !== 'object') return;
  if (patchedContexts.has(rawCtx)) return;

  const ctx = rawCtx as MilkdownCtxLike;
  if (
    typeof ctx.isInjected !== 'function' ||
    typeof ctx.use !== 'function' ||
    typeof ctx.record !== 'function' ||
    typeof ctx.isRecorded !== 'function' ||
    typeof ctx.timer !== 'function'
  ) {
    return;
  }

  patchedContexts.add(rawCtx);

  const timersByName = sharedTimersByName ?? new Map<string, unknown>();
  const origIsInjected = ctx.isInjected.bind(ctx);
  const origUse = ctx.use.bind(ctx);
  const origRemove = typeof ctx.remove === 'function' ? ctx.remove.bind(ctx) : null;
  const origRecord = ctx.record.bind(ctx);
  const origClearTimer = typeof ctx.clearTimer === 'function' ? ctx.clearTimer.bind(ctx) : null;
  const origIsRecorded = ctx.isRecorded.bind(ctx);
  const origTimer = ctx.timer.bind(ctx);
  const origProduce = typeof ctx.produce === 'function' ? ctx.produce.bind(ctx) : null;

  const resolveSliceKey = (slice: unknown): unknown => {
    if (typeof slice === 'string' || origIsInjected(slice)) return slice;
    const name = getKeyName(slice);
    if (name && origIsInjected(name)) return name;
    return slice;
  };

  const resolveTimerKey = (timer: unknown): unknown => {
    if (origIsRecorded(timer)) return timer;
    const name = getKeyName(timer);
    if (!name) return timer;

    const cached = timersByName.get(name);
    if (cached && origIsRecorded(cached)) return cached;

    for (const sliceName of CORE_TIMER_SLICE_NAMES) {
      if (!origIsInjected(sliceName)) continue;
      const list = origUse(sliceName).get();
      if (!Array.isArray(list)) continue;
      for (const candidate of list) {
        if (getKeyName(candidate) === name && origIsRecorded(candidate)) {
          timersByName.set(name, candidate);
          return candidate;
        }
      }
    }
    return timer;
  };

  ctx.isInjected = (slice: unknown): boolean => {
    if (origIsInjected(slice)) return true;
    const name = getKeyName(slice);
    return name ? origIsInjected(name) : false;
  };

  ctx.use = (slice: unknown) => origUse(resolveSliceKey(slice));

  if (origRemove) {
    ctx.remove = (slice: unknown) => origRemove(resolveSliceKey(slice));
  }

  ctx.record = (timer: unknown) => {
    const name = getKeyName(timer);
    if (name) timersByName.set(name, timer);
    return origRecord(timer);
  };

  ctx.isRecorded = (timer: unknown): boolean => origIsRecorded(resolveTimerKey(timer));

  ctx.timer = (timer: unknown) => origTimer(resolveTimerKey(timer));

  if (origClearTimer) {
    ctx.clearTimer = (timer: unknown) => {
      const resolved = resolveTimerKey(timer);
      const name = getKeyName(resolved);
      if (name && timersByName.get(name) === resolved) {
        timersByName.delete(name);
      }
      return origClearTimer(resolved);
    };
  }

  if (origProduce) {
    ctx.produce = (meta?: unknown) => {
      const produced = origProduce(meta);
      if (produced && produced !== ctx) {
        installMilkdownCtxCompat(produced, timersByName);
      }
      return produced;
    };
  }
}
