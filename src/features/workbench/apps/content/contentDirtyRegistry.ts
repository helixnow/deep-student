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

const checkers = new Map<string, Set<() => boolean>>();

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

/** 查询某个资源实例是否有未保存修改（未注册 = 视为干净） */
export function isContentDirty(typeId: string, instanceKey: string | null): boolean {
  const registered = checkers.get(keyOf(typeId, instanceKey));
  if (!registered) return false;
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

/** 仅供测试：清空注册表 */
export function __resetContentDirtyRegistry(): void {
  checkers.clear();
}
