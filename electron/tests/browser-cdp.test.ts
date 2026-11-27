import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_CDP_DOMAINS,
  BrowserCdpSession,
  CDP_MODIFIER_ALT,
  CDP_MODIFIER_CONTROL,
  CDP_MODIFIER_META,
  CDP_MODIFIER_SHIFT,
  RingBuffer,
  assertAllowedCdpMethod,
  buildAxSnapshotTree,
  buildExtractContentScript,
  buildSomOverlayScript,
  buildSomRemoveScript,
  diffSnapshotTrees,
  isPasswordOrOtpNode,
  quadCenter,
  resolveCdpKeySpec,
  type CdpAXNode,
  type CdpDOMSnapshotResult,
  type CdpWebContentsLike,
  type DebuggerLike,
} from '../shell/browser-cdp.ts';
import { BrowserBridgeError } from '../shell/browser-protocol.ts';
import { guardWebContents, type WebSecurityPolicy } from '../shell/web-security.ts';

interface SentCommand {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class TestDebugger extends EventEmitter implements DebuggerLike {
  attached = false;
  attachError: Error | null = null;
  readonly commands: SentCommand[] = [];
  private readonly handler: (method: string, params?: Record<string, unknown>, sessionId?: string) => unknown;

  constructor(handler: (method: string, params?: Record<string, unknown>, sessionId?: string) => unknown) {
    super();
    this.handler = handler;
  }

  attach(_version?: string): void {
    if (this.attachError !== null) throw this.attachError;
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }

  async sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, params: commandParams, sessionId });
    return this.handler(method, commandParams, sessionId);
  }

  emitCdpEvent(method: string, params: Record<string, unknown>, sessionId = ''): void {
    this.emit('message', {}, method, params, sessionId);
  }
}

function createHarness(
  handler: (method: string, params?: Record<string, unknown>, sessionId?: string) => unknown,
  opts: { url?: string; title?: string; platform?: string; logCapacity?: number; resizeImage?: ConstructorParameters<typeof BrowserCdpSession>[0]['resizeImage'] } = {},
) {
  const dbg = new TestDebugger(handler);
  let url = opts.url ?? 'https://example.com/study';
  let title = opts.title ?? 'Study Page';
  const webContents: CdpWebContentsLike = {
    debugger: dbg,
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => title,
  };
  const logs: string[] = [];
  const session = new BrowserCdpSession({
    webContents,
    platform: opts.platform ?? 'darwin',
    log: (m) => logs.push(m),
    logCapacity: opts.logCapacity,
    resizeImage: opts.resizeImage,
  });
  return {
    dbg,
    session,
    logs,
    setUrl(next: string) {
      url = next;
    },
    setTitle(next: string) {
      title = next;
    },
  };
}

