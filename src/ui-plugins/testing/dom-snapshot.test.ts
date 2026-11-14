import { describe, expect, it } from 'vitest';
import { serializeDom } from './dom-snapshot';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('serializeDom', () => {
  it('keeps structure, sorted classes and semantic attributes; drops inline style', () => {
    const root = mount('<button class="b a a" style="top: 3px" aria-label="Send" data-testid="send" type="button">Go <svg viewBox="0 0 1 1"><path d="M0"/></svg></button>');
    expect(serializeDom(root)).toBe([
      '<div>',
      '  <button .a.b aria-label="Send" data-testid="send" type="button">',
      '    "Go"',
      '    <svg viewBox="0 0 1 1" />',
      '',
    ].join('\n'));
  });

  it('renumbers ids consistently with their references', () => {
    const root = mount('<label for=":r7:">Name</label><input id=":r7:" aria-describedby="hint-1700000000"><p id="hint-1700000000">x</p>');
    expect(serializeDom(root)).toContain('<label for="@1">');
    expect(serializeDom(root)).toContain('<input aria-describedby="@2" id="@1" />');
    expect(serializeDom(root)).toContain('<p id="@2">');
  });

  it('renumbers counter-suffixed owner keys per prefix and keeps named ones', () => {
    const root = mount('<i data-sandbox-owner-key="sandbox:chat-page:4"></i><i data-sandbox-owner-key="sandbox:chat-page:7"></i><i data-sandbox-owner-key="sandbox:chat-page:4"></i><i data-sandbox-owner-key="sandbox:chat:demo-1"></i><i data-step="3"></i>');
    expect(serializeDom(root).split('\n').slice(1, 6)).toEqual([
      '  <i data-sandbox-owner-key="sandbox:chat-page:#1" />',
      '  <i data-sandbox-owner-key="sandbox:chat-page:#2" />',
      '  <i data-sandbox-owner-key="sandbox:chat-page:#1" />',
      '  <i data-sandbox-owner-key="sandbox:chat:demo-1" />',
      '  <i data-step="3" />',
    ]);
  });

  it('masks clock, origin and duration noise but not ordinary text', () => {
    const root = mount('<span title="2026/3/2 09:30:41">09:30</span><img src="http://127.0.0.1:51234/a.svg" alt=""><i>57ms</i><b>1.1s</b><u>shortcut_1772415000739_x</u><em>共 5 张卡片</em><s>用时 2 秒</s><q>已用时 13 秒</q><kbd>30 秒后重试</kbd>');
    const text = serializeDom(root);
    expect(text).toContain('title="2026/3/2 09:30:<ss>"');
    expect(text).toContain('src="<origin>/a.svg"');
    expect(text).toContain('"<n>ms"');
    expect(text).toContain('"<n>s"');
    expect(text).toContain('"shortcut_<ts>_x"');
    expect(text).toContain('"共 5 张卡片"');
    expect(text).toContain('"用时 <n> 秒"');
    expect(text).toContain('"已用时 <n> 秒"');
    expect(text).toContain('"30 秒后重试"');
  });

  it('descends into open shadow roots and changes when a class changes', () => {
    const host = mount('<div class="card"></div>');
    host.firstElementChild!.attachShadow({ mode: 'open' }).innerHTML = '<p class="front">Q</p>';
    const before = serializeDom(host);
    expect(before).toContain('#shadow-root');
    expect(before).toContain('<p .front>');
    host.firstElementChild!.shadowRoot!.firstElementChild!.className = 'front flipped';
    expect(serializeDom(host)).not.toBe(before);
  });
});
