/**
 * NoteContentView 用户可见错误/通知文案 i18n 契约测试
 *
 * 背景：学习中心笔记视图的加载/保存/OCC 失败文案曾是硬编码中文。
 * notes.json / learningHub.json 命名空间已被其他切片占用，
 * 本切片将新 key 收敛到 backend_errors.json 的 note_content 分组。
 *
 * 契约：
 * - 源码中所有用户可见的 throw / setError fallback / reportError 动作名 /
 *   通知正文必须通过 i18n.t('backend_errors:note_content.<key>', { defaultValue }) 调用；
 * - defaultValue 与 zh-CN locale 完全一致（key-echo，防止 key 与文案漂移）；
 * - zh-CN / en-US 两份 locale 的 note_content key 集合一致；
 * - 源码不得残留裸中文 throw new Error('...')。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(process.cwd(), 'src/features/learning-hub/apps/views/NoteContentView.tsx'),
  'utf8',
);

const zhCN = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src/locales/zh-CN/backend_errors.json'), 'utf8'),
) as Record<string, Record<string, string>>;

const enUS = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src/locales/en-US/backend_errors.json'), 'utf8'),
) as Record<string, Record<string, string>>;

/** 主干必须覆盖的 key -> 原中文文案（与任务验收清单一一对应） */
const REQUIRED_KEYS: Record<string, string> = {
  load_note_failed: '加载笔记内容失败',
  load_note_action: '加载笔记内容',
  deleted_with_unsaved_changes: '资源已被删除；窗口保留未保存内容，请复制内容后再关闭。',
  save_note_action: '保存笔记',
  update_title_action: '更新标题',
  update_tags_action: '更新标签',
  stale_editor_write_rejected: '笔记实例已切换，拒绝写入过期编辑器',
  editor_readonly: '笔记编辑器为只读状态',
  full_write_occ_failed: '笔记正文已变化，全文写入 OCC 校验失败',
  full_replace_not_confirmed: '编辑器未确认全文替换',
  flush_capability_missing: '编辑器未提供持久化确认能力',
  full_replace_persist_failed: '笔记全文替换未通过持久化验证',
};

describe('NoteContentView backend_errors:note_content i18n contract', () => {
  it("imports the shared i18n instance via '@/i18n'", () => {
    expect(source).toContain("import i18n from '@/i18n';");
  });

  it.each(Object.entries(REQUIRED_KEYS))(
    'calls i18n.t for backend_errors:note_content.%s with the original Chinese defaultValue',
    (key, zhText) => {
      // 允许单行或多行（prettier 折行）两种排版
      const callPattern = new RegExp(
        `i18n\\.t\\(\\s*'backend_errors:note_content\\.${key}',\\s*\\{\\s*defaultValue:\\s*'([^']+)'\\s*,?\\s*\\}`,
        'm',
      );
      const match = source.match(callPattern);
      expect(match, `源码中缺少 backend_errors:note_content.${key} 的 i18n.t 调用`).not.toBeNull();
      expect(match![1], `key ${key} 的 defaultValue 与原中文文案不一致`).toBe(zhText);
    },
  );

  it('key-echo: zh-CN locale mirrors every required key with the exact original text', () => {
    expect(zhCN.note_content, 'zh-CN backend_errors.json 缺少 note_content 分组').toBeDefined();
    for (const [key, zhText] of Object.entries(REQUIRED_KEYS)) {
      expect(zhCN.note_content[key], `zh-CN note_content.${key} 缺失或文案漂移`).toBe(zhText);
    }
  });

  it('en-US locale provides a non-empty English translation for every note_content key', () => {
    expect(enUS.note_content, 'en-US backend_errors.json 缺少 note_content 分组').toBeDefined();
    expect(Object.keys(enUS.note_content).sort()).toEqual(Object.keys(zhCN.note_content).sort());
    for (const [key, value] of Object.entries(enUS.note_content)) {
      expect(value.trim(), `en-US note_content.${key} 不能为空`).not.toBe('');
      expect(value, `en-US note_content.${key} 不应残留中文`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('leaves no user-visible hardcoded Chinese throw / reportError / toVfsError in the source', () => {
    expect(source).not.toMatch(/throw new Error\('[^']*[\u4e00-\u9fff]/);
    expect(source).not.toMatch(/reportError\([^,]+,\s*'[^']*[\u4e00-\u9fff]/);
    expect(source).not.toMatch(/toVfsError\([^,]+,\s*'[^']*[\u4e00-\u9fff]/);
  });
});
