/**
 * In-process Chrome DevTools Protocol (CDP) engine over Electron `webContents.debugger`.
 *
 * Pure testable helpers (AXTree pruning/indentation, DOMSnapshot metric extraction,
 * line-level snapshot diffing, password/OTP detection, key/modifier mapping, SoM overlays,
 * Readability content extraction, ring buffers) have zero runtime Electron imports so they
 * can be unit-tested directly under Node/Vitest.
 */
import {
  BrowserBridgeError,
  messageOf,
  type BrowserClickOptions,
  type BrowserConsoleEntry,
  type BrowserExtractOptions,
  type BrowserHoverOptions,
  type BrowserNetworkEntry,
  type BrowserPressKeyOptions,
  type BrowserRemoteInputOptions,
  type BrowserScreenshotOptions,
  type BrowserScreenshotResult,
  type BrowserSelectOptionOptions,
  type BrowserSnapshotOptions,
  type BrowserWaitOptions,
} from './browser-protocol.ts';

export const CDP_PROTOCOL_VERSION = '1.3';
export const DEFAULT_LOG_RING_CAPACITY = 50;
export const DEFAULT_MAX_SNAPSHOT_CHARS = 40_000;
export const DEFAULT_EXTRACT_MAX_CHARS = 24_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;
export const DEFAULT_SCREENSHOT_QUALITY = 80;

export const ALLOWED_CDP_DOMAINS: ReadonlySet<string> = new Set([
  'Accessibility',
  'DOM',
  'DOMSnapshot',
  'Input',
  'Page',
  'Target',
  'Runtime',
  'Network',
]);

export const CDP_MODIFIER_ALT = 1;
export const CDP_MODIFIER_CONTROL = 2;
export const CDP_MODIFIER_META = 4;
export const CDP_MODIFIER_SHIFT = 8;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
  'columnheader',
  'rowheader',
  'menubar',
  'menu',
  'tablist',
  'radiogroup',
  'scrollbar',
  'clickable',
]);

const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'heading',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'article',
  'section',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'table',
  'row',
  'cell',
  'list',
  'listitem',
  'img',
  'image',
  'figure',
  'paragraph',
  'blockquote',
  'code',
  'math',
  'StaticText',
]);

const IGNORED_WRAPPER_ROLES: ReadonlySet<string> = new Set([
  'none',
  'presentation',
  'generic',
  'RootWebArea',
  'WebArea',
  'InlineTextBox',
  'LineBreak',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'Iframe',
  'IframePresentational',
]);

const PASSWORD_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  'current-password',
  'new-password',
  'one-time-code',
]);

const PASSWORD_OR_OTP_FIELD_RE =
  /\b(otp|one[-_ ]?time|2fa|mfa|totp|passcode|pin[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|password)\b/i;

export interface CdpBase64FilePayload {
  name: string;
  base64: string;
  mimeType?: string;
  lastModified?: number;
}

const MAX_BASE64_UPLOAD_FILES = 20;
const MAX_BASE64_UPLOAD_TOTAL_CHARS = 36_000_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DebuggerMessageListener = (event: any, method: string, params: any, sessionId?: string) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DebuggerDetachListener = (event: any, reason: string) => void;

export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: DebuggerMessageListener): unknown;
  on(event: 'detach', listener: DebuggerDetachListener): unknown;
  off(event: 'message', listener: DebuggerMessageListener): unknown;
  off(event: 'detach', listener: DebuggerDetachListener): unknown;
}

export interface CdpWebContentsLike {
  readonly debugger: DebuggerLike;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
}

export interface CdpImageResizeResult {
  dataBase64: string;
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
}

export type CdpImageResizer = (
  buffer: Buffer,
  mimeType: 'image/png' | 'image/jpeg',
  maxWidth: number,
  quality: number,
) => CdpImageResizeResult;

export interface BrowserCdpSessionOptions {
  webContents: CdpWebContentsLike;
  platform?: string;
  log?: (message: string) => void;
  resizeImage?: CdpImageResizer;
  logCapacity?: number;
}

export interface CdpAXValue {
  type: string;
  value?: unknown;
}

export interface CdpAXProperty {
  name: string;
  value: CdpAXValue;
}

export interface CdpAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: CdpAXValue;
  name?: CdpAXValue;
  value?: CdpAXValue;
  description?: CdpAXValue;
  properties?: CdpAXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface CdpDOMSnapshotDocument {
  frameId?: number;
  nodes?: {
    backendNodeId?: number[];
    nodeName?: number[];
    attributes?: number[][];
    inputValue?: { index?: number[]; value?: number[] };
  };
  layout?: {
    nodeIndex?: number[];
    bounds?: number[][];
    styles?: number[][];
    text?: number[];
  };
}

export interface CdpDOMSnapshotResult {
  documents?: CdpDOMSnapshotDocument[];
  strings?: string[];
}

export interface CdpRefBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CdpDomNodeMetric {
  backendDOMNodeId: number;
  box: CdpRefBox;
  visible: boolean;
  cursorPointer: boolean;
  isPassword: boolean;
  tagName: string;
  text: string;
}

export interface CdpRefEntry {
  ref: string;
  backendDOMNodeId: number;
  frameId?: string;
  sessionId?: string;
  role: string;
  name: string;
  box?: CdpRefBox;
}

export interface CdpSnapshotNode {
  ref: string;
  role: string;
  name: string;
  box?: CdpRefBox;
  value?: string;
  password?: boolean;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
  level?: number;
  frameId?: string;
}

export interface CdpSnapshotResult {
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  engine: 'ax-cdp';
  interactiveOnly: boolean;
  diff: boolean;
  truncated: boolean;
  count: number;
  epoch: number;
  nodes: CdpSnapshotNode[];
  tree: string;
}

export interface CdpAxFrameInput {
  nodes: readonly CdpAXNode[];
  frameId?: string;
  sessionId?: string;
  offsetX?: number;
  offsetY?: number;
}

export interface CdpKeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers: number;
}

export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly items: T[] = [];

  constructor(capacity = DEFAULT_LOG_RING_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  push(item: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(item);
  }

  toArray(limit?: number): T[] {
    if (limit === undefined || limit >= this.items.length) {
      return [...this.items];
    }
    if (limit <= 0) return [];
    return this.items.slice(this.items.length - limit);
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}

export function assertAllowedCdpMethod(method: string): void {
  const dot = method.indexOf('.');
  const domain = dot > 0 ? method.slice(0, dot) : '';
  if (!ALLOWED_CDP_DOMAINS.has(domain)) {
    throw new Error(`CDP domain "${domain || method}" is not whitelisted`);
  }
}

export function parseFlatAttributes(attributes: readonly string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!attributes) return map;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const key = attributes[i];
    const value = attributes[i + 1];
    if (typeof key === 'string' && typeof value === 'string') {
      map.set(key.toLowerCase(), value);
    }
  }
  return map;
}

export function isPasswordOrOtpAttributes(
  attrs: ReadonlyMap<string, string>,
  tagName?: string,
): boolean {
  const typeAttr = (attrs.get('type') ?? '').trim().toLowerCase();
  if (typeAttr === 'password') return true;
  const autocomplete = (attrs.get('autocomplete') ?? '').trim().toLowerCase();
  if (autocomplete !== '') {
    for (const token of autocomplete.split(/\s+/)) {
      if (PASSWORD_AUTOCOMPLETE_TOKENS.has(token)) return true;
    }
  }
  const normalizedTag = (tagName ?? '').trim().toUpperCase();
  const roleAttr = (attrs.get('role') ?? '').trim().toLowerCase();
  const isTextField =
    normalizedTag === 'INPUT' ||
    normalizedTag === 'TEXTAREA' ||
    roleAttr === 'textbox';
  if (isTextField) {
    const hintText = [
      attrs.get('name') ?? '',
      attrs.get('id') ?? '',
      attrs.get('aria-label') ?? '',
      attrs.get('placeholder') ?? '',
    ].join(' ');
    if (PASSWORD_OR_OTP_FIELD_RE.test(hintText)) return true;
  }
  return false;
}

export function isPasswordOrOtpNode(node: { nodeName?: string; attributes?: readonly string[] } | null | undefined): boolean {
  if (!node) return false;
  return isPasswordOrOtpAttributes(parseFlatAttributes(node.attributes), node.nodeName);
}

function readSnapshotString(strings: readonly string[], index: number | undefined): string {
  if (typeof index !== 'number' || index < 0 || index >= strings.length) return '';
  return strings[index] ?? '';
}

