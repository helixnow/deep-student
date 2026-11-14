/**
 * Canvas note tool schemas and pure content helpers, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs`.
 *
 * Tool execution itself is bound to the notes service; this module owns the
 * deterministic text operations and the exact OpenAI function schemas.
 */

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function schema(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { type: 'function', function: { name, description, parameters } };
}

const NOTE_ID_PROPERTY = {
  type: 'string',
  description: '笔记 ID。如果用户已在编辑器中打开笔记，可不指定。',
};

export class NoteReadTool {
  static name(): string { return 'note_read'; }
  static description(): string {
    return '读取笔记内容和 updatedAt OCC 基线。写入前必须完整读取并原样传递该版本。';
  }
  schema(): ToolSchema {
    return schema(NoteReadTool.name(), NoteReadTool.description(), {
      type: 'object',
      properties: {
        noteId: NOTE_ID_PROPERTY,
        section: {
          type: 'string',
          description: "要读取的章节标题（如 '## 代码实现'）。不指定则读取完整内容。",
        },
      },
      required: [],
    });
  }
}

export class NoteAppendTool {
  static name(): string { return 'note_append'; }
  static description(): string {
    return '追加内容到笔记末尾。必须先 note_read，并传入 expected_updated_at。';
  }
  schema(): ToolSchema {
    return schema(NoteAppendTool.name(), NoteAppendTool.description(), {
      type: 'object',
      properties: {
        noteId: NOTE_ID_PROPERTY,
        content: { type: 'string', description: '要追加的内容（支持 Markdown 格式）' },
        section: {
          type: 'string',
          description: "要追加到的章节标题（如 '## 代码实现'）。不指定则追加到末尾。",
        },
        expected_updated_at: {
          type: 'string',
          minLength: 1,
          description: 'note_read 返回的 updatedAt OCC 基线',
        },
      },
      required: ['content', 'expected_updated_at'],
      additionalProperties: false,
    });
  }
}

export class NoteReplaceTool {
  static name(): string { return 'note_replace'; }
  static description(): string {
    return '替换笔记中的内容。必须先 note_read，并传入 expected_updated_at。';
  }
  schema(): ToolSchema {
    return schema(NoteReplaceTool.name(), NoteReplaceTool.description(), {
      type: 'object',
      properties: {
        noteId: NOTE_ID_PROPERTY,
        search: { type: 'string', description: '要查找的文本或正则表达式' },
        replace: { type: 'string', description: '替换后的文本' },
        isRegex: { type: 'boolean', description: '是否使用正则表达式（默认 false）' },
        expected_updated_at: {
          type: 'string',
          minLength: 1,
          description: 'note_read 返回的 updatedAt OCC 基线',
        },
      },
      required: ['search', 'replace', 'expected_updated_at'],
      additionalProperties: false,
    });
  }
}

export class NoteSetTool {
  static name(): string { return 'note_set'; }
  static description(): string {
    return '设置笔记完整内容。必须先 note_read 并传入 expected_updated_at。⚠️ 会覆盖原内容。界面已单独渲染笔记 title 为顶部文档标题，content 必须直接从正文、导语或二级标题（##）开始，不得在开头重复标题或添加一级标题（# 标题）。';
  }
  schema(): ToolSchema {
    return schema(NoteSetTool.name(), NoteSetTool.description(), {
      type: 'object',
      properties: {
        noteId: NOTE_ID_PROPERTY,
        content: {
          type: 'string',
          description: '笔记的新完整内容（支持 Markdown 格式；界面已将笔记 title 渲染为顶部文档标题，请直接以正文、导语或二级标题（##）开头，不得在开头重复标题或添加 # 一级标题）',
        },
        expected_updated_at: {
          type: 'string',
          minLength: 1,
          description: 'note_read 返回的 updatedAt OCC 基线',
        },
      },
      required: ['content', 'expected_updated_at'],
      additionalProperties: false,
    });
  }
}

export class NoteCreateTool {
  static name(): string { return 'note_create'; }
  static description(): string {
    return '创建一个新笔记。返回新笔记的 ID，可用于后续 note_append/note_set 操作。界面已将 title 渲染为顶部文档标题，content 必须直接从正文、导语或二级标题（##）开始，不得在开头重复 title 或添加一级标题（# 标题）。';
  }
  schema(): ToolSchema {
    return schema(NoteCreateTool.name(), NoteCreateTool.description(), {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题（界面会将其单独渲染为文档顶部标题，无需在 content 开头重复）' },
        content: {
          type: 'string',
          description: '初始内容（可选，支持 Markdown 格式；界面已将 title 渲染为顶部文档标题，请直接以正文、导语或二级标题（##）开头，不得在开头重复笔记标题或添加 # 一级标题）',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        folder_id: {
          type: 'string',
          description: '目标文件夹 ID（可选；省略表示根目录）',
        },
      },
      required: ['title'],
      additionalProperties: false,
    });
  }
}

export class NoteListTool {
  static name(): string { return 'note_list'; }
  static description(): string {
    return '列出 Learning Hub 中的笔记。可按标签过滤或只显示收藏。';
  }
  schema(): ToolSchema {
    return schema(NoteListTool.name(), NoteListTool.description(), {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回数量限制（默认 20，最大 100）' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤（AND 逻辑）' },
        favoritesOnly: { type: 'boolean', description: '是否只返回收藏的笔记' },
      },
      required: [],
    });
  }
}

