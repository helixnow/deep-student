import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findSettingsRevealTarget,
  revealSettingsSection,
  SETTINGS_MAIN_CONTENT_ID,
  SETTINGS_SEARCH_HIT_CLASS,
} from '../settingsSearchReveal';

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  root.id = SETTINGS_MAIN_CONTENT_ID;
  document.body.appendChild(root);
  return root;
}

describe('findSettingsRevealTarget 标题定位优先级', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('data-settings-anchor 精确命中优先于文本全等', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3>外观主题</h3>
      <div data-settings-anchor="外观主题" id="anchor-hit"></div>
    `;
    expect(findSettingsRevealTarget(root, '外观主题')?.id).toBe('anchor-hit');
  });

  it('文本全等命中优先于前缀命中；忽略多余空白', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <h3 id="prefix">外观主题（深色）</h3>
      <h3 id="exact">外观  主题</h3>
    `;
    expect(findSettingsRevealTarget(root, '外观 主题')?.id).toBe('exact');
  });

  it('无全等时回退到首个前缀命中', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <h4 id="first-prefix">代理设置说明</h4>
      <h4 id="second-prefix">代理设置端口</h4>
    `;
    expect(findSettingsRevealTarget(root, '代理设置')?.id).toBe('first-prefix');
  });

  it('空 label 或无命中返回 null', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h3>其他</h3>';
    expect(findSettingsRevealTarget(root, '  ')).toBeNull();
    expect(findSettingsRevealTarget(root, '不存在')).toBeNull();
  });
});

describe('revealSettingsSection 轮询定位 + 高亮脉冲', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;
  let activeCancel: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    activeCancel?.();
    activeCancel = null;
    scrollSpy.mockRestore();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('目标已挂载时立即滚动并高亮所在设置行，到时自动褪去', () => {
    const root = makeRoot();
    root.innerHTML = `
      <div class="group" id="row">
        <h3>界面语言</h3>
      </div>
    `;

    activeCancel = revealSettingsSection('界面语言');

    const row = document.getElementById('row')!;
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(row.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(true);

    vi.advanceTimersByTime(2_200);
    expect(row.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(false);
  });

  it('目标 lazy 挂载：先轮询等待，出现后命中', () => {
    const root = makeRoot();
    activeCancel = revealSettingsSection('界面语言');
    expect(scrollSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(scrollSpy).not.toHaveBeenCalled();

    root.innerHTML = '<h3 id="target">界面语言</h3>';
    vi.advanceTimersByTime(100);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(
      document.getElementById('target')!.classList.contains(SETTINGS_SEARCH_HIT_CLASS),
    ).toBe(true);
  });

  it('超时未命中静默放弃，不再轮询', () => {
    const root = makeRoot();
    activeCancel = revealSettingsSection('永远不出现', { timeoutMs: 500 });

    vi.advanceTimersByTime(600);
    root.innerHTML = '<h3>永远不出现</h3>';
    vi.advanceTimersByTime(1_000);

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(document.querySelector(`.${SETTINGS_SEARCH_HIT_CLASS}`)).toBeNull();
  });

  it('新的定位会取消上一个的高亮（同一时刻只有一处命中）', () => {
    const root = makeRoot();
    root.innerHTML = `
      <h3 id="first">主题</h3>
      <h3 id="second">语言</h3>
    `;

    revealSettingsSection('主题');
    expect(document.getElementById('first')!.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(true);

    activeCancel = revealSettingsSection('语言');
    expect(document.getElementById('first')!.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(false);
    expect(document.getElementById('second')!.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(true);
  });

  it('返回的取消函数立刻移除高亮并停止计时', () => {
    const root = makeRoot();
    root.innerHTML = '<h3 id="target">主题</h3>';

    const cancel = revealSettingsSection('主题');
    const target = document.getElementById('target')!;
    expect(target.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(true);

    cancel();
    expect(target.classList.contains(SETTINGS_SEARCH_HIT_CLASS)).toBe(false);
  });
});
