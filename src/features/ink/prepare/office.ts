import JSZip from 'jszip';
import { renderAsync } from 'docx-preview';
import { init as initPptxPreview } from 'pptx-preview';
import { sanitizeRenderedDom, sanitizeDocxGeneratedStyles } from '@/features/learning-hub';

export type OfficeConversionErrorCode = 'UNSUPPORTED_FORMAT' | 'CONVERSION_FAILED' | 'CANCELLED' | 'LIMIT_EXCEEDED';

export interface OfficeConversionError extends Error {
  code: OfficeConversionErrorCode;
  stage?: string;
  cause?: unknown;
}

export interface OfficePage {
  png: Blob;
  width: number;
  height: number;
}

export interface OfficeConversionOptions {
  signal?: AbortSignal;
  max_pages?: number;
  max_pixels_per_page?: number;
}

export interface OfficeConversionResult {
  pages: OfficePage[];
  warnings: string[];
  converter_version: string;
}

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_PIXELS_PER_PAGE = 16_000_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_PNG_BYTES = 128 * 1024 * 1024;
const MAX_LONG_EDGE = 2048;
const STEP_TIMEOUT_MS = 20_000;
const PPTX_SLIDE_SELECTOR = '.pptx-preview-slide-wrapper';
const DOCX_PAGE_SELECTORS = '.docx-preview-wrapper > section.docx-preview, .docx-wrapper > section.docx';
const DOCX_VERSION = 'docx-preview@0.3.7';
const PPTX_VERSION = 'pptx-preview@1.0.7';
const SNAPDOM_VERSION = '@zumer/snapdom@2.0.2';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
let stageSequence = 0;

export function officeConversionError(code: OfficeConversionErrorCode, message: string): OfficeConversionError {
  return Object.assign(new Error(message), { code });
}

function fail(code: OfficeConversionErrorCode, message: string): never {
  throw officeConversionError(code, message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Office conversion was cancelled.');
}

function bounded<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(officeConversionError('CANCELLED', 'Office conversion was cancelled.')));
    const timer = window.setTimeout(
      () => finish(() => reject(officeConversionError('CONVERSION_FAILED', 'Office conversion timed out.'))),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

async function withStage<T>(stage: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    if (typeof (cause as OfficeConversionError)?.code === 'string') throw cause;
    throw Object.assign(officeConversionError('CONVERSION_FAILED', 'Office rendering step failed.'), { stage, cause });
  }
}

function parseXml(text: string): XMLDocument {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) fail('CONVERSION_FAILED', 'Office package XML is malformed.');
  return xml;
}

type ZipBudget = { decoded: number };

function declaredZipBytes(zip: JSZip): JSZip.JSZipObject[] {
  const allEntries = Object.values(zip.files);
  if (allEntries.length > MAX_ZIP_ENTRIES) fail('LIMIT_EXCEEDED', 'Office package has too many ZIP entries.');
  const entries = allEntries.filter((entry) => !entry.dir);
  let declaredTotal = 0;
  for (const entry of entries) {
    const metadata = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
    const declared = metadata?.uncompressedSize;
    if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ZIP_ENTRY_BYTES) {
      fail('LIMIT_EXCEEDED', 'Office package entry exceeds the uncompressed size limit.');
    }
    declaredTotal += declared;
    if (declaredTotal > MAX_ZIP_TOTAL_BYTES) fail('LIMIT_EXCEEDED', 'Office package exceeds the total uncompressed size limit.');
  }
  return entries;
}

function validateZipOutputBudget(zip: JSZip, changedEntryBytes: Map<string, number>): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) fail('LIMIT_EXCEEDED', 'Office package has too many ZIP entries.');
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const metadata = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
    const size = changedEntryBytes.get(entry.name) ?? metadata?.uncompressedSize;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_ZIP_ENTRY_BYTES) {
      fail('LIMIT_EXCEEDED', 'Office package entry exceeds the uncompressed size limit.');
    }
    totalBytes += size;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) fail('LIMIT_EXCEEDED', 'Office package exceeds the total uncompressed size limit.');
  }
}

