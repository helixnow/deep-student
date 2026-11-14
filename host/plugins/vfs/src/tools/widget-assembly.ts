/** Task-local, portable HTML assembly. No source is executed or persisted here. */
export const MAX_WIDGET_HTML = 60_000;
export interface ArtifactEdit { search: string; replace: string }
export type WidgetAssemblyAction = 'append' | 'read' | 'patch' | 'complete' | 'discard';
export interface WidgetAssemblyArgs {
  format: 'html'; code: string; action?: WidgetAssemblyAction; revision?: number;
  offset?: number; limit?: number; edits?: ArtifactEdit[]; title?: string; libs?: string[];
}
export interface WidgetSource { code: string; title?: string; libs?: string[] }
export interface WidgetAssemblyResult {
  status: 'assembling-not-runnable' | 'empty' | 'completed' | 'discarded';
  revision: number; length: number; offsetUnit: 'UTF-16';
  offset?: number; content?: string; nextOffset?: number | null; widget?: WidgetSource;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function unicode(text: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    throw new Error('widget_assembly_unicode_boundary');
}
function validateEdits(raw: unknown): ArtifactEdit[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new Error('invalid_widget_assembly_patch: 1~20 edits required');
  let size = 0;
  const edits = raw.map(value => {
    const edit = record(value);
    if (!edit || Object.keys(edit).some(key => !['search', 'replace'].includes(key))
      || typeof edit.search !== 'string' || !edit.search || typeof edit.replace !== 'string')
      throw new Error('invalid_widget_assembly_patch_edit');
    unicode(edit.search); unicode(edit.replace);
    size += edit.search.length + edit.replace.length;
    return { search: edit.search, replace: edit.replace };
  });
  if (size > 6000 || JSON.stringify(raw).length > 40_000) throw new Error('widget_assembly_patch_too_large: limits=6000/40000');
  return edits;
}

/** All matches are found against the same original source, then applied atomically. */
export function applyArtifactPatch(source: string, edits: readonly ArtifactEdit[]): string {
  unicode(source);
  const ranges = validateEdits(edits).map(edit => {
    const start = source.indexOf(edit.search);
    if (start < 0) throw new Error('widget_assembly_patch_no_match');
    if (source.indexOf(edit.search, start + 1) >= 0) throw new Error('widget_assembly_patch_multiple_matches');
    return { start, end: start + edit.search.length, replace: edit.replace };
  }).sort((a, b) => a.start - b.start);
  let result = '', cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) throw new Error('widget_assembly_patch_overlap');
    result += source.slice(cursor, range.start) + range.replace;
    cursor = range.end;
  }
  result += source.slice(cursor);
  if (!result.length) throw new Error('widget_assembly_patch_empty_result');
  if (result === source) throw new Error('widget_assembly_patch_no_change');
  if (result.length > MAX_WIDGET_HTML) throw new Error('widget_assembly_too_large: limit=60000');
  unicode(result);
  return result;
}

/** Accept either HTML arguments themselves or the executor's widgetAssembly envelope. */
export function parseWidgetAssemblyArgs(raw: unknown): WidgetAssemblyArgs {
  const outer = record(raw);
  const input = outer && Object.hasOwn(outer, 'widgetAssembly') ? record(outer.widgetAssembly) : outer;
  if (!input) throw new Error('invalid_widget_assembly');
  const value = { ...input, format: input.format ?? outer?.format ?? 'html' };
  const fields: Record<WidgetAssemblyAction, string[]> = {
    append: ['offset', 'title', 'libs'], read: ['offset', 'limit'], patch: ['edits'], complete: ['offset'], discard: [],
  };
  if (value.format !== 'html' || typeof input.code !== 'string') throw new Error('invalid_widget_assembly: html format and code required');
  const action = input.action;
  if (action === undefined) {
    if (Object.keys(input).some(key => !['format', 'code', 'title', 'libs'].includes(key)))
      throw new Error('invalid_widget_assembly: action required for assembly fields');
    if (!input.code.trim() || input.code.length > MAX_WIDGET_HTML) throw new Error('invalid_widget_html: code must contain 1~60000 UTF-16 characters');
    unicode(input.code);
  } else {
    if (typeof action !== 'string' || !Object.hasOwn(fields, action)) throw new Error('invalid_widget_assembly_action');
    if (Object.keys(input).some(key => !['format', 'action', 'revision', 'code', ...fields[action as WidgetAssemblyAction]].includes(key))
      || (action !== 'append' && input.code !== '')) throw new Error('invalid_widget_assembly_fields');
    if (!(action === 'read' && input.revision === undefined)
      && (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)) throw new Error('invalid_widget_assembly_revision');
    if (action === 'patch') validateEdits(input.edits);
  }
  if (input.title !== undefined && typeof input.title !== 'string') throw new Error('invalid_widget_assembly_title');
  if (input.libs !== undefined && (!Array.isArray(input.libs) || input.libs.length > 16
    || input.libs.some(lib => lib !== 'chart.js'))) throw new Error('invalid_widget_assembly_libs: supported library is chart.js');
  return value as unknown as WidgetAssemblyArgs;
}

