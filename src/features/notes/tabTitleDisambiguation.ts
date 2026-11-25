/**
 * Generalized multi-tab title disambiguation for the Notes tab bar.
 *
 * When multiple open tabs share a common prefix long enough that compact tabs
 * would truncate identically to "<prefix>…", this computes per-cluster common
 * prefixes (snapped to clean word/separator boundaries) and produces compact
 * labels that preserve each tab's differentiating segment while keeping a short
 * leading context hint.
 */

export interface TabTitleInput {
  readonly key: string;
  readonly title: string;
}

export interface DisambiguatedTabLabel {
  /** Whether the tab title was shortened to expose its differentiating suffix. */
  readonly disambiguated: boolean;
  /** Short leading prefix hint ending with "…" when disambiguated (empty when not disambiguated). */
  readonly prefixHint: string;
  /** Differentiating portion (or full original title when not disambiguated). */
  readonly distinguishing: string;
  /** Combined display text (`prefixHint + distinguishing`). */
  readonly display: string;
  /** Original untruncated note title (for tooltip `title` and `aria-label`). */
  readonly fullTitle: string;
}

export interface DisambiguateTabTitlesOptions {
  /**
   * Approximate character width budget (ASCII = 1, CJK/wide = 2) before titles
   * sharing a prefix are considered likely to collide in compact tabs.
   * Defaults adaptively by open tab count (`>=4` -> 10, `3` -> 13, `2` -> 16).
   */
  readonly compactBudget?: number;
  /** Maximum visual units kept in the leading context hint before "…". Default: 4. */
  readonly prefixHintUnits?: number;
}

const SEPARATOR_CHARS = new Set([' ', '\t', '-', '_', '/', '\\', ':', '：', '—', '–', '·', '|', '.', '(', '（', '[', '【', '·', '・', '、', '，', ',']);

