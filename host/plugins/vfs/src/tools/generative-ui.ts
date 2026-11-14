/** chat_v2/tools/generative_ui_executor.rs. Pending L07 registration and L17 HPIAS ports. */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo, ChatV2Emitter } from '../../../chat/api.ts';
import { stripToolNamespace } from '../../../agent-skills/portable.ts';
import type { WindowRef } from '../../../../kernel/api.ts';
import { rustTrim, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { parseSerdeJson } from '../../repository/json.ts';
import { WidgetAssemblyManager, type WidgetAssemblyResult } from './widget-assembly.ts';
export { WidgetAssembler, WidgetAssemblyManager, applyArtifactPatch, parseWidgetAssemblyArgs } from './widget-assembly.ts';

const BLOCK_TYPES = new Set(['stat-card', 'alert', 'list', 'progress', 'action-bar', 'text', 'key-value-grid',
  'flashcard-preview', 'review-calendar', 'mistake-analysis', 'mindmap-embed', 'paper-digest', 'research-plan',
  'research-report', 'markdown', 'chart', 'steps', 'table']);
const MAX_INTENT_BYTES = 256000;
type ObjectValue = Record<string, unknown>;
export interface GenerativeIntent extends ObjectValue { blocks: ObjectValue[] }
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as ObjectValue : null;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function validateIntentVersion(intent: ObjectValue): void {
  if (!Object.hasOwn(intent, 'version')) return;
  const value = intent.version;
  if (value === '1' || value === '1.1') return;
  if (typeof value === 'string') throw new Error(`intent.version 不支持: ${value}（支持 "1" / "1.1"）`);
  throw new Error('intent.version 必须是字符串 "1" 或 "1.1"');
}
export function knownLayoutMode(intent: ObjectValue): 'stack' | 'grid' | null {
  const mode = object(intent.layout)?.mode;
  return mode === 'stack' || mode === 'grid' ? mode : null;
}
export function parseIntent(args: unknown): GenerativeIntent {
  const input = object(args);
  if (input === null || !Object.hasOwn(input, 'intent')) throw new Error('render_generative_ui 需要 intent 参数（JSON 对象或字符串）');
  const raw = input.intent;
  let parsed: unknown;
  if (typeof raw === 'string') {
    try { parsed = parseSerdeJson(rustTrim(raw)); }
    catch (error) { throw new Error(`intent 不是合法 JSON: ${errorText(error)}`); }
  } else { parsed = structuredClone(raw); }
  const intent = object(parsed);
  if (intent === null) throw new Error('intent 必须是 JSON 对象');
  if ((typeof raw === 'string' && utf8ByteLength(raw) > MAX_INTENT_BYTES)
    || utf8ByteLength(JSON.stringify(intent)) > MAX_INTENT_BYTES) throw new Error(`intent 超过 ${MAX_INTENT_BYTES} 字符上限`);
  validateIntentVersion(intent);
  knownLayoutMode(intent);
  const blocks = intent.blocks;
  if (!Array.isArray(blocks)) throw new Error('intent.blocks 必须是数组');
  if (blocks.length === 0) throw new Error('intent.blocks 不能为空');
  if (blocks.length > 32) throw new Error(`intent.blocks 超过上限 32（收到 ${blocks.length}）`);
  blocks.forEach((value, index) => {
    const block = object(value);
    if (block === null) throw new Error(`intent.blocks[${index}] 必须是对象`);
    if (typeof block.type !== 'string') throw new Error(`intent.blocks[${index}].type 必须是字符串`);
    if (!BLOCK_TYPES.has(block.type)) throw new Error(`intent.blocks[${index}].type 不支持: ${block.type}`);
  });
  return intent as GenerativeIntent;
}
function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = rustTrim(value);
  return id !== '' && utf8ByteLength(id) <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}
export function parseResearchSessionId(args: unknown, intent: unknown): string | null {
  return safeId(object(args)?.researchSessionId) ?? safeId(object(object(intent)?.meta)?.researchSessionId);
}
export function parseSkeletonRef(args: unknown): string | null { return safeId(object(args)?.skeletonRef); }
export function parseNoteEdit(args: unknown): ObjectValue | null {
  const input = object(args);
  if (input === null || !Object.hasOwn(input, 'noteEdit')) return null;
  const raw = object(input.noteEdit);
  if (raw === null) throw new Error('noteEdit 必须是 JSON 对象');
  const operation = raw.operation;
  if (typeof operation !== 'string') throw new Error('noteEdit.operation 必填（append | replace | set）');
  if (!['append', 'replace', 'set'].includes(operation)) throw new Error(`noteEdit.operation 无效: ${operation}`);
  if (raw.isRegex === true) throw new Error('noteEdit.isRegex 不被支持');
  const size = (key: string) => typeof raw[key] === 'string' ? utf8ByteLength(raw[key]) : 0;
  if (size('section') > 1024) throw new Error('noteEdit.section 过长');
  if (size('content') + size('search') + size('replace') + size('section') > 262144) throw new Error('noteEdit 内容超过 262144 字节');
  const result: ObjectValue = { operation };
  for (const key of ['content', 'search', 'replace', 'section']) {
    if (!Object.hasOwn(raw, key)) continue;
    if (typeof raw[key] !== 'string') throw new Error(`noteEdit.${key} 必须是字符串`);
    result[key] = raw[key];
  }
  return result;
}
export function intentHasApplyNoteEdit(intent: unknown): boolean {
  const blocks = object(intent)?.blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(value => {
    const block = object(value);
    if (block?.type !== 'action-bar') return false;
    const actions = object(block.props)?.actions;
    return Array.isArray(actions) && actions.some(action => object(action)?.id === 'apply-note-edit');
  });
}

