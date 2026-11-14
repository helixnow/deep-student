/** builtin_resource_executor.rs:4280-4780. Shared ACR protocol stays with L07. */
import { get_json_array_arg, type JsonValue } from '../../../../platform/errors/api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { workbench, type AcrBridgeCallContext, type WorkbenchGateEnvironment } from '../workbench-bridge.ts';
import { parseSerdeJson } from '../../repository/json.ts';
import { updatedEvent } from '../dstu-types.ts';
import { mindmapToDstuNode } from '../node-converters.ts';
import { emitDstuWatchEvent } from '../locations.ts';
import type { ResourceToolContext } from './resource-executor.ts';
import { toolVfsDatabase, toolVfsRepos } from './tool-services.ts';
import { recordOf, sanitizeMindmapAssociations, valueString } from './mindmap-document.ts';
import { applyMindmapOperation, mindmapOperationToAgentOp } from './mindmap-operations.ts';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

async function tryFrontend(ctx: ResourceToolContext, toolCallId: string, id: string, operations: unknown[]): Promise<Record<string, unknown> | null> {
  const services = ctx.services, log = services.logger;
  try {
    const flags = services.get('featureFlags'), settings = services.get('settings');
    const gates: WorkbenchGateEnvironment | null = flags && settings ? { settings,
      featureFlagEnabled: name => flags.load({ getSetting: key => settings.get(key), saveSetting: (key, value) => settings.save(key, value) },
        services.app.version, { debug: services.app.debug }).isFeatureEnabled(name) } : null;
    if (!workbench.isWorkbenchAgentDelegationEnabled(gates)) { log.debug('[BuiltinResourceExecutor] mindmap ACR dual gate disabled; use backend data plane'); return null; }
  } catch (error) { log.warn('[BuiltinResourceExecutor] mindmap ACR dual gate unavailable; fail closed to backend: %s', detail(error)); return null; }
  const bridgeCall = async (command: string, args: unknown, timeout: number) => {
    const window = ctx.windowRef?.();
    if (!window) throw new Error('ACR bridge requires a frontend window');
    const bridge: AcrBridgeCallContext = { sessionId: ctx.session_id ?? '', toolCallId, cancel: ctx.cancellation_token ?? null,
      events: { emit: (name, payload) => services.backendEvents.emit(name, payload),
        listen: (name, callback) => services.backendEvents.listenWindow(window, name, callback) },
      emitProgressChunk: chunk => ctx.emitter.emitChunk('tool_call', ctx.block_id, chunk, ctx.variant_id), logger: log };
    return workbench.acrBridgeCall(bridge, command, args, timeout);
  };
  let probe;
  try { probe = await bridgeCall('probe', { target: { typeId: 'mindmap', resourceId: id } }, workbench.probeTimeoutMs); }
  catch (error) {
    if (workbench.isBridgeCancelled(detail(error))) return { status: 'cancelled', mode: 'frontend', applied: 0, totalOps: operations.length,
      entityIds: [id], done: [], undone: operations.map(() => 'cancelled before probe'), message: '用户取消；未写入。请根据 done/undone 继续，勿原样重试。', plane: 'frontend', delegated: true };
    log.info('[BuiltinResourceExecutor] mindmap ACR probe bridge error, fallback backend: %s', detail(error)); return null;
  }
  if (!probe.ok) { log.info('[BuiltinResourceExecutor] mindmap ACR probe not ok, fallback backend: %s', probe.error); return null; }
  const state = valueString(recordOf(probe.data)?.state) ?? '', windowId = valueString(recordOf(probe.data)?.windowId);
  if (!['clean', 'dirty', 'hot'].includes(state)) {
    log.info(['closed', 'frozen', 'disabled', ''].includes(state)
      ? "[BuiltinResourceExecutor] mindmap ACR probe state='%s', fallback backend" : "[BuiltinResourceExecutor] mindmap ACR probe unknown state='%s', fallback backend", state);
    return null;
  }
  if (windowId === null || rustTrim(windowId) === '') {
    log.warn('[BuiltinResourceExecutor] mindmap probe eligible but missing exact windowId');
    throw new Error(JSON.stringify({ code: 'BRIDGE_PROTOCOL_ERROR', message: 'mindmap probe 未返回精确 windowId', hint: '重新 probe；不得对同资源的其他窗口粗粒度委托', retryable: false }));
  }
  if (ctx.isCancelled?.() || ctx.cancellation_token?.aborted) return { status: 'cancelled', mode: 'frontend', applied: 0, totalOps: operations.length,
    entityIds: [id], done: [], undone: operations.map(() => 'cancelled before apply_ops submission'), message: '用户在提交写入前取消；未改动导图，不可自动重试。', retryable: false, plane: 'frontend', delegated: true };
  const ops = operations.map(mindmapOperationToAgentOp), labels = ops.map(op => op.label);
  let applied;
  try { applied = await bridgeCall('apply_ops', { target: { typeId: 'mindmap', resourceId: id, windowId }, ops,
    pacing: 'normal', destructive: ops.some(op => op.destructive) }, workbench.applyOpsTimeoutMs(ops.length, 'normal')); }
  catch (error) {
    log.warn('[BuiltinResourceExecutor] mindmap ACR apply_ops bridge error; no backend fallback: %s', detail(error));
    return workbench.uncertainApplyReceipt([id], labels, detail(error));
  }
  if (!applied.ok) {
    const error = applied.error ?? 'ACR apply_ops returned ok=false';
    log.warn('[BuiltinResourceExecutor] mindmap ACR apply_ops not ok; no backend fallback: %s', error);
    let parsed: unknown;
    try { parsed = JSON.parse(error); } catch { parsed = null; }
    const object = recordOf(parsed);
    if (object !== null && Object.hasOwn(object, 'code')) throw new Error(error);
    return workbench.uncertainApplyReceipt([id], labels, error);
  }
  if (applied.data == null) return workbench.uncertainApplyReceipt([id], labels, 'ACR apply_ops returned no receipt');
  if (!workbench.isValidApplyReceipt(applied.data)) return workbench.uncertainApplyReceipt([id], labels, 'ACR apply_ops returned malformed receipt');
  const receipt = recordOf(structuredClone(applied.data))!;
  const message = valueString(receipt.message) ?? '';
  if (receipt.suggestionPending === true || receipt.mode === 'suggestion') {
    receipt.mode = 'suggestion'; receipt.plane = 'suggestion'; receipt.delegated = true; receipt.success = true;
    if (message === '') receipt.message = '存在未保存编辑，已提交建议（未改文档）；请等待用户空闲或改走后端路径';
  } else {
    if (!Object.hasOwn(receipt, 'mode')) receipt.mode = 'frontend';
    if (message === '') receipt.message = '已在前端导图窗口实时应用并自动保存（debounceSave + OCC）';
    else if (!message.includes('自动保存') && !message.includes('实时')) receipt.message = `${message}（前端实时应用 + 自动保存）`;
    receipt.success = true; receipt.delegated = true; receipt.plane = 'frontend';
  }
  log.info('[BuiltinResourceExecutor] mindmap_edit_nodes delegated to frontend: id=%s, ops=%d', id, operations.length);
  return receipt;
}
export async function editToolMindmap(ctx: ResourceToolContext, toolCallId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const services = ctx.services;
  if (!services.get('vfsDatabase')) throw new Error('VFS database not available');
  const id = valueString(args.mindmap_id);
  if (id === null) throw new Error("Missing 'mindmap_id' parameter");
  const operations = get_json_array_arg(args as JsonValue, 'operations');
  if (operations === null) throw new Error("Missing or invalid 'operations' parameter (expected array)");
  const associations = args.associations == null ? null : Array.isArray(args.associations) ? structuredClone(args.associations) : undefined;
  if (associations === undefined) throw new Error("Invalid 'associations' parameter: expected an array of {source, target, label?} objects");
  if (operations.length === 0 && associations === null) return { success: true, appliedCount: 0, totalOperations: 0 };
  services.logger.info('[BuiltinResourceExecutor] mindmap_edit_nodes: id=%s, ops=%d, associations=%s', id, operations.length, associations?.length ?? null);
  if (associations === null) { const frontend = await tryFrontend(ctx, toolCallId, id, operations); if (frontend !== null) return frontend; }
  const start = performance.now(), repo = toolVfsRepos(services).mindmaps, db = toolVfsDatabase(services).getConnSafe();
  let mindmap;
  try { mindmap = repo.getMindmap(db, id); } catch (error) { throw new Error(`Failed to get mindmap: ${detail(error)}`); }
  if (mindmap === null) throw new Error(`Mindmap not found: ${id}. 请先调用 resource_list(type="mindmap") 确认导图存在。`);
  let content;
  try { content = repo.getMindmapContent(db, id); } catch (error) { throw new Error(`Failed to get mindmap content: ${detail(error)}`); }
  if (content === null) throw new Error(`Mindmap content is empty: ${id}`);
  let doc: unknown;
  try { doc = parseSerdeJson(content); } catch (error) { throw new Error(`Failed to parse mindmap content JSON: ${detail(error)}`); }
  let applied = 0, associationsUpdated = false;
  const errors: string[] = [];
  for (const [index, op] of operations.entries()) {
    const kind = valueString(recordOf(op)?.type) ?? '';
    try { applyMindmapOperation(doc, op); applied++; }
    catch (error) {
      const message = `op[${index}] ${kind} failed: ${detail(error)}`;
      services.logger.warn('[BuiltinResourceExecutor] mindmap_edit_nodes: %s', message); errors.push(message);
    }
  }
  if (associations !== null) {
    const object = recordOf(doc);
    if (object === null) errors.push('associations failed: mindmap document is not an object');
    else { object.associations = associations; sanitizeMindmapAssociations(object, services.logger); associationsUpdated = true; }
  }
  if (applied > 0 || associationsUpdated) {
    let updated;
    try { updated = repo.updateMindmap(db, id, { content: JSON.stringify(doc), expectedUpdatedAt: mindmap.updatedAt, versionSource: 'chat_edit_nodes' }); }
    catch (error) { throw new Error(`Failed to save mindmap after edit: ${detail(error)}`); }
    const node = mindmapToDstuNode(updated);
    emitDstuWatchEvent({ database: toolVfsDatabase(services), log: services.logger, emit: (name, payload) => services.backendEvents.emit(name, payload) }, updatedEvent(node.path, node));
  }
  const durationMs = Math.floor(performance.now() - start);
  services.logger.info('[BuiltinResourceExecutor] mindmap_edit_nodes completed: id=%s, applied=%d/%d in %dms', id, applied, operations.length, durationMs);
  const result: Record<string, unknown> = { success: errors.length === 0, appliedCount: applied, totalOperations: operations.length, associationsUpdated, durationMs,
    mode: 'backend', plane: 'backend', delegated: false, message: '导图未打开/桌面未就绪，已直接写入后端（OCC + 版本快照）', ...(errors.length === 0 ? {} : { errors }) };
  if (applied > 0 || associationsUpdated) {
    let finalContent: string | null;
    try { finalContent = repo.getMindmapContent(db, id); } catch { finalContent = null; }
    if (finalContent !== null) {
      let title: string;
      try { title = repo.getMindmap(db, id)?.title ?? '思维导图'; } catch { title = '思维导图'; }
      try {
        const version = repo.createVersion(db, id, finalContent, title, null, 'chat_edit_nodes');
        result.versionId = version.versionId; result.citation = `[思维导图:${version.versionId}:${title}]`;
        result.hint = '请在回复中使用上方 citation 字段的引用文本，让用户可以点击查看编辑后的导图。';
      } catch (error) { services.logger.warn('[BuiltinResourceExecutor] Failed to create post-edit version for mindmap %s: %s', id, detail(error)); }
    }
  }
  return result;
}
