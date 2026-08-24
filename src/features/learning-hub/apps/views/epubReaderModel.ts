import JSZip, { type JSZipObject } from 'jszip';
import { decodeBase64ToArrayBuffer, normalizeBase64 } from './previewUtils';

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const MAX_CHAPTER_BYTES = 12 * 1024 * 1024;
/** Hard cap on book-wide search hits; the UI tells the user when it is reached. */
export const EPUB_SEARCH_RESULT_LIMIT = 200;

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

export interface EpubChapter {
  id: string;
  path: string;
  title: string;
}

export interface EpubTocEntry {
  title: string;
  chapterIndex: number;
  fragment?: string;
  depth: number;
}

export interface EpubBookModel {
  title: string;
  author?: string;
  chapters: EpubChapter[];
  toc: EpubTocEntry[];
  zip: JSZip;
}

export interface RenderedEpubChapter {
  srcDoc: string;
  objectUrls: string[];
}

export type EpubReaderThemeName = 'light' | 'sepia' | 'dark';
export type EpubReaderFontFamily = 'book' | 'serif' | 'sans';

export interface EpubRenderOptions {
  theme: EpubReaderThemeName;
  fontScale: number;
  /** 'book' keeps the publisher font; 'serif' / 'sans' force a reader stack. */
  fontFamily?: EpubReaderFontFamily;
  lineHeight?: number;
  /** 0..1, mapped to the horizontal page padding inside the reading column. */
  pageMargin?: number;
}

export interface EpubSearchResult {
  chapterIndex: number;
  title: string;
  excerpt: string;
  /** Ordinal of this match inside its chapter (0-based), used to focus the hit. */
  matchIndex: number;
}

type ZipEntryWithSizes = JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

function parseXml(xml: string, label: string): Document {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error(`Invalid EPUB ${label}`);
  return document;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function directoryOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash + 1);
}

function decodeUriPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolveArchivePath(basePath: string, href: string): string {
  const path = href.split('#')[0]?.split('?')[0] ?? '';
  return normalizePath(`${directoryOf(basePath)}${decodeUriPath(path)}`);
}

function textContent(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function validateArchive(zip: JSZip, compressedBytes: number): void {
  const files = Object.values(zip.files).filter((entry) => !entry.dir) as ZipEntryWithSizes[];
  if (files.length > MAX_ARCHIVE_ENTRIES) throw new Error('EPUB contains too many files');

  let expandedBytes = 0;
  for (const file of files) {
    const size = file._data?.uncompressedSize;
    if (typeof size === 'number') expandedBytes += size;
  }
  if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('EPUB expanded content is too large');
  if (compressedBytes > 0 && expandedBytes / compressedBytes > MAX_COMPRESSION_RATIO) {
    throw new Error('EPUB compression ratio is unsafe');
  }
}

function findZipFile(zip: JSZip, path: string): JSZipObject | null {
  const normalized = normalizePath(path);
  const exact = zip.file(normalized);
  if (exact) return exact;
  const lower = normalized.toLocaleLowerCase();
  return Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLocaleLowerCase() === lower) ?? null;
}

async function readZipText(zip: JSZip, path: string, required = true): Promise<string> {
  const file = findZipFile(zip, path);
  if (!file) {
    if (required) throw new Error(`EPUB entry is missing: ${path}`);
    return '';
  }
  const size = (file as ZipEntryWithSizes)._data?.uncompressedSize;
  if (typeof size === 'number' && size > MAX_CHAPTER_BYTES) {
    throw new Error(`EPUB entry is too large: ${path}`);
  }
  return file.async('string');
}

function parseManifest(opf: Document, opfPath: string): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();
  for (const item of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    const id = item.getAttribute('id') ?? '';
    const href = item.getAttribute('href') ?? '';
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: resolveArchivePath(opfPath, href),
      mediaType: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    });
  }
  return manifest;
}

function chapterTitle(html: string, fallback: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return textContent(document.body.querySelector('h1, h2')) || textContent(document.querySelector('title')) || fallback;
}

function chapterText(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  // Keep <svg> subtrees: publishers put real text inside SVG (cover titles,
  // decorated headings) and it must stay searchable.
  document.querySelectorAll('script, style').forEach((node) => node.remove());
  return textContent(document.body);
}

