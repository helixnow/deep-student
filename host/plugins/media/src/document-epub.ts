/** `dstu-docs/src/document_parser.rs` EPUB extraction: container.xml → OPF metadata/spine → chapter text. */
import { rustTrim } from './transcript.ts';
import { readZipEntries } from './zip.ts';
import { ParsingError } from './document-errors.ts';
import { MAX_SINGLE_ENTRY_SIZE, checkFileSize, checkZipBomb } from './document-guards.ts';
import { htmlToText } from './document-xml.ts';
import { epubFindRootFile, epubParseOpf } from './epub-structure.ts';

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