describe('browser-cdp::pure helpers', () => {
  it('enforces the whitelisted CDP domain set', () => {
    for (const domain of ALLOWED_CDP_DOMAINS) {
      expect(() => assertAllowedCdpMethod(`${domain}.enable`)).not.toThrow();
    }
    expect(() => assertAllowedCdpMethod('Storage.clearDataForOrigin')).toThrow(/not whitelisted/);
    expect(() => assertAllowedCdpMethod('Fetch.enable')).toThrow(/not whitelisted/);
    expect(() => assertAllowedCdpMethod('InvalidMethod')).toThrow(/not whitelisted/);
  });

  it('prunes generic wrappers, preserves hierarchy indentation, masks passwords, and supplements cursor:pointer nodes', () => {
    const axNodes: CdpAXNode[] = [
      { nodeId: 'root', role: { type: 'role', value: 'RootWebArea' }, childIds: ['wrap', 'shadow-host'] },
      { nodeId: 'wrap', role: { type: 'role', value: 'generic' }, childIds: ['nav', 'main'] },
      { nodeId: 'nav', role: { type: 'role', value: 'navigation' }, name: { type: 'computedString', value: 'Top Nav' }, backendDOMNodeId: 10, childIds: ['link1'] },
      { nodeId: 'link1', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'Docs' }, backendDOMNodeId: 11 },
      {
        nodeId: 'main',
        role: { type: 'role', value: 'main' },
        backendDOMNodeId: 20,
        childIds: ['heading1', 'pw', 'chk', 'tab1', 'btn-disabled'],
      },
      {
        nodeId: 'heading1',
        role: { type: 'role', value: 'heading' },
        name: { type: 'computedString', value: 'Welcome' },
        properties: [{ name: 'level', value: { type: 'integer', value: 2 } }],
        backendDOMNodeId: 21,
      },
      {
        nodeId: 'pw',
        role: { type: 'role', value: 'textbox' },
        name: { type: 'computedString', value: 'Password' },
        value: { type: 'string', value: 'super-secret-123' },
        properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
        backendDOMNodeId: 22,
      },
      {
        nodeId: 'chk',
        role: { type: 'role', value: 'checkbox' },
        name: { type: 'computedString', value: 'Remember me' },
        properties: [{ name: 'checked', value: { type: 'tristate', value: 'true' } }],
        backendDOMNodeId: 23,
      },
      {
        nodeId: 'tab1',
        role: { type: 'role', value: 'tab' },
        name: { type: 'computedString', value: 'Overview' },
        properties: [
          { name: 'selected', value: { type: 'boolean', value: true } },
          { name: 'expanded', value: { type: 'boolean', value: true } },
        ],
        backendDOMNodeId: 24,
      },
      {
        nodeId: 'btn-disabled',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Submit' },
        properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
        backendDOMNodeId: 25,
      },
      // Shadow DOM child attached directly under a generic host
      { nodeId: 'shadow-host', role: { type: 'role', value: 'generic' }, childIds: ['shadow-btn'] },
      { nodeId: 'shadow-btn', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Inside Shadow' }, backendDOMNodeId: 30 },
    ];

    const strings = [
      '', // 0
      'input', // 1
      'type', // 2
      'password', // 3
      'div', // 4
      'block', // 5
      'visible', // 6
      '1', // 7
      'pointer', // 8
      'auto', // 9
      'Click Card', // 10
    ];

    const domSnapshot: CdpDOMSnapshotResult = {
      strings,
      documents: [
        {
          nodes: {
            backendNodeId: [22, 40],
            nodeName: [1, 4],
            attributes: [[2, 3], []],
          },
          layout: {
            nodeIndex: [0, 1],
            bounds: [
              [10, 20, 200, 32],
              [10, 80, 140, 44],
            ],
            styles: [
              [5, 6, 7, 9, 9],
              [5, 6, 7, 8, 9],
            ],
            text: [0, 10],
          },
        },
      ],
    };

    const full = buildAxSnapshotTree({
      axFrames: [{ nodes: axNodes }],
      domSnapshot,
      interactiveOnly: false,
    });

    expect(full.tree).toContain('[e1] navigation "Top Nav"');
    expect(full.tree).toContain('  [e2] link "Docs"');
    expect(full.tree).toContain('[e3] main');
    expect(full.tree).toContain('  [e4] heading(h2) "Welcome"');
    expect(full.tree).toContain('(password)');
    expect(full.tree).not.toContain('super-secret-123');
    expect(full.tree).toContain('focused');
    expect(full.tree).toContain('checked');
    expect(full.tree).toContain('expanded');
    expect(full.tree).toContain('selected');
    expect(full.tree).toContain('disabled');
    expect(full.tree).toContain('button "Inside Shadow"');
    // Non-ARIA cursor:pointer div supplemented from DOMSnapshot
    expect(full.tree).toContain('clickable "Click Card"');
    const pwNode = full.nodes.find((n) => n.name === 'Password');
    expect(pwNode?.password).toBe(true);
    expect(pwNode?.value).toBe('[password]');

    // Interactive-only omits structural landmarks/headings
    const interactive = buildAxSnapshotTree({
      axFrames: [{ nodes: axNodes }],
      domSnapshot,
      interactiveOnly: true,
    });
    expect(interactive.tree).not.toContain('navigation');
    expect(interactive.tree).not.toContain('heading(h2)');
    expect(interactive.tree).toContain('link "Docs"');
    expect(interactive.tree).toContain('clickable "Click Card"');
  });

  it('computes compact line-level snapshot diffs with summary header', () => {
    const prev = ['[e1] button "Save"', '[e2] link "Home"', '[e3] textbox "Query"'].join('\n');
    const next = ['[e1] button "Save"', '[e2] link "Home"', '[e3] textbox "Query" value="cdp"', '[e4] button "Run"'].join('\n');
    const diff = diffSnapshotTrees(prev, next);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(2);
    expect(diff.tree).toContain('--- snapshot diff (+2 -1, 2 unchanged) ---');
    expect(diff.tree).toContain('- [e3] textbox "Query"');
    expect(diff.tree).toContain('+ [e3] textbox "Query" value="cdp"');
    expect(diff.tree).toContain('+ [e4] button "Run"');
    expect(diff.tree).not.toContain('[e1] button "Save"');

    const same = diffSnapshotTrees(next, next);
    expect(same.added).toBe(0);
    expect(same.removed).toBe(0);
    expect(same.unchanged).toBe(4);
    expect(same.tree).toContain('(no changes)');
  });

  it('detects password and OTP inputs from CDP flat attribute lists and heuristics', () => {
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'password'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'current-password'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'section-login new-password'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'tel', 'autocomplete', 'one-time-code'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'name', 'otp'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'id', '2fa-input'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'aria-label', 'Verification code'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'placeholder', 'Enter passcode'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'TEXTAREA', attributes: ['name', 'security_code'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'DIV', attributes: ['role', 'textbox', 'aria-label', 'TOTP'] })).toBe(true);
    expect(isPasswordOrOtpNode({ nodeName: 'DIV', attributes: ['id', 'password-section'] })).toBe(false);
    expect(isPasswordOrOtpNode({ nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'username'] })).toBe(false);
    expect(isPasswordOrOtpNode({ nodeName: 'TEXTAREA', attributes: ['name', 'notes'] })).toBe(false);
  });

  it('maps named keys, combos, and explicit modifiers to CDP key specs without forcing Shift on shortcuts', () => {
    expect(resolveCdpKeySpec('Enter')).toEqual({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0,
    });
    expect(resolveCdpKeySpec('Escape')).toEqual({
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      modifiers: 0,
    });
    expect(resolveCdpKeySpec('Control+a')).toEqual({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: CDP_MODIFIER_CONTROL,
    });
    expect(resolveCdpKeySpec('Control+A')).toEqual({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: CDP_MODIFIER_CONTROL,
    });
    expect(resolveCdpKeySpec('Meta+A')).toEqual({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: CDP_MODIFIER_META,
    });
    expect(resolveCdpKeySpec('Control+Shift+A')).toEqual({
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: CDP_MODIFIER_CONTROL | CDP_MODIFIER_SHIFT,
    });
    expect(resolveCdpKeySpec('A')).toEqual({
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'A',
      modifiers: CDP_MODIFIER_SHIFT,
    });
    expect(resolveCdpKeySpec('Meta+Shift+k')).toEqual({
      key: 'K',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: CDP_MODIFIER_META | CDP_MODIFIER_SHIFT,
    });
    expect(resolveCdpKeySpec('ArrowLeft', ['Alt'])).toEqual({
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
      modifiers: CDP_MODIFIER_ALT,
    });
    expect(resolveCdpKeySpec('F5')).toEqual({
      key: 'F5',
      code: 'F5',
      windowsVirtualKeyCode: 116,
      modifiers: 0,
    });
  });

  it('rejects zero-area or degenerate quads in quadCenter', () => {
    expect(quadCenter([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(quadCenter([10, 20, 10.4, 20, 10.4, 40, 10, 40])).toBeNull();
    expect(quadCenter([10, 20, 50, 20, 50, 20.2, 10, 20.2])).toBeNull();
    expect(quadCenter([10, 20, 50, 20, 50, 60, 10, 60])).toEqual({ x: 30, y: 40 });
  });

  it('bounds RingBuffer entries to configured capacity', () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    ring.push(4);
    expect(ring.size).toBe(3);
    expect(ring.toArray()).toEqual([2, 3, 4]);
    expect(ring.toArray(2)).toEqual([3, 4]);
  });

  it('builds deterministic SoM (scroll-aware) and paginated code-point content extraction scripts', () => {
    const somViewport = buildSomOverlayScript([{ ref: 'e1', box: { x: 10, y: 20, w: 100, h: 30 } }]);
    expect(somViewport).toContain('data-ds-som-overlay');
    expect(somViewport).toContain('pointer-events:none');
    expect(somViewport).toContain('window.scrollX');
    expect(somViewport).toContain('"ref":"e1"');
    const somFull = buildSomOverlayScript([{ ref: 'e1', box: { x: 10, y: 20, w: 100, h: 30 } }], true);
    expect(somFull).toContain('position:absolute;left:0;top:0;');
    expect(buildSomRemoveScript()).toContain('data-ds-som-overlay');

    const extract = buildExtractContentScript(12_000, 50);
    expect(extract).toContain("document.querySelector('article')");
    expect(extract).toContain('katex');
    expect(extract).toContain('MJX-CONTAINER');
    expect(extract).toContain('Array.from(fullMarkdown)');
    expect(extract).toContain('totalChars: totalChars');
    expect(extract).toContain('(12000, 50)');

    // Execute generated extraction script on a minimal fake DOM to verify code-point pagination
    const content = 'A'.repeat(300) + '\u{1D400}' + 'B'.repeat(100);
    const fakeDoc = {
      title: 'Paginated Doc',
      querySelector: () => null,
      body: {
        nodeType: 1,
        tagName: 'BODY',
        getAttribute: () => '',
        hasAttribute: () => false,
        className: '',
        firstChild: { nodeType: 3, nodeValue: content, nextSibling: null },
      },
    };
    const fakeLocation = { href: 'https://example.com/article' };
    const runExtract = (maxChars: number, startIndex: number) =>
      new Function('document', 'location', `return ${buildExtractContentScript(maxChars, startIndex)}`)(fakeDoc, fakeLocation) as {
        url: string;
        title: string;
        markdown: string;
        totalChars: number;
        textLength: number;
        truncated: boolean;
      };
    const page1 = runExtract(256, 0);
    expect(page1.totalChars).toBe(401);
    expect(page1.textLength).toBe(401);
    expect(page1.truncated).toBe(true);
    expect(Array.from(page1.markdown)).toHaveLength(256);

    const page2 = runExtract(256, 256);
    expect(page2.totalChars).toBe(401);
    expect(page2.truncated).toBe(false);
    expect(Array.from(page2.markdown)).toHaveLength(145);
    expect(page2.markdown).toContain('\u{1D400}');
  });
});

