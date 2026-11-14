/**
 * 安装桌面本地运行时端口：供不经宿主、直接调用按路径读写模块的测试使用
 * （`tests/protocols.test.ts` 直接调用协议处理函数）。宿主测试由 `index.ts` 入口在 apply 时注入。
 */
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';

setLocalRuntime(nodeLocalRuntime);
