/**
 * 目标笔记内容的轻量异步读取（懒加载 DSTU 适配器，模式同 defaultGetNotes）。
 * 供 `[[Note#` 标题补全与 hover 预览卡片共用；带短 TTL 缓存，失败返回空值不抛错。
 * 缓存随 dstu.watch 事件按 noteId 失效，编辑后 hover / heading 补全不再拿到过期内容。
 */

const CONTENT_TTL_MS = 15000;
const contentCache = new Map<string, { at: number; content: string }>();
let watcherStarted = false;

/** 主动失效缓存；缺省清空全部（供测试与批量事件兜底）。 */
export function invalidateNoteContentCache(noteId?: string): void {
  if (noteId) contentCache.delete(noteId);
  else contentCache.clear();
}

/** 从 DSTU 事件路径提取资源 ID（末段，如 '/folder/note_1' → 'note_1'）。 */
function noteIdFromEventPath(path: string | undefined): string | null {
  if (!path) return null;
  const segment = path.split('/').filter(Boolean).pop();
  return segment || null;
}

/**
 * 惰性启动全局 watch（幂等，跟随应用生命周期不解绑，模式同 wikilinkNotesCache）。
 * 能定位 noteId 的事件精确失效；文件夹 / 批量事件清空整表兜底。
 */
function ensureContentWatcher(): void {
  if (watcherStarted || typeof window === 'undefined') return;
  watcherStarted = true;
  void (async () => {
    try {
      const { dstu } = await import('@/dstu');
      dstu.watch('*', (event) => {
        const ids = [
          event.node?.id,
          noteIdFromEventPath(event.path),
          noteIdFromEventPath(event.oldPath),
        ].filter((id): id is string => Boolean(id));
        if (ids.length === 0) {
          invalidateNoteContentCache();
          return;
        }
        for (const id of ids) invalidateNoteContentCache(id);
      });
    } catch (error: unknown) {
      console.warn('[wikilink noteContent] dstu watch unavailable:', error);
    }
  })();
}

export async function loadNoteContent(noteId: string): Promise<string | null> {
  if (!noteId) return null;
  ensureContentWatcher();
  const cached = contentCache.get(noteId);
  if (cached && Date.now() - cached.at < CONTENT_TTL_MS) {
    return cached.content;
  }
  try {
    const { notesDstuAdapter } = await import('@/dstu/adapters/notesDstuAdapter');
    const result = await notesDstuAdapter.getNoteContent(noteId);
    if (!result.ok) return null;
    const content = result.value;
    contentCache.set(noteId, { at: Date.now(), content });
    return content;
  } catch {
    return null;
  }
}

/** 提取 markdown 标题（# ~ ######），跳过 fenced code；按文档顺序去重。 */
export function extractMarkdownHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const seen = new Set<string>();
  let fenceMarker: string | null = null;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        fenceMarker = null;
      }
      continue;
    }
    if (fenceMarker) continue;

    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    headings.push(text);
  }
  return headings;
}

export async function loadNoteHeadings(noteId: string): Promise<string[]> {
  const content = await loadNoteContent(noteId);
  if (content == null) return [];
  return extractMarkdownHeadings(content);
}

/**
 * 轻量 markdown 剥离（预览摘要用，非完整渲染）：
 * 去掉标题 #、粗斜体/删除线/行内 code 记号、图片/链接语法、
 * [[target|label]] 取显示文本、引用 >；列表符号保留可读性。
 */
export function stripMarkdownLight(line: string): string {
  return line
    .replace(/^ {0,3}#{1,6}\s+/, '')
    .replace(/^ {0,3}>\s?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]\r\n]+?)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf('|');
      return (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
    })
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/** 预览卡片摘要：跳过 frontmatter，取前若干行并做轻量 markdown 剥离。 */
export function buildPreviewSnippet(markdown: string, maxLines = 8, maxChars = 480): string {
  let text = markdown;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (frontmatter) text = text.slice(frontmatter[0].length);

  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (lines.length >= maxLines) break;
    const line = stripMarkdownLight(rawLine.replace(/\r$/, '')).trimEnd();
    if (!line.trim() && lines.length === 0) continue;
    lines.push(line);
  }
  let snippet = lines.join('\n').trimEnd();
  if (snippet.length > maxChars) {
    snippet = `${snippet.slice(0, maxChars).trimEnd()}…`;
  }
  return snippet;
}