export function extractDomSnapshotMetrics(
  snapshot: CdpDOMSnapshotResult | null | undefined,
): Map<number, CdpDomNodeMetric> {
  const metrics = new Map<number, CdpDomNodeMetric>();
  if (!snapshot || !Array.isArray(snapshot.documents)) return metrics;
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];

  for (const doc of snapshot.documents) {
    const nodes = doc.nodes;
    const layout = doc.layout;
    if (!nodes || !Array.isArray(nodes.backendNodeId)) continue;

    const layoutByNodeIndex = new Map<number, number>();
    if (layout && Array.isArray(layout.nodeIndex)) {
      for (let layoutIdx = 0; layoutIdx < layout.nodeIndex.length; layoutIdx += 1) {
        const nodeIndex = layout.nodeIndex[layoutIdx];
        if (typeof nodeIndex === 'number' && !layoutByNodeIndex.has(nodeIndex)) {
          layoutByNodeIndex.set(nodeIndex, layoutIdx);
        }
      }
    }

    for (let nodeIdx = 0; nodeIdx < nodes.backendNodeId.length; nodeIdx += 1) {
      const backendDOMNodeId = nodes.backendNodeId[nodeIdx];
      if (typeof backendDOMNodeId !== 'number' || backendDOMNodeId <= 0) continue;

      const tagName = readSnapshotString(strings, nodes.nodeName?.[nodeIdx]).toLowerCase();
      const rawAttrIndices = nodes.attributes?.[nodeIdx];
      const attrMap = new Map<string, string>();
      if (Array.isArray(rawAttrIndices)) {
        for (let i = 0; i + 1 < rawAttrIndices.length; i += 2) {
          const name = readSnapshotString(strings, rawAttrIndices[i]).toLowerCase();
          const val = readSnapshotString(strings, rawAttrIndices[i + 1]);
          if (name !== '') attrMap.set(name, val);
        }
      }
      const isPassword = isPasswordOrOtpAttributes(attrMap, tagName);

      const layoutIdx = layoutByNodeIndex.get(nodeIdx);
      let box: CdpRefBox = { x: 0, y: 0, w: 0, h: 0 };
      let visible = false;
      let cursorPointer = false;
      let text = '';

      if (layoutIdx !== undefined && layout) {
        const bounds = layout.bounds?.[layoutIdx];
        if (Array.isArray(bounds) && bounds.length >= 4) {
          box = {
            x: Math.round(bounds[0] ?? 0),
            y: Math.round(bounds[1] ?? 0),
            w: Math.round(bounds[2] ?? 0),
            h: Math.round(bounds[3] ?? 0),
          };
        }
        const styleIndices = layout.styles?.[layoutIdx];
        // Computed styles order requested in captureSnapshot:
        // ['display', 'visibility', 'opacity', 'cursor', 'pointer-events']
        const display = readSnapshotString(strings, styleIndices?.[0]).toLowerCase();
        const visibility = readSnapshotString(strings, styleIndices?.[1]).toLowerCase();
        const opacityRaw = readSnapshotString(strings, styleIndices?.[2]);
        const cursor = readSnapshotString(strings, styleIndices?.[3]).toLowerCase();
        const pointerEvents = readSnapshotString(strings, styleIndices?.[4]).toLowerCase();

        const opacity = opacityRaw === '' ? 1 : Number(opacityRaw);
        const hasArea = box.w >= 1 && box.h >= 1;
        visible =
          hasArea &&
          display !== 'none' &&
          visibility !== 'hidden' &&
          visibility !== 'collapse' &&
          !(Number.isFinite(opacity) && opacity <= 0.01);
        cursorPointer = visible && cursor === 'pointer' && pointerEvents !== 'none';
        text = readSnapshotString(strings, layout.text?.[layoutIdx]).replace(/\s+/g, ' ').trim();
      }

      metrics.set(backendDOMNodeId, {
        backendDOMNodeId,
        box,
        visible,
        cursorPointer,
        isPassword,
        tagName,
        text,
      });
    }
  }

  return metrics;
}

function axString(value: CdpAXValue | undefined): string {
  if (!value || value.value === undefined || value.value === null) return '';
  return String(value.value).replace(/\s+/g, ' ').trim();
}

function axProp(node: CdpAXNode, name: string): unknown {
  if (!Array.isArray(node.properties)) return undefined;
  const found = node.properties.find((prop) => prop.name === name);
  return found?.value?.value;
}

function escapeTreeName(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 120);
}

export function buildAxSnapshotTree(params: {
  axFrames: readonly CdpAxFrameInput[];
  domSnapshot: CdpDOMSnapshotResult | null;
  interactiveOnly: boolean;
  maxChars?: number;
  rootBackendNodeIds?: ReadonlySet<number> | null;
}): {
  nodes: CdpSnapshotNode[];
  refs: Map<string, CdpRefEntry>;
  tree: string;
  truncated: boolean;
} {
  const maxChars = params.maxChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  const domMetrics = extractDomSnapshotMetrics(params.domSnapshot);
  const refs = new Map<string, CdpRefEntry>();
  const emittedNodes: CdpSnapshotNode[] = [];
  const emittedBackendIds = new Set<number>();
  const lines: string[] = [];
  let refCounter = 0;
  let charCount = 0;
  let truncated = false;

  const pushLine = (line: string): boolean => {
    const addition = lines.length === 0 ? line.length : line.length + 1;
    if (charCount + addition > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    charCount += addition;
    return true;
  };

  for (let frameIdx = 0; frameIdx < params.axFrames.length; frameIdx += 1) {
    if (truncated) break;
    const frame = params.axFrames[frameIdx];
    if (!frame || frame.nodes.length === 0) continue;

    const byId = new Map<string, CdpAXNode>();
    const childSet = new Set<string>();
    for (const node of frame.nodes) {
      byId.set(node.nodeId, node);
      if (Array.isArray(node.childIds)) {
        for (const childId of node.childIds) childSet.add(childId);
      }
    }

    const roots = frame.nodes.filter((node) => !childSet.has(node.nodeId));
    const startNodes = roots.length > 0 ? roots : [frame.nodes[0]!];
    const visited = new Set<string>();
    const offsetX = frame.offsetX ?? 0;
    const offsetY = frame.offsetY ?? 0;
    let frameHeaderPending = frameIdx > 0 && typeof frame.frameId === 'string' && frame.frameId !== '';

    const pushFrameLine = (line: string): boolean => {
      if (frameHeaderPending && frame.frameId) {
        frameHeaderPending = false;
        if (!pushLine(`[frame ${frame.frameId}]`)) return false;
      }
      return pushLine(line);
    };

    const visit = (node: CdpAXNode, depth: number, inScope: boolean): void => {
      if (truncated || visited.has(node.nodeId)) return;
      visited.add(node.nodeId);

      const backendId = node.backendDOMNodeId;
      const nowInScope =
        inScope ||
        params.rootBackendNodeIds === undefined ||
        params.rootBackendNodeIds === null ||
        (backendId !== undefined && params.rootBackendNodeIds.has(backendId));

      const rawRole = axString(node.role) || 'generic';
      const role = rawRole === 'RootWebArea' || rawRole === 'WebArea' ? rawRole : rawRole;
      const metric = backendId !== undefined ? domMetrics.get(backendId) : undefined;
      const isClickableNonAria =
        !INTERACTIVE_ROLES.has(role) &&
        metric !== undefined &&
        metric.cursorPointer &&
        metric.visible;

      const isInteractive = INTERACTIVE_ROLES.has(role) || isClickableNonAria;
      const isStructural = !params.interactiveOnly && STRUCTURAL_ROLES.has(role);
      const isIgnored = node.ignored === true && !isClickableNonAria;
      const isWrapper = IGNORED_WRAPPER_ROLES.has(role) && !isClickableNonAria;

      const shouldEmit = nowInScope && !isIgnored && !isWrapper && (isInteractive || isStructural);

      let nextDepth = depth;
      if (shouldEmit) {
        const name = axString(node.name) || metric?.text || '';
        const isPassword =
          metric?.isPassword === true ||
          axProp(node, 'inputType') === 'password' ||
          role === 'password';
        const rawValue = axString(node.value);
        const disabled = axProp(node, 'disabled') === true;
        const focused = axProp(node, 'focused') === true;
        const expandedRaw = axProp(node, 'expanded');
        const expanded = typeof expandedRaw === 'boolean' ? expandedRaw : undefined;
        const selectedRaw = axProp(node, 'selected');
        const selected = typeof selectedRaw === 'boolean' ? selectedRaw : undefined;
        const checkedRaw = axProp(node, 'checked');
        const checked: boolean | 'mixed' | undefined =
          checkedRaw === true || checkedRaw === 'true'
            ? true
            : checkedRaw === false || checkedRaw === 'false'
              ? false
              : checkedRaw === 'mixed'
                ? 'mixed'
                : undefined;
        const levelRaw = axProp(node, 'level');
        const level = typeof levelRaw === 'number' && Number.isFinite(levelRaw) ? levelRaw : undefined;

        const effectiveRole = isClickableNonAria ? (metric?.tagName && metric.tagName !== 'div' && metric.tagName !== 'span' ? metric.tagName : 'clickable') : role;

        // Skip empty StaticText or invisible DOM nodes when metrics confirm hidden
        const confirmedHidden = metric !== undefined && !metric.visible && !focused;
        const emptyStaticText = effectiveRole === 'StaticText' && name === '';

        if (!confirmedHidden && !emptyStaticText) {
          const box: CdpRefBox | undefined = metric
            ? {
                x: metric.box.x + offsetX,
                y: metric.box.y + offsetY,
                w: metric.box.w,
                h: metric.box.h,
              }
            : undefined;

          const wantsRef = backendId !== undefined && (isInteractive || effectiveRole !== 'StaticText');
          let ref: string | undefined;
          if (wantsRef && backendId !== undefined) {
            refCounter += 1;
            ref = `e${refCounter}`;
            emittedBackendIds.add(backendId);
            refs.set(ref, {
              ref,
              backendDOMNodeId: backendId,
              ...(frame.frameId !== undefined ? { frameId: frame.frameId } : {}),
              ...(frame.sessionId !== undefined ? { sessionId: frame.sessionId } : {}),
              role: effectiveRole,
              name: name.slice(0, 120),
              ...(box !== undefined ? { box } : {}),
            });
            const snapshotNode: CdpSnapshotNode = {
              ref,
              role: effectiveRole,
              name: name.slice(0, 120),
              ...(box !== undefined ? { box } : {}),
              ...(isPassword
                ? { value: '[password]', password: true }
                : rawValue !== ''
                  ? { value: rawValue.slice(0, 120) }
                  : {}),
              ...(disabled ? { disabled: true } : {}),
              ...(checked !== undefined ? { checked } : {}),
              ...(expanded !== undefined ? { expanded } : {}),
              ...(selected !== undefined ? { selected } : {}),
              ...(focused ? { focused: true } : {}),
              ...(level !== undefined ? { level } : {}),
              ...(frame.frameId !== undefined ? { frameId: frame.frameId } : {}),
            };
            emittedNodes.push(snapshotNode);
          }

          const indent = '  '.repeat(Math.min(depth, 10));
          const bits: string[] = [];
          if (ref !== undefined) bits.push(`[${ref}]`);
          bits.push(level !== undefined && effectiveRole === 'heading' ? `heading(h${level})` : effectiveRole);
          if (name !== '') bits.push(`"${escapeTreeName(name)}"`);
          if (isPassword) bits.push('(password)');
          else if (rawValue !== '') bits.push(`value=${JSON.stringify(rawValue.slice(0, 120))}`);
          if (focused) bits.push('focused');
          if (checked === true) bits.push('checked');
          else if (checked === 'mixed') bits.push('checked=mixed');
          if (expanded === true) bits.push('expanded');
          else if (expanded === false) bits.push('collapsed');
          if (selected === true) bits.push('selected');
          if (disabled) bits.push('disabled');

          if (!pushFrameLine(`${indent}${bits.join(' ')}`)) return;
          nextDepth = depth + 1;
        }
      }

      if (Array.isArray(node.childIds)) {
        for (const childId of node.childIds) {
          const child = byId.get(childId);
          if (child) visit(child, nextDepth, nowInScope);
          if (truncated) break;
        }
      }
    };

    for (const root of startNodes) {
      visit(root, frameIdx > 0 ? 1 : 0, false);
      if (truncated) break;
    }
  }

  // Supplement clickable non-ARIA elements from DOMSnapshot that were omitted from AXTree entirely
  if (!truncated && (params.rootBackendNodeIds === undefined || params.rootBackendNodeIds === null)) {
    for (const metric of domMetrics.values()) {
      if (truncated) break;
      if (!metric.cursorPointer || !metric.visible) continue;
      if (emittedBackendIds.has(metric.backendDOMNodeId)) continue;
      refCounter += 1;
      const ref = `e${refCounter}`;
      const name = metric.text.slice(0, 120);
      const role = metric.tagName === 'div' || metric.tagName === 'span' || metric.tagName === '' ? 'clickable' : metric.tagName;
      refs.set(ref, {
        ref,
        backendDOMNodeId: metric.backendDOMNodeId,
        role,
        name,
        box: metric.box,
      });
      emittedNodes.push({
        ref,
        role,
        name,
        box: metric.box,
      });
      const line = `[${ref}] ${role}${name !== '' ? ` "${escapeTreeName(name)}"` : ''}`;
      if (!pushLine(line)) break;
    }
  }

  return {
    nodes: emittedNodes,
    refs,
    tree: lines.join('\n'),
    truncated,
  };
}

export function diffSnapshotTrees(
  previousTree: string,
  currentTree: string,
  maxChars = DEFAULT_MAX_SNAPSHOT_CHARS,
): { tree: string; truncated: boolean; added: number; removed: number; unchanged: number } {
  const prevLines = previousTree === '' ? [] : previousTree.split('\n');
  const currLines = currentTree === '' ? [] : currentTree.split('\n');

  const diffOps: Array<{ kind: 'same' | 'add' | 'del'; line: string }> = [];

  // Bounded LCS for line-level diff; fall back to multiset diff on very large trees
  if (prevLines.length * currLines.length <= 250_000) {
    const m = prevLines.length;
    const n = currLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      const row = dp[i]!;
      const nextRow = dp[i + 1]!;
      for (let j = n - 1; j >= 0; j -= 1) {
        if (prevLines[i] === currLines[j]) {
          row[j] = (nextRow[j + 1] ?? 0) + 1;
        } else {
          row[j] = Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (prevLines[i] === currLines[j]) {
        diffOps.push({ kind: 'same', line: currLines[j]! });
        i += 1;
        j += 1;
      } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
        diffOps.push({ kind: 'del', line: prevLines[i]! });
        i += 1;
      } else {
        diffOps.push({ kind: 'add', line: currLines[j]! });
        j += 1;
      }
    }
    while (i < m) {
      diffOps.push({ kind: 'del', line: prevLines[i]! });
      i += 1;
    }
    while (j < n) {
      diffOps.push({ kind: 'add', line: currLines[j]! });
      j += 1;
    }
  } else {
    const prevCounts = new Map<string, number>();
    for (const line of prevLines) prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1);
    const currCounts = new Map<string, number>();
    for (const line of currLines) currCounts.set(line, (currCounts.get(line) ?? 0) + 1);
    for (const line of prevLines) {
      const rem = currCounts.get(line) ?? 0;
      if (rem > 0) {
        currCounts.set(line, rem - 1);
        diffOps.push({ kind: 'same', line });
      } else {
        diffOps.push({ kind: 'del', line });
      }
    }
    for (const line of currLines) {
      const rem = prevCounts.get(line) ?? 0;
      if (rem > 0) {
        prevCounts.set(line, rem - 1);
      } else {
        diffOps.push({ kind: 'add', line });
      }
    }
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  const changeLines: string[] = [];
  for (const op of diffOps) {
    if (op.kind === 'same') {
      unchanged += 1;
    } else if (op.kind === 'add') {
      added += 1;
      changeLines.push(`+ ${op.line}`);
    } else {
      removed += 1;
      changeLines.push(`- ${op.line}`);
    }
  }

  const header = `--- snapshot diff (+${added} -${removed}, ${unchanged} unchanged) ---`;
  if (changeLines.length === 0) {
    return {
      tree: `${header}\n(no changes)`,
      truncated: false,
      added,
      removed,
      unchanged,
    };
  }

  const out: string[] = [header];
  let chars = header.length;
  let truncated = false;
  for (const line of changeLines) {
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    out.push(line);
    chars += line.length + 1;
  }

  return {
    tree: out.join('\n'),
    truncated,
    added,
    removed,
    unchanged,
  };
}

const NAMED_KEYS: Readonly<Record<string, { key: string; code: string; vk: number; text?: string }>> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
};

