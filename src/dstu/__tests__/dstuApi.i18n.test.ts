/**
 * DSTU api.ts 用户可见错误文案 i18n 契约测试
 *
 * 覆盖三层保障：
 * 1. locale 契约：zh-CN/en-US 的 chat_host.json 均含 vfs_api 组，
 *    且 zh-CN 取值与主干原始中文文案逐字一致（含 {{}} 插值占位）。
 * 2. source 守卫：api.ts 中所有 toVfsError / new VfsError 的用户可见
 *    message 均经由 i18n.t('chat_host:vfs_api.*')，defaultValue 与 zh-CN
 *    locale 完全一致（chat_host 为异步 namespace，defaultValue 是兜底）。
 * 3. key-echo：mock @/i18n 后走真实错误路径，确认 VfsError.message
 *    确实来自 i18n.t 的返回值（即运行时已接管文案）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import zhCN from '@/locales/zh-CN/chat_host.json';
import enUS from '@/locales/en-US/chat_host.json';

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/features/chat/context/vfsRefApiEnhancements', () => ({
  invalidateResourceCache: vi.fn(),
}));

/** 主干原始中文文案（zh-CN locale 必须与之逐字一致） */
const EXPECTED_ZH_CN: Record<string, string> = {
  list_failed: '列出目录内容失败',
  get_failed: '获取资源详情失败',
  resource_not_found: '资源未找到: {{path}}',
  file_read_failed: '文件读取失败',
  create_failed: '创建资源失败',
  update_failed: '更新资源失败',
  delete_failed: '删除资源失败',
  move_failed: '移动资源失败',
  rename_failed: '重命名资源失败',
  rename_missing_resource_hash: 'resourceHash 缺失，无法完成资源重命名',
  copy_failed: '复制资源失败',
  copy_missing_resource_hash: 'resourceHash 缺失，无法完成资源复制',
  search_failed: '搜索资源失败',
  get_content_failed: '获取资源内容失败',
  set_metadata_failed: '设置元数据失败',
  set_favorite_failed: '设置收藏状态失败',
  watch_failed: '监听资源变化失败',
  unwatch_failed: '取消监听失败',
  delete_many_failed: '批量删除资源失败',
  restore_many_failed: '批量恢复资源失败',
  move_many_failed: '批量移动资源失败',
  search_in_folder_failed: '文件夹内搜索失败',
  restore_failed: '恢复资源失败',
  purge_failed: '永久删除资源失败',
  list_deleted_failed: '列出已删除资源失败',
  purge_all_failed: '清空回收站失败',
  export_formats_failed: '查询导出格式失败',
  export_failed: '导出资源失败',
  path_too_long: '路径长度超限: {{length}} 字符（最大 {{max}}）',
  source_id_too_long: 'sourceId长度超限: {{length}} 字符（最大 {{max}}）',
};

// jsdom 环境下 import.meta.url 非 file 协议，使用 vitest 根目录（项目根）解析
const apiSourcePath = resolve(process.cwd(), 'src/dstu/api.ts');
const apiSource = readFileSync(apiSourcePath, 'utf-8');

