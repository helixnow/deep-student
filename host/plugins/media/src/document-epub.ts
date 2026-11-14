/** `dstu-docs/src/document_parser.rs` EPUB extraction: container.xml → OPF metadata/spine → chapter text. */
import { rustTrim } from './transcript.ts';
import { readZipEntries } from './zip.ts';
import { ParsingError } from './document-errors.ts';
import { MAX_SINGLE_ENTRY_SIZE, checkFileSize, checkZipBomb } from './document-guards.ts';
import { htmlToText, xmlTokens } from './document-xml.ts';

/** `extract_epub_pages_from_bytes`：第一页为元信息（标题/作者），其后每个 spine 条目一页。 */
export function extractEpubPagesFromBytes(bytes: Uint8Array, warn: (message: string) => void): string[] {
  checkFileSize(bytes.length);
  checkZipBomb(bytes, 'book.epub', warn);
  const entries = readZipEntries(bytes);
  if (entries === null) {
    throw new ParsingError('EpubParsingError', '无法打开EPUB ZIP: invalid Zip archive');
  }
  const files = new Map(entries.map(entry => [entry.name, entry.bytes]));
  const readEntry = (name: string): string => {
    const content = files.get(name);
    if (content === undefined) {
      throw new ParsingError('EpubParsingError', `EPUB 中未找到 ${name}: file not found`);
    }
    if (content.length > MAX_SINGLE_ENTRY_SIZE) {
      throw new ParsingError('ZipBombDetected',
        `ZIP 条目 '${name}' 实际解压大小超过 `
        + `${(MAX_SINGLE_ENTRY_SIZE / (1024 * 1024)).toFixed(0)}MB 上限（声明大小可能被伪造）`);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch {
      throw new ParsingError('EpubParsingError', `读取 EPUB 条目 ${name} 失败: 非 UTF-8 内容`);
    }
  };

  const opfPath = epubFindRootFile(readEntry('META-INF/container.xml'));
  const slash = opfPath.lastIndexOf('/');
  const opfDir = slash >= 0 ? opfPath.slice(0, slash + 1) : '';
  const { metadata, spineHrefs } = epubParseOpf(readEntry(opfPath));

  const pages: string[] = [];
  let header = '';
  const title = metadata.get('title');
  if (title !== undefined && title !== '') header += `# ${title}\n\n`;
  const creator = metadata.get('creator');
  if (creator !== undefined && creator !== '') header += `作者: ${creator}\n\n`;
  if (rustTrim(header) !== '') pages.push(rustTrim(header));

  for (const href of spineHrefs) {
    let decoded = href;
    // Rust `unwrap_or` 在解码失败时保留原始 href。
    try { decoded = decodeURIComponent(href); }
    catch { decoded = href; }
    const fullPath = decoded.startsWith('/') ? decoded.slice(1) : `${opfDir}${decoded}`;
    let xhtml: string;
    try { xhtml = readEntry(fullPath); }
    catch { continue; }
    const plainText = htmlToText(xhtml);
    if (rustTrim(plainText) !== '') pages.push(rustTrim(plainText));
  }
  return pages;
}

function epubFindRootFile(containerXml: string): string {
  for (const token of xmlTokens(containerXml)) {
    if (token.kind === 'start' && token.local === 'rootfile') {
      const path = token.attrs['full-path'];
      if (path !== undefined) return path;
    }
  }
  throw new ParsingError('EpubParsingError', 'container.xml 中未找到 rootfile');
}

function epubParseOpf(opfContent: string): {
  metadata: Map<string, string>;
  spineHrefs: string[];
} {
  const metadata = new Map<string, string>();
  const manifest = new Map<string, string>();
  const spineIdrefs: string[] = [];
  let section: 'none' | 'metadata' | 'manifest' | 'spine' = 'none';
  let currentMetaTag: string | null = null;

  for (const token of xmlTokens(opfContent)) {
    if (token.kind === 'start') {
      switch (token.local) {
        case 'metadata': section = 'metadata'; break;
        case 'manifest': section = 'manifest'; break;
        case 'spine': section = 'spine'; break;
        case 'title':
        case 'creator':
        case 'language':
        case 'description':
        case 'publisher':
          if (section === 'metadata') currentMetaTag = token.local;
          break;
        case 'item':
          if (section === 'manifest') {
            const id = token.attrs.id ?? '';
            const href = token.attrs.href ?? '';
            if (id !== '' && href !== '') manifest.set(id, href);
          }
          break;
        case 'itemref':
          if (section === 'spine' && token.attrs.idref !== undefined) {
            spineIdrefs.push(token.attrs.idref);
          }
          break;
        default:
          break;
      }
    } else if (token.kind === 'text') {
      if (currentMetaTag !== null) {
        const text = rustTrim(token.text);
        if (text !== '') metadata.set(currentMetaTag, text);
      }
    } else {
      if (token.local === 'metadata' || token.local === 'manifest' || token.local === 'spine') {
        section = 'none';
      }
      currentMetaTag = null;
    }
  }

  const spineHrefs = spineIdrefs
    .map(idref => manifest.get(idref))
    .filter((href): href is string => href !== undefined);
  return { metadata, spineHrefs };
}