function tocFromNav(
  html: string,
  navPath: string,
  chapterIndexByPath: Map<string, number>
): EpubTocEntry[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const nav = Array.from(document.querySelectorAll('nav')).find((element) => {
    const type = element.getAttribute('epub:type') ?? element.getAttribute('type') ?? '';
    return type.split(/\s+/).includes('toc');
  }) ?? document.querySelector('nav');
  if (!nav) return [];

  const entries: EpubTocEntry[] = [];
  for (const anchor of Array.from(nav.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    const path = resolveArchivePath(navPath, href);
    const chapterIndex = chapterIndexByPath.get(path);
    if (chapterIndex === undefined) continue;
    let depth = 0;
    let parent = anchor.parentElement;
    while (parent && parent !== nav) {
      if (parent.tagName === 'OL' || parent.tagName === 'UL') depth += 1;
      parent = parent.parentElement;
    }
    entries.push({
      title: textContent(anchor) || `Chapter ${chapterIndex + 1}`,
      chapterIndex,
      fragment: href.includes('#') ? href.slice(href.indexOf('#') + 1) : undefined,
      depth: Math.max(0, depth - 1),
    });
  }
  return entries;
}

function tocFromNcx(
  xml: string,
  ncxPath: string,
  chapterIndexByPath: Map<string, number>
): EpubTocEntry[] {
  const document = parseXml(xml, 'NCX');
  const entries: EpubTocEntry[] = [];
  for (const point of Array.from(document.getElementsByTagNameNS('*', 'navPoint'))) {
    const src = point.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src') ?? '';
    const path = resolveArchivePath(ncxPath, src);
    const chapterIndex = chapterIndexByPath.get(path);
    if (chapterIndex === undefined) continue;
    let depth = 0;
    let parent = point.parentElement;
    while (parent) {
      if (parent.localName === 'navPoint') depth += 1;
      parent = parent.parentElement;
    }
    entries.push({
      title: textContent(point.getElementsByTagNameNS('*', 'navLabel')[0]) || `Chapter ${chapterIndex + 1}`,
      chapterIndex,
      fragment: src.includes('#') ? src.slice(src.indexOf('#') + 1) : undefined,
      depth,
    });
  }
  return entries;
}

export async function loadEpubBook(base64Content: string): Promise<EpubBookModel> {
  const buffer = decodeBase64ToArrayBuffer(normalizeBase64(base64Content));
  const zip = await JSZip.loadAsync(buffer, { createFolders: false });
  validateArchive(zip, buffer.byteLength);

  const container = parseXml(await readZipText(zip, 'META-INF/container.xml'), 'container');
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB package document is missing');

  const opf = parseXml(await readZipText(zip, opfPath), 'package document');
  const manifest = parseManifest(opf, opfPath);
  const chapters: EpubChapter[] = [];
  for (const itemref of Array.from(opf.getElementsByTagNameNS('*', 'itemref'))) {
    const id = itemref.getAttribute('idref') ?? '';
    const item = manifest.get(id);
    if (!item) continue;
    chapters.push({
      id,
      path: item.href,
      title: `Chapter ${chapters.length + 1}`,
    });
  }
  if (!chapters.length) throw new Error('EPUB has no readable chapters');

  const chapterIndexByPath = new Map(chapters.map((chapter, index) => [chapter.path, index]));
  const navItem = Array.from(manifest.values()).find((item) => item.properties.split(/\s+/).includes('nav'));
  const ncxItem = Array.from(manifest.values()).find((item) => item.mediaType === 'application/x-dtbncx+xml');
  let toc: EpubTocEntry[] = [];
  if (navItem) toc = tocFromNav(await readZipText(zip, navItem.href), navItem.href, chapterIndexByPath);
  if (!toc.length && ncxItem) toc = tocFromNcx(await readZipText(zip, ncxItem.href), ncxItem.href, chapterIndexByPath);
  if (!toc.length) {
    for (const [chapterIndex, chapter] of chapters.entries()) {
      const html = await readZipText(zip, chapter.path);
      chapter.title = chapterTitle(html, chapter.title);
      toc.push({ title: chapter.title, chapterIndex, depth: 0 });
    }
  } else {
    for (const entry of toc) {
      if (entry.depth === 0 && chapters[entry.chapterIndex]?.title.startsWith('Chapter ')) {
        chapters[entry.chapterIndex].title = entry.title;
      }
    }
  }

  return {
    title: textContent(opf.getElementsByTagNameNS('*', 'title')[0]) || 'EPUB',
    author: textContent(opf.getElementsByTagNameNS('*', 'creator')[0]) || undefined,
    chapters,
    toc,
    zip,
  };
}

function mimeTypeForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', mp4: 'video/mp4', ogg: 'audio/ogg',
  };
  return types[extension ?? ''] ?? 'application/octet-stream';
}