/** L17 owns research intent predicates, backend enablement, event emission and pipeline start. */
export interface GenerativeResearchPort {
  startFromIntent(request: { window: WindowRef; sessionId: string; title: string | null; intent: GenerativeIntent }): void;
}
/** L07 registry addition required before this executor can be marked ported. */
export interface VfsToolRegistrationPort { registerToolExecutors(executors: readonly ToolExecutor[]): void }
export type GenerativeUiExecutionContext = Pick<ExecutionContext,
  'message_id' | 'block_id' | 'variant_id' | 'skill_state_version' | 'round_id' | 'emitter' | 'tryWindow' | 'saveToolBlock'>
  & Partial<Pick<ExecutionContext, 'session_id' | 'runId' | 'emitToolCallStart' | 'emitToolCallEnd'>>;

export class GenerativeUiExecutor implements ToolExecutor {
  readonly widgetAssemblies = new WidgetAssemblyManager();
  private readonly research: () => GenerativeResearchPort;
  constructor(research: () => GenerativeResearchPort) { this.research = research; }
  name(): string { return 'GenerativeUiExecutor'; }
  sensitivityLevel(): 'low' { return 'low'; }
  canHandle(name: string): boolean { return stripToolNamespace(name) === 'render_generative_ui'; }
  async execute(call: ToolCall, ctx: GenerativeUiExecutionContext): Promise<ToolResultInfo> {
    const start = performance.now();
    const meta = [ctx.variant_id, ctx.skill_state_version, ctx.round_id] as const;
    const begin = (title: string | null) => ctx.emitter.emitStartWithMeta('generative_ui', ctx.message_id,
      ctx.block_id, title === null ? { toolCallId: call.id } : { title, toolCallId: call.id }, ...meta);
    const save = (result: ToolResultInfo) => {
      try { ctx.saveToolBlock(result); }
      catch { // boundary-allow empty-catch: generative_ui_executor.rs:395,413,432,483 deliberately discards save_tool_block failure
        // The tool result is still returned to the pipeline.
      }
      return result;
    };
    let intent: GenerativeIntent;
    let assembly: WidgetAssemblyResult | undefined;
    try {
      const input = object(call.arguments);
      if (input?.format === 'html' || (input && Object.hasOwn(input, 'widgetAssembly'))) {
        const assembler = this.widgetAssemblies.get(ctx.session_id ?? ctx.message_id,
          JSON.stringify([ctx.runId?.() ?? ctx.message_id, ctx.variant_id]));
        assembly = assembler.execute(call.arguments);
        if (!assembly.widget) {
          const durationMs = Math.floor(performance.now() - start);
          ctx.emitToolCallStart?.(call.name, call.arguments, call.id);
          ctx.emitToolCallEnd?.({ result: assembly, durationMs });
          return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
            output: assembly, success: true, durationMs });
        }
        const widget = assembly.widget;
        intent = { version: '1', ...(widget.title === undefined ? {} : { meta: { title: widget.title } }),
          blocks: [{ type: 'html', props: { html: widget.code,
            ...(widget.title === undefined ? {} : { title: widget.title }), ...(widget.libs === undefined ? {} : { libs: widget.libs }) } }] };
      } else {
        intent = parseIntent(call.arguments);
      }
      const noteEdit = parseNoteEdit(call.arguments);
      if (intentHasApplyNoteEdit(intent) && noteEdit === null) throw new Error('intent 含 apply-note-edit 时必须提供 noteEdit 参数');
    } catch (error) {
      const detail = errorText(error);
      begin(null);
      ctx.emitter.emitErrorWithMeta('generative_ui', ctx.block_id, detail, ...meta);
      return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: detail, durationMs: Math.floor(performance.now() - start) });
    }
    const researchSessionId = parseResearchSessionId(call.arguments, intent);
    const skeletonRef = parseSkeletonRef(call.arguments);
    const rawTitle = object(intent.meta)?.title;
    const title = typeof rawTitle === 'string' ? rawTitle : null;
    let serialized: string;
    try { serialized = JSON.stringify(intent); }
    catch (error) { throw new Error(`intent 序列化失败: ${errorText(error)}`); }
    begin(title);
    // The public concrete emitter exposes the metadata-preserving method; the
    // narrow ExecutionContext emitter interface has not yet listed it.
    (ctx.emitter as ExecutionContext['emitter'] & Pick<ChatV2Emitter, 'emitChunkWithMeta'>)
      .emitChunkWithMeta('generative_ui', ctx.block_id, serialized, ...meta);
    ctx.emitter.emitEndWithMeta('generative_ui', ctx.block_id, { intent, isStreaming: false,
      ...(researchSessionId === null ? {} : { researchSessionId }), ...(skeletonRef === null ? {} : { skeletonRef }) }, ...meta);
    if (researchSessionId !== null) {
      const window = ctx.tryWindow();
      if (window !== null) this.research().startFromIntent({ window, sessionId: researchSessionId, title, intent });
    }
    return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
      output: { status: 'rendered', blockCount: intent.blocks.length, ...(researchSessionId === null ? {} : { researchSessionId }),
        ...(assembly === undefined ? {} : { assembly: { status: assembly.status, revision: assembly.revision,
          length: assembly.length, offsetUnit: assembly.offsetUnit } }) },
      success: true, durationMs: Math.floor(performance.now() - start) });
  }
}