/** Splits text into user-perceived grapheme clusters so CJK/emoji are never torn apart. */
function toGraphemes(text: string): string[] {
  if (!text) return [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Rough monospaced/visual width estimate: CJK & fullwidth glyphs count as 2, ASCII as 1. */
export function visualWidth(text: string): number {
  let width = 0;
  for (const grapheme of toGraphemes(text)) {
    const code = grapheme.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || code >= 0x1f300;
    width += isWide ? 2 : 1;
  }
  return width;
}

function commonPrefixGraphemes(a: readonly string[], b: readonly string[]): string[] {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

function longestCommonPrefixOfGroup(groups: readonly (readonly string[])[]): string[] {
  if (groups.length === 0) return [];
  let prefix = [...groups[0]!];
  for (let i = 1; i < groups.length; i += 1) {
    prefix = commonPrefixGraphemes(prefix, groups[i]!);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/**
 * Snaps a raw common prefix back to a natural separator/boundary when one exists
 * near the end, so words or numbers (e.g. `01` vs `02`, `Chapter 10` vs `Chapter 11`)
 * are not sliced in half.
 */
function snapPrefixToBoundary(rawPrefix: readonly string[]): number {
  if (rawPrefix.length === 0) return 0;
  const last = rawPrefix[rawPrefix.length - 1]!;
  if (SEPARATOR_CHARS.has(last)) return rawPrefix.length;

  // Walk back at most 6 graphemes looking for a separator so we keep the whole differentiating token.
  const lookbackLimit = Math.max(0, rawPrefix.length - 6);
  for (let i = rawPrefix.length - 1; i >= lookbackLimit; i -= 1) {
    if (SEPARATOR_CHARS.has(rawPrefix[i]!)) {
      return i + 1;
    }
  }
  // If ending inside digits (e.g. "Note 10" vs "Note 11" -> raw prefix "Note 1"), back up before digits.
  if (/^\d+$/.test(last)) {
    let i = rawPrefix.length - 1;
    while (i > 0 && /^\d+$/.test(rawPrefix[i - 1]!)) i -= 1;
    if (i > 0) return i;
  }
  return rawPrefix.length;
}

function takeVisualPrefix(graphemes: readonly string[], maxUnits: number): string {
  let units = 0;
  const out: string[] = [];
  for (const g of graphemes) {
    const w = visualWidth(g);
    if (out.length > 0 && units + w > maxUnits) break;
    out.push(g);
    units += w;
    if (units >= maxUnits) break;
  }
  // Trim trailing separator noise before inserting "…"
  while (out.length > 1 && SEPARATOR_CHARS.has(out[out.length - 1]!)) {
    out.pop();
  }
  return out.join('');
}

function leadingUnitsKey(text: string, unitsBudget: number): string {
  const gs = toGraphemes(text);
  let units = 0;
  const out: string[] = [];
  for (const g of gs) {
    const w = visualWidth(g);
    if (units + w > unitsBudget) break;
    out.push(g);
    units += w;
  }
  return out.join('');
}

interface InternalEntry {
  readonly key: string;
  readonly title: string;
  readonly graphemes: readonly string[];
  readonly width: number;
}

/**
 * Computes disambiguated labels for a list of open tabs, keyed by `tab.key`.
 * Never hardcodes any specific prefix; works for arbitrary Latin, CJK, numeric,
 * mixed-cluster, and hierarchically prefixed note titles.
 */
export function disambiguateTabTitles(
  items: readonly TabTitleInput[],
  options: DisambiguateTabTitlesOptions = {},
): Map<string, DisambiguatedTabLabel> {
  const result = new Map<string, DisambiguatedTabLabel>();
  for (const item of items) {
    result.set(item.key, {
      disambiguated: false,
      prefixHint: '',
      distinguishing: item.title,
      display: item.title,
      fullTitle: item.title,
    });
  }
  if (items.length < 2) return result;

  const compactBudget = options.compactBudget ?? (items.length >= 4 ? 10 : items.length === 3 ? 13 : 16);
  const minClusterPrefixUnits = items.length >= 4 ? 4 : 6;
  const prefixHintUnits = options.prefixHintUnits ?? 4;

  const entries: InternalEntry[] = items.map((item) => ({
    key: item.key,
    title: item.title,
    graphemes: toGraphemes(item.title),
    width: visualWidth(item.title),
  }));

  // Sort lexicographically: any subset sharing a prefix is guaranteed to be contiguous.
  const sorted = [...entries].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  // Partition into contiguous clusters where adjacent titles share a significant prefix.
  const clusters: InternalEntry[][] = [];
  let currentCluster: InternalEntry[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const shared = commonPrefixGraphemes(prev.graphemes, curr.graphemes);
    const sharedWidth = visualWidth(shared.join(''));
    if (sharedWidth >= minClusterPrefixUnits) {
      currentCluster.push(curr);
    } else {
      clusters.push(currentCluster);
      currentCluster = [curr];
    }
  }
  clusters.push(currentCluster);

  // Track the deepest safe elided prefix length (in graphemes) per tab key.
  const elidePrefixLen = new Map<string, number>();

  const refineCluster = (cluster: readonly InternalEntry[], depth: number): void => {
    if (cluster.length < 2 || depth > 4) return;
    // Deduplicate by title for prefix calculation (identical titles don't differentiate each other).
    const uniqueTitles = new Map<string, InternalEntry>();
    for (const entry of cluster) {
      if (!uniqueTitles.has(entry.title)) uniqueTitles.set(entry.title, entry);
    }
    if (uniqueTitles.size < 2) return;

    const uniqueEntries = [...uniqueTitles.values()];
    const rawLcp = longestCommonPrefixOfGroup(uniqueEntries.map((e) => e.graphemes));
    const rawLcpWidth = visualWidth(rawLcp.join(''));
    if (rawLcpWidth < minClusterPrefixUnits) return;

    const snappedLen = snapPrefixToBoundary(rawLcp);
    const effectiveLen = snappedLen > 0 ? snappedLen : rawLcp.length;
    const prefixText = rawLcp.slice(0, effectiveLen).join('');
    const prefixWidth = visualWidth(prefixText);

    // Only elide when the shared prefix meaningfully eats into the compact tab width
    // (either full titles exceed the compact budget, or truncated prefixes collide).
    const truncatedBuckets = new Set(uniqueEntries.map((e) => leadingUnitsKey(e.title, compactBudget)));
    const hasCollisionAtBudget = truncatedBuckets.size < uniqueEntries.length;
    const anyExceedsBudget = uniqueEntries.some((e) => e.width > compactBudget);
    const prefixDominates = prefixWidth >= Math.max(minClusterPrefixUnits, Math.floor(compactBudget * 0.5));

    if (prefixWidth >= minClusterPrefixUnits && (hasCollisionAtBudget || (anyExceedsBudget && prefixDominates))) {
      for (const entry of cluster) {
        const remainder = entry.graphemes.slice(effectiveLen).join('').trim();
        // Only elide if a meaningful distinguishing suffix remains (preserves a tab whose title IS the prefix).
        if (remainder.length > 0) {
          const prevLen = elidePrefixLen.get(entry.key) ?? 0;
          if (effectiveLen > prevLen) {
            elidePrefixLen.set(entry.key, effectiveLen);
          }
        }
      }
    }

    // Check if sub-groups within this cluster STILL collide on their remaining tails (hierarchical prefixes).
    const byNextBucket = new Map<string, InternalEntry[]>();
    const suffixCollisionWindow = Math.max(4, compactBudget - prefixHintUnits - 1);
    for (const entry of cluster) {
      const start = elidePrefixLen.get(entry.key) ?? effectiveLen;
      const tail = entry.graphemes.slice(start).join('');
      const bucketKey = leadingUnitsKey(tail, suffixCollisionWindow);
      if (!bucketKey) continue;
      const list = byNextBucket.get(bucketKey);
      if (list) list.push(entry);
      else byNextBucket.set(bucketKey, [entry]);
    }
    for (const sub of byNextBucket.values()) {
      if (sub.length >= 2 && sub.length < cluster.length) {
        refineCluster(sub, depth + 1);
      }
    }
  };

  for (const cluster of clusters) {
    refineCluster(cluster, 0);
  }

  for (const entry of entries) {
    const cut = elidePrefixLen.get(entry.key);
    if (!cut || cut <= 0) continue;

    // Strip leading separator characters from the distinguishing suffix (e.g. "-Alpha" -> "Alpha").
    let suffixStart = cut;
    while (suffixStart < entry.graphemes.length && SEPARATOR_CHARS.has(entry.graphemes[suffixStart]!)) {
      suffixStart += 1;
    }
    const distinguishing = entry.graphemes.slice(suffixStart).join('').trim();
    if (!distinguishing) continue;

    const lead = takeVisualPrefix(entry.graphemes.slice(0, cut), prefixHintUnits);
    const prefixHint = lead ? `${lead}…` : '…';
    const display = `${prefixHint}${distinguishing}`;
    // Only use disambiguated form if it actually saves space over the original title.
    if (visualWidth(display) >= entry.width) continue;

    result.set(entry.key, {
      disambiguated: true,
      prefixHint,
      distinguishing,
      display,
      fullTitle: entry.title,
    });
  }

  return result;
}
