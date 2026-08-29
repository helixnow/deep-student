/**
 * deactivationTransaction — Workbench 停用事务（缝一修复 · 0824 Wave2-B r2）
 *
 * 背景（docs/0824-quality-review/workbench-fg.md 接缝一）：模式开关 / 断点
 * 切壳 / 应用退出此前直接卸载整棵 WorkbenchDesktop，绕过逐窗 canClose——
 * 未保存草稿随 React 子树卸载静默丢失（快照契约只存壳，见 snapshot.ts 头注）。
 * 本模块把三条停用路径收敛到同一个可取消、可回滚的预检事务。
 *
 * 两阶段语义（有意区别于「关闭全部窗口」快捷键的边确认边关）：
 * - phase 1（本函数的全部职责）：枚举 windowStore 当前全部窗口，逐窗
 *   **顺序** await confirmWindowClose（single-flight；顺序而非并行——
 *   canClose 可能弹未保存确认对话框，并行会同时弹多个互相遮挡）。
 *   任一窗口取消 / 保存失败 → { ok: false }：**不关闭任何窗口**（包括
 *   已确认过的），调用方不得 persist 模式、不得派发 WORKBENCH_MODE_CHANGED，
 *   模式开关 UI 回滚。
 * - phase 2（调用方职责）：全部通过后才由调用方执行真正的关窗 / 卸壳；
 *   mode-off 场景成功后调用方才 workbenchBus.setEnabled(false)。
 *
 * canClose 的「保存并关闭」分支在 phase 1 内即完成保存（返回 true =
 * 内容已安全落库），因此 phase 2 直接卸壳不再有数据风险。成功路径顺带
 * flushSnapshot()：壳布局在卸壳前立即落盘，WorkbenchDesktop 卸载 cleanup
 * 里的 flush 只是之后的兜底（unmount cleanup 不能异步阻塞，事务不放那里）。
 *
 * 依赖保持轻量（core 内部 + 启动期已在 App 依赖图中的通知 / i18n 工具），
 * App.tsx 可深路径引入而不把 workbench 主体拖进首屏 chunk。
 */
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { t } from '@/utils/i18n';
import { appRegistry } from './appRegistry';
import { flushSnapshot } from './snapshot';
import { confirmWindowClose, isWindowDirty } from './windowCloseGuard';
import { useWindowStore } from './windowStore';

export type WorkbenchDeactivationReason = 'mode-off' | 'breakpoint' | 'app-exit';

export interface WorkbenchDeactivationResult {
  ok: boolean;
}

// 整个事务 single-flight：模式开关连点 / 退出与开关同时触发时共享同一轮
// 逐窗确认，不会叠加弹第二轮对话框。
let inFlight: Promise<WorkbenchDeactivationResult> | null = null;

export function isWorkbenchDeactivationInFlight(): boolean {
  return inFlight !== null;
}

/**
 * 同步脏窗探测，供 beforeunload 等不能 await 的调用方使用：
 * 窗口级红点（isWindowDirty）∪ 应用 canSuspend 契约的同步分支
 * （false = 有未保存内存态）。与调度器热路径同约定：canSuspend 返回
 * Promise / 缺省按干净处理，回调抛异常按脏处理（fail-closed）。
 */
export function hasDirtyWorkbenchWindows(): boolean {
  const { windows } = useWindowStore.getState();
  for (const win of Object.values(windows)) {
    if (isWindowDirty(win.id)) return true;
    const canSuspend = appRegistry.get(win.typeId)?.canSuspend;
    if (!canSuspend) continue;
    try {
      if (canSuspend(win.instanceKey) === false) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * 停用预检事务（phase 1）。逐窗顺序确认；全过 → { ok: true }，真正的
 * 关窗 / 卸壳由调用方决定（mode-off 成功后调用方才 setEnabled(false)）。
 * 任一取消 → { ok: false }，无任何副作用（已确认的窗也不会被关）。
 */
export function runWorkbenchDeactivationTransaction(
  reason: WorkbenchDeactivationReason,
): Promise<WorkbenchDeactivationResult> {
  if (inFlight) return inFlight;
  const transaction = (async (): Promise<WorkbenchDeactivationResult> => {
    // 枚举一次即可：事务期间新开的窗不参与本次停用决策；已被用户手动
    // 关掉的窗由 confirmWindowClose 按「窗不存在 = 可关」放行。
    const ids = Object.keys(useWindowStore.getState().windows);
    for (const id of ids) {
      const approved = await confirmWindowClose(id);
      if (approved) continue;
      if (import.meta.env.DEV) {
        console.info(
          `[workbench] deactivation (${reason}) cancelled by window ${id}`,
        );
      }
      showGlobalNotification(
        'info',
        t(
          'deactivation.cancelled',
          {
            defaultValue:
              '已取消退出学习桌面：有窗口未确认关闭 / Leaving the desktop was cancelled: a window declined to close.',
          },
          'workbench',
        ),
      );
      return { ok: false };
    }
    try {
      await flushSnapshot();
    } catch {
      // 快照失败不阻塞停用：布局层丢失可接受，数据安全已由逐窗确认保证
    }
    return { ok: true };
  })().finally(() => {
    inFlight = null;
  });
  inFlight = transaction;
  return transaction;
}