async function readZipEntry(entry: JSZip.JSZipObject, budget: ZipBudget, signal?: AbortSignal, collect = true, countTotal = true): Promise<Uint8Array> {
  type ChunkStream = JSZip.JSZipObject & { internalStream(kind: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
  const stream = (entry as ChunkStream).internalStream('uint8array');
  const chunks: Uint8Array[] = [];
  const metadata = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
  let entryBytes = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else if (!collect) resolve(new Uint8Array());
      else {
        const output = new Uint8Array(entryBytes);
        let offset = 0;
        chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.byteLength; });
        resolve(output);
      }
    };
    const onAbort = () => {
      stream.pause();
      finish(officeConversionError('CANCELLED', 'Office conversion was cancelled.'));
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      entryBytes += chunk.byteLength;
      if (countTotal) budget.decoded += chunk.byteLength;
      if (entryBytes > MAX_ZIP_ENTRY_BYTES || (countTotal && budget.decoded > MAX_ZIP_TOTAL_BYTES) || entryBytes > (metadata?.uncompressedSize ?? -1)) {
        stream.pause();
        finish(officeConversionError('LIMIT_EXCEEDED', 'Office ZIP data exceeds actual or declared size limits.'));
        return;
      }
      if (collect) chunks.push(chunk);
    }).on('error', (error) => finish(error)).on('end', () => {
      if (entryBytes !== metadata?.uncompressedSize) {
        finish(officeConversionError('CONVERSION_FAILED', 'Office ZIP entry size does not match its directory metadata.'));
        return;
      }
      finish();
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    stream.resume();
  });
}

function hasExternalUri(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.trim());
}

function isRasterDataUri(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/]+={0,2}$/i.test(value.trim());
}

function isSafeGeneratedImageSource(value: string): boolean {
  const source = value.trim();
  if (isRasterDataUri(source)) return true;
  try {
    const url = new URL(source);
    return url.protocol === 'blob:' && url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function generatedImageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.getAttribute('src') || '';
}

function describeImageSource(source: string): string {
  const mime = /^data:([^;,]+)/i.exec(source)?.[1];
  const protocol = /^[a-z][a-z\d+.-]*:/i.exec(source)?.[0].slice(0, -1).toLowerCase();
  const kind = !source ? 'missing' : source.startsWith('blob:') ? 'blob' : mime ? `data:${mime}` : protocol ?? 'relative';
  return `${kind}/${source.length}`;
}

function imageSourceDescription(image: HTMLImageElement): string {
  return `currentSrc=${describeImageSource(image.currentSrc)},src=${describeImageSource(image.getAttribute('src') ?? '')}`;
}

type GeneratedImageSources = Array<string | null>;

function snapshotImageSources(root: ParentNode): GeneratedImageSources {
  return Array.from(root.querySelectorAll('img'), (image) => {
    const source = generatedImageSource(image);
    return isSafeGeneratedImageSource(source) ? source : null;
  });
}

async function waitForGeneratedImageSources(root: ParentNode, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    throwIfAborted(signal);
    const images = Array.from(root.querySelectorAll('img'));
    if (images.every((image) => isSafeGeneratedImageSource(generatedImageSource(image)))) return;
    await nextFrame(signal);
  }
  const missing = Array.from(root.querySelectorAll('img')).find((image) => !isSafeGeneratedImageSource(generatedImageSource(image)));
  fail('CONVERSION_FAILED', `Office renderer did not provide a safe image source (${missing ? imageSourceDescription(missing) : 'image count changed'}).`);
}

function restoreImageSources(root: ParentNode, sources: GeneratedImageSources): void {
  const images = Array.from(root.querySelectorAll('img'));
  if (images.length !== sources.length) fail('CONVERSION_FAILED', 'Sanitization changed the Office image set.');
  images.forEach((image, index) => {
    const source = sources[index];
    if (source && isSafeGeneratedImageSource(source) && image.getAttribute('src') !== source) {
      image.setAttribute('src', source);
    }
  });
}

