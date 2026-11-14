/**
 * 单元测试装桌面入口注入的同一份本地文件端口（`node:fs/promises`）。
 *
 * 传输与增量归档按路径读写文件，代码里经 `src/local-fs.ts` 端口；生产上由 `index.ts` 注入。
 * 直接 import 本模块即可（模块级 `beforeAll` / `afterAll` 安装与还原）。
 */
import { afterAll, beforeAll } from 'vitest';
import { setLocalFs } from '../src/local-fs.ts';
import { nodeLocalFs } from '../src/local-fs.node.ts';

beforeAll(() => { setLocalFs(nodeLocalFs); });
afterAll(() => { setLocalFs(null); });
