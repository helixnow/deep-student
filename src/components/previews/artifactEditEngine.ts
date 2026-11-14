/**
 * 图表 / SVG / HTML 局部 Search-Replace 补丁微调与块级撤销引擎
 *
 * 包含：
 * 1. parseArtifactReply：解析模型返回的 JSON 补丁响应（支持剥离外层代码块围栏）
 * 2. applyArtifactReply：基于同一份原始 source 并发定位 1~30 项 search/replace，拒绝不唯一或范围重叠
 * 3. artifactFences / replaceArtifactFence：精确匹配目标围栏并拦截闭合围栏逃逸注入
 * 4. ArtifactUndoStack：最多保留最近 10 步的块级独立撤销栈
 */

export type ArtifactKind = 'diagram' | 'svg' | 'mermaid' | 'html';
export type ArtifactLocation = 'fence' | 'html' | 'widget';

export const MAX_ARTIFACT_LENGTH = 120_000;
export const MAX_ARTIFACT_UNDO_STEPS = 10;

export interface ArtifactPatchEdit {
  search: string;
  replace: string;
}

export interface FenceRange {
  start: number;
  end: number;
  kind: string;
  source: string;
  marker: string;
}

export interface ArtifactRevision {
  blockKey?: string;
  kind?: ArtifactKind;
  location?: ArtifactLocation;
  before: string;
  after: string;
  widgetRef?: string;
  widgetIndex?: number;
}

export interface ArtifactUndoQuery {
  blockKey?: string;
  kind?: ArtifactKind;
  location?: ArtifactLocation;
  currentSource?: string;
  after?: string;
  widgetRef?: string;
  widgetIndex?: number;
}

/**
 * 仅对标记或未标记代码推断 SVG 内容，绝不误判普通 JS/JSX 字符串或非 SVG XML。
 */
export function isSvgCode(lang: unknown, source: unknown): boolean {
  if (!/^(?:xml|html?|image\/svg\+xml|application\/svg\+xml)?$/i.test(String(lang ?? '').trim())) return false;
  if (typeof source !== 'string') return false;
  const text = source
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/^\s*(?:<\?xml\b[^?]*\?>\s*|<!--[\s\S]*?-->\s*)*/i, '')
    .trimStart();
  return /^<svg(?:\s|\/?>|$)/i.test(text);
}

/**
 * 解析模型返回的补丁或重写 JSON 响应。
 */
export function parseArtifactReply(reply: string): unknown {
  const clean = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  if (!clean.trim()) {
    throw new Error('模型未返回修改内容，原内容未修改；请重试或切换模型');
  }
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('模型返回的修改 JSON 不完整或格式不正确，原内容未修改；请重试、缩小修改范围，或使用“仅重生成此块”');
  }
}

/**
 * 将模型的修改响应（patch 或 rewrite）应用到原始源码上。
 * 所有 1~30 项 search/replace 均基于同一份原始 source 定位，存在歧义、不唯一、范围重叠或无变化时立即拒绝。
 */
export function applyArtifactReply(source: string, reply: unknown, mode: 'patch' | 'rewrite'): string {
  if (!reply || typeof reply !== 'object') {
    throw new Error('模型未返回有效的修改对象');
  }
  const result = reply as { edits?: unknown; source?: unknown };
  let next = source;
  if (mode === 'rewrite') {
    if (typeof result.source !== 'string') {
      throw new Error('模型未返回此块的完整源码');
    }
    next = result.source;
  } else {
    if (!Array.isArray(result.edits) || !result.edits.length || result.edits.length > 30) {
      throw new Error('补丁必须包含 1–30 项修改，可尝试仅重生成此块');
    }
    const edits = result.edits
      .map((edit: unknown) => {
        if (!edit || typeof edit !== 'object') throw new Error('补丁格式不正确');
        const { search, replace } = edit as { search?: unknown; replace?: unknown };
        if (typeof search !== 'string' || !search || typeof replace !== 'string') {
          throw new Error('补丁缺少 search / replace');
        }
        const start = source.indexOf(search);
        if (start < 0 || source.indexOf(search, start + 1) >= 0) {
          throw new Error('补丁位置不存在或不唯一，原内容未修改；可尝试仅重生成此块');
        }
        return { start, end: start + search.length, replace };
      })
      .sort((a, b) => b.start - a.start);

    let boundary = source.length;
    for (const edit of edits) {
      if (edit.end > boundary) {
        throw new Error('补丁范围重叠，原内容未修改');
      }
      next = next.slice(0, edit.start) + edit.replace + next.slice(edit.end);
      boundary = edit.start;
    }
  }

  if (!next.trim() || next.length > MAX_ARTIFACT_LENGTH) {
    throw new Error('修改结果为空或超过内容块大小限制');
  }
  if (next === source) {
    throw new Error('模型没有修改此块');
  }
  return next;
}

/**
 * 扫描 Markdown 中的全部代码块围栏（支持反引号与波浪线长围栏，忽略代码块内部的伪围栏）。
 */