describe('browser-cdp::BrowserCdpSession', () => {
  it('supports OOPIF flattening, selector scoping, and snapshot diffing across turns', async () => {
    let callCount = 0;
    const { dbg, session } = createHarness((method, params, sessionId) => {
      if (method === 'Accessibility.getFullAXTree') {
        if (sessionId === 'oopif-1') {
          return {
            nodes: [
              { nodeId: 'f1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Frame Action' }, backendDOMNodeId: 901 },
            ],
          };
        }
        callCount += 1;
        return {
          nodes: [
            { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: ['2', '3'] },
            { nodeId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Search' }, backendDOMNodeId: 101 },
            ...(callCount >= 2
              ? [{ nodeId: '3', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'Result 1' }, backendDOMNodeId: 102 }]
              : []),
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: params?.selector === '#only-search' ? 50 : 0 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 101 } };
      return {};
    });

    await session.ensureAttached();
    dbg.emitCdpEvent('Target.attachedToTarget', {
      sessionId: 'oopif-1',
      targetInfo: { targetId: 'frame-oopif', type: 'iframe' },
    });

    const first = await session.snapshot({ interactiveOnly: true });
    expect(first.engine).toBe('ax-cdp');
    expect(first.diff).toBe(false);
    expect(first.epoch).toBe(1);
    expect(first.tree).toContain('[e1] button "Search"');
    expect(first.tree).toContain('[frame frame-oopif]');
    expect(first.tree).toContain('[e2] button "Frame Action"');

    const second = await session.snapshot({ interactiveOnly: true, diff: true });
    expect(second.diff).toBe(true);
    expect(second.epoch).toBe(2);
    expect(second.tree).toContain('+ [e2] link "Result 1"');

    const scoped = await session.snapshot({ interactiveOnly: true, selector: '#only-search' });
    expect(scoped.count).toBe(1);
    expect(scoped.tree).toBe('[e1] button "Search"');
  });

  it('strictly blocks typing into password and OTP fields before focusing or inserting text', async () => {
    const attrsByBackendId: Record<number, string[]> = {
      101: ['type', 'password'],
      102: ['type', 'text', 'autocomplete', 'one-time-code'],
      103: ['type', 'text', 'name', 'query'],
    };
    const { dbg, session } = createHarness((method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'Pass' }, backendDOMNodeId: 101 },
            { nodeId: '2', role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'OTP' }, backendDOMNodeId: 102 },
            { nodeId: '3', role: { type: 'role', value: 'textbox' }, name: { type: 'computedString', value: 'Search' }, backendDOMNodeId: 103 },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 700 } };
      if (method === 'DOM.describeNode') {
        const id = Number(params?.backendNodeId);
        return { node: { nodeName: 'INPUT', attributes: attrsByBackendId[id] ?? [] } };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-103' } };
      return {};
    });

    await session.snapshot({ interactiveOnly: true });
    dbg.commands.length = 0;

    // Password field must throw BLOCKED without touching DOM.focus or Input.insertText
    let pwErr: unknown;
    try {
      await session.typeText({ ref: 'e1', text: 'secret' });
    } catch (error) {
      pwErr = error;
    }
    expect(pwErr).toBeInstanceOf(BrowserBridgeError);
    expect((pwErr as BrowserBridgeError).data).toEqual({
      code: 'BLOCKED',
      message: 'password fields cannot be typed by agent bridge',
      details: { reason: 'password_field', ref: 'e1' },
    });
    expect(dbg.commands.map((c) => c.method)).toEqual(['DOM.describeNode']);

    // OTP field must also throw BLOCKED on typeText and click
    dbg.commands.length = 0;
    await expect(session.typeText({ ref: 'e2', text: '123456' })).rejects.toThrow('password fields cannot be typed by agent bridge');
    expect(dbg.commands.map((c) => c.method)).toEqual(['DOM.describeNode']);

    // Clicking password/OTP ref must also throw BLOCKED without dispatching mouse events
    dbg.commands.length = 0;
    let clickErr: unknown;
    try {
      await session.click({ ref: 'e1' });
    } catch (error) {
      clickErr = error;
    }
    expect(clickErr).toBeInstanceOf(BrowserBridgeError);
    expect((clickErr as BrowserBridgeError).data).toEqual({
      code: 'BLOCKED',
      message: 'password/OTP fields cannot be interacted with by agent bridge',
      details: { reason: 'password_field', ref: 'e1' },
    });
    expect(dbg.commands.map((c) => c.method)).toEqual(['DOM.describeNode']);

    // Default typeText has clear=false (does not send selectAll or Backspace)
    dbg.commands.length = 0;
    const defaultTyped = await session.typeText({ ref: 'e3', text: 'append' });
    expect(defaultTyped).toMatchObject({ mode: 'ref', ref: 'e3', length: 6, cleared: false, submitted: false, engine: 'ax-cdp' });
    expect(dbg.commands.some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(false);
    expect(dbg.commands.some((c) => c.method === 'Input.insertText' && c.params?.text === 'append')).toBe(true);

    // Normal textbox with clear: true (macOS selectAll command + contenteditable fallback) and submit: true (keyDown Enter)
    dbg.commands.length = 0;
    const typed = await session.typeText({ ref: 'e3', text: 'hello', clear: true, submit: true });
    expect(typed).toMatchObject({ mode: 'ref', ref: 'e3', length: 5, cleared: true, submitted: true, engine: 'ax-cdp' });
    expect(dbg.commands.some((c) => c.method === 'DOM.focus')).toBe(true);
    expect(dbg.commands.some((c) =>
      c.method === 'Input.dispatchKeyEvent' &&
      c.params?.type === 'rawKeyDown' &&
      c.params?.code === 'KeyA' &&
      Array.isArray(c.params?.commands) &&
      c.params.commands.includes('selectAll'),
    )).toBe(true);
    expect(dbg.commands.some((c) =>
      c.method === 'Runtime.callFunctionOn' &&
      String(c.params?.functionDeclaration ?? '').includes('isContentEditable'),
    )).toBe(true);
    expect(dbg.commands.some((c) => c.method === 'Input.insertText' && c.params?.text === 'hello')).toBe(true);
    expect(dbg.commands.some((c) =>
      c.method === 'Input.dispatchKeyEvent' &&
      c.params?.type === 'keyDown' &&
      c.params?.key === 'Enter' &&
      c.params?.windowsVirtualKeyCode === 13 &&
      c.params?.nativeVirtualKeyCode === 13 &&
      c.params?.text === '\r' &&
      c.params?.unmodifiedText === '\r',
    )).toBe(true);
  });

  it('dispatches trusted click, hover, pressKey, selectOption, setInputFiles, scroll, and remoteInput commands', async () => {
    const { dbg, session } = createHarness((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Go' }, backendDOMNodeId: 201 },
            { nodeId: '2', role: { type: 'role', value: 'combobox' }, name: { type: 'computedString', value: 'Lang' }, backendDOMNodeId: 202 },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      if (method === 'DOM.getBoxModel') return { model: { border: [100, 50, 200, 50, 200, 90, 100, 90] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'select-obj-1' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, selectedValues: ['zh'], selectedLabels: ['Chinese'] } } };
      }
      return {};
    });

    await session.snapshot({ interactiveOnly: true });
    dbg.commands.length = 0;

    const clicked = await session.click({ ref: 'e1', doubleClick: true, button: 'left' });
    expect(clicked).toMatchObject({ mode: 'ref', ref: 'e1', point: { x: 150, y: 70 }, doubleClick: true });
    const mouseEvents = dbg.commands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseEvents.map((c) => c.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mousePressed',
      'mouseReleased',
    ]);

    dbg.commands.length = 0;
    await session.hover({ x: 40, y: 80 });
    expect(dbg.commands).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 40, y: 80, button: 'none', buttons: 0 }, sessionId: undefined },
    ]);

    dbg.commands.length = 0;
    await session.pressKey({ key: 'Control+k' });
    expect(dbg.commands.map((c) => c.params?.type)).toEqual(['rawKeyDown', 'keyUp']);
    expect(dbg.commands[0]?.params?.modifiers).toBe(CDP_MODIFIER_CONTROL);

    const selected = await session.selectOption({ ref: 'e2', values: ['zh'] });
    expect(selected).toMatchObject({ ref: 'e2', selectedValues: ['zh'], selectedLabels: ['Chinese'] });

    dbg.commands.length = 0;
    const filesRes = await session.setInputFiles('e1', ['/tmp/a.pdf']);
    expect(filesRes).toMatchObject({ ref: 'e1', files: ['/tmp/a.pdf'], count: 1 });
    expect(dbg.commands[0]).toEqual({
      method: 'DOM.setFileInputFiles',
      params: { backendNodeId: 201, files: ['/tmp/a.pdf'] },
      sessionId: undefined,
    });

    dbg.commands.length = 0;
    await session.scroll({ direction: 'down', amount: 250 });
    expect(dbg.commands.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseWheel' && c.params?.deltaY === 250)).toBe(true);

    dbg.commands.length = 0;
    await session.remoteInput({ type: 'insertText', text: 'abc' });
    expect(dbg.commands).toEqual([{ method: 'Input.insertText', params: { text: 'abc' }, sessionId: undefined }]);
  });

  it('applies SoM overlay before screenshot and always cleans it up in finally, even on capture error', async () => {
    let failCapture = false;
    const evals: string[] = [];
    const { session } = createHarness(
      (method, params) => {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Play' }, backendDOMNodeId: 301 },
            ],
          };
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return {
            strings: ['', 'button', 'block', 'visible', '1', 'pointer', 'auto'],
            documents: [
              {
                nodes: { backendNodeId: [301], nodeName: [1], attributes: [[]] },
                layout: { nodeIndex: [0], bounds: [[12, 24, 80, 32]], styles: [[2, 3, 4, 5, 6]], text: [0] },
              },
            ],
          };
        }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
        if (method === 'Runtime.evaluate') {
          evals.push(String(params?.expression ?? ''));
          return { result: { value: 1 } };
        }
        if (method === 'Page.captureScreenshot') {
          if (failCapture) throw new Error('capture crashed');
          return { data: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x90, 0x02, 0x80]).toString('base64') };
        }
        return {};
      },
      {
        resizeImage: (_buf, mimeType, _maxWidth, _quality) => ({
          dataBase64: 'resized-data',
          width: 640,
          height: 400,
          mimeType,
        }),
      },
    );

    await session.snapshot({ interactiveOnly: true });
    const shot = await session.screenshot({ annotate: true, fullPage: true, maxWidth: 640, quality: 80 });
    expect(shot).toEqual({
      available: true,
      capability: 'browser_visible_webview_screenshot',
      mimeType: 'image/jpeg',
      dataBase64: 'resized-data',
      width: 640,
      height: 400,
      annotated: true,
    });
    expect(evals.some((expr) => expr.includes('data-ds-som-overlay') && expr.includes('appendChild'))).toBe(true);
    expect(evals[evals.length - 1]).toContain('removeChild');

    // Even if Page.captureScreenshot throws, overlay cleanup still executes
    evals.length = 0;
    failCapture = true;
    await expect(session.screenshot({ annotate: true })).rejects.toThrow('capture crashed');
    expect(evals.length).toBe(2);
    expect(evals[1]).toContain('removeChild');
  });

  it('captures console and network logs into capped ring buffers and supports filtering', async () => {
    const { dbg, session } = createHarness(() => ({}), { logCapacity: 3 });
    await session.ensureAttached();

    for (let i = 1; i <= 5; i += 1) {
      dbg.emitCdpEvent('Runtime.consoleAPICalled', {
        type: i % 2 === 0 ? 'error' : 'log',
        args: [{ type: 'string', value: `msg-${i}` }],
        timestamp: 1000 + i,
      });
    }
    expect(await session.consoleLogs()).toHaveLength(3);
    expect((await session.consoleLogs()).map((e) => e.text)).toEqual(['msg-3', 'msg-4', 'msg-5']);
    expect((await session.consoleLogs({ level: 'error' })).map((e) => e.text)).toEqual(['msg-4']);
    expect((await session.consoleLogs({ limit: 1 })).map((e) => e.text)).toEqual(['msg-5']);

    dbg.emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/ok', method: 'GET' },
      type: 'Fetch',
    });
    dbg.emitCdpEvent('Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://example.com/ok', status: 200, statusText: 'OK' },
      type: 'Fetch',
    });
    dbg.emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'r2',
      request: { url: 'https://example.com/missing', method: 'POST' },
      type: 'XHR',
    });
    dbg.emitCdpEvent('Network.responseReceived', {
      requestId: 'r2',
      response: { url: 'https://example.com/missing', status: 404, statusText: 'Not Found' },
      type: 'XHR',
    });
    dbg.emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'r3',
      request: { url: 'https://example.com/offline', method: 'GET' },
      type: 'Fetch',
    });
    dbg.emitCdpEvent('Network.loadingFailed', {
      requestId: 'r3',
      errorText: 'net::ERR_FAILED',
      type: 'Fetch',
    });

    expect(await session.networkLogs()).toHaveLength(3);
    const errorsOnly = await session.networkLogs({ statusMin: 400 });
    expect(errorsOnly).toHaveLength(2);
    expect(errorsOnly[0]?.status).toBe(404);
    expect(errorsOnly[1]?.failed).toBe(true);
    expect(errorsOnly[1]?.errorText).toBe('net::ERR_FAILED');
  });

  it('deduplicates concurrent ensureAttached calls, enables Page, attaches lazily on logs, and clears pendingRequests on nav/detach', async () => {
    const { dbg, session } = createHarness(async (method) => {
      if (method === 'Page.enable') {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: 'complete' } };
      }
      return {};
    });

    await Promise.all([session.ensureAttached(), session.ensureAttached(), session.consoleLogs()]);
    expect(dbg.commands.filter((c) => c.method === 'Page.enable')).toHaveLength(1);
    expect(dbg.commands.filter((c) => c.method === 'Runtime.enable')).toHaveLength(1);
    expect(dbg.commands.filter((c) => c.method === 'Network.enable')).toHaveLength(1);
    expect(dbg.commands.filter((c) => c.method === 'Target.setAutoAttach')).toHaveLength(1);

    // A pending request blocks networkidle until cleared by Page.frameNavigated
    dbg.emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'stuck-1',
      request: { url: 'https://example.com/slow', method: 'GET' },
      type: 'Fetch',
    });
    setTimeout(() => {
      dbg.emitCdpEvent('Page.frameNavigated', { frame: { id: 'main-frame' } });
    }, 60);
    const started = Date.now();
    const idleResult = await session.waitFor({ loadState: 'networkidle', timeoutMs: 2_000 }) as { matched: boolean };
    expect(idleResult.matched).toBe(true);
    // Must wait at least ~400ms of sustained quiet after navigation cleared pendingRequests
    expect(Date.now() - started).toBeGreaterThanOrEqual(420);

    // Pending request also clears on Target.detachedFromTarget
    dbg.emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'stuck-2',
      request: { url: 'https://example.com/iframe-req', method: 'GET' },
      type: 'Fetch',
    });
    dbg.emitCdpEvent('Target.detachedFromTarget', { sessionId: 'oopif-9' });
    const idleAfterDetach = await session.waitFor({ loadState: 'networkidle', timeoutMs: 1_500 }) as { matched: boolean };
    expect(idleAfterDetach.matched).toBe(true);
  });

  it('rejects zero-area box on click, subtracts scroll offset on fallback box, and uploads base64 files via DataTransfer', async () => {
    const { dbg, session } = createHarness((method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Zero' }, backendDOMNodeId: 501 },
            { nodeId: '2', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Scrolled' }, backendDOMNodeId: 502 },
            { nodeId: '3', role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Upload' }, backendDOMNodeId: 503 },
          ],
        };
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: ['', 'button', 'block', 'visible', '1', 'pointer', 'auto'],
          documents: [
            {
              nodes: { backendNodeId: [502], nodeName: [1], attributes: [[]] },
              layout: { nodeIndex: [0], bounds: [[100, 600, 80, 40]], styles: [[2, 3, 4, 5, 6]], text: [0] },
            },
          ],
        };
      }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON', attributes: [] } };
      if (method === 'DOM.getBoxModel') {
        if (params?.backendNodeId === 501) return { model: { border: [0, 0, 0, 0, 0, 0, 0, 0] } };
        throw new Error('no box model');
      }
      if (method === 'Runtime.evaluate') {
        if (String(params?.expression ?? '').includes('scrollY')) {
          return { result: { value: { x: 10, y: 400 } } };
        }
        return { result: { value: null } };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'upload-obj-503' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { ok: true, files: [{ name: 'notes.txt', size: 5, type: 'text/plain' }] } } };
      }
      return {};
    });

    await session.snapshot({ interactiveOnly: true });

    // Zero-area box must reject with STALE_REF instead of clicking (0, 0)
    await expect(session.click({ ref: 'e1' })).rejects.toThrow(/element box could not be resolved/);

    // Scrolled snapshot box fallback subtracts scrollX=10, scrollY=400 from center (140, 620) -> (130, 220)
    const clickedScrolled = await session.click({ ref: 'e2' });
    expect(clickedScrolled).toMatchObject({ mode: 'ref', ref: 'e2', point: { x: 130, y: 220 } });

    // Base64 file upload uses DOM.resolveNode + Runtime.callFunctionOn with DataTransfer
    dbg.commands.length = 0;
    const uploaded = await session.setInputFiles('e3', [{ name: 'notes.txt', base64: 'aGVsbG8=', mimeType: 'text/plain' }]);
    expect(uploaded).toEqual({
      ref: 'e3',
      files: [{ name: 'notes.txt', size: 5, type: 'text/plain' }],
      count: 1,
      submitted: false,
      engine: 'ax-cdp',
    });
    expect(dbg.commands.map((c) => c.method)).toEqual(['DOM.resolveNode', 'Runtime.callFunctionOn']);
    expect(String(dbg.commands[1]?.params?.functionDeclaration ?? '')).toContain('new DataTransfer()');
  });

  it('surfaces debugger attach failures cleanly so callers can fall back to ax-lite', async () => {
    const { dbg, session } = createHarness(() => ({}));
    dbg.attachError = new Error('Debugger is already attached to the target');
    await expect(session.snapshot({ interactiveOnly: true })).rejects.toThrow('Debugger is already attached');
    expect(session.isAttached()).toBe(false);
  });

  it('supports waitFor satisfaction and timeout errors', async () => {
    let ticks = 0;
    const { session } = createHarness((method, params) => {
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        if (expr === 'document.readyState') return { result: { value: 'complete' } };
        ticks += 1;
        return { result: { value: ticks >= 2 } };
      }
      return {};
    });

    const waited = await session.waitFor({ text: 'Loaded', loadState: 'load', timeoutMs: 2_000 });
    expect(waited).toMatchObject({ matched: true, engine: 'ax-cdp' });

    const { session: failing } = createHarness((method) => {
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      return {};
    });
    await expect(failing.waitFor({ selector: '#never', timeoutMs: 120 })).rejects.toThrow(/waitFor timed out/);
  });
});

