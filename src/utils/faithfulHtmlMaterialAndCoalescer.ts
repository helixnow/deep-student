export interface MaterialBlock { unit: number; text: string; html: string; }
export interface FaithfulHtmlOptions { allowRemoteResources: boolean; }

const SEMANTIC_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,pre,blockquote,li,table,figcaption,dt,dd';
const FALLBACK_BLOCKS = 'main,article,section,aside,div';
const DROP_ELEMENTS = new Set([
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'output',
  'base', 'video', 'audio', 'source', 'track', 'canvas',
  'svg', 'math', 'use', 'animate', 'animatemotion', 'animatetransform', 'set', 'foreignobject', 'image',
]);

export function assertSandboxSafe(sandboxValue: string): void {
  const tokens = new Set(sandboxValue.toLowerCase().split(/\s+/));
  if (tokens.has('allow-scripts') && tokens.has('allow-same-origin')) {
    throw new Error('沙箱不能同时允许脚本和同源访问');
  }
}

/** 去掉 U+0000–U+0020（控制字符与空格）；scheme 判定前归一化，控制字符无法写进正则字面量，故逐字符过滤。 */
function stripControlAndSpace(value: string): string {
  let normalized = '';
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) normalized += ch;
  }
  return normalized;
}

function urlKind(raw: string): 'relative' | 'remote' | 'inline' | 'fragment' | 'blocked' {
  const url = stripControlAndSpace(raw.trim());
  if (url.startsWith('#')) return 'fragment';
  if (/^(https?:)?\/\//i.test(url)) return 'remote';
  if (/^(data|blob):/i.test(url)) return 'inline';
  if (!url || /^[a-z][a-z\d+.-]*:/i.test(url)) return 'blocked';
  return 'relative';
}

/** Serialize only into an iframe using the returned sandbox, never into the host DOM. */
export function prepareFaithfulHtmlMaterial(rawHtml: string, options: FaithfulHtmlOptions) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  let blockedRelativeResourceCount = 0;
  const resourceAllowed = (url: string): boolean => {
    const kind = urlKind(url);
    if (kind === 'relative') blockedRelativeResourceCount++;
    return kind === 'inline' || kind === 'fragment' || (kind === 'remote' && options.allowRemoteResources);
  };
  const rewriteCss = (css: string): string => css
    .replace(/\\[0-9a-fA-F]{1,6}\s?|\\./g, (escape) => {
      const hex = /^\\([0-9a-fA-F]{1,6})/.exec(escape);
      const code = hex ? parseInt(hex[1], 16) : 0;
      return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : escape.slice(1);
    })
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')[^;]*;?/gi,
      (_statement, ...groups: unknown[]) => {
        const url = groups.slice(0, 5).find((group) => typeof group === 'string') as string | undefined;
        if (urlKind(url ?? '') === 'relative') blockedRelativeResourceCount++;
        return '';
      })
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi,
      (token, double: string | undefined, single: string | undefined, bare: string | undefined) =>
        resourceAllowed(double ?? single ?? bare ?? '') ? token : 'url(about:invalid)');

  const materialBlocks: MaterialBlock[] = [];
  let pendingHeadings: Element[] = [];
  const textOf = (element: Element): string => (element.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  const emit = (body?: Element): void => {
    const elements = [...pendingHeadings, ...(body ? [body] : [])];
    pendingHeadings = [];
    const text = elements.map(textOf).filter(Boolean).join('\n\n');
    if (!text) return;
    const unit = materialBlocks.length + 1;
    for (const element of elements) element.setAttribute('data-mr-unit', String(unit));
    materialBlocks.push({ unit, text, html: elements.map((element) => element.outerHTML).join('\n') });
  };

  // One recursive walk sanitizes descendants before emitting both the block and its anchors.
  const walk = (element: Element, insideBlock = false, hidden = false): void => {
    const name = element.localName.toLowerCase();
    if (DROP_ELEMENTS.has(name) || (name === 'meta' && element.hasAttribute('http-equiv')) ||
        (name === 'link' && !(element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'))) {
      element.remove();
      return;
    }
    for (const attribute of [...element.attributes]) {
      const key = attribute.name.toLowerCase();
      const value = attribute.value;
      if (key.startsWith('on') || key === 'data-mr-unit' || key === 'srcdoc' || key === 'srcset' || key === 'ping' ||
          /^javascript:/i.test(stripControlAndSpace(value))) {
        element.removeAttribute(attribute.name);
      } else if (key === 'style') {
        element.setAttribute(attribute.name, rewriteCss(value));
      } else if (['src', 'href', 'xlink:href', 'poster', 'background', 'action', 'formaction'].includes(key)) {
        if (name === 'a' && key === 'href') {
          if (!/^(https?:|mailto:|#)/i.test(value.trim())) element.removeAttribute(attribute.name);
        } else if (!resourceAllowed(value)) element.removeAttribute(attribute.name);
      }
    }
    if (name === 'style') { element.textContent = rewriteCss(element.textContent ?? ''); return; }
    const inBody = element === doc.body || doc.body.contains(element);
    const isHidden = hidden || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true';
    const semantic = inBody && element.matches(SEMANTIC_BLOCKS);
    for (const child of [...element.children]) walk(child, insideBlock || semantic, isHidden);
    if (!inBody || insideBlock || isHidden || !textOf(element)) return;
    const fallback = element.matches(FALLBACK_BLOCKS) && !element.querySelector(SEMANTIC_BLOCKS) &&
      ![...element.children].some((child) => child.matches(FALLBACK_BLOCKS) && textOf(child));
    if (!semantic && !fallback) return;
    if (/^h[1-6]$/.test(name)) pendingHeadings.push(element);
    else emit(element);
  };
  walk(doc.documentElement);
  if (pendingHeadings.length) emit();
  if (!materialBlocks.length && textOf(doc.body)) {
    // Plain-text documents have one real location, not a fabricated wrapper per line.
    emit(doc.body);
  }
  const network = options.allowRemoteResources ? ' https: http:' : '';
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', [
    "default-src 'none'", "script-src 'none'", `img-src data: blob:${network}`,
    `style-src 'unsafe-inline'${network}`, `font-src data:${network}`,
    "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ].join('; '));
  doc.head.prepend(csp);
  assertSandboxSafe('allow-same-origin');
  return {
    html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
    materialBlocks,
    blockedRelativeResourceCount,
    sandboxAttribute: 'allow-same-origin' as const,
  };
}

export interface ViewportRect { left: number; top: number; width: number; height: number; }

export function translateIframeRectToViewport(rangeRect: ViewportRect, iframeRect: Pick<ViewportRect, 'left' | 'top'>) {
  const left = rangeRect.left + iframeRect.left;
  const top = rangeRect.top + iframeRect.top;
  return { left, top, x: left, y: top, width: rangeRect.width, height: rangeRect.height,
    right: left + rangeRect.width, bottom: top + rangeRect.height };
}

export interface ProgressUpdate<T = unknown> {
  scopeId: string;
  resourceId: string;
  field: string;
  value: T;
  sequenceFence: number;
}

export function progressFieldKey(update: Pick<ProgressUpdate, 'scopeId' | 'resourceId' | 'field'>): string {
  return JSON.stringify([update.scopeId, update.resourceId, update.field]);
}

/** Store the fence and value atomically in the receiving transaction. Older/equal replies are no-ops. */
export function applyFencedProgressUpdate<T>(state: Map<string, ProgressUpdate<T>>, update: ProgressUpdate<T>): boolean {
  const key = progressFieldKey(update);
  if (!Number.isSafeInteger(update.sequenceFence) || update.sequenceFence <= (state.get(key)?.sequenceFence ?? 0)) return false;
  state.set(key, { ...update });
  return true;
}

export interface ProgressCoalescerOptions<T> {
  send: (update: ProgressUpdate<T>) => Promise<unknown> | unknown;
  debounceMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  onError?: (error: unknown, update: ProgressUpdate<T>) => void;
}

/** Only replacement progress belongs here; documents, uploads and evidence must not coalesce.
 * Own one instance per browser stream/database lifetime; scopeId isolates database switches.
 * A durable outbox should persist returned updates (including fences) before transport.
 */
export class ProgressCommandCoalescer<T = unknown> {
  private readonly pending = new Map<string, { update: ProgressUpdate<T>; firstAt: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly sequences = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: ProgressCoalescerOptions<T>) { this.now = options.now ?? Date.now; }

  enqueue(input: Omit<ProgressUpdate<T>, 'sequenceFence'>): ProgressUpdate<T> {
    const key = progressFieldKey(input);
    const sequenceFence = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, sequenceFence);
    const update = { ...input, sequenceFence };
    const existing = this.pending.get(key);
    const now = this.now();
    const firstAt = existing?.firstAt ?? now;
    if (existing) clearTimeout(existing.timer);
    const delay = Math.max(0, Math.min(this.options.debounceMs ?? 400, firstAt + (this.options.maxDelayMs ?? 1000) - now));
    const timer = setTimeout(() => { void this.dispatch(key); }, delay);
    this.pending.set(key, { update, firstAt, timer });
    return { ...update };
  }

  private dispatch(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    this.pending.delete(key);
    const task = Promise.resolve().then(() => this.options.send(entry.update)).then(() => {}, (error: unknown) => {
      if ((this.pending.get(key)?.update.sequenceFence ?? 0) <= entry.update.sequenceFence &&
          (this.sequences.get(key) ?? 0) <= entry.update.sequenceFence) {
        this.pending.set(key, entry);
      }
      this.options.onError?.(error, entry.update);
    });
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task), () => this.inFlight.delete(task));
    return task;
  }

  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) void this.dispatch(key);
    await Promise.all([...this.inFlight]);
  }

  /** Drain on reader/player exit rather than silently dropping its last position. */
  dispose(): Promise<void> { return this.flush(); }
}