function modifierBitOf(token: string): number {
  switch (token.trim().toLowerCase()) {
    case 'alt':
    case 'option':
      return CDP_MODIFIER_ALT;
    case 'control':
    case 'ctrl':
      return CDP_MODIFIER_CONTROL;
    case 'meta':
    case 'cmd':
    case 'command':
    case 'super':
      return CDP_MODIFIER_META;
    case 'shift':
      return CDP_MODIFIER_SHIFT;
    default:
      return 0;
  }
}

export function resolveCdpKeySpec(rawKey: string, extraModifiers?: readonly string[]): CdpKeySpec {
  let modifiers = 0;
  if (extraModifiers) {
    for (const mod of extraModifiers) {
      modifiers |= modifierBitOf(mod);
    }
  }

  let baseKey = rawKey;
  if (rawKey.includes('+') && rawKey.length > 1) {
    const parts = rawKey.split('+');
    const last = parts[parts.length - 1] ?? '';
    let parsedAllPrefixAsModifiers = true;
    let comboModifiers = 0;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const bit = modifierBitOf(parts[i] ?? '');
      if (bit === 0) {
        parsedAllPrefixAsModifiers = false;
        break;
      }
      comboModifiers |= bit;
    }
    if (parsedAllPrefixAsModifiers && last !== '') {
      modifiers |= comboModifiers;
      baseKey = last;
    }
  }

  const lower = baseKey.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) {
    const hasNonShiftModifier = (modifiers & (CDP_MODIFIER_ALT | CDP_MODIFIER_CONTROL | CDP_MODIFIER_META)) !== 0;
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      ...(!hasNonShiftModifier && named.text !== undefined ? { text: named.text } : {}),
      modifiers,
    };
  }

  const fMatch = /^f([1-9]|1[0-2])$/i.exec(baseKey);
  if (fMatch) {
    const num = Number(fMatch[1]);
    return {
      key: `F${num}`,
      code: `F${num}`,
      windowsVirtualKeyCode: 111 + num,
      modifiers,
    };
  }

  if (baseKey.length === 1) {
    const codePoint = baseKey.charCodeAt(0);
    const hasNonShiftModifier = (modifiers & (CDP_MODIFIER_ALT | CDP_MODIFIER_CONTROL | CDP_MODIFIER_META)) !== 0;
    if (baseKey >= 'a' && baseKey <= 'z') {
      const upper = baseKey.toUpperCase();
      return {
        key: (modifiers & CDP_MODIFIER_SHIFT) !== 0 ? upper : baseKey,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        ...(!hasNonShiftModifier ? { text: (modifiers & CDP_MODIFIER_SHIFT) !== 0 ? upper : baseKey } : {}),
        modifiers,
      };
    }
    if (baseKey >= 'A' && baseKey <= 'Z') {
      const effectiveModifiers = hasNonShiftModifier ? modifiers : (modifiers | CDP_MODIFIER_SHIFT);
      const effectiveKey = hasNonShiftModifier && (modifiers & CDP_MODIFIER_SHIFT) === 0
        ? baseKey.toLowerCase()
        : baseKey;
      return {
        key: effectiveKey,
        code: `Key${baseKey}`,
        windowsVirtualKeyCode: baseKey.charCodeAt(0),
        ...(!hasNonShiftModifier ? { text: baseKey } : {}),
        modifiers: effectiveModifiers,
      };
    }
    if (baseKey >= '0' && baseKey <= '9') {
      return {
        key: baseKey,
        code: `Digit${baseKey}`,
        windowsVirtualKeyCode: codePoint,
        ...(!hasNonShiftModifier ? { text: baseKey } : {}),
        modifiers,
      };
    }
    return {
      key: baseKey,
      code: '',
      windowsVirtualKeyCode: codePoint,
      ...(!hasNonShiftModifier ? { text: baseKey } : {}),
      modifiers,
    };
  }

  return {
    key: baseKey,
    code: baseKey,
    windowsVirtualKeyCode: 0,
    modifiers,
  };
}

