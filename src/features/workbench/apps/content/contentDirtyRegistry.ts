/**
 * 内容应用脏状态注册表（P8）
 *
 * AppDefinition.canClose 的未保存拦截挂点：编辑类视图（note/essay/translation）
 * 可在此注册"当前是否有未保存修改"的查询函数，关窗前由 canClose 询问。
 *
 * 现状：现有 views/*ContentView 未暴露脏状态查询接口（NotesCrepeEditor 的
 * isDirty 为组件内部状态），因此本注册表暂时不会被现有视图填充——
 * 已在 P8 进度文件记录为遗留项，交由 P11/后续在视图层接线。
 */

const checkers = new Map<string, () => boolean>();

function keyOf(typeId: string, instanceKey: string | null): string {
  return `${typeId}::${instanceKey ?? ''}`;
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
  checkers.set(key, isDirty);
  return () => {
    if (checkers.get(key) === isDirty) {
      checkers.delete(key);
    }
  };
}

/** 查询某个资源实例是否有未保存修改（未注册 = 视为干净） */
export function isContentDirty(typeId: string, instanceKey: string | null): boolean {
  try {
    return checkers.get(keyOf(typeId, instanceKey))?.() ?? false;
  } catch {
    // 查询函数异常时宁可放行关闭，也不要把窗口锁死
    return false;
  }
}

/** 仅供测试：清空注册表 */
export function __resetContentDirtyRegistry(): void {
  checkers.clear();
}
