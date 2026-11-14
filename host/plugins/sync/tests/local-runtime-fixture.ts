/**
 * 单元测试装桌面入口注入的同一份本地运行时端口。
 *
 * 快照、资产树扫描与导出/导入经 `src/local-runtime.ts` 端口；文件级传输（`calculateFileHash`、
 * 断点续传落地）经 sync-providers 的 `src/local-fs.ts` 端口。生产上两个桌面入口都会注入，
 * 这里一起装（模块级 `beforeAll` / `afterAll` 安装与还原）。
 */
import { afterAll, beforeAll } from 'vitest';
import { setLocalFs } from '../../sync-providers/src/local-fs.ts'; // boundary-allow cross-plugin-impl: test fixture wires desktop localFs runtime port directly
import { nodeLocalFs } from '../../sync-providers/src/local-fs.node.ts'; // boundary-allow cross-plugin-impl: test fixture wires desktop localFs runtime port directly
import { setLocalRuntime } from '../src/local-runtime.ts';
import { nodeLocalRuntime } from '../src/local-runtime.node.ts';

beforeAll(() => {
  setLocalRuntime(nodeLocalRuntime);
  setLocalFs(nodeLocalFs);
});
afterAll(() => {
  setLocalRuntime(null);
  setLocalFs(null);
});