function sanitizeSvg(text: string): string {
  const svg = parseXml(text);
  for (const node of Array.from(svg.querySelectorAll('script, foreignObject, iframe, object, embed'))) node.remove();
  for (const element of Array.from(svg.getElementsByTagName('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) element.removeAttributeNode(attribute);
      else if ((name === 'href' || name === 'src') && !value.startsWith('#') && !isRasterDataUri(value)) element.removeAttributeNode(attribute);
      else if (/url\s*\(/i.test(value) && Array.from(value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)).some((match) => !(match[2] ?? '').trim().startsWith('#'))) element.removeAttributeNode(attribute);
      else if (name === 'style' && /@import|expression\s*\(|javascript\s*:/i.test(value)) element.removeAttributeNode(attribute);
    }
  }
  for (const style of Array.from(svg.getElementsByTagName('style'))) {
    const text = style.textContent ?? '';
    if (/@import|expression\s*\(|javascript\s*:/i.test(text) || Array.from(text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)).some((match) => !(match[2] ?? '').trim().startsWith('#'))) style.remove();
  }
  return new XMLSerializer().serializeToString(svg);
}

function resolvePackageTarget(sourcePath: string, target: string): string {
  const path = target.trim();
  if (!path || hasExternalUri(path) || path.startsWith('/')) fail('CONVERSION_FAILED', 'Office asset relationship is invalid.');
  const parts = sourcePath.split('/').slice(0, -1);
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) fail('CONVERSION_FAILED', 'Office asset relationship escapes the package.');
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

function relationshipPath(partPath: string): string {
  const parts = partPath.split('/');
  const name = parts.pop();
  return [...parts, '_rels', `${name}.rels`].join('/');
}

function relationshipSourcePath(path: string): string {
  return path.replace(/_rels\/([^/]+)\.rels$/, '$1');
}

function relativePackageTarget(sourcePath: string, targetPath: string): string {
  const source = sourcePath.split('/').slice(0, -1);
  const target = targetPath.split('/');
  while (source.length && target.length && source[0] === target[0]) {
    source.shift();
    target.shift();
  }
  return [...source.map(() => '..'), ...target].join('/');
}

async function loadSafePackage(bytes: ArrayBuffer, format: 'docx' | 'pptx', signal?: AbortSignal) {
  throwIfAborted(signal);
  if (bytes.byteLength > MAX_SOURCE_BYTES) fail('LIMIT_EXCEEDED', 'Office source file exceeds the byte limit.');
  if (bytes.byteLength < 4) fail('UNSUPPORTED_FORMAT', 'Unsupported or empty Office file.');
  const signature = new Uint8Array(bytes, 0, 4);
  if (signature[0] === 0xd0 && signature[1] === 0xcf && signature[2] === 0x11 && signature[3] === 0xe0) {
    fail('UNSUPPORTED_FORMAT', 'Encrypted or legacy Office files are not supported.');
  }
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) fail('UNSUPPORTED_FORMAT', 'Expected a DOCX or PPTX OOXML package.');

  let zip: JSZip;
  try {
    zip = await bounded(JSZip.loadAsync(bytes), signal);
  } catch (error) {
    if ((error as OfficeConversionError)?.code) throw error;
    fail('CONVERSION_FAILED', 'Office package could not be read.');
  }
  const entries = declaredZipBytes(zip);
  const decodedBudget: ZipBudget = { decoded: 0 };
  const changedEntryBytes = new Map<string, number>();
  for (const entry of entries) await readZipEntry(entry, decodedBudget, signal, false);
  const imageTargets = new Map<string, string>();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (/\.rels$/i.test(entry.name)) {
      const xml = parseXml(new TextDecoder().decode(await readZipEntry(entry, decodedBudget, signal, true, false)));
      let changed = false;
      for (const relation of Array.from(xml.getElementsByTagName('*'))) {
        if (relation.localName !== 'Relationship') continue;
        const target = relation.getAttribute('Target') ?? '';
        const type = relation.getAttribute('Type') ?? '';
        if (relation.getAttribute('TargetMode')?.toLowerCase() === 'external' || hasExternalUri(target)) {
          relation.remove();
          changed = true;
          continue;
        }
        if (format === 'pptx' && /\/image$/i.test(type)) {
          const packageTarget = resolvePackageTarget(relationshipSourcePath(entry.name), target);
          const extension = packageTarget.split('.').pop();
          const isSupportedRaster = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension?.toLowerCase() ?? '');
          if (!isSupportedRaster || !zip.file(packageTarget)) {
            relation.remove();
            changed = true;
            continue;
          }
          if (!packageTarget.startsWith('ppt/media/image')) {
            let rendererTarget = imageTargets.get(packageTarget);
            if (!rendererTarget) {
              const basename = packageTarget.split('/').pop() ?? 'asset.png';
              const extension = basename.split('.').pop();
              const prefix = `ppt/media/imageInk${imageTargets.size + 1}`;
              rendererTarget = `${prefix}.${extension}`;
              for (let suffix = 1; zip.file(rendererTarget); suffix += 1) rendererTarget = `${prefix}_${suffix}.${extension}`;
              imageTargets.set(packageTarget, rendererTarget);
              const imageBytes = await readZipEntry(zip.file(packageTarget)!, decodedBudget, signal, true, false);
              changedEntryBytes.set(rendererTarget, imageBytes.byteLength);
              zip.file(rendererTarget, imageBytes);
            }
            relation.setAttribute('Target', relativePackageTarget(relationshipSourcePath(entry.name), rendererTarget));
            changed = true;
          }
        }
      }
      if (changed) {
        const rewritten = new XMLSerializer().serializeToString(xml);
        changedEntryBytes.set(entry.name, new TextEncoder().encode(rewritten).byteLength);
        zip.file(entry.name, rewritten);
      }
    } else if (/\.svg$/i.test(entry.name)) {
      const sanitized = sanitizeSvg(new TextDecoder().decode(await readZipEntry(entry, decodedBudget, signal, true, false)));
      changedEntryBytes.set(entry.name, new TextEncoder().encode(sanitized).byteLength);
      zip.file(entry.name, sanitized);
    }
  }

  const mainPath = format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
  const main = zip.file(mainPath);
  if (!main) fail('UNSUPPORTED_FORMAT', `This package is not a supported ${format.toUpperCase()} file.`);
  const mainXml = parseXml(new TextDecoder().decode(await readZipEntry(main, decodedBudget, signal, true, false)));
  const expectedRoot = format === 'docx' ? 'document' : 'presentation';
  if (mainXml.documentElement.localName !== expectedRoot) fail('UNSUPPORTED_FORMAT', 'Office package type does not match the requested format.');

  let slideCount = 0;
  if (format === 'pptx') {
    slideCount = mainXml.getElementsByTagNameNS('*', 'sldId').length;
    if (slideCount < 1) fail('CONVERSION_FAILED', 'Presentation contains no slides.');
  }
  validateZipOutputBudget(zip, changedEntryBytes);
  return { safeBytes: await bounded(zip.generateAsync({ type: 'arraybuffer' }), signal), slideCount };
}

