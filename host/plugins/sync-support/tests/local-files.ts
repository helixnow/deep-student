import os from 'node:os';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { filesTombstonePort, type TombstoneLocalFiles } from '../src/tombstone-files.ts';

/** 桌面 `ctx.files` 实现（允许根 = 系统临时目录）支撑的 tombstone 本地文件端口。 */
export function tempDirLocalFiles(): TombstoneLocalFiles {
  const files = createNodeFiles({ roots: [{ name: 'temp', path: os.tmpdir() }] });
  return filesTombstonePort(() => files);
}