export function artifactFences(content: string): FenceRange[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const ranges: FenceRange[] = [];
  let offset = 0;
  let open: { start: number; kind: string; marker: string } | undefined;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, '');
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)[^\r\n]*$/.exec(text);
      if (match) open = { start: offset + line.length, marker: match[1], kind: match[2].toLowerCase() };
    } else if (new RegExp(`^ {0,3}${open.marker[0]}{${open.marker.length},}[ \\t]*$`).test(text)) {
      ranges.push({ ...open, end: offset, source: content.slice(open.start, offset).replace(/\s+$/, '') });
      open = undefined;
    }
    offset += line.length;
  }
  return ranges;
}

/**
 * 在消息全文中精确替换唯一匹配的目标围栏内容，并拦截包含闭合围栏标记的逃逸注入。
 */
export function replaceArtifactFence(content: string, kind: ArtifactKind, source: string, next: string): string {
  const trimmedSource = source.replace(/\s+$/, '');
  const matches = artifactFences(content).filter(
    (f) =>
      (f.kind === kind || (kind === 'html' && f.kind === 'htm') || (kind === 'svg' && isSvgCode(f.kind, f.source))) &&
      f.source === trimmedSource,
  );
  if (matches.length !== 1) {
    throw new Error('无法唯一定位此块，原回答未修改（可能包含相同的图或内容已变化）');
  }
  const range = matches[0];
  const closing = new RegExp(`^ {0,3}${range.marker[0]}{${range.marker.length},}([^\\r\\n]*)$`, 'gm');
  const fences = [...next.matchAll(closing)];
  // An inner example must end in a bare fence, not close the outer block and reopen it with a language tag.
  if (fences.length % 2 !== 0 || fences.some((fence, index) => index % 2 === 1 && fence[1].trim() !== '')) {
    throw new Error('修改内容包含围栏结束标记，已拒绝覆盖');
  }
  return content.slice(0, range.start) + next.replace(/\s+$/, '') + '\n' + content.slice(range.end);
}

/**
 * 块级独立撤销栈（最多保留最近 10 步修改，支持按块标识或当前源码分别撤销对应图形的最近修改）。
 */
export class ArtifactUndoStack {
  private history: ArtifactRevision[] = [];
  readonly maxSteps: number;

  constructor(maxSteps: number = MAX_ARTIFACT_UNDO_STEPS) {
    this.maxSteps = Math.max(1, maxSteps);
  }

  get size(): number {
    return this.history.length;
  }

  getHistory(): readonly ArtifactRevision[] {
    return [...this.history];
  }

  push(revision: ArtifactRevision): void;
  push(blockKey: string, before: string, after: string, kind?: ArtifactKind): void;
  push(
    revisionOrKey: ArtifactRevision | string,
    before?: string,
    after?: string,
    kind?: ArtifactKind,
  ): void {
    const entry: ArtifactRevision =
      typeof revisionOrKey === 'string'
        ? {
            blockKey: revisionOrKey,
            before: before ?? '',
            after: after ?? '',
            ...(kind ? { kind } : {}),
          }
        : { ...revisionOrKey };

    this.history = [...this.history.slice(-(this.maxSteps - 1)), entry];
  }

  record(revision: ArtifactRevision): void {
    this.push(revision);
  }

  private matchesQuery(item: ArtifactRevision, query?: string | ArtifactUndoQuery): boolean {
    if (query === undefined) return true;
    if (typeof query === 'string') {
      return item.blockKey === query || item.after.trimEnd() === query.trimEnd();
    }
    if (query.blockKey !== undefined && item.blockKey !== query.blockKey) return false;
    if (query.kind !== undefined && item.kind !== query.kind) return false;
    if (query.location !== undefined && item.location !== query.location) return false;
    if (query.widgetRef !== undefined && item.widgetRef !== query.widgetRef) return false;
    if (query.widgetIndex !== undefined && item.widgetIndex !== query.widgetIndex) return false;
    const expectedAfter = query.currentSource ?? query.after;
    if (expectedAfter !== undefined && item.after.trimEnd() !== expectedAfter.trimEnd()) return false;
    return true;
  }

  findLatest(query?: string | ArtifactUndoQuery): ArtifactRevision | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.matchesQuery(this.history[i], query)) {
        return this.history[i];
      }
    }
    return undefined;
  }

  canUndo(query?: string | ArtifactUndoQuery): boolean {
    return this.findLatest(query) !== undefined;
  }

  /**
   * 弹出并返回匹配块最近一次修改记录，不影响其他块的撤销记录。
   */
  undo(query?: string | ArtifactUndoQuery): ArtifactRevision | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.matchesQuery(this.history[i], query)) {
        const [removed] = this.history.splice(i, 1);
        return removed;
      }
    }
    return null;
  }

  /**
   * 在 Markdown 全文中直接撤销指定围栏块的最近一次修改，保持其余正文与图形不变。
   */
  undoFenceInContent(
    content: string,
    query: { kind: ArtifactKind; currentSource: string; blockKey?: string },
  ): { content: string; revision: ArtifactRevision } {
    const rev = this.findLatest({
      kind: query.kind,
      currentSource: query.currentSource,
      ...(query.blockKey !== undefined ? { blockKey: query.blockKey } : {}),
    });
    if (!rev) {
      throw new Error('没有可撤销的修改记录');
    }
    const nextContent = replaceArtifactFence(content, query.kind, query.currentSource, rev.before);
    this.history = this.history.filter((item) => item !== rev);
    return { content: nextContent, revision: rev };
  }

  clear(): void {
    this.history = [];
  }
}
