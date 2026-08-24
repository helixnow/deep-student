/**
 * VFS 资源引用注入链路 i18n 契约测试
 *
 * 覆盖「把资源引用注入对话」链路上用户可见错误的 i18n 化：
 * - locale：zh-CN / en-US chat_module.json 均含 vfs_inject 组，插值占位符齐全
 * - key-echo：checkResourceCapacity 走 chat_module:vfs_inject.capacity_exceeded 且带 defaultValue
 * - source 守卫：调用点引用正确的 key，旧的硬编码拼接形式不再出现
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import zhChatModule from '@/locales/zh-CN/chat_module.json';
import enChatModule from '@/locales/en-US/chat_module.json';

const { tCalls } = vi.hoisted(() => ({
  tCalls: [] as Array<{ key: string; options?: Record<string, unknown> }>,
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      tCalls.push({ key, options });
      const vars = options
        ? Object.entries(options).filter(([name]) => name !== 'defaultValue')
        : [];
      return `${key}|${vars.map(([name, value]) => `${name}=${String(value)}`).join(',')}`;
    },
  },
}));

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENHANCEMENTS_PATH = path.resolve(TEST_DIR, '../vfsRefApiEnhancements.ts');
const VFS_CONTEXT_INJECT_PATH = path.resolve(
  TEST_DIR,
  '../../../learning-hub/hooks/useVfsContextInject.ts'
);
const REFERENCE_TO_CHAT_PATH = path.resolve(
  TEST_DIR,
  '../../../learning-hub/useReferenceToChat.ts'
);

const EXPECTED_ZH: Record<string, string> = {
  resource_not_found: '资源 {{sourceId}} 未找到',
  network_error: '网络错误，无法获取资源引用',
  permission_denied: '权限不足，无法访问资源',
  capacity_exceeded: '资源数量超限：当前 {{count}}，最大 {{maxCount}}',
  batch_query_failed: '批量查询资源失败',
  network_retry: '网络错误，请重试',
};

describe('chat_module vfs_inject locale keys', () => {
  it('zh-CN 含全部 vfs_inject key 且与主干原文一致', () => {
    const group = (zhChatModule as Record<string, unknown>).vfs_inject as Record<string, string>;
    expect(group).toBeDefined();
    for (const [key, value] of Object.entries(EXPECTED_ZH)) {
      expect(group[key]).toBe(value);
    }
  });

  it('en-US 含全部 vfs_inject key 且插值占位符与 zh-CN 对齐', () => {
    const zhGroup = (zhChatModule as Record<string, unknown>).vfs_inject as Record<string, string>;
    const enGroup = (enChatModule as Record<string, unknown>).vfs_inject as Record<string, string>;
    expect(enGroup).toBeDefined();
    for (const key of Object.keys(EXPECTED_ZH)) {
      expect(typeof enGroup[key]).toBe('string');
      expect(enGroup[key].length).toBeGreaterThan(0);
      // 占位符集合必须一致，避免翻译丢插值
      const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort();
      expect(placeholders(enGroup[key])).toEqual(placeholders(zhGroup[key]));
    }
    expect(enGroup.resource_not_found).toContain('{{sourceId}}');
    expect(enGroup.capacity_exceeded).toContain('{{count}}');
    expect(enGroup.capacity_exceeded).toContain('{{maxCount}}');
  });
});

describe('checkResourceCapacity key-echo', () => {
  it('超限时错误消息走 chat_module:vfs_inject.capacity_exceeded 并传入插值变量', async () => {
    const { checkResourceCapacity } = await import('../vfsRefApiEnhancements');

    const result = checkResourceCapacity(51, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        'chat_module:vfs_inject.capacity_exceeded|count=51,maxCount=50'
      );
    }

    const call = tCalls.find((c) => c.key === 'chat_module:vfs_inject.capacity_exceeded');
    expect(call).toBeDefined();
    // 异步 namespace 惯例：必须带 defaultValue，且与 zh-CN locale 原文一致
    expect(call?.options?.defaultValue).toBe(EXPECTED_ZH.capacity_exceeded);
    expect(call?.options?.count).toBe(51);
    expect(call?.options?.maxCount).toBe(50);
  });

  it('未超限时不触发翻译调用', async () => {
    const { checkResourceCapacity } = await import('../vfsRefApiEnhancements');
    const before = tCalls.length;
    const result = checkResourceCapacity(3, 50);
    expect(result.ok).toBe(true);
    expect(tCalls.length).toBe(before);
  });
});

describe('注入链路调用点 source 守卫', () => {
  it('vfsRefApiEnhancements.ts：容量/批量查询错误走 i18n，旧硬编码拼接消失', () => {
    const source = readFileSync(ENHANCEMENTS_PATH, 'utf-8');

    expect(source).toContain("i18n.t('chat_module:vfs_inject.capacity_exceeded'");
    expect(source).toContain("i18n.t('chat_module:vfs_inject.batch_query_failed'");
    expect(source).toContain("defaultValue: '资源数量超限：当前 {{count}}，最大 {{maxCount}}'");
    expect(source).toContain("{ defaultValue: '批量查询资源失败' }");

    // 旧形式：模板字符串拼接 / 裸中文字面量直传 toVfsError
    expect(source).not.toMatch(/`资源数量超限：当前 \$\{count\}/);
    expect(source).not.toMatch(/toVfsError\(\s*caughtError,\s*'批量查询资源失败'/);
  });

  it('useVfsContextInject.ts：NOT_FOUND/NETWORK/PERMISSION 错误走 chat_module:vfs_inject.*', () => {
    const source = readFileSync(VFS_CONTEXT_INJECT_PATH, 'utf-8');

    expect(source).toContain("t('chat_module:vfs_inject.resource_not_found'");
    expect(source).toContain("t('chat_module:vfs_inject.network_error'");
    expect(source).toContain("t('chat_module:vfs_inject.permission_denied'");
    expect(source).toContain("defaultValue: '资源 {{sourceId}} 未找到'");

    // 旧形式：模板字符串 / 裸赋值
    expect(source).not.toMatch(/`资源 \$\{sourceId\} 未找到`/);
    expect(source).not.toMatch(/errorMsg = '网络错误，无法获取资源引用'/);
    expect(source).not.toMatch(/errorMsg = '权限不足，无法访问资源'/);

    // 已有的 learningHub / notes 调用保持不动
    expect(source).toContain("t('learningHub:context.resourceNotFound')");
    expect(source).toContain("t('notes:reference.session_not_found')");
  });

  it('useReferenceToChat.ts：NETWORK 分支走 chat_module:vfs_inject.network_retry', () => {
    const source = readFileSync(REFERENCE_TO_CHAT_PATH, 'utf-8');

    expect(source).toContain("t('chat_module:vfs_inject.network_retry'");
    expect(source).not.toMatch(/errorMsg = '网络错误，请重试'/);

    // 已有的 notes:reference.* 调用保持不动
    expect(source).toContain("t('notes:reference.resource_not_found')");
    expect(source).toContain("t('notes:reference.no_active_session')");
  });
});
