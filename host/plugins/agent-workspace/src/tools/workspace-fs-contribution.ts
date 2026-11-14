/** W02: L07 contribution -> L04 context -> the existing L05 execution body. */
import { getGroupWithConn, getSessionWithConn } from '../../../chat/api.ts';
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import type { WorkspaceFsExecutor, WorkspaceToolContext } from './workspace-fs.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** runtime_roots.rs `GroupPreferredRuntimeRoot`: at least one field is set. */
export interface GroupPreferredRuntimeRoot { rootId: string | null; projectRootPath: string | null }

/** runtime_roots.rs:1413–1419 `resolve_group_preferred_runtime_root_id`. */
export function preferredRoot(context: ExecutionContext): string | null {
  return resolveGroupPreferredRuntimeRoot(context)?.rootId ?? null;
}

/** runtime_roots.rs:1429–1500; borrow the caller's DB and use only L04 owner reads. */
export function resolveGroupPreferredRuntimeRoot(context: ExecutionContext): GroupPreferredRuntimeRoot | null {
  if (context.chat_v2_db === null) return null;
  let conn: ReturnType<NonNullable<ExecutionContext['chat_v2_db']>['getConnSafe']>;
  try { conn = context.chat_v2_db.getConnSafe(); }
  catch (error) {
    context.services.logger.warn(`[runtime_roots] failed to open chat_v2 db while resolving preferred root for session '${context.session_id}': ${message(error)}`);
    return null;
  }
  let session: ReturnType<typeof getSessionWithConn>;
  try { session = getSessionWithConn(conn, context.session_id); }
  catch (error) {
    context.services.logger.warn(`[runtime_roots] failed to load session '${context.session_id}' for preferred root: ${message(error)}`);
    return null;
  }
  const groupId = session?.groupId == null ? '' : rustTrim(session.groupId);
  if (groupId === '') return null;
  let group: ReturnType<typeof getGroupWithConn>;
  try { group = getGroupWithConn(conn, groupId); }
  catch (error) {
    context.services.logger.warn(`[runtime_roots] failed to load group '${groupId}' for preferred root: ${message(error)}`);
    return null;
  }
  if (group == null) return null;
  const rootId = group.defaultRuntimeRootId == null ? null : rustTrim(group.defaultRuntimeRootId) || null;
  const projectRootPath = group.preferredProjectRootPath == null ? null : rustTrim(group.preferredProjectRootPath) || null;
  return rootId === null && projectRootPath === null ? null : { rootId, projectRootPath };
}

export class WorkspaceFsContribution implements ToolExecutor {
  private readonly executor: WorkspaceFsExecutor;
  constructor(executor: WorkspaceFsExecutor) { this.executor = executor; }

  name(): string { return this.executor.name(); }
  canHandle(name: string): boolean { return this.executor.canHandle(name); }
  sensitivityLevel(name: string) { return this.executor.sensitivityLevel(name); }
  resultCharBudget(name: string): number | null { return this.executor.resultCharBudget(name); }

  execute(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo> {
    const local: WorkspaceToolContext = {
      sessionId: context.session_id,
      blockId: context.block_id,
      settings: context.services.settings,
      dataDir: context.services.app.dataDir,
      skillPackageRoots: context.skill_package_roots === null ? null : new Map(Object.entries(context.skill_package_roots)),
      requireWindow: () => { context.windowRef(); },
      preferredRuntimeRootIdForSession: () => preferredRoot(context),
      emitToolCallStart: (name, args, id) => context.emitToolCallStart(name, args, id),
      emitToolCallEnd: payload => context.emitToolCallEnd(payload),
      emitToolCallError: error => context.emitToolCallError(error),
      saveToolBlock: result => context.saveToolBlock(result),
      warn: warning => context.services.logger.warn(warning),
    };
    return this.executor.execute(call, local);
  }
}