function lowerCap(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) fail('LIMIT_EXCEEDED', 'Office conversion limit is invalid.');
  return Math.min(value, maximum);
}

function nextFrame(signal?: AbortSignal): Promise<void> {
  return bounded(new Promise((resolve) => requestAnimationFrame(() => resolve())), signal);
}

async function waitForImages(root: ParentNode, signal?: AbortSignal): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (image) => {
    const src = generatedImageSource(image);
    const description = imageSourceDescription(image);
    if (!isSafeGeneratedImageSource(src)) {
      fail('CONVERSION_FAILED', `Office image has no safe local source (${description}).`);
    }
    try {
      await bounded(image.decode(), signal);
    } catch (cause) {
      if (typeof (cause as OfficeConversionError)?.code === 'string') throw cause;
      throw Object.assign(officeConversionError('CONVERSION_FAILED', `Office image decode failed (${description}).`), { stage: 'image-decode', cause });
    }
  }));
}

async function waitForReady(root: HTMLElement, signal?: AbortSignal, charts = false): Promise<void> {
  await bounded((document.fonts?.ready ?? Promise.resolve()).then(() => undefined), signal);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    throwIfAborted(signal);
    await withStage('source-image-decode', waitForImages(root, signal));
    if (charts) {
      const chartNodes = Array.from(root.querySelectorAll<HTMLElement>('.chart-node'));
      if (chartNodes.some((node) => !node.querySelector('svg, canvas'))) {
        await nextFrame(signal);
        continue;
      }
    }
    const before = root.getBoundingClientRect();
    await nextFrame(signal);
    const after = root.getBoundingClientRect();
    if (Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5) return;
  }
  fail('CONVERSION_FAILED', 'Office page layout did not become ready.');
}

function sanitizeResourceUrls(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of ['src', 'href', 'xlink:href', 'poster']) {
      const value = element.getAttribute(attribute)?.trim();
      if (!value || value.startsWith('#')) continue;
      if (element instanceof HTMLImageElement && attribute === 'src' && isSafeGeneratedImageSource(value)) continue;
      element.removeAttribute(attribute);
    }
    const style = element.getAttribute('style');
    const urls = style?.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi);
    if (urls && Array.from(urls).some((match) => {
      const value = (match[2] ?? '').trim();
      return !value.startsWith('#') && !isSafeGeneratedImageSource(value);
    })) element.removeAttribute('style');
  }
}