export function buildSomOverlayScript(
  marks: readonly { ref: string; box: CdpRefBox }[],
  fullPage = false,
): string {
  const payload = JSON.stringify(marks.slice(0, 200));
  return `(function(marks, fullPage){
  var ID = 'data-ds-som-overlay';
  var existing = document.querySelector('[' + ID + ']');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  var root = document.createElement('div');
  root.setAttribute(ID, '1');
  var sx = window.scrollX || (document.documentElement && document.documentElement.scrollLeft) || 0;
  var sy = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
  if (fullPage) {
    root.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;overflow:visible;';
  } else {
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
  }
  for (var i = 0; i < marks.length; i += 1) {
    var m = marks[i];
    if (!m || !m.box || m.box.w < 1 || m.box.h < 1) continue;
    var box = document.createElement('div');
    var pos = fullPage ? 'absolute' : 'fixed';
    box.style.cssText = 'position:' + pos + ';box-sizing:border-box;border:1.5px solid #d946ef;background:rgba(217,70,239,0.08);pointer-events:none;';
    box.style.left = (fullPage ? m.box.x : (m.box.x - sx)) + 'px';
    box.style.top = (fullPage ? m.box.y : (m.box.y - sy)) + 'px';
    box.style.width = m.box.w + 'px';
    box.style.height = m.box.h + 'px';
    var badge = document.createElement('span');
    badge.textContent = '[' + m.ref + ']';
    badge.style.cssText = 'position:absolute;left:0;top:0;transform:translateY(-100%);background:#111827;color:#ffffff;font:600 10px/1.2 monospace;padding:1px 3px;border-radius:2px;white-space:nowrap;pointer-events:none;';
    box.appendChild(badge);
    root.appendChild(box);
  }
  (document.documentElement || document.body).appendChild(root);
  return marks.length;
})(${payload}, ${fullPage ? 'true' : 'false'})`;
}

export function buildSomRemoveScript(): string {
  return `(function(){
  var nodes = document.querySelectorAll('[data-ds-som-overlay]');
  for (var i = 0; i < nodes.length; i += 1) {
    var node = nodes[i];
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
  return nodes.length;
})()`;
}

export function buildExtractContentScript(maxChars: number, startIndex = 0): string {
  const safeMax = Math.max(256, Math.min(200_000, Math.round(maxChars)));
  const safeStart = Math.max(0, Math.round(Number.isFinite(startIndex) ? startIndex : 0));
  return `(function(maxChars, startIndex){
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, IFRAME: 1, CANVAS: 1, TEMPLATE: 1, NAV: 1, ASIDE: 1, FOOTER: 1 };
  var SKIP_ROLES = { navigation: 1, banner: 1, contentinfo: 1, complementary: 1 };
  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('data-ds-som-overlay') || el.hasAttribute('data-ds-browser-occlusion-layer')) return true;
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (SKIP_ROLES[role]) return true;
    var cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    if (cls && /(^|\\s)(ad|ads|advert|advertisement|cookie-banner|cookie-consent)(\\s|$)/.test(cls)) return true;
    return false;
  }
  function mathTex(el) {
    var ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding*="tex"]');
    if (ann && ann.textContent) return ann.textContent.trim();
    var dataTex = el.getAttribute('data-tex') || el.getAttribute('aria-label');
    if (dataTex) return dataTex.trim();
    return (el.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  function inlineText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return (node.nodeValue || '').replace(/\\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    if (isSkipped(node)) return '';
    var tag = node.tagName;
    if (tag === 'MATH' || (node.classList && node.classList.contains('katex')) || tag === 'MJX-CONTAINER') {
      var tex = mathTex(node);
      return tex ? '$' + tex + '$' : '';
    }
    if (tag === 'BR') return '\\n';
    if (tag === 'CODE') {
      var codeText = (node.textContent || '').trim();
      return codeText ? '\`' + codeText.replace(/\`/g, '\\\\\`') + '\`' : '';
    }
    if (tag === 'A') {
      var href = node.getAttribute('href') || '';
      var label = collectInline(node).trim();
      if (!label) return '';
      if (!href || href.startsWith('javascript:')) return label;
      return '[' + label + '](' + href + ')';
    }
    if (tag === 'IMG') {
      var alt = (node.getAttribute('alt') || '').trim();
      var src = node.getAttribute('src') || '';
      return alt ? '![' + alt + '](' + src + ')' : '';
    }
    return collectInline(node);
  }
  function collectInline(el) {
    var out = '';
    for (var c = el.firstChild; c; c = c.nextSibling) out += inlineText(c);
    return out;
  }
  function renderTable(table) {
    var rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    var lines = [];
    for (var i = 0; i < rows.length; i += 1) {
      var cells = Array.from(rows[i].children).filter(function(c){ return c.tagName === 'TH' || c.tagName === 'TD'; });
      if (cells.length === 0) continue;
      var texts = cells.map(function(cell){ return collectInline(cell).trim().replace(/\\|/g, '\\\\|'); });
      lines.push('| ' + texts.join(' | ') + ' |');
      if (i === 0) {
        lines.push('| ' + texts.map(function(){ return '---'; }).join(' | ') + ' |');
      }
    }
    return lines.join('\\n');
  }
  var blocks = [];
  function walk(node, listDepth) {
    if (!node) return;
    if (node.nodeType === 3) {
      var t = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (t) blocks.push(t);
      return;
    }
    if (node.nodeType !== 1 || isSkipped(node)) return;
    var tag = node.tagName;
    if (tag === 'MATH' || (node.classList && (node.classList.contains('katex-display') || node.classList.contains('katex'))) || tag === 'MJX-CONTAINER') {
      var tex = mathTex(node);
      if (tex) {
        var display = (node.classList && node.classList.contains('katex-display')) || node.getAttribute('display') === 'block';
        blocks.push(display ? '$$\\n' + tex + '\\n$$' : '$' + tex + '$');
      }
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      var lvl = Number(tag.slice(1));
      var heading = collectInline(node).trim();
      if (heading) blocks.push('#'.repeat(lvl) + ' ' + heading);
      return;
    }
    if (tag === 'PRE') {
      var rawCode = (node.textContent || '').replace(/\\n$/, '');
      if (rawCode.trim()) blocks.push('\`\`\`\\n' + rawCode + '\\n\`\`\`');
      return;
    }
    if (tag === 'TABLE') {
      var tbl = renderTable(node);
      if (tbl) blocks.push(tbl);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      var q = collectInline(node).trim();
      if (q) blocks.push(q.split('\\n').map(function(l){ return '> ' + l.trim(); }).join('\\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      var items = Array.from(node.children).filter(function(c){ return c.tagName === 'LI'; });
      var listLines = [];
      for (var i = 0; i < items.length; i += 1) {
        var prefix = '  '.repeat(listDepth) + (tag === 'OL' ? (i + 1) + '. ' : '- ');
        var itemText = collectInline(items[i]).trim();
        if (itemText) listLines.push(prefix + itemText);
      }
      if (listLines.length > 0) blocks.push(listLines.join('\\n'));
      return;
    }
    if (tag === 'P') {
      var p = collectInline(node).trim();
      if (p) blocks.push(p);
      return;
    }
    for (var child = node.firstChild; child; child = child.nextSibling) {
      walk(child, listDepth);
    }
  }
  var root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]') || document.body || document.documentElement;
  if (root) walk(root, 0);
  var fullMarkdown = blocks.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  var chars = Array.from(fullMarkdown);
  var totalChars = chars.length;
  var sliceArr = startIndex >= totalChars ? [] : chars.slice(startIndex, startIndex + maxChars);
  var sliceChars = sliceArr.length;
  var markdown = sliceArr.join('');
  var truncated = startIndex + sliceChars < totalChars;
  var excerpt = markdown.replace(/\\s+/g, ' ').slice(0, 300);
  return {
    url: location.href,
    title: document.title || '',
    markdown: markdown,
    totalChars: totalChars,
    textLength: totalChars,
    truncated: truncated,
    excerpt: excerpt
  };
})(${safeMax}, ${safeStart})`;
}

