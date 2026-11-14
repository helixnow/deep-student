/**
 * 测试用的完整 `ctx.files`：根为本次测试的 appData 目录（含 slots 下全部数据槽），
 * 外加系统临时目录（OCR 临时图片等绝对路径）。生产宿主由 `dstu.platform.files` 提供。
 */
import os from 'node:os';
import { createNodeFiles } from '../../../../platform/files/index.ts';
import type { FilesService } from '../../../../platform/files/api.ts';

export function testFiles(storage: { readonly locations: { readonly baseDir: string } }): FilesService {
  return createNodeFiles({
    roots: [
      { name: 'appData', path: storage.locations.baseDir },
      { name: 'temp', path: os.tmpdir() },
    ],
  });
}
