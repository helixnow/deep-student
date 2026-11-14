/** Stable local-material references; never persist temporary image URLs or image bytes. */
export interface PermilleCropRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SourceImageRef = { resourceId: string; versionDigest?: string } & (
  { imageId: string } | PermilleCropRegion
);

function safeIdentifier(value: string): boolean {
  return value.trim().length > 0 && !/[\\/\u0000-\u001f\u007f]/.test(value)
    && !value.includes('..') && !/^(?:javascript|data|blob|file):/i.test(value.trim());
}

function validRegion(region: PermilleCropRegion): boolean {
  const { page, x, y, width, height } = region;
  return Number.isSafeInteger(page) && page >= 1
    && [x, y, width, height].every(n => Number.isInteger(n) && n >= 0 && n <= 1000)
    && width > 0 && height > 0 && x + width <= 1000 && y + height <= 1000;
}

/** Invalid or foreign URIs are not material references. */
export function parseSourceImageUri(uri: string): SourceImageRef | null {
  const match = /^#source-image\/([^/?#]+)\/([^/?#]+)(?:\?v=([^&#?]+))?$/.exec(uri);
  if (match === null) return null;
  let resourceId: string;
  let imageId: string;
  let versionDigest: string | undefined;
  try {
    resourceId = decodeURIComponent(match[1]!);
    imageId = decodeURIComponent(match[2]!);
    versionDigest = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  if (!safeIdentifier(resourceId) || !safeIdentifier(imageId)
    || (versionDigest !== undefined && !safeIdentifier(versionDigest))) return null;
  const version = versionDigest === undefined ? {} : { versionDigest };
  if (/^page-.*-region-/.test(imageId)) {
    const crop = /^page-([1-9]\d*)-region-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(imageId);
    if (crop === null) return null;
    const region = {
      page: Number(crop[1]), x: Number(crop[2]), y: Number(crop[3]),
      width: Number(crop[4]), height: Number(crop[5]),
    };
    return validRegion(region) ? { resourceId, ...region, ...version } : null;
  }
  return { resourceId, imageId, ...version };
}

export function formatSourceImageUri(ref: SourceImageRef): string {
  if (!safeIdentifier(ref.resourceId) || (ref.versionDigest !== undefined && !safeIdentifier(ref.versionDigest))) {
    throw new TypeError('Invalid source image identifier');
  }
  let imageId: string;
  if ('imageId' in ref) {
    imageId = ref.imageId;
    if (!safeIdentifier(imageId) || /^page-.*-region-/.test(imageId)) {
      throw new TypeError('Invalid source image identifier; use region coordinates for PDF crops');
    }
  } else {
    if (!validRegion(ref)) throw new RangeError('Invalid permille crop region');
    imageId = `page-${ref.page}-region-${ref.x}-${ref.y}-${ref.width}-${ref.height}`;
  }
  // Parentheses also need escaping when embedded in a Markdown destination.
  const encode = (value: string): string => encodeURIComponent(value).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `#source-image/${encode(ref.resourceId)}/${encode(imageId)}`
    + (ref.versionDigest === undefined ? '' : `?v=${encode(ref.versionDigest)}`);
}

export function formatSourceImageMarkdown(alt: string, ref: SourceImageRef, asPreviewLink = false): string {
  const label = alt.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return `${asPreviewLink ? '' : '!'}[${label}](${formatSourceImageUri(ref)})`;
}

/** Text boxes are in rotated-page coordinates with the origin at the top left, not PDF bottom-left. */
export interface PageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** One-based page; omitted for a single-page input (page 1). */
  page?: number;
}

/** Conservative single/two-column segmentation; uncertain layouts retain the whole page. */
export function computePermilleCropRegionsForQuestions(
  pageTextItems: readonly PageTextItem[], pageWidth: number, pageHeight: number,
): PermilleCropRegion[] {
  if (![pageWidth, pageHeight].every(n => Number.isFinite(n) && n > 0)) {
    throw new RangeError('Page dimensions must be positive');
  }
  const pages = [...new Set(pageTextItems.map(item => item.page ?? 1))];
  if (pages.length === 0) pages.push(1);
  return pages.flatMap(page => {
    if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('Page must be one-based');
    const fallback = (): PermilleCropRegion[] => [{ page, x: 0, y: 0, width: 1000, height: 1000 }];
    const rows: PageTextItem[] = [];
    for (const box of pageTextItems.filter(item => (item.page ?? 1) === page)
      .sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (!box.text.trim() || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
        || box.x < 0 || box.y < 0 || box.x >= pageWidth || box.y >= pageHeight
        || box.width < 0 || box.height <= 0) continue;
      const row = rows.find(r => Math.abs(r.y - box.y) < Math.max(2, box.height * .3)
        && box.x >= r.x && box.x - (r.x + r.width) < pageWidth * .045);
      if (row) {
        row.text += box.text;
        row.width = Math.max(row.width, box.x + box.width - row.x);
        row.height = Math.max(row.height, box.height);
      } else rows.push({ ...box });
    }
    const starts = rows.filter(row => /^\s*(?:\d{1,3}\s*[.．、](?!\d)|[（(]\s*\d{1,3}\s*[）)]|第\s*\d{1,3}\s*题)\s*\S/.test(row.text)
      && row.y > pageHeight * .025 && row.y < pageHeight * .94);
    if (starts.length === 0 || starts.length > 60) return fallback();
    const columns: PageTextItem[][] = [];
    for (const row of [...starts].sort((a, b) => a.x - b.x)) {
      const column = columns.find(c => Math.abs(c[0]!.x - row.x) < pageWidth * .08);
      if (column) column.push(row); else columns.push([row]);
    }
    if (columns.length > 2 || (columns.length === 2
      && columns[1]![0]!.x - columns[0]![0]!.x < pageWidth * .3)) return fallback();
    const regions: PermilleCropRegion[] = [];
    for (let ci = 0; ci < columns.length; ci += 1) {
      const column = columns[ci]!.sort((a, b) => a.y - b.y);
      const left = Math.max(0, column[0]!.x - pageWidth * .025);
      const right = ci + 1 < columns.length ? columns[ci + 1]![0]!.x - pageWidth * .025 : pageWidth * .985;
      if (columns.length === 2 && rows.some(row => row.x < right
        && row.x + row.width > right + pageWidth * .04 && row.y >= column[0]!.y)) return fallback();
      for (let i = 0; i < column.length; i += 1) {
        const current = column[i]!;
        const next = column[i + 1];
        const top = Math.max(0, current.y - Math.max(3, current.height * .3));
        const bottom = next ? next.y - Math.max(3, next.height * .3) : pageHeight * .985;
        if (bottom - top < current.height * 1.4) return fallback();
        const x = Math.floor(left / pageWidth * 1000);
        const y = Math.floor(top / pageHeight * 1000);
        const x2 = Math.min(1000, Math.floor(right / pageWidth * 1000));
        const y2 = Math.min(1000, Math.ceil(bottom / pageHeight * 1000));
        const region = { page, x, y, width: x2 - x, height: y2 - y };
        if (!validRegion(region)) return fallback();
        regions.push(region);
      }
    }
    return regions;
  });
}
