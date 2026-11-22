import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadNoteContentMock = vi.fn<(noteId: string) => Promise<string | null>>();

vi.mock('../noteContent', () => ({
  loadNoteContent: (noteId: string) => loadNoteContentMock(noteId),
}));

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn(async () => ({ x: 42, y: 84 })),
  offset: vi.fn(() => ({ name: 'offset' })),
  flip: vi.fn(() => ({ name: 'flip' })),
  shift: vi.fn(() => ({ name: 'shift' })),
}));

import {
  cancelWikilinkPreview,
  hideWikilinkPreviewNow,
  scheduleWikilinkPreview,
  WIKILINK_PREVIEW_SHOW_DELAY_MS,
} from '../hoverPreview';
import { renderPreviewMarkdown } from '../renderPreviewMarkdown';

function parseHtml(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('renderPreviewMarkdown', () => {
  it('renders headings, inline formatting, highlight, wikilinks, and links', () => {
    const md = [
      '# Main Heading',
      '### Sub Heading',
      '',
      'This has **bold**, *italic*, ~~strike~~, ==key point==, and `inline code`.',
      'Link to [[Calculus#Limits|Limits Note]] and [[Linear Algebra]] plus [Docs](https://example.com/a_(b)).',
    ].join('\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    expect(dom.querySelector('h1')?.textContent).toBe('Main Heading');
    expect(dom.querySelector('h3')?.textContent).toBe('Sub Heading');
    expect(dom.querySelector('strong')?.textContent).toBe('bold');
    expect(dom.querySelector('em')?.textContent).toBe('italic');
    expect(dom.querySelector('del')?.textContent).toBe('strike');

    const mark = dom.querySelector('mark.crepe-preview-mark');
    expect(mark?.textContent).toBe('key point');

    expect(dom.querySelector('code')?.textContent).toBe('inline code');

    const wikilinks = Array.from(dom.querySelectorAll('.crepe-preview-wikilink')).map(
      (el) => el.textContent,
    );
    expect(wikilinks).toEqual(['Limits Note', 'Linear Algebra']);

    const anchor = dom.querySelector<HTMLAnchorElement>('a.crepe-preview-link');
    expect(anchor?.textContent).toBe('Docs');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/a_(b)');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });

  it('renders blockquotes, bullet/ordered/nested lists, task lists, and fenced code blocks', () => {
    const md = [
      '> Important **quote**',
      '',
      '- Bullet one',
      '  - Nested bullet',
      '',
      '1. First step',
      '2. Second step',
      '',
      '- [x] Completed task',
      '- [ ] Pending task',
      '',
      '```ts',
      'const price = "$x$ ==not mark==";',
      '<!-- ds:block-id=inside-code -->',
      '```',
    ].join('\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    expect(dom.querySelector('blockquote strong')?.textContent).toBe('quote');
    expect(dom.querySelectorAll('ol > li')).toHaveLength(2);
    expect(dom.querySelector('ul ul li')?.textContent).toBe('Nested bullet');

    const taskItems = dom.querySelectorAll('.crepe-preview-task-item');
    expect(taskItems).toHaveLength(2);
    expect(taskItems[0].classList.contains('crepe-preview-task-item--checked')).toBe(true);
    expect(taskItems[0].querySelector('.crepe-preview-task-box')?.getAttribute('data-checked')).toBe(
      'true',
    );
    expect(taskItems[1].classList.contains('crepe-preview-task-item--checked')).toBe(false);

    const codeBlock = dom.querySelector('pre.crepe-preview-code-block code.language-ts');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.textContent).toContain('$x$ ==not mark==');
    expect(codeBlock?.textContent).toContain('<!-- ds:block-id=inside-code -->');
    expect(dom.querySelector('pre .katex')).toBeNull();
    expect(dom.querySelector('pre mark')).toBeNull();
  });

  it('renders inline and block KaTeX while guarding escaped dollars, currency, and inline code', () => {
    const md = [
      'Einstein: $E = mc^2$ and escaped \\$5 to \\$10, plus currency $5 and $10.',
      'Code stays raw: `$a + b$` and `$$c + d$$`.',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
      '',
      '$$\\sum_{i=1}^n i$$',
    ].join('\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    // Inline math rendered with KaTeX
    const katexNodes = dom.querySelectorAll('.katex');
    expect(katexNodes.length).toBeGreaterThanOrEqual(3);

    // Display math blocks rendered cleanly
    const mathBlocks = dom.querySelectorAll('.crepe-preview-math-block .katex-display');
    expect(mathBlocks).toHaveLength(2);

    // Escaped \$ and currency are not parsed as math
    const firstParagraphText = dom.querySelector('p')?.textContent ?? '';
    expect(firstParagraphText).toContain('$5 to $10');
    expect(firstParagraphText).toContain('$5 and $10');

    // Inline code preserves raw $...$
    const inlineCodes = Array.from(dom.querySelectorAll('code')).map((el) => el.textContent);
    expect(inlineCodes).toEqual(['$a + b$', '$$c + d$$']);
  });

  it('strips frontmatter and internal ds:block-id comments cleanly', () => {
    const md = [
      '---',
      'title: Calculus Notes',
      'tags: [math, calculus]',
      '---',
      '<!-- ds:block-id=blk_001 -->',
      '',
      '# Derivatives <!-- ds:block-id=blk_002 -->',
      '',
      '<!-- ds:block-id=blk_003 -->',
      'Rate of change.',
    ].join('\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    expect(html).not.toContain('ds:block-id');
    expect(html).not.toContain('Calculus Notes');
    expect(dom.querySelector('h1')?.textContent).toBe('Derivatives');
    expect(dom.querySelector('p')?.textContent).toBe('Rate of change.');
  });

  it('returns empty string when content has only frontmatter and internal comments', () => {
    const md = [
      '---',
      'title: Empty',
      '---',
      '<!-- ds:block-id=only_meta -->',
      '   ',
    ].join('\n');

    expect(renderPreviewMarkdown(md)).toBe('');
  });

  it('sanitizes XSS payloads (<script>, onerror, onload, iframe, javascript: links)', () => {
    const md = [
      'Safe text <script>window.__xss = 1; alert(1)</script>',
      '<img src="x" onerror="alert(1)" />',
      '<svg onload="alert(2)"><circle r="5" /></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '[click me](javascript:alert(3))',
    ].join('\n\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    expect(dom.querySelector('script')).toBeNull();
    expect(dom.querySelector('iframe')).toBeNull();
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onload');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(dom.textContent).toContain('Safe text');
    expect(dom.querySelector('.crepe-preview-link')?.textContent).toBe('click me');
    expect(dom.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('bounds large note content cleanly and closes truncated fences', () => {
    const longMd = ['```js', 'const a = 1;\n'.repeat(200), '```'].join('\n');
    const html = renderPreviewMarkdown(longMd, { maxChars: 240 });
    const dom = parseHtml(html);

    expect(dom.querySelector('pre.crepe-preview-code-block code')).not.toBeNull();
    expect(dom.querySelector('.crepe-preview-ellipsis')?.textContent).toBe('…');
    expect(html.length).toBeLessThan(2000);
  });

  it('returns truncation ellipsis instead of empty string when a line-0 math block exceeds maxChars', () => {
    const hugeMath = ['$$', 'x + y + z = 0 \\\\ '.repeat(50), '$$'].join('\n');
    const html = renderPreviewMarkdown(hugeMath, { maxChars: 120 });
    const dom = parseHtml(html);

    expect(html).not.toBe('');
    expect(dom.querySelector('.crepe-preview-ellipsis')?.textContent).toBe('…');
  });

  it('converts raw <img> to image badge, forbids media tags, and enforces safe <a> attributes', () => {
    const md = [
      'Diagram: <img alt="Architecture" src="https://evil.example/a.png" onerror="alert(1)" />',
      '<video src="https://evil.example/v.mp4"></video><audio src="x"></audio><picture><source srcset="x"></picture>',
      '<a href="https://example.com/docs" target="_self">Safe Raw</a>',
      '<a href="javascript:alert(1)">Bad Raw</a>',
      '<a href="data:text/html,hi">Data Raw</a>',
    ].join('\n\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('video')).toBeNull();
    expect(dom.querySelector('audio')).toBeNull();
    expect(dom.querySelector('picture')).toBeNull();
    expect(dom.querySelector('source')).toBeNull();

    const badge = dom.querySelector('.crepe-preview-image-badge');
    expect(badge?.textContent).toBe('Architecture');

    const anchors = dom.querySelectorAll<HTMLAnchorElement>('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/docs');
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    expect(anchors[0].getAttribute('rel')).toBe('noopener noreferrer');

    const spans = Array.from(dom.querySelectorAll('span.crepe-preview-link')).map(
      (el) => el.textContent,
    );
    expect(spans).toEqual(['Bad Raw', 'Data Raw']);
  });

  it('supports double-backtick inline code containing backticks and avoids ===/==== highlight false positives', () => {
    const md = [
      'Inline ``foo `bar` baz`` and `` `x` ``.',
      'Not marks: ===foo===, ====, and a === b === c.',
      'Valid mark with equation: ==E = mc^2==.',
    ].join('\n\n');

    const html = renderPreviewMarkdown(md);
    const dom = parseHtml(html);

    const codes = Array.from(dom.querySelectorAll('code')).map((el) => el.textContent);
    expect(codes).toEqual(['foo `bar` baz', '`x`']);

    const marks = Array.from(dom.querySelectorAll('mark.crepe-preview-mark')).map(
      (el) => el.textContent,
    );
    expect(marks).toEqual(['E = mc^2']);
    expect(dom.textContent).toContain('===foo===');
    expect(dom.textContent).toContain('====');
  });
});

describe('hoverPreview DOM lifecycle', () => {
  let anchor: HTMLSpanElement;

  beforeEach(() => {
    vi.useFakeTimers();
    loadNoteContentMock.mockReset();
    hideWikilinkPreviewNow();
    window.dispatchEvent(new Event('blur'));

    anchor = document.createElement('span');
    anchor.textContent = 'Target Note';
    document.body.appendChild(anchor);
  });

  afterEach(() => {
    hideWikilinkPreviewNow();
    window.dispatchEvent(new Event('blur'));
    anchor.remove();
    vi.useRealTimers();
  });

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('waits 650ms by default then renders rich Markdown + KaTeX preview', async () => {
    loadNoteContentMock.mockResolvedValue(
      '<!-- ds:block-id=b1 -->\n## Theorem\n\n==Crucial== formula $a^2 + b^2 = c^2$.',
    );

    scheduleWikilinkPreview(anchor, 'note_1', 'Pythagoras', { meta: '/math' });

    // Before 650ms, card should not be shown
    vi.advanceTimersByTime(WIKILINK_PREVIEW_SHOW_DELAY_MS - 50);
    await flushMicrotasks();
    const earlyCard = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview');
    expect(earlyCard === null || earlyCard.style.display === 'none').toBe(true);

    // After 650ms, card renders rich content
    vi.advanceTimersByTime(50);
    await flushMicrotasks();

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview');
    expect(card).not.toBeNull();
    expect(card?.style.display).toBe('flex');
    expect(card?.querySelector('.crepe-wikilink-preview__title')?.textContent).toBe('Pythagoras');
    expect(card?.querySelector('.crepe-wikilink-preview__meta')?.textContent).toBe('/math');

    const body = card?.querySelector('.crepe-wikilink-preview__body');
    expect(body?.classList.contains('crepe-wikilink-preview__body--rich')).toBe(true);
    expect(body?.querySelector('h2')?.textContent).toBe('Theorem');
    expect(body?.querySelector('mark.crepe-preview-mark')?.textContent).toBe('Crucial');
    expect(body?.querySelector('.katex')).not.toBeNull();
    expect(body?.innerHTML).not.toContain('ds:block-id');
  });

  it('shows empty fallback when note content is empty or only frontmatter', async () => {
    loadNoteContentMock.mockResolvedValue('---\ntitle: Blank\n---\n<!-- ds:block-id=1 -->');

    scheduleWikilinkPreview(anchor, 'note_empty', 'Blank Note', { immediate: true });
    await flushMicrotasks();

    const body = document.querySelector('.crepe-wikilink-preview__body');
    expect(body?.classList.contains('crepe-wikilink-preview__body--status')).toBe(true);
    expect(body?.textContent).toBeTruthy();
  });

  it('supports instant preview via immediate option and Cmd/Ctrl modifier key', async () => {
    loadNoteContentMock.mockResolvedValue('Instant **preview**');

    // 1. Pressed before hover
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    scheduleWikilinkPreview(anchor, 'note_mod', 'Mod Preview');
    await flushMicrotasks();

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview');
    expect(card?.style.display).toBe('flex');
    expect(card?.querySelector('strong')?.textContent).toBe('preview');

    // Release modifier -> goes back to 650ms delay
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false }));
    hideWikilinkPreviewNow();

    // 2. Pressed mid-hover while waiting for 650ms timer -> opens immediately
    scheduleWikilinkPreview(anchor, 'note_mod_2', 'Mid Hover');
    vi.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(card?.style.display).toBe('none');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    await flushMicrotasks();
    expect(card?.style.display).toBe('flex');
    expect(card?.querySelector('.crepe-wikilink-preview__title')?.textContent).toBe('Mid Hover');

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
  });

  it('keeps card open when scrolling inside card body, closes on external scroll or Escape', async () => {
    loadNoteContentMock.mockResolvedValue('Line 1\n\nLine 2');

    scheduleWikilinkPreview(anchor, 'note_scroll', 'Scrollable', { immediate: true });
    await flushMicrotasks();

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview')!;
    const body = card.querySelector<HTMLDivElement>('.crepe-wikilink-preview__body')!;
    expect(card.style.display).toBe('flex');

    // Scroll inside preview body must NOT close card
    body.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(card.style.display).toBe('flex');

    // Escape during IME composition must NOT close card
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }),
    );
    expect(card.style.display).toBe('flex');

    // Normal Escape closes card
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card.style.display).toBe('none');

    // Reopen and verify external scroll closes card
    scheduleWikilinkPreview(anchor, 'note_scroll', 'Scrollable', { immediate: true });
    await flushMicrotasks();
    expect(card.style.display).toBe('flex');

    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(card.style.display).toBe('none');
  });

  it('allows moving pointer from anchor into card without premature dismissal', async () => {
    loadNoteContentMock.mockResolvedValue('Hoverable content');

    scheduleWikilinkPreview(anchor, 'note_hover', 'Hoverable', { immediate: true });
    await flushMicrotasks();

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview')!;
    expect(card.style.display).toBe('flex');

    // Leave anchor -> schedules hide (200ms)
    cancelWikilinkPreview(anchor);
    vi.advanceTimersByTime(100);
    // Enter card before hide timer fires -> cancels hide
    card.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(300);
    expect(card.style.display).toBe('flex');

    // Leave card -> hides after 200ms
    card.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(250);
    expect(card.style.display).toBe('none');
  });

  it('renders error state distinctly when loadNoteContent returns null', async () => {
    loadNoteContentMock.mockResolvedValue(null);

    scheduleWikilinkPreview(anchor, 'note_missing', 'Broken Note', { immediate: true });
    await flushMicrotasks();

    const body = document.querySelector('.crepe-wikilink-preview__body');
    expect(body?.classList.contains('crepe-wikilink-preview__body--status')).toBe(true);
    expect(body?.classList.contains('crepe-wikilink-preview__body--error')).toBe(true);
    expect(body?.textContent).not.toContain('空笔记');
  });

  it('preserves rendered content and scrollTop when re-entering the same anchor, and closes on resize', async () => {
    loadNoteContentMock.mockResolvedValue('Paragraph 1\n\nParagraph 2');

    scheduleWikilinkPreview(anchor, 'note_same', 'Same Note', { immediate: true });
    await flushMicrotasks();
    expect(loadNoteContentMock).toHaveBeenCalledTimes(1);

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview')!;
    const body = card.querySelector<HTMLDivElement>('.crepe-wikilink-preview__body')!;
    body.scrollTop = 120;

    // Leave anchor -> schedule hide -> re-enter same anchor before hide fires
    cancelWikilinkPreview(anchor);
    vi.advanceTimersByTime(50);
    scheduleWikilinkPreview(anchor, 'note_same', 'Same Note', { immediate: true });
    vi.advanceTimersByTime(300);
    await flushMicrotasks();

    // Still same DOM node, scrollTop preserved, no redundant fetch
    expect(loadNoteContentMock).toHaveBeenCalledTimes(1);
    expect(card.style.display).toBe('flex');
    expect(card.style.visibility).toBe('visible');
    expect(card.querySelector('.crepe-wikilink-preview__body')).toBe(body);
    expect(body.scrollTop).toBe(120);

    // Resize closes preview
    window.dispatchEvent(new Event('resize'));
    expect(card.style.display).toBe('none');
  });

  it('prevents Escape from propagating to focus-mode listeners when closing a visible preview', async () => {
    loadNoteContentMock.mockResolvedValue('Focus mode check');

    scheduleWikilinkPreview(anchor, 'note_esc', 'Esc Note', { immediate: true });
    await flushMicrotasks();

    const card = document.querySelector<HTMLDivElement>('.crepe-wikilink-preview')!;
    expect(card.style.display).toBe('flex');

    let bubbleReached = false;
    const onBubbleEscape = () => {
      bubbleReached = true;
    };
    window.addEventListener('keydown', onBubbleEscape, false);
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(escEvent);
    window.removeEventListener('keydown', onBubbleEscape, false);

    expect(card.style.display).toBe('none');
    expect(escEvent.defaultPrevented).toBe(true);
    expect(bubbleReached).toBe(false);
  });
});