async function resourceUrl(zip: JSZip, chapterPath: string, href: string, urls: string[]): Promise<string | null> {
  if (/^(?:data:|blob:|#)/i.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const path = resolveArchivePath(chapterPath, href);
  const file = findZipFile(zip, path);
  if (!file) return null;
  // JSZip 类型返回裸 Uint8Array；TS 5.7+ 的 BlobPart 要求 ArrayBuffer 背书的
  // 视图（排除 SharedArrayBuffer），运行时值满足该约束，收窄为 BlobPart。
  const blob = new Blob([(await file.async('uint8array')) as BlobPart], { type: mimeTypeForPath(path) });
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

async function rewriteCssUrls(css: string, zip: JSZip, cssPath: string, urls: string[]): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi));
  let rewritten = css.replace(/@import[^;]+;?/gi, '');
  for (const match of matches) {
    const replacement = await resourceUrl(zip, cssPath, match[2], urls);
    rewritten = rewritten.replace(match[0], replacement ? `url("${replacement}")` : 'none');
  }
  return rewritten.replace(/expression\s*\(|behavior\s*:|-moz-binding\s*:/gi, 'blocked(');
}

/**
 * Reading paper palettes. These are deliberate product colors (paper tones)
 * rendered inside the sandboxed iframe, which cannot read app-level tokens.
 * Keep them in sync with the `--epub-paper` custom properties in EpubPreview.css.
 */
const READER_PALETTES: Record<EpubReaderThemeName, {
  background: string;
  foreground: string;
  link: string;
  highlight: string;
  activeHighlight: string;
}> = {
  light: {
    background: '#ffffff',
    foreground: '#202124',
    link: '#2457a7',
    highlight: 'rgba(255, 204, 0, 0.32)',
    activeHighlight: 'rgba(255, 165, 0, 0.55)',
  },
  sepia: {
    background: '#f4ecd8',
    foreground: '#3d3528',
    link: '#735c2e',
    highlight: 'rgba(206, 137, 44, 0.28)',
    activeHighlight: 'rgba(196, 112, 22, 0.5)',
  },
  dark: {
    background: '#18191b',
    foreground: '#e8e8e8',
    link: '#8ab4f8',
    highlight: 'rgba(255, 200, 87, 0.26)',
    activeHighlight: 'rgba(255, 200, 87, 0.52)',
  },
};

const READER_FONT_STACKS: Record<Exclude<EpubReaderFontFamily, 'book'>, string> = {
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', 'Songti SC', 'Source Han Serif SC', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
};

export async function renderEpubChapter(
  book: EpubBookModel,
  chapterIndex: number,
  options: EpubRenderOptions
): Promise<RenderedEpubChapter> {
  const { theme, fontScale } = options;
  const fontFamily = options.fontFamily ?? 'book';
  const lineHeight = options.lineHeight ?? 1.75;
  const pageMargin = Math.min(1, Math.max(0, options.pageMargin ?? 0.4));
  const chapter = book.chapters[chapterIndex];
  if (!chapter) throw new Error('EPUB chapter is unavailable');
  const chapterHtml = await readZipText(book.zip, chapter.path);
  const document = new DOMParser().parseFromString(chapterHtml, 'text/html');
  const objectUrls: string[] = [];

  document.querySelectorAll('script, iframe, frame, object, embed, form, base, meta[http-equiv]').forEach((node) => node.remove());
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'srcdoc') {
        element.removeAttribute(attribute.name);
      }
    }
  }

  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const cssPath = resolveArchivePath(chapter.path, link.getAttribute('href') ?? '');
    const css = await readZipText(book.zip, cssPath, false);
    const style = document.createElement('style');
    style.textContent = css ? await rewriteCssUrls(css, book.zip, cssPath, objectUrls) : '';
    link.replaceWith(style);
  }

  const resourceAttributes: Array<[string, string]> = [
    ['img[src]', 'src'], ['source[src]', 'src'],
    ['audio[src]', 'src'], ['video[src]', 'src'], ['video[poster]', 'poster'],
  ];
  for (const [selector, attribute] of resourceAttributes) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const href = element.getAttribute(attribute);
      if (!href) continue;
      const url = await resourceUrl(book.zip, chapter.path, href, objectUrls);
      if (url) element.setAttribute(attribute, url);
      else element.removeAttribute(attribute);
    }
  }
  // SVG <image> may reference bitmaps via either `href` (SVG 2) or the legacy
  // namespaced `xlink:href`; both must be rewritten to blob URLs.
  for (const element of Array.from(document.querySelectorAll('image'))) {
    for (const attribute of ['href', 'xlink:href']) {
      const href = element.getAttribute(attribute);
      if (!href) continue;
      const url = await resourceUrl(book.zip, chapter.path, href, objectUrls);
      if (url) element.setAttribute(attribute, url);
      else element.removeAttribute(attribute);
    }
  }

  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^(?:https?:|mailto:)/i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }

  const palette = READER_PALETTES[theme];
  const paddingInline = (1 + pageMargin * 5).toFixed(2);
  const fontFamilyCss = fontFamily === 'book' ? '' : `
    body { font-family: ${READER_FONT_STACKS[fontFamily]} !important; }
    body * { font-family: inherit !important; }
    body :where(pre, code, kbd, samp, tt), body :where(pre, code, kbd, samp, tt) * { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace !important; }`;
  const readerStyle = document.createElement('style');
  readerStyle.textContent = `
    :root {
      color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
      --reader-scrollbar-thumb: color-mix(in srgb, currentColor 28%, transparent);
    }
    html { background: ${palette.background}; color: ${palette.foreground}; font-size: ${Math.round(fontScale * 100)}%; }
    html { scrollbar-width: thin; scrollbar-color: var(--reader-scrollbar-thumb) transparent; }
    body { max-width: 48rem; margin: 0 auto; padding: 2.75rem ${paddingInline}rem 5.5rem; overflow-wrap: anywhere; text-rendering: optimizeLegibility; }
    body, body :where(p, li, blockquote, dd) { line-height: ${lineHeight} !important; }${fontFamilyCss}
    img, svg, video { max-width: 100%; height: auto; }
    /* 宽表格/代码块在窄 iframe 内自身横向滚动，避免撑破正文横向溢出 */
    table { max-width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
    pre { overflow-x: auto; max-width: 100%; }
    a { color: ${palette.link}; }
    ::selection { background: ${palette.highlight}; }
    mark[data-epub-search] { padding: 0 1px; border-radius: 2px; color: inherit; background: ${palette.highlight}; }
    mark[data-epub-search][data-current] { background: ${palette.activeHighlight}; }
    @media (max-width: 640px) { body { padding: 1.5rem 1.25rem 4rem; } }
  `;
  document.head.append(readerStyle);
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(csp);

  return { srcDoc: `<!doctype html>${document.documentElement.outerHTML}`, objectUrls };
}

