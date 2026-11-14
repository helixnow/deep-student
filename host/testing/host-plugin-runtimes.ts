/**
 * `vitest.host.config.ts` 的 setupFiles：给桌面测试注入各插件的同步本地运行时端口。
 *
 * 生产环境由插件入口（各插件的 `index.ts`）注入 `node:fs` / `node:worker_threads` 实现；
 * 移动端入口（`mobile.ts`）不注入，缺省端口按“不可用”降级。而测试里既有经插件宿主取服务的
 * 用例，也有直接 `new BlobRepo()` / `new FileRepo()` / `new AttachmentRepo()` 的跨插件用例
 * （media、browser、qbank 的测试宿主），后者不经过入口，因此在这里统一补上桌面实现，
 * 保持这些用例的真实文件读写语义。
 *
 * 只影响 vitest host 测试，不参与打包与运行时。
 */
// boundary-allow test-double: vitest setupFile registered in vitest.host.config.ts
import { beforeEach } from 'vitest';
import {
  PROBE_TIMEOUT_MS,
  acrBridgeCall,
  applyOpsTimeoutMs,
  isBridgeCancelled,
  isWorkbenchAgentDelegationEnabled,
  isValidApplyReceipt,
  uncertainApplyReceipt,
} from '../plugins/agent-skills/api.ts';
import { setQbankLocalRuntime } from '../plugins/qbank/src/local-runtime.ts';
import { nodeQbankLocalRuntime } from '../plugins/qbank/src/local-runtime.node.ts';
import { setVfsReposLocalRuntime } from '../plugins/vfs-repos/src/local-runtime.ts';
import { nodeVfsReposLocalRuntime } from '../plugins/vfs-repos/src/local-runtime.node.ts';
import { setLocalRuntime as setVfsLocalRuntime } from '../plugins/vfs/src/local-runtime.ts';
import { nodeLocalRuntime as nodeVfsLocalRuntime } from '../plugins/vfs/src/local-runtime.node.ts';
import { setWorkbenchBridge as setVfsWorkbenchBridge } from '../plugins/vfs/src/workbench-bridge.ts';

function installDesktopRuntimes(): void {
  setVfsReposLocalRuntime(nodeVfsReposLocalRuntime);
  setQbankLocalRuntime(nodeQbankLocalRuntime);
  setVfsLocalRuntime(nodeVfsLocalRuntime);
  setVfsWorkbenchBridge({
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    acrBridgeCall,
    applyOpsTimeoutMs,
    isBridgeCancelled,
    isValidApplyReceipt,
    isWorkbenchAgentDelegationEnabled,
    uncertainApplyReceipt,
  });
}

installDesktopRuntimes();

// 插件的 dispose 会把端口还原成缺省（无本地文件系统）。测试里同一个文件经常先建宿主再
// 直接 new 仓储/导出桥，因此每条用例开始前重新装回桌面实现。
beforeEach(installDesktopRuntimes);