export class NoteSearchTool {
  static name(): string { return 'note_search'; }
  static description(): string {
    return '在 Learning Hub 中搜索笔记。支持全文检索，返回匹配片段。';
  }
  schema(): ToolSchema {
    return schema(NoteSearchTool.name(), NoteSearchTool.description(), {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'integer', description: '返回数量限制（默认 10，最大 50）' },
      },
      required: ['query'],
    });
  }
}

export const CANVAS_TOOL_SCHEMAS: readonly ToolSchema[] = [
  new NoteReadTool().schema(),
  new NoteAppendTool().schema(),
  new NoteReplaceTool().schema(),
  new NoteSetTool().schema(),
  new NoteCreateTool().schema(),
  new NoteListTool().schema(),
  new NoteSearchTool().schema(),
];

function lines(content: string): string[] {
  // Rust `str::lines` splits on `\n` and strips a preceding `\r`.
  const out = content.split('\n');
  return out.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Extract one section body (without its heading); `null` when absent. */
export function extractSection(content: string, sectionTitle: string): string | null {
  const title = sectionTitle.trim();
  if (title === '') return null;
  const sectionLevel = [...title].findIndex(ch => ch !== '#');
  const level = sectionLevel < 0 ? title.length : sectionLevel;
  if (level === 0) return null;

  const sourceLines = lines(content);
  let inSection = false;
  const sectionContent: string[] = [];
  for (const line of sourceLines) {
    if (inSection) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) {
        let lineLevel = 0;
        while (lineLevel < trimmed.length && trimmed[lineLevel] === '#') lineLevel += 1;
        if (lineLevel <= level) break;
      }
      sectionContent.push(line);
    } else if (line.trim() === title) {
      inSection = true;
    }
  }
  if (sectionContent.length === 0 && !inSection) return null;
  return sectionContent.join('\n').trim();
}

/** Append to the end of a section; `null` when the section is absent. */
export function appendToSection(
  content: string,
  sectionTitle: string,
  appendContent: string,
): string | null {
  const title = sectionTitle.trim();
  if (title === '') return null;
  const sectionLevel = [...title].findIndex(ch => ch !== '#');
  const level = sectionLevel < 0 ? title.length : sectionLevel;
  if (level === 0) return null;

  const sourceLines = lines(content);
  const result: string[] = [];
  let foundSection = false;
  let insertIndex: number | null = null;

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!;
    if (foundSection && insertIndex === null) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) {
        let lineLevel = 0;
        while (lineLevel < trimmed.length && trimmed[lineLevel] === '#') lineLevel += 1;
        if (lineLevel <= level) insertIndex = index;
      }
    }
    if (line.trim() === title) foundSection = true;
    result.push(line);
  }
  if (!foundSection) return null;

  const insertPosition = insertIndex ?? result.length;
  const finalResult = result.slice(0, insertPosition);
  if (finalResult.length > 0 && finalResult[finalResult.length - 1] !== '') finalResult.push('');
  for (const line of lines(appendContent)) finalResult.push(line);
  if (insertPosition < result.length) {
    finalResult.push('');
    for (const line of result.slice(insertPosition)) finalResult.push(line);
  }
  return finalResult.join('\n');
}

/** Convert Rust regex inline flags such as `(?i)` into JS `RegExp` flags. */
function compileRegex(pattern: string): RegExp {
  let flags = '';
  let body = pattern;
  const inline = /^\(\?([imsux]+)\)/.exec(body);
  if (inline !== null) {
    flags = inline[1]!;
    body = body.slice(inline[0].length);
  }
  // `s` and `u` are valid JS flags; `x` (verbose) is not supported.
  if (flags.includes('x')) throw new Error('无效的正则表达式: verbose mode is not supported');
  if (!flags.includes('u')) flags += 'u';
  return new RegExp(body, `${flags}g`);
}

/** Replace text or a regex; returns the new content and replacement count. */
export function replaceContent(
  content: string,
  search: string,
  replace: string,
  isRegex: boolean,
): [string, number] {
  if (isRegex) {
    let regex: RegExp;
    try { regex = compileRegex(search); }
    catch (error) {
      throw new Error(`无效的正则表达式: ${error instanceof Error ? error.message : String(error)}`);
    }
    let count = 0;
    const newContent = content.replace(regex, () => { count += 1; return replace; });
    return [newContent, count];
  }
  // Rust `matches` counts non-overlapping occurrences.
  let count = 0;
  let offset = 0;
  if (search !== '') {
    for (;;) {
      const found = content.indexOf(search, offset);
      if (found < 0) break;
      count += 1;
      offset = found + search.length;
    }
  } else {
    count = [...content].length + 1;
  }
  return [content.replaceAll(search, replace), count];
}

/** Collect all Markdown headings, trimmed. */
export function parseStructure(content: string): string[] {
  return lines(content)
    .filter(line => line.trimStart().startsWith('#'))
    .map(line => line.trim());
}

/** Plain-text preview capped by Unicode scalar count. */
export function generateSummary(content: string, maxLength: number): string {
  const plainText = lines(content)
    .filter(line => !line.trimStart().startsWith('#'))
    .filter(line => line.trim() !== '')
    .join(' ');
  const chars = Array.from(plainText);
  if (chars.length <= maxLength) return plainText;
  return `${chars.slice(0, maxLength).join('')}...`;
}