describe('web-security::onBrowserWindowOpen controlled tab hook', () => {
  it('routes valid http(s) window.open to managed tab callback while denying non-http(s) and native popups', () => {
    const openedTabs: string[] = [];
    const logs: string[] = [];
    const contents = new EventEmitter() as EventEmitter & {
      windowOpenHandler?: (details: { url: string }) => { action: string };
      isDestroyed(): boolean;
      getURL(): string;
      setWindowOpenHandler(fn: (details: { url: string }) => { action: string }): void;
    };
    contents.isDestroyed = () => false;
    contents.getURL = () => 'https://example.com/';
    contents.setWindowOpenHandler = (fn) => {
      contents.windowOpenHandler = fn;
    };

    const policy: WebSecurityPolicy = {
      appOrigin: 'tauri://localhost',
      roleOf: () => 'browser',
      openerUrlAllow: [],
      openExternal: vi.fn(async () => undefined),
      onBrowserWindowOpen: (_source, url) => {
        if (url.includes('blocked')) return false;
        openedTabs.push(url);
        return true;
      },
      log: (msg) => logs.push(msg),
    };

    guardWebContents(contents as unknown as WebContents, policy);

    expect(contents.windowOpenHandler?.({ url: 'https://docs.example.com/guide' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler?.({ url: 'https://blocked.example.com/secret' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });

    expect(openedTabs).toEqual(['https://docs.example.com/guide']);
    expect(logs.some((line) => line.includes('opened managed tab'))).toBe(true);
    expect(logs.filter((line) => line.includes('blocked new window')).length).toBe(3);
  });
});