function pageSize(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const width = rect.width || element.scrollWidth || element.offsetWidth;
  const height = rect.height || element.scrollHeight || element.offsetHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail('CONVERSION_FAILED', 'Office page has no measurable dimensions.');
  }
  return { width, height };
}

async function capturePng(element: HTMLElement, maxPixels: number, maxOutputBytes: { value: number }, signal?: AbortSignal): Promise<OfficePage> {
  throwIfAborted(signal);
  const { width, height } = pageSize(element);
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(maxPixels / (width * height))) * (1 - 1e-7);
  const { snapdom } = await import('@zumer/snapdom');
  const snapshot = await withStage('snapdom-snapshot', bounded(snapdom(element, {
    scale,
    dpr: 1,
    embedFonts: true,
    backgroundColor: '#ffffff',
    useProxy: undefined,
  }), signal));
  const canvas = await withStage('snapdom-rasterize', bounded(snapshot.toCanvas(), signal));
  if (canvas.width < 1 || canvas.height < 1 || canvas.width > MAX_LONG_EDGE || canvas.height > MAX_LONG_EDGE || canvas.width * canvas.height > maxPixels) {
    fail('LIMIT_EXCEEDED', 'Rendered Office page exceeds the image limits.');
  }
  const png = await bounded(new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png');
  }), signal);
  if (png.type !== 'image/png') fail('CONVERSION_FAILED', 'Office page could not be encoded as PNG.');
  if (png.size > maxOutputBytes.value) fail('LIMIT_EXCEEDED', 'Office PNG output exceeds the byte limit.');
  maxOutputBytes.value -= png.size;
  return { png, width: canvas.width, height: canvas.height };
}

function makeStage(className: string, width: number): HTMLDivElement {
  const host = document.createElement('div');
  host.className = className;
  if (className === 'ink-office-docx') host.dataset.inkOfficeInstance = String(++stageSequence);
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;min-height:1px;overflow:visible;z-index:0;pointer-events:none;background:#fff;`;
  document.body.append(host);
  return host;
}

function ensurePageCount(count: number, maxPages: number): void {
  if (!count) fail('CONVERSION_FAILED', 'Office document contains no renderable pages.');
  if (count > maxPages) fail('LIMIT_EXCEEDED', 'Office document exceeds the page limit.');
}

