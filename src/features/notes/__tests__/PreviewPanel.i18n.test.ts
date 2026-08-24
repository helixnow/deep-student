/**
 * PreviewPanel reportError 标签 i18n 合同测试
 *
 * 背景：fetchReferenceContent 中两处 reportError 的上下文标签
 * （「获取引用节点」/「获取引用内容」）原为硬编码中文，
 * 现改走 template:preview_ref.* i18n key（defaultValue 保持主干原文）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import zhTemplate from '@/locales/zh-CN/template.json';
import enTemplate from '@/locales/en-US/template.json';

const componentSource = readFileSync(resolve(__dirname, '../PreviewPanel.tsx'), 'utf-8');

describe('PreviewPanel reportError i18n', () => {
  it('zh-CN locale 提供 preview_ref key，文案与主干原文一致', () => {
    expect(zhTemplate.preview_ref.get_node).toBe('获取引用节点');
    expect(zhTemplate.preview_ref.get_content).toBe('获取引用内容');
  });

  it('en-US locale 提供对应英文文案', () => {
    expect(enTemplate.preview_ref.get_node).toBe('Fetch referenced node');
    expect(enTemplate.preview_ref.get_content).toBe('Fetch referenced content');
  });

  it('reportError 标签通过 template:preview_ref.* 解析并保留 defaultValue', () => {
    expect(componentSource).toContain(
      "i18next.t('template:preview_ref.get_node', { defaultValue: '获取引用节点' })"
    );
    expect(componentSource).toContain(
      "i18next.t('template:preview_ref.get_content', { defaultValue: '获取引用内容' })"
    );
  });

  it('不再向 reportError 直接传硬编码中文标签', () => {
    expect(componentSource).not.toContain("reportError(nodeResult.error, '获取引用节点')");
    expect(componentSource).not.toContain("reportError(contentResult.error, '获取引用内容')");
    // 兜底：reportError 第二个参数不应是含中文的字符串字面量
    expect(componentSource).not.toMatch(/reportError\([^,]+,\s*'[^']*[\u4e00-\u9fff]/);
  });
});