const chapterTextCache = new WeakMap<JSZip, Map<string, string>>();

async function cachedChapterText(zip: JSZip, path: string): Promise<string> {
  let cache = chapterTextCache.get(zip);
  if (!cache) {
    cache = new Map();
    chapterTextCache.set(zip, cache);
  }
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const text = chapterText(await readZipText(zip, path));
  cache.set(path, text);
  return text;
}

export async function searchEpubBook(book: EpubBookModel, query: string): Promise<EpubSearchResult[]> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const results: EpubSearchResult[] = [];
  for (const [chapterIndex, chapter] of book.chapters.entries()) {
    if (results.length >= EPUB_SEARCH_RESULT_LIMIT) break;
    const text = await cachedChapterText(book.zip, chapter.path);
    const lower = text.toLocaleLowerCase();
    // Locale lowercasing can change string length; when it does, slice excerpts
    // from the lowercased text so offsets always stay valid.
    const source = lower.length === text.length ? text : lower;
    let matchIndex = 0;
    let offset = lower.indexOf(normalized);
    while (offset >= 0 && results.length < EPUB_SEARCH_RESULT_LIMIT) {
      const start = Math.max(0, offset - 50);
      const end = Math.min(source.length, offset + normalized.length + 90);
      results.push({
        chapterIndex,
        title: chapter.title,
        excerpt: `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`,
        matchIndex,
      });
      matchIndex += 1;
      offset = lower.indexOf(normalized, offset + Math.max(1, normalized.length));
    }
  }
  return results;
}

export function resolveEpubNavigation(
  book: EpubBookModel,
  currentChapterIndex: number,
  href: string
): { chapterIndex: number; fragment?: string } | null {
  const currentChapter = book.chapters[currentChapterIndex];
  if (!currentChapter || /^(?:https?:|mailto:|tel:|data:|blob:)/i.test(href) || href.startsWith('//')) return null;
  const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : undefined;
  if (href.startsWith('#')) return { chapterIndex: currentChapterIndex, fragment };
  const path = resolveArchivePath(currentChapter.path, href);
  const chapterIndex = book.chapters.findIndex((chapter) => chapter.path === path);
  return chapterIndex >= 0 ? { chapterIndex, fragment } : null;
}
