/**
 * 内容应用脏状态注册表（P8）
 *
 * AppDefinition.canClose 的未保存拦截挂点：编辑类视图（note/essay/translation）
 * 可在此注册"当前是否有未保存修改"的查询函数，关窗前由 canClose 询问。
 *
 * 同一资源允许正文、标题、附件等多个编辑面分别注册 checker；任一 dirty
 * 即触发关闭确认。资源键统一规范化为 DSTU 叶 ID，避免路径别名绕过保护。
 */

import { normalizeResourceInstanceKey } from './resourceIdentity';

export type ContentSaveState = 'saved' | 'saving' | 'dirty' | 'failed' | 'conflict';

const checkers = new Map<string, Set<() => boolean>>();

type ContentSaveHandler = () => Promise<void>;

/** 「保存并关闭」的保存挂点：视图注册后，关窗确认对话框才提供保存选项 */
const saveHandlers = new Map<string, Set<ContentSaveHandler>>();

function keyOf(typeId: string, instanceKey: string | null): string {
  return `${typeId}::${normalizeResourceInstanceKey(instanceKey) ?? ''}`;
}

/**
 * 注册某个资源实例的脏状态查询函数。
 * 返回注销函数（视图卸载时调用）。
 */
export function registerContentDirtyChecker(
  typeId: string,
  instanceKey: string | null,
  isDirty: () => boolean,
): () => void {
  const key = keyOf(typeId, instanceKey);
  const existing = checkers.get(key) ?? new Set<() => boolean>();
  existing.add(isDirty);
  checkers.set(key, existing);
  return () => {
    const registered = checkers.get(key);
    registered?.delete(isDirty);
    if (registered?.size === 0) {
      checkers.delete(key);
    }
  };
}

function anyCheckerDirty(registered: Set<() => boolean>): boolean {
  for (const checker of registered) {
    try {
      if (checker()) return true;
    } catch {
      // A broken checker must still surface the close confirmation. The user
      // can explicitly confirm, while silently treating it as clean loses data.
      return true;
    }
  }
  return false;
}

/** 查询某个资源实例是否有未保存修改（未注册 = 视为干净） */
export function isContentDirty(typeId: string, instanceKey: string | null): boolean {
  const registered = checkers.get(keyOf(typeId, instanceKey));
  if (!registered) return false;
  return anyCheckerDirty(registered);
}

/**
 * 是否存在任一注册资源处于 dirty 状态（同步，供 suspend 决策等全局查询）。
 * 纯查询：不卸载任何视图、不触发保存；checker 抛错沿用 fail-closed 语义计为 dirty。
 */
export function isAnyContentDirty(): boolean {
  for (const registered of checkers.values()) {
    if (anyCheckerDirty(registered)) return true;
  }
  return false;
}

/**
 * 列出当前所有 dirty 资源的注册键（同步，供 suspend 决策等全局查询）。
 * key 格式与内部 keyOf 一致：`${typeId}::${normalizedInstanceKey}`。
 * 纯查询：不卸载任何视图、不触发保存；checker 抛错的资源计为 dirty 一并列出。
 */
export function listDirtyContentKeys(): string[] {
  const dirtyKeys: string[] = [];
  for (const [key, registered] of checkers) {
    if (anyCheckerDirty(registered)) dirtyKeys.push(key);
  }
  return dirtyKeys;
}

/**
 * 注册某个资源实例的「立即保存」处理函数（供关窗确认的「保存并关闭」调用）。
 * 返回注销函数（视图卸载时调用）。
 */
export function registerContentSaveHandler(
  typeId: string,
  instanceKey: string | null,
  save: ContentSaveHandler,
): () => void {
  const key = keyOf(typeId, instanceKey);
  const existing = saveHandlers.get(key) ?? new Set<ContentSaveHandler>();
  existing.add(save);
  saveHandlers.set(key, existing);
  return () => {
    const registered = saveHandlers.get(key);
    registered?.delete(save);
    if (registered?.size === 0) {
      saveHandlers.delete(key);
    }
  };
}

/** 某个资源实例是否有保存处理函数（决定关窗确认是否提供「保存并关闭」） */
export function hasContentSaveHandler(typeId: string, instanceKey: string | null): boolean {
  return (saveHandlers.get(keyOf(typeId, instanceKey))?.size ?? 0) > 0;
}

/**
 * 立即执行某个资源实例的所有保存处理函数。
 * 全部成功返回 true；任一失败/无注册返回 false（关窗流程据此保持窗口打开）。
 *
 * 「保存后是否仍 dirty」的最终屏障由各保存 handler 自行保证（如 note 的
 * handler 在 flush 后复查 isContentDirty 并抛出）。此处不做通用复查：essay /
 * translation 等资源存在“草稿级持久化但基线有意保持 dirty”的语义，通用复查
 * 会把它们的保存并关闭误判为失败。
 */
export async function saveContentNow(typeId: string, instanceKey: string | null): Promise<boolean> {
  const registered = saveHandlers.get(keyOf(typeId, instanceKey));
  if (!registered || registered.size === 0) return false;
  try {
    // 顺序执行（注册顺序 = 子组件优先）：标题等字段级提交先于正文 flush，
    // 正文 handler 的“仍 dirty”复查才能看到标题已提交，避免误判关闭失败。
    for (const save of registered) {
      await save();
    }
    return true;
  } catch {
    // 保存失败不放行关闭：视图侧的保存错误 UI（重试条/toast）负责展示细节
    return false;
  }
}

/**
 * C16：为需要快照一致性的批量操作（文库导出等）冲刷所有 dirty 资源。
 * 复用 saveContentNow（含最终 dirty 屏障）；返回 true = 调用时刻全部落盘。
 *
 * 逐资源顺序执行而非并发，避免同一底层文件的并发写产生 OCC 冲突。
 */
export async function flushAllDirtyContent(): Promise<boolean> {
  const keys = listDirtyContentKeys();
  if (keys.length === 0) return true;
  let allSaved = true;
  for (const key of keys) {
    const separator = key.indexOf('::');
    if (separator < 0) continue;
    const typeId = key.slice(0, separator);
    const instanceKey = key.slice(separator + 2) || null;
    const saved = await saveContentNow(typeId, instanceKey);
    if (!saved) allSaved = false;
  }
  return allSaved;
}

/** 仅供测试：清空注册表 */
export function __resetContentDirtyRegistry(): void {
  checkers.clear();
  saveHandlers.clear();
}
