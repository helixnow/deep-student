/**
 * util 的入口：`portable.ts`（可移植）、`node.ts`（依赖 Node，仅桌面）、`index.ts` / `api.ts`（兼容桶）。
 * 桶文件已去掉 Node 专有重导出，与 `portable.ts` 一样可移植：每个运行时导出都必须与 `portable.ts` 中的
 * 同名值完全相同，且不含任何只属于 `node.ts` 的名字。需要 ZIP、QR PNG 或返回 `Buffer` 的 base64 解码器时
 * 从 `node.ts` 导入。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as api from '../api.ts';
import * as barrel from '../index.ts';
import * as nodeOnly from '../node.ts';
import * as portable from '../portable.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NODE_NAMES = Object.keys(nodeOnly).sort();

describe('platform/util entries', () => {
  it('node.ts and portable.ts share only the base64 decoder name, which differs by return type', () => {
    expect(NODE_NAMES.filter((name) => name in portable)).toEqual(['decodeBase64Standard']);
    expect(nodeOnly.decodeBase64Standard).not.toBe(portable.decodeBase64Standard);
  });

  it.each([['index.ts', barrel], ['api.ts', api]] as const)('%s exports only values identical to portable.ts', (_file, entry) => {
    for (const [name, value] of Object.entries(entry)) {
      expect(name in portable, name).toBe(true);
      expect(value, name).toBe((portable as Record<string, unknown>)[name]);
    }
  });

  it.each([['index.ts', barrel], ['api.ts', api]] as const)('%s carries no Node-specific name', (_file, entry) => {
    const exported = Object.keys(entry);
    expect(NODE_NAMES.filter((name) => !(name in portable) && exported.includes(name))).toEqual([]);
    expect((entry as Record<string, unknown>).decodeBase64Standard).toBe(portable.decodeBase64Standard);
  });

  it('node.ts is the entry that carries the Node dependencies; portable.ts and both barrels carry none', () => {
    for (const file of ['portable.ts', 'index.ts', 'api.ts']) {
      expect(checkModulesClosure(ROOT, [`host/platform/util/${file}`]), file).toEqual([]);
    }
    expect(checkModulesClosure(ROOT, ['host/platform/util/node.ts']).map((violation) => violation.key)).toContain('node-builtin:zlib');
  });
});