export class WidgetAssembler {
  private pending: WidgetSource | undefined;
  private version = 0;
  get revision(): number { return this.version; }
  get length(): number { return this.pending?.code.length ?? 0; }
  private receipt(status: WidgetAssemblyResult['status'], extra: Partial<WidgetAssemblyResult> = {}): WidgetAssemblyResult {
    return { status, revision: this.version, length: this.length, offsetUnit: 'UTF-16', ...extra };
  }
  /** accept runs before complete commits, so delivery/validation failures retain the buffer. */
  execute(raw: unknown, accept?: (widget: WidgetSource) => void): WidgetAssemblyResult {
    const args = parseWidgetAssemblyArgs(raw);
    if (args.action === undefined) {
      const widget = { code: args.code, ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.libs === undefined ? {} : { libs: [...args.libs] }) };
      accept?.(widget);
      return this.receipt('completed', { widget });
    }
    if (!(args.action === 'read' && args.revision === undefined) && args.revision !== this.version)
      throw new Error(`widget_assembly_revision_conflict: revision=${this.version}, length=${this.length}`);
    if (args.action === 'read') {
      const offset = args.offset, limit = args.limit ?? 2000, source = this.pending?.code ?? '';
      if (!Number.isSafeInteger(offset) || offset! < 0 || offset! > this.length
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error('invalid_widget_assembly_read');
      const start = offset!;
      if (start < source.length && /[\uDC00-\uDFFF]/.test(source[start]!)) throw new Error('widget_assembly_unicode_boundary');
      let end = Math.min(source.length, start + limit);
      if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end]!)) end--;
      if (end === start && start < source.length) throw new Error('widget_assembly_read_limit: increase limit');
      return this.receipt(this.pending ? 'assembling-not-runnable' : 'empty',
        { offset: start, content: source.slice(start, end), nextOffset: end < source.length ? end : null });
    }
    if (args.action === 'discard') {
      this.pending = undefined; this.version++;
      return this.receipt('discarded');
    }
    if (args.action === 'patch') {
      if (!this.pending) throw new Error('invalid_widget_assembly_patch: pending source required');
      const code = applyArtifactPatch(this.pending.code, args.edits!);
      this.pending = { ...this.pending, code }; this.version++;
      return this.receipt('assembling-not-runnable');
    }
    if (!Number.isSafeInteger(args.offset) || args.offset !== this.length)
      throw new Error(`widget_assembly_offset_conflict: length=${this.length}`);
    if (args.action === 'append') {
      if (args.code.length < 1 || args.code.length > 6000) throw new Error('invalid_widget_assembly_chunk: limit=6000');
      unicode(args.code);
      if (this.length + args.code.length > MAX_WIDGET_HTML) throw new Error('widget_assembly_too_large: limit=60000');
      if (this.pending && (args.title !== undefined || args.libs !== undefined)) throw new Error('widget_assembly_metadata_only_on_first_chunk');
      this.pending = { code: (this.pending?.code ?? '') + args.code,
        title: this.pending?.title ?? args.title, libs: this.pending?.libs ?? (args.libs && [...args.libs]) };
      this.version++;
      return this.receipt('assembling-not-runnable');
    }
    if (!this.pending?.code.trim()) throw new Error('invalid_widget_assembly_complete: nonempty source required');
    const widget = structuredClone(this.pending);
    for (const tag of ['script', 'style']) {
      if ([...widget.code.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].length
        !== [...widget.code.matchAll(new RegExp(`</${tag}\\s*>`, 'gi'))].length) throw new Error(`widget_assembly_incomplete: unclosed ${tag}`);
    }
    accept?.(widget);
    this.pending = undefined; this.version++;
    return this.receipt('completed', { widget });
  }
}

/** Owned by one executor; explicit release ends a task without retaining its source. */
export class WidgetAssemblyManager {
  private readonly sessions = new Map<string, Map<string, WidgetAssembler>>();
  get(sessionId: string, taskId: string): WidgetAssembler {
    let tasks = this.sessions.get(sessionId);
    if (!tasks) { tasks = new Map(); this.sessions.set(sessionId, tasks); }
    let assembler = tasks.get(taskId);
    if (!assembler) { assembler = new WidgetAssembler(); tasks.set(taskId, assembler); }
    return assembler;
  }
  release(sessionId: string, taskId?: string): void {
    if (taskId === undefined) { this.sessions.delete(sessionId); return; }
    const tasks = this.sessions.get(sessionId);
    tasks?.delete(taskId);
    if (tasks?.size === 0) this.sessions.delete(sessionId);
  }
}
