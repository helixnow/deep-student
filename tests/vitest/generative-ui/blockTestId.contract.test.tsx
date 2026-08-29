/**
 * Contract: 18 种内置块必须稳定暴露 data-generative-block="<type>"
 *
 * 由 GenerativeBlockSlot 统一挂载（未知 / 校验失败块同样挂上），
 * 供测试、CT、宿主探测使用。禁止各 *Block.tsx 再各自写一份以免分叉。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { GenerativeUIRenderer, generativeUIRegistry } from '@/features/generative-ui';
import {
  ALL_BLOCK_TYPES,
  buildAllBlocksGridIntent,
  buildAllBlocksIntent,
  buildSingleBlockIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析',
        unknown_block_title: `未知：${params?.type ?? ''}`,
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'action.unregistered_hint': '未注册',
        'action.confirm_title': `确认：${params?.label ?? ''}`,
        'action.confirm_desc': '确认描述',
        'action.confirm_execute': '确认执行',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';

const REQUIRED_EIGHTEEN = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
  'paper-digest',
  'research-plan',
  'research-report',
  'markdown',
  'chart',
  'steps',
  'table',
] as const;

const SLOT_SRC = path.join(
  process.cwd(),
  'src/features/generative-ui/components/GenerativeBlockSlot.tsx',
);
const BLOCKS_DIR = path.join(process.cwd(), 'src/features/generative-ui/components');

function collectGenerativeBlockAttrs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-generative-block]')).map(
    (el) => el.getAttribute('data-generative-block') ?? '',
  );
}

describe('blockTestId.contract — data-generative-block', () => {
  it('fixture + registry cover exactly the 18 built-in types', () => {
    expect(ALL_BLOCK_TYPES).toHaveLength(18);
    expect([...ALL_BLOCK_TYPES].sort()).toEqual([...REQUIRED_EIGHTEEN].sort());
    const registered = new Set(generativeUIRegistry.keys());
    for (const type of REQUIRED_EIGHTEEN) {
      expect(registered.has(type), `missing registry entry: ${type}`).toBe(true);
    }
  });

  it('GenerativeBlockSlot is the single source of data-generative-block={type}', () => {
    const slotSrc = fs.readFileSync(SLOT_SRC, 'utf8');
    expect(slotSrc).toMatch(/data-generative-block=\{type\}/);

    const blockFiles = fs
      .readdirSync(BLOCKS_DIR)
      .filter((f) => f.endsWith('Block.tsx') && f !== 'GenerativeBlockSlot.tsx');
    expect(blockFiles.length).toBeGreaterThanOrEqual(18);
    for (const file of blockFiles) {
      const src = fs.readFileSync(path.join(BLOCKS_DIR, file), 'utf8');
      expect(src, `${file} must not set data-generative-block (Slot is the single source)`).not.toMatch(
        /data-generative-block/,
      );
    }
  });

  it.each(REQUIRED_EIGHTEEN)(
    'renders a single "%s" block with exactly one matching data-generative-block',
    (blockType) => {
      const { container } = render(
        <GenerativeUIRenderer intent={buildSingleBlockIntent(blockType)} showChrome={false} />,
      );
      const matches = container.querySelectorAll(`[data-generative-block="${blockType}"]`);
      expect(matches, `expected one [data-generative-block="${blockType}"]`).toHaveLength(1);
      expect(matches[0]).toHaveAttribute('data-block-type', blockType);
      expect(container.querySelector('[data-block-invalid]')).toBeNull();
    },
  );

  it('all-blocks stack intent exposes each type exactly once', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />,
    );
    const types = collectGenerativeBlockAttrs(container);
    expect(types).toHaveLength(18);
    expect(types.sort()).toEqual([...REQUIRED_EIGHTEEN].sort());
  });

  it('v1.1 grid showcase keeps the same 18 stable selectors', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={buildAllBlocksGridIntent()} showChrome={false} />,
    );
    const types = collectGenerativeBlockAttrs(container);
    expect(types).toHaveLength(18);
    expect(new Set(types)).toEqual(new Set(REQUIRED_EIGHTEEN));
    expect(container.querySelector('[data-layout-mode="grid"]')).toBeTruthy();
  });

  it('unknown block type still gets data-generative-block on the slot', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'not-a-real-block', props: {} }],
        }}
        showChrome={false}
      />,
    );
    const slot = container.querySelector('[data-generative-block="not-a-real-block"]');
    expect(slot).toBeTruthy();
    expect(slot).toHaveAttribute('data-block-type', 'not-a-real-block');
    expect(container.querySelector('[data-block-invalid]')).toBeTruthy();
  });

  it('validation failure still keeps data-generative-block="<type>"', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'stat-card', props: { title: 1 } }],
        }}
        showChrome={false}
      />,
    );
    const slot = container.querySelector('[data-generative-block="stat-card"]');
    expect(slot).toBeTruthy();
    expect(container.querySelector('[data-block-invalid]')).toBeTruthy();
  });
});
