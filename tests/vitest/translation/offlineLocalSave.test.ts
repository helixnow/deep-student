/**
 * 离线时的本地保存/评分不被 navigator.onLine 拦截（源码契约）
 *
 * 本地 DSTU/VFS 写入不依赖网络：
 * - 编辑译文保存（handleSaveEditedTranslation）
 * - 质量评分（handleRateTranslation）
 * - 保存并关闭（saveCurrentSessionRef）
 * 均不得检查 isOnline / navigator.onLine。
 * 网络路径（handleTranslate 发起流式翻译）保留离线拦截。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '../../../src/components/TranslateWorkbench.tsx'),
  'utf-8'
);

/** 截取 [startMarker, endMarker) 之间的源码片段，找不到标记直接失败 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `找不到起始标记：${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `找不到结束标记：${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const OFFLINE_GATE = /isOnline|navigator\.onLine/;

describe('本地 VFS 保存路径不做离线拦截', () => {
  it('编辑译文保存不检查网络状态', () => {
    const body = sliceBetween(
      'const handleSaveEditedTranslation',
      'const handleCancelEdit'
    );
    expect(body).not.toMatch(OFFLINE_GATE);
  });

  it('翻译质量评分不检查网络状态', () => {
    const body = sliceBetween('const handleRateTranslation', '// 快捷键支持');
    expect(body).not.toMatch(OFFLINE_GATE);
  });

  it('「保存并关闭」的整体落盘不检查网络状态', () => {
    const body = sliceBetween('saveCurrentSessionRef.current = async', '// 同步流式管线');
    expect(body).not.toMatch(OFFLINE_GATE);
  });
});

describe('网络路径保留离线拦截', () => {
  it('发起流式翻译（走远端模型）离线时仍应被拦截并提示', () => {
    const body = sliceBetween('const handleTranslate', 'const handleCancelTranslation');
    expect(body).toMatch(/!isOnline/);
    expect(body).toMatch(/errors\.offline/);
  });
});