async function renderDocx(bytes: ArrayBuffer, host: HTMLElement, maxPages: number, maxPixels: number, maxOutputBytes: { value: number }, signal?: AbortSignal): Promise<OfficePage[]> {
  const content = document.createElement('div');
  content.className = 'ink-office-docx-content';
  const generatedStyles = document.createElement('div');
  host.append(content);
  let objectUrls: string[] = [];
  try {
    await bounded(renderAsync(bytes, content, generatedStyles, {
      className: 'docx-preview',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      experimental: false,
      trimXmlDeclaration: true,
      useBase64URL: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: true,
      debug: false,
    }), signal);
    objectUrls = Array.from(new Set((`${content.innerHTML}${generatedStyles.innerHTML}`.match(/blob:[^"'()\s]+/g) ?? []).filter(isSafeGeneratedImageSource)));
    await waitForGeneratedImageSources(content, signal);
    await waitForImages(content, signal);
    const imageSources = snapshotImageSources(content);
    sanitizeRenderedDom(content);
    restoreImageSources(content, imageSources);
    sanitizeResourceUrls(content);
    host.append(...sanitizeDocxGeneratedStyles(generatedStyles, { scope: `[data-ink-office-instance="${host.dataset.inkOfficeInstance}"]` }));

    const pages = Array.from(content.querySelectorAll<HTMLElement>(DOCX_PAGE_SELECTORS));
    ensurePageCount(pages.length, maxPages);
    const output: OfficePage[] = [];
    for (const page of pages) {
      throwIfAborted(signal);
      if (!page.textContent?.trim() && !page.querySelector('img, svg, canvas')) {
        fail('CONVERSION_FAILED', 'A document page rendered without content.');
      }
      page.style.backgroundColor = '#fff';
      page.style.contentVisibility = 'visible';
      await waitForReady(page, signal);
      output.push(await capturePng(page, maxPixels, maxOutputBytes, signal));
    }
    return output;
  } finally {
    objectUrls.forEach(URL.revokeObjectURL);
  }
}

async function renderPptx(bytes: ArrayBuffer, host: HTMLElement, slideCount: number, maxPages: number, maxPixels: number, maxOutputBytes: { value: number }, signal?: AbortSignal): Promise<OfficePage[]> {
  if (slideCount > maxPages) fail('LIMIT_EXCEEDED', 'Presentation exceeds the page limit.');
  const previewer = initPptxPreview(host, { width: 960, mode: 'slide' });
  try {
    await bounded(previewer.preview(bytes), signal);
    if (previewer.slideCount !== slideCount) fail('CONVERSION_FAILED', 'Rendered slide count does not match the presentation.');
    const output: OfficePage[] = [];
    for (let index = 0; index < slideCount; index += 1) {
      throwIfAborted(signal);
      previewer.renderSingleSlide(index);
      await bounded(new Promise<void>((resolve) => window.setTimeout(resolve, 0)), signal);
      await nextFrame(signal);
      const slide = host.querySelector<HTMLElement>(PPTX_SLIDE_SELECTOR);
      if (!slide || !slide.textContent?.trim() && !slide.querySelector('img, svg, canvas')) {
        fail('CONVERSION_FAILED', 'A presentation slide rendered without content.');
      }
      await waitForGeneratedImageSources(slide, signal);
      await waitForImages(slide, signal);
      const imageSources = snapshotImageSources(slide);
      const safeHost = document.createElement('div');
      safeHost.innerHTML = slide.outerHTML;
      sanitizeRenderedDom(safeHost);
      restoreImageSources(safeHost, imageSources);
      sanitizeResourceUrls(safeHost);
      const safeSlide = safeHost.firstElementChild as HTMLElement | null;
      if (!safeSlide) fail('CONVERSION_FAILED', 'Presentation slide could not be sanitized.');
      await waitForReady(safeSlide, signal, true);
      const captureStage = document.createElement('div');
      captureStage.className = 'ink-office-slide-capture';
      captureStage.style.cssText = 'position:fixed;left:-100000px;top:0;z-index:0;pointer-events:none;';
      captureStage.append(safeSlide);
      host.append(captureStage);
      try {
        output.push(await capturePng(safeSlide, maxPixels, maxOutputBytes, signal));
      } finally {
        captureStage.remove();
      }
    }
    return output;
  } finally {
    try { previewer.destroy(); } catch { /* Best-effort release of renderer resources. */ }
  }
}

export async function convertOfficePages(
  bytes: ArrayBuffer,
  format: 'docx' | 'pptx',
  options: OfficeConversionOptions = {},
): Promise<OfficeConversionResult> {
  if (format !== 'docx' && format !== 'pptx') fail('UNSUPPORTED_FORMAT', 'Unsupported Office format.');
  const maxPages = lowerCap(options.max_pages, DEFAULT_MAX_PAGES);
  const maxPixels = lowerCap(options.max_pixels_per_page, DEFAULT_MAX_PIXELS_PER_PAGE);
  const signal = options.signal;
  const maxOutputBytes = { value: MAX_OUTPUT_PNG_BYTES };
  let host: HTMLDivElement | undefined;
  let stage = 'package-validation';
  try {
    throwIfAborted(signal);
    const packageInfo = await loadSafePackage(bytes, format, signal);
    stage = format === 'docx' ? 'render-docx' : 'render-pptx';
    host = makeStage(format === 'docx' ? 'ink-office-docx' : 'ink-office-pptx', 2048);
    const pages = format === 'docx'
      ? await renderDocx(packageInfo.safeBytes, host, maxPages, maxPixels, maxOutputBytes, signal)
      : await renderPptx(packageInfo.safeBytes, host, packageInfo.slideCount, maxPages, maxPixels, maxOutputBytes, signal);
    stage = 'validate-output';
    ensurePageCount(pages.length, maxPages);
    return {
      pages,
      warnings: ['Browser rendering may differ from native Office; unavailable fonts may be substituted.'],
      converter_version: `${DOCX_VERSION}+${PPTX_VERSION}+${SNAPDOM_VERSION};pages-v1;white-paper;embed-fonts;max-edge-${MAX_LONG_EDGE}`,
    };
  } catch (error) {
    if ((error as OfficeConversionError)?.code) throw error;
    if (signal?.aborted || (error as Error)?.name === 'AbortError') fail('CANCELLED', 'Office conversion was cancelled.');
    throw Object.assign(officeConversionError('CONVERSION_FAILED', 'Office document could not be converted.'), { stage, cause: error });
  } finally {
    host?.remove();
  }
}
