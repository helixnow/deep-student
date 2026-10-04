/**
 * ACR 用户可见文案 i18n 契约（源码扫描）：
 * - noteDriver 回执 / 进度 / reviewing label → workbench:agent.drivers.note.*（tNote）
 * - stageManager 中止原因 / presence 兜底 → workbench:agent.*（tAgent）
 *
 * 断言每个 key 在 zh-CN / en-US 均存在，且 zh-CN 文案与源码 defaultValue 完全一致
 * （namespace 异步加载窗口期回落 defaultValue 时中文界面不变）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import zhCN from '@/locales/zh-CN/workbench.json';
import enUS from '@/locales/en-US/workbench.json';

function lookup(bundle: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

function collectCalls(file: string, helper: string): Array<{ key: string; defaultValue: string }> {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const pattern = new RegExp(`${helper}\\(\\s*'([\\w.]+)',\\s*'([^']*)'`, 'g');
  return [...source.matchAll(pattern)].map((m) => ({ key: m[1]!, defaultValue: m[2]! }));
}

const CASES = [
  {
    file: 'src/features/workbench/agent/drivers/noteDriver.ts',
    helper: 'tNote',
    prefix: 'agent.drivers.note.',
    min: 30,
  },
  {
    file: 'src/features/workbench/agent/stageManager.ts',
    helper: 'tAgent',
    prefix: 'agent.',
    min: 6,
  },
];

describe('workbench agent receipt i18n contract', () => {
  for (const { file, helper, prefix, min } of CASES) {
    it(`${file} 的 ${helper} key 双语齐全且 zh-CN 与 defaultValue 一致`, () => {
      const calls = collectCalls(file, helper);
      expect(calls.length).toBeGreaterThanOrEqual(min);
      for (const { key, defaultValue } of calls) {
        const fullKey = `${prefix}${key}`;
        expect(lookup(zhCN, fullKey), fullKey).toBe(defaultValue);
        const en = lookup(enUS, fullKey);
        expect(typeof en, fullKey).toBe('string');
        expect(en as string, fullKey).not.toMatch(/[一-鿿]/);
      }
    });
  }
});