export function quadCenter(quad: readonly number[]): { x: number; y: number } | null {
  if (quad.length < 8) return null;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX < 0.5 || maxY - minY < 0.5) return null;
  const x = xs.reduce((sum, v) => sum + v, 0) / 4;
  const y = ys.reduce((sum, v) => sum + v, 0) / 4;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function readImageDimensions(buffer: Buffer, mimeType: 'image/png' | 'image/jpeg'): { width: number; height: number } {
  if (mimeType === 'image/png' && buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (mimeType === 'image/jpeg' && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1]!;
      const len = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (len < 2) break;
      offset += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

function mouseButtonsBitmask(button: 'left' | 'right' | 'middle'): number {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

function formatConsoleArg(arg: Record<string, unknown>): string {
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined) {
    try {
      return JSON.stringify(arg.value);
    } catch {
      // boundary-allow empty-catch: fallback to string conversion for unserializable CDP console values
      return String(arg.value);
    }
  }
  if (typeof arg.description === 'string') return arg.description;
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  return typeof arg.type === 'string' ? `[${arg.type}]` : '';
}

export class BrowserCdpSession {
  private readonly webContents: CdpWebContentsLike;
  private readonly platform: string;
  private readonly log: (message: string) => void;
  private readonly resizeImage: CdpImageResizer | null;
  private readonly consoleRing: RingBuffer<BrowserConsoleEntry>;
  private readonly networkRing: RingBuffer<BrowserNetworkEntry>;
  private readonly childSessions = new Map<string, { targetId: string; frameId?: string }>();
  private readonly pendingRequests = new Map<string, { url: string; method: string; resourceType: string; timestamp: number }>();
  private refs = new Map<string, CdpRefEntry>();
  private epoch = 0;
  private lastSnapshotUrl: string | null = null;
  private lastSnapshotTree: string | null = null;
  private listenersBound = false;
  private domainsInitialized = false;
  private attachPromise: Promise<void> | null = null;
  private lastNetworkActivityAt = 0;

  private readonly onMessage: DebuggerMessageListener;
  private readonly onDetach: DebuggerDetachListener;

  constructor(options: BrowserCdpSessionOptions) {
    this.webContents = options.webContents;
    this.platform = options.platform ?? process.platform;
    this.log = options.log ?? (() => undefined);
    this.resizeImage = options.resizeImage ?? null;
    const capacity = options.logCapacity ?? DEFAULT_LOG_RING_CAPACITY;
    this.consoleRing = new RingBuffer<BrowserConsoleEntry>(capacity);
    this.networkRing = new RingBuffer<BrowserNetworkEntry>(capacity);

    this.onMessage = (_event, method, params, sessionId) => {
      this.handleProtocolEvent(method, (params ?? {}) as Record<string, unknown>, sessionId);
    };
    this.onDetach = (_event, reason) => {
      this.domainsInitialized = false;
      this.attachPromise = null;
      this.childSessions.clear();
      this.pendingRequests.clear();
      this.log(`[browser.cdp] debugger detached: ${reason}`);
    };
  }

  getEpoch(): number {
    return this.epoch;
  }

  hasRef(ref: string): boolean {
    return this.refs.has(ref);
  }

  isAttached(): boolean {
    if (this.webContents.isDestroyed()) return false;
    return this.webContents.debugger.isAttached();
  }

  async ensureAttached(): Promise<void> {
    if (this.webContents.isDestroyed()) {
      throw new Error('webview not found: browser-content');
    }
    if (this.domainsInitialized && this.webContents.debugger.isAttached()) {
      return;
    }
    if (this.attachPromise !== null) {
      return this.attachPromise;
    }
    const run = this.attachInternal().finally(() => {
      if (this.attachPromise === run) {
        this.attachPromise = null;
      }
    });
    this.attachPromise = run;
    return run;
  }

  private async attachInternal(): Promise<void> {
    if (this.webContents.isDestroyed()) {
      throw new Error('webview not found: browser-content');
    }
    const dbg = this.webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach(CDP_PROTOCOL_VERSION);
      this.domainsInitialized = false;
    }
    if (!this.listenersBound) {
      dbg.on('message', this.onMessage);
      dbg.on('detach', this.onDetach);
      this.listenersBound = true;
    }
    if (!this.domainsInitialized) {
      // Enable observation, navigation lifecycle, and OOPIF auto-attach on a best-effort basis.
      await this.sendBestEffortAttached('Page.enable');
      await this.sendBestEffortAttached('Runtime.enable');
      await this.sendBestEffortAttached('Network.enable');
      await this.sendBestEffortAttached('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      this.domainsInitialized = true;
    }
  }

  private async sendBestEffortAttached(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    assertAllowedCdpMethod(method);
    try {
      const dbg = this.webContents.debugger;
      return sessionId !== undefined
        ? await dbg.sendCommand(method, params, sessionId)
        : await dbg.sendCommand(method, params);
    } catch (error) {
      this.log(`[browser.cdp] optional command ${method} failed: ${messageOf(error)}`);
      return null;
    }
  }

  detach(): void {
    const dbg = this.webContents.debugger;
    if (this.listenersBound) {
      try {
        dbg.off('message', this.onMessage);
        dbg.off('detach', this.onDetach);
      } catch (error) {
        this.log(`[browser.cdp] failed to unbind debugger listeners: ${messageOf(error)}`);
      }
      this.listenersBound = false;
    }
    this.domainsInitialized = false;
    this.attachPromise = null;
    this.childSessions.clear();
    this.pendingRequests.clear();
    try {
      if (!this.webContents.isDestroyed() && dbg.isAttached()) {
        dbg.detach();
      }
    } catch (error) {
      this.log(`[browser.cdp] failed to detach debugger: ${messageOf(error)}`);
    }
  }

  private async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    assertAllowedCdpMethod(method);
    await this.ensureAttached();
    const dbg = this.webContents.debugger;
    const result = sessionId !== undefined
      ? await dbg.sendCommand(method, params, sessionId)
      : await dbg.sendCommand(method, params);
    return result as T;
  }

  private handleProtocolEvent(method: string, params: Record<string, unknown>, _sessionId?: string): void {
    if (method === 'Target.attachedToTarget') {
      const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
      const targetInfo = (params.targetInfo ?? {}) as Record<string, unknown>;
      const targetType = typeof targetInfo.type === 'string' ? targetInfo.type : '';
      const targetId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : '';
      if (targetSessionId !== null && (targetType === 'iframe' || targetType === 'page')) {
        this.childSessions.set(targetSessionId, { targetId, frameId: targetId || undefined });
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
      if (targetSessionId !== null) this.childSessions.delete(targetSessionId);
      this.pendingRequests.clear();
      this.lastNetworkActivityAt = Date.now();
      return;
    }
    if (method === 'Page.frameNavigated') {
      const frame = (params.frame ?? {}) as Record<string, unknown>;
      if (frame.parentId === undefined) {
        this.pendingRequests.clear();
        this.lastNetworkActivityAt = Date.now();
      }
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const level = typeof params.type === 'string' ? params.type : 'log';
      const args = Array.isArray(params.args) ? (params.args as Record<string, unknown>[]) : [];
      const text = args.map(formatConsoleArg).filter((item) => item !== '').join(' ').slice(0, 1_000);
      const stack = (params.stackTrace ?? {}) as { callFrames?: Array<{ url?: string; lineNumber?: number }> };
      const topFrame = stack.callFrames?.[0];
      const entry: BrowserConsoleEntry = {
        level,
        text,
        timestamp: typeof params.timestamp === 'number' ? Math.round(params.timestamp) : Date.now(),
        ...(typeof topFrame?.url === 'string' && topFrame.url !== '' ? { url: topFrame.url } : {}),
        ...(typeof topFrame?.lineNumber === 'number' ? { lineNumber: topFrame.lineNumber } : {}),
      };
      this.consoleRing.push(entry);
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : null;
      const request = (params.request ?? {}) as Record<string, unknown>;
      if (requestId !== null) {
        this.lastNetworkActivityAt = Date.now();
        this.pendingRequests.set(requestId, {
          url: typeof request.url === 'string' ? request.url : '',
          method: typeof request.method === 'string' ? request.method : 'GET',
          resourceType: typeof params.type === 'string' ? params.type : 'Other',
          timestamp: Date.now(),
        });
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : '';
      const response = (params.response ?? {}) as Record<string, unknown>;
      const pending = this.pendingRequests.get(requestId);
      this.lastNetworkActivityAt = Date.now();
      this.networkRing.push({
        requestId,
        url: typeof response.url === 'string' ? response.url : pending?.url ?? '',
        method: pending?.method ?? 'GET',
        status: typeof response.status === 'number' ? response.status : 0,
        statusText: typeof response.statusText === 'string' ? response.statusText : '',
        resourceType: typeof params.type === 'string' ? params.type : pending?.resourceType ?? 'Other',
        failed: false,
        timestamp: Date.now(),
      });
      return;
    }
    if (method === 'Network.loadingFinished') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : '';
      this.pendingRequests.delete(requestId);
      this.lastNetworkActivityAt = Date.now();
      return;
    }
    if (method === 'Network.loadingFailed') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : '';
      const pending = this.pendingRequests.get(requestId);
      this.pendingRequests.delete(requestId);
      this.lastNetworkActivityAt = Date.now();
      this.networkRing.push({
        requestId,
        url: pending?.url ?? '',
        method: pending?.method ?? 'GET',
        status: 0,
        statusText: '',
        resourceType: typeof params.type === 'string' ? params.type : pending?.resourceType ?? 'Other',
        failed: true,
        ...(typeof params.errorText === 'string' ? { errorText: params.errorText } : {}),
        timestamp: Date.now(),
      });
    }
  }

  private async evaluateInternal<T>(expression: string, sessionId?: string): Promise<T> {
    const reply = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    if (reply?.exceptionDetails) {
      const msg =
        reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text ??
        'Runtime evaluation failed';
      throw new Error(msg);
    }
    return reply?.result?.value as T;
  }

  private async getViewport(): Promise<{ w: number; h: number; dpr: number }> {
    try {
      const metrics = await this.send<{
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
        visualViewport?: { clientWidth?: number; clientHeight?: number; scale?: number };
      }>('Page.getLayoutMetrics');
      const w = Math.round(metrics?.cssVisualViewport?.clientWidth ?? metrics?.visualViewport?.clientWidth ?? 0);
      const h = Math.round(metrics?.cssVisualViewport?.clientHeight ?? metrics?.visualViewport?.clientHeight ?? 0);
      if (w > 0 && h > 0) {
        return { w, h, dpr: metrics?.visualViewport?.scale ?? 1 };
      }
    } catch (error) {
      this.log(`[browser.cdp] Page.getLayoutMetrics fallback: ${messageOf(error)}`);
    }
    try {
      const vp = await this.evaluateInternal<{ w: number; h: number; dpr: number }>(
        '({ w: window.innerWidth || 0, h: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 })',
      );
      if (vp && typeof vp.w === 'number' && typeof vp.h === 'number') return vp;
    } catch (error) {
      this.log(`[browser.cdp] viewport eval fallback: ${messageOf(error)}`);
    }
    return { w: 0, h: 0, dpr: 1 };
  }

  private async resolveSelectorBackendIds(selector: string): Promise<Set<number>> {
    const doc = await this.send<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: 1, pierce: true });
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== 'number') return new Set<number>();
    const found = await this.send<{ nodeId?: number }>('DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    });
    if (typeof found?.nodeId !== 'number' || found.nodeId === 0) {
      throw new BrowserBridgeError({
        code: 'NOT_FOUND',
        message: `selector did not match any element: ${selector}`,
        details: { selector },
      });
    }
    const described = await this.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
      nodeId: found.nodeId,
    });
    const set = new Set<number>();
    if (typeof described?.node?.backendNodeId === 'number') {
      set.add(described.node.backendNodeId);
    }
    return set;
  }

  async snapshot(options: Partial<BrowserSnapshotOptions> = {}): Promise<CdpSnapshotResult> {
    await this.ensureAttached();
    const interactiveOnly = options.interactiveOnly !== false;
    const maxChars = options.maxChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
    const wantsDiff = options.diff === true;

    let rootBackendNodeIds: Set<number> | null = null;
    if (typeof options.selector === 'string' && options.selector.trim() !== '') {
      rootBackendNodeIds = await this.resolveSelectorBackendIds(options.selector.trim());
    }

    const axFrames: CdpAxFrameInput[] = [];
    const mainAx = await this.send<{ nodes?: CdpAXNode[] }>('Accessibility.getFullAXTree');
    axFrames.push({ nodes: Array.isArray(mainAx?.nodes) ? mainAx.nodes : [] });

    // Traverse attached cross-origin/OOPIF child sessions when available
    for (const [childSessionId, info] of this.childSessions.entries()) {
      try {
        const childAx = await this.send<{ nodes?: CdpAXNode[] }>('Accessibility.getFullAXTree', {}, childSessionId);
        if (Array.isArray(childAx?.nodes) && childAx.nodes.length > 0) {
          axFrames.push({
            nodes: childAx.nodes,
            frameId: info.frameId,
            sessionId: childSessionId,
          });
        }
      } catch (error) {
        this.log(`[browser.cdp] skipping OOPIF AX tree (${childSessionId}): ${messageOf(error)}`);
      }
    }

    let domSnapshot: CdpDOMSnapshotResult | null = null;
    try {
      domSnapshot = await this.send<CdpDOMSnapshotResult>('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor', 'pointer-events'],
      });
    } catch (error) {
      this.log(`[browser.cdp] DOMSnapshot.captureSnapshot unavailable: ${messageOf(error)}`);
    }

    const built = buildAxSnapshotTree({
      axFrames,
      domSnapshot,
      interactiveOnly,
      maxChars,
      rootBackendNodeIds,
    });

    this.epoch += 1;
    this.refs = built.refs;

    const url = this.webContents.getURL();
    const title = this.webContents.getTitle();
    const viewport = await this.getViewport();

    let tree = built.tree;
    let truncated = built.truncated;
    let diffApplied = false;

    if (wantsDiff && this.lastSnapshotTree !== null && this.lastSnapshotUrl === url) {
      const diffed = diffSnapshotTrees(this.lastSnapshotTree, built.tree, maxChars);
      tree = diffed.tree;
      truncated = diffed.truncated;
      diffApplied = true;
    }

    this.lastSnapshotUrl = url;
    this.lastSnapshotTree = built.tree;

    return {
      url,
      title,
      viewport,
      engine: 'ax-cdp',
      interactiveOnly,
      diff: diffApplied,
      truncated,
      count: built.nodes.length,
      epoch: this.epoch,
      nodes: built.nodes,
      tree,
    };
  }

  private requireRef(ref: string): CdpRefEntry {
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new BrowserBridgeError({
        code: 'STALE_REF',
        message: `ref not found or detached: ${ref}`,
        details: { ref, epoch: this.epoch },
      });
    }
    return entry;
  }

  private async resolveRefCenter(entry: CdpRefEntry): Promise<{ x: number; y: number }> {
    try {
      await this.send(
        'DOM.scrollIntoViewIfNeeded',
        { backendNodeId: entry.backendDOMNodeId },
        entry.sessionId,
      );
    } catch (error) {
      this.log(`[browser.cdp] scrollIntoViewIfNeeded fallback for ${entry.ref}: ${messageOf(error)}`);
    }
    try {
      const boxModel = await this.send<{
        model?: { content?: number[]; border?: number[]; padding?: number[] };
      }>('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId }, entry.sessionId);
      const quad = boxModel?.model?.border ?? boxModel?.model?.content ?? boxModel?.model?.padding;
      if (Array.isArray(quad)) {
        const center = quadCenter(quad);
        if (center !== null) return center;
      }
    } catch (error) {
      this.log(`[browser.cdp] DOM.getBoxModel fallback for ${entry.ref}: ${messageOf(error)}`);
    }
    if (entry.box && entry.box.w >= 0.5 && entry.box.h >= 0.5) {
      let scrollX = 0;
      let scrollY = 0;
      try {
        const scroll = await this.evaluateInternal<{ x?: number; y?: number }>(
          '({ x: window.scrollX || (document.documentElement && document.documentElement.scrollLeft) || 0, y: window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0 })',
          entry.sessionId,
        );
        if (scroll && typeof scroll.x === 'number' && Number.isFinite(scroll.x)) scrollX = scroll.x;
        if (scroll && typeof scroll.y === 'number' && Number.isFinite(scroll.y)) scrollY = scroll.y;
      } catch (error) {
        this.log(`[browser.cdp] scroll offset fallback for ${entry.ref}: ${messageOf(error)}`);
      }
      return {
        x: entry.box.x + entry.box.w / 2 - scrollX,
        y: entry.box.y + entry.box.h / 2 - scrollY,
      };
    }
    throw new BrowserBridgeError({
      code: 'STALE_REF',
      message: `element box could not be resolved for ref: ${entry.ref}`,
      details: { ref: entry.ref },
    });
  }

  async click(target: BrowserClickOptions): Promise<unknown> {
    await this.ensureAttached();
    let x: number;
    let y: number;
    let entry: CdpRefEntry | null = null;
    if (typeof target.ref === 'string') {
      entry = this.requireRef(target.ref);
      // Security invariant: inspect DOM node attributes BEFORE clicking; NEVER interact with password/OTP inputs.
      const described = await this.send<{ node?: { nodeName?: string; attributes?: string[] } }>(
        'DOM.describeNode',
        { backendNodeId: entry.backendDOMNodeId },
        entry.sessionId,
      );
      if (isPasswordOrOtpNode(described?.node)) {
        throw new BrowserBridgeError({
          code: 'BLOCKED',
          message: 'password/OTP fields cannot be interacted with by agent bridge',
          details: { reason: 'password_field', ref: target.ref },
        });
      }
      const center = await this.resolveRefCenter(entry);
      x = center.x;
      y = center.y;
    } else if (typeof target.x === 'number' && Number.isFinite(target.x) && typeof target.y === 'number' && Number.isFinite(target.y)) {
      x = target.x;
      y = target.y;
    } else {
      throw new BrowserBridgeError({
        code: 'INVALID_ARGS',
        message: 'click requires {ref} or {x,y}',
      });
    }

    const button = target.button ?? 'left';
    const buttons = mouseButtonsBitmask(button);
    const doubleClick = target.doubleClick === true;
    const sessionId = entry?.sessionId;

    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 }, sessionId);
    if (doubleClick) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 2 }, sessionId);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 2 }, sessionId);
    }

    return {
      mode: entry !== null ? 'ref' : 'xy',
      ...(entry !== null ? { ref: entry.ref, role: entry.role, name: entry.name } : {}),
      point: { x: Math.round(x), y: Math.round(y) },
      button,
      doubleClick,
      engine: 'ax-cdp',
    };
  }

  async hover(target: BrowserHoverOptions): Promise<unknown> {
    await this.ensureAttached();
    let x: number;
    let y: number;
    let entry: CdpRefEntry | null = null;
    if (typeof target.ref === 'string') {
      entry = this.requireRef(target.ref);
      const center = await this.resolveRefCenter(entry);
      x = center.x;
      y = center.y;
    } else if (typeof target.x === 'number' && Number.isFinite(target.x) && typeof target.y === 'number' && Number.isFinite(target.y)) {
      x = target.x;
      y = target.y;
    } else {
      throw new BrowserBridgeError({
        code: 'INVALID_ARGS',
        message: 'hover requires {ref} or {x,y}',
      });
    }

    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0 },
      entry?.sessionId,
    );

    return {
      mode: entry !== null ? 'ref' : 'xy',
      ...(entry !== null ? { ref: entry.ref, role: entry.role, name: entry.name } : {}),
      point: { x: Math.round(x), y: Math.round(y) },
      engine: 'ax-cdp',
    };
  }

  async typeText(options: { ref: string; text: string; clear?: boolean; submit?: boolean }): Promise<unknown> {
    await this.ensureAttached();
    const entry = this.requireRef(options.ref);
    const clear = options.clear === true;
    const submit = options.submit === true;

    // Security invariant: inspect DOM node attributes BEFORE focusing or typing; NEVER type into password/OTP inputs.
    const described = await this.send<{ node?: { nodeName?: string; attributes?: string[] } }>(
      'DOM.describeNode',
      { backendNodeId: entry.backendDOMNodeId },
      entry.sessionId,
    );
    if (isPasswordOrOtpNode(described?.node)) {
      throw new BrowserBridgeError({
        code: 'BLOCKED',
        message: 'password fields cannot be typed by agent bridge',
        details: { reason: 'password_field', ref: options.ref },
      });
    }

    try {
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendDOMNodeId }, entry.sessionId);
    } catch (error) {
      this.log(`[browser.cdp] scrollIntoViewIfNeeded skipped during typeText: ${messageOf(error)}`);
    }

    await this.send('DOM.focus', { backendNodeId: entry.backendDOMNodeId }, entry.sessionId);

    if (clear) {
      const selectAllMod = this.platform === 'darwin' ? CDP_MODIFIER_META : CDP_MODIFIER_CONTROL;
      await this.send(
        'Input.dispatchKeyEvent',
        {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: selectAllMod,
          ...(this.platform === 'darwin' ? { commands: ['selectAll'] } : {}),
        },
        entry.sessionId,
      );
      await this.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllMod },
        entry.sessionId,
      );
      await this.send(
        'Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 },
        entry.sessionId,
      );
      await this.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 },
        entry.sessionId,
      );
      // Ensure standard input/textarea/contenteditable value is cleared cleanly even if selection was ignored.
      try {
        const resolved = await this.send<{ object?: { objectId?: string } }>(
          'DOM.resolveNode',
          { backendNodeId: entry.backendDOMNodeId },
          entry.sessionId,
        );
        if (typeof resolved?.object?.objectId === 'string') {
          await this.send(
            'Runtime.callFunctionOn',
            {
              objectId: resolved.object.objectId,
              functionDeclaration: `function() {
                if ((this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && this.value !== '') {
                  var proto = this instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (desc && desc.set) desc.set.call(this, '');
                  else this.value = '';
                  this.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (this && this.isContentEditable && this.textContent !== '') {
                  this.textContent = '';
                  this.dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
              }`,
              returnByValue: true,
            },
            entry.sessionId,
          );
        }
      } catch (error) {
        this.log(`[browser.cdp] clear fallback skipped: ${messageOf(error)}`);
      }
    }

    if (options.text !== '') {
      await this.send('Input.insertText', { text: options.text }, entry.sessionId);
    }

    if (submit) {
      await this.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
          modifiers: 0,
        },
        entry.sessionId,
      );
      await this.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: 0,
        },
        entry.sessionId,
      );
    }

    return {
      mode: 'ref',
      ref: entry.ref,
      role: entry.role,
      name: entry.name,
      length: options.text.length,
      cleared: clear,
      submitted: submit,
      engine: 'ax-cdp',
    };
  }

  async pressKey(options: BrowserPressKeyOptions): Promise<unknown> {
    await this.ensureAttached();
    const spec = resolveCdpKeySpec(options.key, options.modifiers);
    const downParams: Record<string, unknown> = {
      type: spec.text !== undefined ? 'keyDown' : 'rawKeyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: spec.modifiers,
      ...(spec.text !== undefined ? { text: spec.text, unmodifiedText: spec.text } : {}),
    };
    const upParams: Record<string, unknown> = {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: spec.modifiers,
    };
    await this.send('Input.dispatchKeyEvent', downParams);
    await this.send('Input.dispatchKeyEvent', upParams);
    return {
      key: spec.key,
      code: spec.code,
      modifiers: spec.modifiers,
      engine: 'ax-cdp',
    };
  }

  async selectOption(options: BrowserSelectOptionOptions): Promise<unknown> {
    await this.ensureAttached();
    const entry = this.requireRef(options.ref);
    const resolved = await this.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: entry.backendDOMNodeId },
      entry.sessionId,
    );
    const objectId = resolved?.object?.objectId;
    if (typeof objectId !== 'string') {
      throw new BrowserBridgeError({
        code: 'STALE_REF',
        message: `could not resolve DOM object for ref: ${options.ref}`,
        details: { ref: options.ref },
      });
    }

    const callResult = await this.send<{
      result?: { value?: { ok: boolean; error?: string; selectedValues?: string[]; selectedLabels?: string[] } };
    }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        arguments: [{ value: options.values }],
        returnByValue: true,
        functionDeclaration: `function(targets) {
          if (!(this instanceof HTMLSelectElement)) {
            return { ok: false, error: 'target element is not a <select>' };
          }
          var wanted = new Set(Array.isArray(targets) ? targets.map(String) : []);
          var matched = 0;
          for (var i = 0; i < this.options.length; i += 1) {
            var opt = this.options[i];
            var label = (opt.label || opt.textContent || '').trim();
            var hit = wanted.has(opt.value) || wanted.has(label);
            if (hit) {
              opt.selected = true;
              matched += 1;
              if (!this.multiple) {
                for (var j = 0; j < this.options.length; j += 1) {
                  if (j !== i) this.options[j].selected = false;
                }
                break;
              }
            } else if (this.multiple) {
              opt.selected = false;
            }
          }
          if (matched === 0) {
            return { ok: false, error: 'no matching <option> found' };
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          var selected = Array.from(this.selectedOptions);
          return {
            ok: true,
            selectedValues: selected.map(function(o) { return o.value; }),
            selectedLabels: selected.map(function(o) { return (o.label || o.textContent || '').trim(); }),
          };
        }`,
      },
      entry.sessionId,
    );

    const payload = callResult?.result?.value;
    if (!payload || payload.ok !== true) {
      throw new BrowserBridgeError({
        code: 'INVALID_TARGET',
        message: payload?.error ?? 'selectOption failed',
        details: { ref: options.ref },
      });
    }
    return {
      ref: entry.ref,
      selectedValues: payload.selectedValues ?? [],
      selectedLabels: payload.selectedLabels ?? [],
      engine: 'ax-cdp',
    };
  }

  async setInputFiles(
    ref: string,
    files: readonly (string | CdpBase64FilePayload)[],
  ): Promise<unknown> {
    await this.ensureAttached();
    const entry = this.requireRef(ref);
    if (files.length === 0) {
      throw new BrowserBridgeError({
        code: 'INVALID_ARGS',
        message: 'at least one file is required',
        details: { ref },
      });
    }
    const allPaths = files.every((item): item is string => typeof item === 'string');
    if (allPaths) {
      await this.send(
        'DOM.setFileInputFiles',
        {
          backendNodeId: entry.backendDOMNodeId,
          files: [...files],
        },
        entry.sessionId,
      );
      return {
        ref: entry.ref,
        files: [...files],
        count: files.length,
        engine: 'ax-cdp',
      };
    }

    const base64Files: CdpBase64FilePayload[] = [];
    let totalBase64Chars = 0;
    if (files.length > MAX_BASE64_UPLOAD_FILES) {
      throw new BrowserBridgeError({
        code: 'TOO_MANY_FILES',
        message: `too many files (${files.length} > ${MAX_BASE64_UPLOAD_FILES})`,
        details: { ref, maxFiles: MAX_BASE64_UPLOAD_FILES },
      });
    }
    for (const item of files) {
      if (typeof item !== 'object' || item === null || typeof item.name !== 'string' || typeof item.base64 !== 'string') {
        throw new BrowserBridgeError({
          code: 'INVALID_ARGS',
          message: 'file payload requires path or { name, base64 }',
          details: { ref },
        });
      }
      totalBase64Chars += item.base64.length;
      if (totalBase64Chars > MAX_BASE64_UPLOAD_TOTAL_CHARS) {
        throw new BrowserBridgeError({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'file upload payload exceeds size limit',
          details: { ref },
        });
      }
      base64Files.push({
        name: item.name,
        base64: item.base64,
        ...(typeof item.mimeType === 'string' && item.mimeType !== '' ? { mimeType: item.mimeType } : {}),
        ...(typeof item.lastModified === 'number' && Number.isFinite(item.lastModified) ? { lastModified: item.lastModified } : {}),
      });
    }

    const resolved = await this.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: entry.backendDOMNodeId },
      entry.sessionId,
    );
    const objectId = resolved?.object?.objectId;
    if (typeof objectId !== 'string') {
      throw new BrowserBridgeError({
        code: 'STALE_REF',
        message: `could not resolve DOM object for ref: ${ref}`,
        details: { ref },
      });
    }

    const callResult = await this.send<{
      result?: { value?: { ok: boolean; code?: string; error?: string; files?: Array<{ name: string; size: number; type: string }> } };
    }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        arguments: [{ value: base64Files }],
        returnByValue: true,
        functionDeclaration: `function(items) {
          if (!(this instanceof HTMLInputElement) || (this.type || '').toLowerCase() !== 'file') {
            return { ok: false, code: 'NOT_FILE_INPUT', error: 'target is not an input[type=file]' };
          }
          if (!Array.isArray(items) || items.length === 0) {
            return { ok: false, code: 'INVALID_ARGS', error: 'at least one file is required' };
          }
          if (!this.multiple && items.length > 1) {
            return { ok: false, code: 'TOO_MANY_FILES', error: 'target does not allow multiple files' };
          }
          if (typeof DataTransfer !== 'function') {
            return { ok: false, code: 'UNSUPPORTED', error: 'DataTransfer is unavailable in this WebView' };
          }
          var transfer = new DataTransfer();
          var selected = [];
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            var binary = window.atob(item.base64);
            var bytes = new Uint8Array(binary.length);
            for (var j = 0; j < binary.length; j += 1) {
              bytes[j] = binary.charCodeAt(j);
            }
            var file = new File([bytes], item.name, {
              type: typeof item.mimeType === 'string' && item.mimeType !== '' ? item.mimeType : 'application/octet-stream',
              lastModified: typeof item.lastModified === 'number' ? item.lastModified : Date.now(),
            });
            transfer.items.add(file);
            selected.push({ name: file.name, size: file.size, type: file.type });
          }
          this.files = transfer.files;
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return { ok: true, files: selected };
        }`,
      },
      entry.sessionId,
    );

    const payload = callResult?.result?.value;
    if (!payload || payload.ok !== true) {
      throw new BrowserBridgeError({
        code: payload?.code ?? 'FILE_SET_FAILED',
        message: payload?.error ?? 'setInputFiles failed',
        details: { ref },
      });
    }
    const uploaded = payload.files ?? [];
    return {
      ref: entry.ref,
      files: uploaded,
      count: uploaded.length,
      submitted: false,
      engine: 'ax-cdp',
    };
  }

  async scroll(options: { direction?: string | null; amount?: number | null; ref?: string | null }): Promise<unknown> {
    await this.ensureAttached();
    const direction = (options.direction ?? 'down').toLowerCase();
    const amount = typeof options.amount === 'number' && Number.isFinite(options.amount) ? Math.abs(options.amount) : 480;

    if (direction === 'top' || direction === 'bottom') {
      await this.evaluateInternal<boolean>(
        direction === 'top'
          ? '(window.scrollTo({ top: 0, behavior: "instant" }), true)'
          : '(window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }), true)',
      );
      return { direction, amount: 0, engine: 'ax-cdp' };
    }

    let x = 200;
    let y = 200;
    let sessionId: string | undefined;
    if (typeof options.ref === 'string' && options.ref !== '') {
      const entry = this.requireRef(options.ref);
      const center = await this.resolveRefCenter(entry);
      x = center.x;
      y = center.y;
      sessionId = entry.sessionId;
    } else {
      const vp = await this.getViewport();
      if (vp.w > 0 && vp.h > 0) {
        x = Math.round(vp.w / 2);
        y = Math.round(vp.h / 2);
      }
    }

    let deltaX = 0;
    let deltaY = 0;
    if (direction === 'up') deltaY = -amount;
    else if (direction === 'down') deltaY = amount;
    else if (direction === 'left') deltaX = -amount;
    else if (direction === 'right') deltaX = amount;
    else deltaY = amount;

    await this.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x,
        y,
        deltaX,
        deltaY,
      },
      sessionId,
    );

    return {
      direction,
      amount,
      point: { x: Math.round(x), y: Math.round(y) },
      deltaX,
      deltaY,
      engine: 'ax-cdp',
    };
  }

  async waitFor(options: BrowserWaitOptions = {}): Promise<unknown> {
    await this.ensureAttached();
    const timeoutMs = Math.max(100, Math.min(MAX_WAIT_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const loadState =
      options.loadState ?? (options.text === undefined && options.selector === undefined ? 'load' : undefined);
    let networkIdleSince: number | null = null;

    while (Date.now() <= deadline) {
      let satisfied = true;

      if (loadState !== undefined) {
        const readyState = await this.evaluateInternal<string>('document.readyState');
        if (loadState === 'domcontentloaded') {
          if (readyState !== 'interactive' && readyState !== 'complete') satisfied = false;
        } else if (loadState === 'load') {
          if (readyState !== 'complete') satisfied = false;
        } else if (loadState === 'networkidle') {
          const now = Date.now();
          if (readyState !== 'complete' || this.pendingRequests.size > 0) {
            networkIdleSince = null;
            satisfied = false;
          } else {
            if (networkIdleSince === null) {
              networkIdleSince = now;
            }
            if (this.lastNetworkActivityAt > networkIdleSince) {
              networkIdleSince = this.lastNetworkActivityAt;
            }
            if (now - networkIdleSince < 400) {
              satisfied = false;
            }
          }
        }
      }

      if (satisfied && typeof options.selector === 'string' && options.selector !== '') {
        const selectorOk = await this.evaluateInternal<boolean>(
          `(function(sel){
            var el = document.querySelector(sel);
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var r = el.getBoundingClientRect();
            return r.width >= 1 && r.height >= 1;
          })(${JSON.stringify(options.selector)})`,
        );
        if (!selectorOk) satisfied = false;
      }

      if (satisfied && typeof options.text === 'string' && options.text !== '') {
        const textOk = await this.evaluateInternal<boolean>(
          `(function(needle){
            var body = document.body;
            return Boolean(body && typeof body.innerText === 'string' && body.innerText.includes(needle));
          })(${JSON.stringify(options.text)})`,
        );
        if (!textOk) satisfied = false;
      }

      if (satisfied) {
        return {
          matched: true,
          elapsedMs: Date.now() - startedAt,
          url: this.webContents.getURL(),
          engine: 'ax-cdp',
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(120, remaining)));
    }

    throw new BrowserBridgeError({
      code: 'TIMEOUT',
      message: `waitFor timed out after ${timeoutMs}ms`,
      details: {
        timeoutMs,
        ...(options.text !== undefined ? { text: options.text } : {}),
        ...(options.selector !== undefined ? { selector: options.selector } : {}),
        ...(loadState !== undefined ? { loadState } : {}),
      },
    });
  }

  async extractContent(options: BrowserExtractOptions = {}): Promise<unknown> {
    await this.ensureAttached();
    const maxChars = options.maxChars ?? DEFAULT_EXTRACT_MAX_CHARS;
    const startIndex =
      typeof options.startIndex === 'number' && Number.isFinite(options.startIndex)
        ? Math.max(0, Math.round(options.startIndex))
        : 0;
    const script = buildExtractContentScript(maxChars, startIndex);
    return this.evaluateInternal<Record<string, unknown>>(script);
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    await this.ensureAttached();
    const fullPage = options.fullPage === true;
    const annotate = options.annotate === true;
    const maxWidth = options.maxWidth ?? DEFAULT_SCREENSHOT_MAX_WIDTH;
    const quality = options.quality ?? DEFAULT_SCREENSHOT_QUALITY;
    const format: 'png' | 'jpeg' = quality === 100 ? 'png' : 'jpeg';
    const mimeType: 'image/png' | 'image/jpeg' = format === 'png' ? 'image/png' : 'image/jpeg';

    let overlayApplied = false;
    try {
      if (annotate) {
        const marks: Array<{ ref: string; box: CdpRefBox }> = [];
        for (const entry of this.refs.values()) {
          if (entry.box && entry.box.w >= 1 && entry.box.h >= 1) {
            marks.push({ ref: entry.ref, box: entry.box });
          }
        }
        await this.evaluateInternal<number>(buildSomOverlayScript(marks, fullPage));
        overlayApplied = true;
      }

      const params: Record<string, unknown> = {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        ...(fullPage ? { captureBeyondViewport: true } : {}),
      };
      const result = await this.send<{ data?: string }>('Page.captureScreenshot', params);
      const rawBase64 = result?.data;
      if (typeof rawBase64 !== 'string' || rawBase64 === '') {
        return {
          available: false,
          capability: 'browser_visible_webview_screenshot',
          reasonCode: 'PLATFORM_API_UNAVAILABLE',
          reason: 'CDP Page.captureScreenshot returned empty image data',
        };
      }

      const buffer = Buffer.from(rawBase64, 'base64');
      if (this.resizeImage !== null) {
        const resized = this.resizeImage(buffer, mimeType, maxWidth, quality);
        return {
          available: true,
          capability: 'browser_visible_webview_screenshot',
          mimeType: resized.mimeType,
          dataBase64: resized.dataBase64,
          width: resized.width,
          height: resized.height,
          ...(annotate ? { annotated: true } : {}),
        };
      }

      const dims = readImageDimensions(buffer, mimeType);
      return {
        available: true,
        capability: 'browser_visible_webview_screenshot',
        mimeType,
        dataBase64: rawBase64,
        width: dims.width,
        height: dims.height,
        ...(annotate ? { annotated: true } : {}),
      };
    } finally {
      if (overlayApplied) {
        try {
          await this.evaluateInternal<number>(buildSomRemoveScript());
        } catch (error) {
          this.log(`[browser.cdp] failed to remove SoM overlay: ${messageOf(error)}`);
        }
      }
    }
  }

  async consoleLogs(options: { level?: string; limit?: number } = {}): Promise<BrowserConsoleEntry[]> {
    await this.ensureAttached();
    const all = this.consoleRing.toArray();
    const filtered = options.level ? all.filter((entry) => entry.level === options.level) : all;
    if (options.limit !== undefined && options.limit >= 0 && options.limit < filtered.length) {
      return filtered.slice(filtered.length - options.limit);
    }
    return filtered;
  }

  async networkLogs(options: { statusMin?: number; limit?: number } = {}): Promise<BrowserNetworkEntry[]> {
    await this.ensureAttached();
    const all = this.networkRing.toArray();
    const filtered =
      options.statusMin !== undefined
        ? all.filter((entry) => entry.failed || entry.status >= options.statusMin!)
        : all;
    if (options.limit !== undefined && options.limit >= 0 && options.limit < filtered.length) {
      return filtered.slice(filtered.length - options.limit);
    }
    return filtered;
  }

  async remoteInput(options: BrowserRemoteInputOptions): Promise<unknown> {
    await this.ensureAttached();
    if (options.type === 'insertText') {
      await this.send('Input.insertText', { text: options.text ?? '' });
      return { ok: true, type: options.type, engine: 'ax-cdp' };
    }
    if (options.type === 'keyDown' || options.type === 'keyUp') {
      const spec = resolveCdpKeySpec(options.key ?? '', options.modifiers);
      await this.send('Input.dispatchKeyEvent', {
        type: options.type === 'keyDown' && spec.text === undefined ? 'rawKeyDown' : options.type,
        key: spec.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        modifiers: spec.modifiers,
        ...(options.type === 'keyDown' && spec.text !== undefined ? { text: spec.text } : {}),
      });
      return { ok: true, type: options.type, key: spec.key, engine: 'ax-cdp' };
    }
    const x = options.x ?? 0;
    const y = options.y ?? 0;
    if (options.type === 'mouseWheel') {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: options.deltaX ?? 0,
        deltaY: options.deltaY ?? 0,
      });
      return { ok: true, type: options.type, engine: 'ax-cdp' };
    }
    const button = options.button ?? (options.type === 'mouseMoved' ? 'none' : 'left');
    const buttons =
      options.type === 'mousePressed' && button !== 'none'
        ? mouseButtonsBitmask(button)
        : 0;
    await this.send('Input.dispatchMouseEvent', {
      type: options.type,
      x,
      y,
      button,
      buttons,
      ...(options.clickCount !== undefined ? { clickCount: options.clickCount } : {}),
    });
    return { ok: true, type: options.type, engine: 'ax-cdp' };
  }
}
