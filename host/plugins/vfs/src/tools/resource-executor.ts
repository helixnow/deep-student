/** builtin_resource_executor.rs:5531-5670. Only completed tool names are registered. */
import { DEFAULT_TOOL_RESULT_CHAR_BUDGET } from '../../../../kernel/api.ts';
import { stripToolNamespace } from '../../../agent-skills/portable.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import { executeResourceRead } from './resource-read.ts';
import { executeResourceList } from './resource-list.ts';
import { executeResourceSearch, executeFolderList } from './resource-search-folders.ts';
import { createToolMindmap, updateToolMindmap, deleteToolMindmap } from './mindmap-crud.ts';
import { listToolMindmapVersions, diffToolMindmapVersions } from './mindmap-versions.ts';
import { editToolMindmap } from './mindmap-edit.ts';
import { importToolMindmap } from './mindmap-import.ts';
import type { MindmapXmlParser } from './mindmap-import-xml.ts';

export type ResourceToolContext = Pick<ExecutionContext, 'services' | 'message_id' | 'block_id' | 'variant_id' | 'skill_state_version' |
  'round_id' | 'emitter' | 'emitToolCallStart' | 'saveToolBlock'> & Partial<Pick<ExecutionContext, 'session_id' | 'cancellation_token' | 'isCancelled' | 'chat_v2_db' | 'windowRef'>>;
export class BuiltinResourceExecutor implements ToolExecutor {
  readonly importOnly: boolean;
  readonly xml: MindmapXmlParser | null;
  constructor(xml: MindmapXmlParser | null = null, importOnly = false) { this.xml = xml; this.importOnly = importOnly; }
  name(): string { return 'BuiltinResourceExecutor'; }
  canHandle(name: string): boolean {
    if (stripToolNamespace(name) === 'mindmap_import') return this.xml !== null;
    if (this.importOnly) return false;
    return ['resource_read', 'resource_list', 'resource_search', 'folder_list',
    'mindmap_create', 'mindmap_update', 'mindmap_delete', 'mindmap_versions', 'mindmap_diff_versions', 'mindmap_edit_nodes'].includes(stripToolNamespace(name)); }
  sensitivityLevel(name: string): 'low' | 'high' { return ['mindmap_delete', 'mindmap_edit_nodes'].includes(stripToolNamespace(name)) ? 'high' : 'low'; }
  concurrencyClass(name: string): 'read_only' | 'serial' { return ['resource_list', 'resource_read', 'resource_search', 'folder_list'].includes(stripToolNamespace(name)) ? 'read_only' : 'serial'; }
  managesCancellation(name: string): boolean { return stripToolNamespace(name) === 'mindmap_edit_nodes'; }
  resultCharBudget(name: string): number | null { return stripToolNamespace(name) === 'resource_read' ? null : DEFAULT_TOOL_RESULT_CHAR_BUDGET; }
  async execute(call: ToolCall, ctx: ResourceToolContext): Promise<ToolResultInfo> {
    const start = performance.now(), name = stripToolNamespace(call.name);
    ctx.services.logger.debug('[BuiltinResourceExecutor] Executing builtin tool: %s (full: %s)', name, call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let result: ToolResultInfo;
    try {
      const args = call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
      let output: Record<string, unknown>;
      switch (name) {
        case 'resource_read': output = executeResourceRead(ctx.services, call.arguments); break;
        case 'resource_list': output = executeResourceList(ctx.services, args); break;
        case 'resource_search': output = executeResourceSearch(ctx.services, args); break;
        case 'folder_list': output = executeFolderList(ctx.services, args); break;
        case 'mindmap_create': output = createToolMindmap(ctx.services, args); break;
        case 'mindmap_update': output = updateToolMindmap(ctx.services, args); break;
        case 'mindmap_delete': output = await deleteToolMindmap(ctx.services, args); break;
        case 'mindmap_versions': output = listToolMindmapVersions(ctx.services, args); break;
        case 'mindmap_diff_versions': output = diffToolMindmapVersions(ctx.services, args); break;
        case 'mindmap_edit_nodes': output = await editToolMindmap(ctx, call.id, args); break;
        case 'mindmap_import': {
          if (this.xml === null) throw new Error('Unknown builtin resource tool: mindmap_import');
          output = await importToolMindmap(ctx, args, this.xml); break;
        }
        default: throw new Error(`Unknown builtin resource tool: ${name}`);
      }
      const durationMs = Math.floor(performance.now() - start);
      ctx.emitter.emitEndWithMeta('tool_call', ctx.block_id, { result: output, durationMs }, ctx.variant_id, ctx.skill_state_version, ctx.round_id);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output, success: true, durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error), durationMs = Math.floor(performance.now() - start);
      ctx.emitter.emitErrorWithMeta('tool_call', ctx.block_id, message, ctx.variant_id, ctx.skill_state_version, ctx.round_id);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null, success: false, error: message, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (error) { ctx.services.logger.warn('[BuiltinResourceExecutor] Failed to save tool block: %s', error instanceof Error ? error.message : String(error)); }
    return result;
  }
}
