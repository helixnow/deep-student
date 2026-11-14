// RUST-FIX(RF-P3-workshop-tools): managed tools with no installation authority.
import type { ToolCall, ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import type { AgentSchemaTool } from '../../agent-skills/api.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import type { WorkshopTemplate } from '../api.ts';
import type { WorkshopOperations } from './operations.ts';
import type { WorkshopCatalog, ApiCategory } from './catalog.ts';
import type { SourceFile } from './source.ts';

const specs = {
  diagnose: { description: 'Read exact managed source, build errors, last good release and live Host status for this conversation.', properties: { id: { type: 'string' } }, required: ['id'] },
  write_source: { description: 'Edit files only in a conversation-owned draft/failed managed source directory. Cannot install or alter a frozen candidate.', properties: {
    id: { type: 'string' }, revision: { type: 'integer' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  }, required: ['id', 'revision', 'files'] },
  rollback: { description: 'Recover a failed managed work to its previously user-approved usable release. Cannot install new Agent code.', properties: { id: { type: 'string' }, revision: { type: 'integer' } }, required: ['id', 'revision'] },
  api_list: { description: 'List real dstu SDK, service, slot, config, theme and shipped resources. Read-only.', properties: { category: { type: 'string', enum: ['sdk', 'services', 'slots', 'config', 'theme', 'examples', 'resources'] } }, required: [] },
  api_read: { description: 'Read an exact API/resource id from api_list; never executes business methods.', properties: { id: { type: 'string' } }, required: ['id'] },
  validate: { description: 'Compile and test-load/unload a managed work. Does not install. Visual remains unverified.', properties: { id: { type: 'string' } }, required: ['id'] },
  propose_install: { description: 'Propose a managed work. With autoGenerate, autonomously compile/test/repair and stage for one user installation confirmation. Never installs.', properties: {
    autoGenerate: { type: 'boolean' },
    title: { type: 'string' }, description: { type: 'string' }, template: { type: 'string', enum: ['learning-tool', 'host-tool'] },
    changes: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'array', items: { type: 'string' } },
    pluginId: {
      type: 'string',
      description: 'Omit when creating a new plugin (the Host assigns workshop.plugin-<uuid> automatically). Only pass an existing workshop.plugin-... pluginId returned by dstu_plugin_status when editing an existing managed work.',
    },
  }, required: ['title', 'description', 'template', 'changes', 'capabilities'] },
  status: { description: 'Read workshop works belonging to this conversation.', properties: { id: { type: 'string' } }, required: [] },
  export: { description: 'Export a validated work to its Host-owned .dstuplugin path. Does not publish.', properties: { id: { type: 'string' } }, required: ['id'] },
  inventory: { description: 'List all installed plugins (builtin, workshop, community) with their running state, trust tier, and whether they have configurable settings (hasConfig). Read-only.', properties: {}, required: [] },
  config_get: { description: 'Read a plugin\'s configuration schema and current values by pluginId (e.g. workshop.plugin-xxx or builtin plugin id). Read-only.', properties: { pluginId: { type: 'string' } }, required: ['pluginId'] },
  configure: { description: 'Update a plugin\'s configuration values by pluginId and hot-reload its running fiber immediately without requiring an app restart. Requires user approval.', properties: { pluginId: { type: 'string' }, values: { type: 'object', additionalProperties: true } }, required: ['pluginId', 'values'] },
  set_enabled: { description: 'Enable or disable a managed workshop plugin by pluginId and hot-load/unload it immediately. Requires user approval.', properties: { pluginId: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['pluginId', 'enabled'] },
  app_restart: { description: 'Trigger a full application restart after explicit user confirmation (note: plugin installation and configuration hot-load automatically and do NOT require a restart; use only when the user explicitly asks to restart the app).', properties: { reason: { type: 'string' } }, required: [] },
} as const;
export const workshopToolNames = Object.keys(specs).map(name => `dstu_plugin_${name}`);
const normalized = (name: string) => name.replace(/^builtin[-:]/, '');
/** Read-only tools: inspection never mutates the profile or the running runtime. */
const readOnlyTools = new Set(['dstu_plugin_api_list', 'dstu_plugin_api_read', 'dstu_plugin_status', 'dstu_plugin_diagnose', 'dstu_plugin_inventory', 'dstu_plugin_config_get']);
/** Irreversible or execution-authority tools: the chat pipeline must ask the user first. */
const confirmTools = new Set(['dstu_plugin_configure', 'dstu_plugin_set_enabled', 'dstu_plugin_app_restart', 'dstu_plugin_propose_install']);
export class WorkshopToolExecutor {
  readonly operations: WorkshopOperations;
  readonly catalog: WorkshopCatalog;
  constructor(operations: WorkshopOperations, catalog: WorkshopCatalog) { this.operations = operations; this.catalog = catalog; }
  name(): string { return 'DstuPluginWorkshopExecutor'; }
  canHandle(name: string): boolean { return workshopToolNames.includes(normalized(name)); }
  sensitivityLevel(name: string): 'low' | 'medium' | 'high' {
    const tool = normalized(name);
    if (confirmTools.has(tool)) return 'high';
    return readOnlyTools.has(tool) ? 'low' : 'medium';
  }
  concurrencyClass(): 'serial' { return 'serial'; }
  schemaTools(): AgentSchemaTool[] {
    return Object.entries(specs).map(([suffix, spec]) => ({ id: `dstu_plugin_${suffix}`, schema: { type: 'function', function: {
      name: `dstu_plugin_${suffix}`, description: spec.description, parameters: { type: 'object', properties: spec.properties,
        required: spec.required, additionalProperties: false },
    } } }));
  }
  async invoke(name: string, args: Record<string, unknown>, sessionId: string): Promise<unknown> {
    switch (normalized(name)) {
      case 'dstu_plugin_api_list': return this.catalog.list(args.category as ApiCategory | undefined);
      case 'dstu_plugin_api_read': return this.catalog.read(String(args.id), this.operations.app.version);
      case 'dstu_plugin_inventory': return this.operations.inventory();
      case 'dstu_plugin_config_get': return this.operations.configGet(String(args.pluginId));
      case 'dstu_plugin_configure': return this.operations.configure(String(args.pluginId), args.values as Record<string, unknown>);
      case 'dstu_plugin_set_enabled': return this.operations.setEnabled(String(args.pluginId), args.enabled === true);
      case 'dstu_plugin_app_restart': return this.operations.requestRestart();
      case 'dstu_plugin_propose_install': {
        const rawPluginId = typeof args.pluginId === 'string'
          ? args.pluginId.trim()
          : args.pluginId == null ? '' : String(args.pluginId).trim();
        let resolvedPluginId: string | undefined;
        if (rawPluginId !== '') {
          const works = await this.operations.list();
          const matched = works.find(
            w => w.pluginId === rawPluginId || w.id === rawPluginId || w.pluginId === `workshop.plugin-${rawPluginId}`,
          );
          if (matched) {
            resolvedPluginId = matched.pluginId;
          } else if (await this.operations.isInstalledNonWorkshopPlugin(rawPluginId)) {
            resolvedPluginId = rawPluginId;
          }
          // Otherwise the model invented a slug for a brand-new plugin; omit pluginId so Host assigns workshop.plugin-<uuid>.
        }
        const card = await this.operations.propose({ sessionId, title: args.title as string,
        description: args.description as string, template: args.template as WorkshopTemplate,
        changes: args.changes as string[], capabilities: args.capabilities as string[],
        ...(resolvedPluginId === undefined ? {} : { pluginId: resolvedPluginId }) });
        const result = args.autoGenerate === true ? await this.operations.create(card.id, card.revision) : card;
        return { ...result, serviceName: pluginServiceName(result.pluginId) };
      }
      case 'dstu_plugin_status': {
        const filterId = args.id === undefined ? undefined : String(args.id).trim().replace(/^workshop\.plugin-/, '');
        const works = (await this.operations.list())
          .filter(card => card.sessionId === sessionId && (filterId === undefined || card.id === filterId))
          .map(card => ({ ...card, serviceName: pluginServiceName(card.pluginId) }));
        return { works };
      }
      case 'dstu_plugin_validate':
      case 'dstu_plugin_diagnose':
      case 'dstu_plugin_write_source':
      case 'dstu_plugin_rollback':
      case 'dstu_plugin_export': {
        const id = String(args.id ?? '').trim().replace(/^workshop\.plugin-/, ''), card = await this.operations.status(id);
        if (card.sessionId !== sessionId) throw new Error('WORKSHOP_INVALID: work belongs to another conversation');
        if (normalized(name) === 'dstu_plugin_diagnose') return this.operations.diagnose(id);
        if (normalized(name) === 'dstu_plugin_write_source') {
          const rev = ['draft', 'generating', 'failed', 'cancelled'].includes(card.state) ? card.revision : Number(args.revision);
          return this.operations.writeSource(id, rev, args.files as SourceFile[]);
        }
        if (normalized(name) === 'dstu_plugin_rollback') {
          if (card.state !== 'failed') throw new Error('WORKSHOP_STATE: rollback only recovers failed works');
          return this.operations.restore(id, Number(args.revision));
        }
        return normalized(name) === 'dstu_plugin_validate' ? this.operations.stageValidated(id) : this.operations.export(id);
      }
      default: throw new Error(`WORKSHOP_INVALID: unsupported tool ${name}`);
    }
  }
  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    try {
      const output = await this.invoke(call.name, call.arguments as Record<string, unknown>, ctx.session_id);
      const json = JSON.parse(JSON.stringify(output));
      ctx.emitToolCallEnd(json);
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: json, success: true, durationMs: Math.trunc(performance.now() - started) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.emitToolCallError(message);
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: message, durationMs: Math.trunc(performance.now() - started) };
    }
  }
}