describe('dstu/api.ts 错误文案 i18n（chat_host:vfs_api）', () => {
  describe('locale 契约', () => {
    it('zh-CN 含 vfs_api 组且取值与主干原文一致', () => {
      const group = (zhCN as Record<string, unknown>).vfs_api as Record<string, string>;
      expect(group).toBeTruthy();
      expect(group).toEqual(EXPECTED_ZH_CN);
    });

    it('en-US 含 vfs_api 组，key 与 zh-CN 对齐且值非空', () => {
      const group = (enUS as Record<string, unknown>).vfs_api as Record<string, string>;
      expect(group).toBeTruthy();
      expect(Object.keys(group).sort()).toEqual(Object.keys(EXPECTED_ZH_CN).sort());
      for (const [key, value] of Object.entries(group)) {
        expect(value, `en-US vfs_api.${key} 不应为空`).toBeTruthy();
        expect(value, `en-US vfs_api.${key} 不应含中文`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    });

    it('插值 key 在两种语言中保留相同的 {{}} 占位符', () => {
      const zhGroup = (zhCN as Record<string, unknown>).vfs_api as Record<string, string>;
      const enGroup = (enUS as Record<string, unknown>).vfs_api as Record<string, string>;
      for (const key of Object.keys(EXPECTED_ZH_CN)) {
        const zhVars = (zhGroup[key].match(/\{\{\w+\}\}/g) ?? []).sort();
        const enVars = (enGroup[key].match(/\{\{\w+\}\}/g) ?? []).sort();
        expect(enVars, `vfs_api.${key} 插值占位符应一致`).toEqual(zhVars);
      }
    });
  });

  describe('source 守卫', () => {
    it('所有 toVfsError 调用的标签都走 i18n.t(chat_host:vfs_api.*)', () => {
      const totalCalls = apiSource.match(/toVfsError\(/g) ?? [];
      const i18nLabeled =
        apiSource.match(
          /toVfsError\(\s*\w+,\s*i18n\.t\('chat_host:vfs_api\.\w+'/g
        ) ?? [];
      expect(totalCalls.length).toBeGreaterThan(0);
      expect(i18nLabeled.length).toBe(totalCalls.length);
    });

    it('所有 new VfsError 的 message 都走 i18n.t(chat_host:vfs_api.*)', () => {
      const totalCalls = apiSource.match(/new VfsError\(/g) ?? [];
      const i18nLabeled =
        apiSource.match(
          /new VfsError\(\s*VfsErrorCode\.\w+,\s*i18n\.t\(\s*'chat_host:vfs_api\.\w+'/g
        ) ?? [];
      expect(totalCalls.length).toBeGreaterThan(0);
      expect(i18nLabeled.length).toBe(totalCalls.length);
    });

    it('source 引用的每个 key 都存在于两种 locale，且 defaultValue 与 zh-CN 一致', () => {
      const zhGroup = (zhCN as Record<string, unknown>).vfs_api as Record<string, string>;
      const enGroup = (enUS as Record<string, unknown>).vfs_api as Record<string, string>;

      const usedKeys = new Set<string>();
      for (const match of apiSource.matchAll(/'chat_host:vfs_api\.(\w+)'/g)) {
        usedKeys.add(match[1]);
      }
      expect(usedKeys.size).toBeGreaterThan(0);
      for (const key of usedKeys) {
        expect(zhGroup[key], `zh-CN 缺少 vfs_api.${key}`).toBeTruthy();
        expect(enGroup[key], `en-US 缺少 vfs_api.${key}`).toBeTruthy();
      }

      // defaultValue 兜底文案必须与 zh-CN locale 逐字一致（异步 namespace 未就绪时回退）
      const pairs = apiSource.matchAll(
        /'chat_host:vfs_api\.(\w+)',\s*\{\s*defaultValue:\s*'([^']*)'/g
      );
      let pairCount = 0;
      for (const [, key, defaultValue] of pairs) {
        pairCount += 1;
        expect(defaultValue, `vfs_api.${key} 的 defaultValue 应与 zh-CN 一致`).toBe(
          zhGroup[key]
        );
      }
      expect(pairCount).toBe(usedKeys.size);
    });
  });

  describe('key-echo 运行时验证（mock @/i18n）', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('list() 失败时 VfsError.message 来自 i18n.t', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      // 非 Error/string/object 的拒绝值会走 toVfsError 的 defaultMessage 分支
      vi.mocked(invoke).mockRejectedValueOnce(42);

      const { list } = await import('../api');
      const result = await list('/some/path');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('chat_host:vfs_api.list_failed');
      }
    });

    it('get() 未找到资源时 message 来自 i18n.t', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce(null);

      const { get } = await import('../api');
      const result = await get('/missing/path');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('chat_host:vfs_api.resource_not_found');
      }
    });
  });
});
