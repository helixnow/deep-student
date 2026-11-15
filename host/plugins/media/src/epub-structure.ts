import { rustTrim } from './transcript.ts';
import { ParsingError } from './document-errors.ts';
import { xmlTokens } from './document-xml.ts';

export function epubFindRootFile(containerXml: string): string {
  for (const token of xmlTokens(containerXml)) {
    if (token.kind === 'start' && token.local === 'rootfile') {
      const path = token.attrs['full-path'];
      if (path !== undefined) return path;
    }
  }
  throw new ParsingError('EpubParsingError', 'container.xml 中未找到 rootfile');
}

export function epubParseOpf(opfContent: string): {
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
