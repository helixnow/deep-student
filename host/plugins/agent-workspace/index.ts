import * as fs from 'node:fs';
import path from 'node:path';
import { CommandError, definePlugin } from '../../kernel/api.ts';
import { rustTrim } from '../../platform/util/index.ts';
import type { Commands } from '../../../contracts/ipc/generated/L05-agent-workspace.ts';
import type { SettingsStore } from '../../platform/settings/api.ts';
import { registerWorkspaceIndexDeletionOwner, type DatabaseHandle } from '../../platform/storage/api.ts';
import type {} from '../../platform/native/regex/api.ts';
import type {} from '../../platform/native/windows/api.ts';
import {
  canonicalizeExistingDir, listRuntimeDirectoryPage, normalizeRuntimeRelativePath,
  cleanupSessionRuntimeRoots, removeArtifactFile, sessionRoot,
  parseRuntimeDirectoryCursor,
} from './src/runtime-paths.ts';
import {
  artifactRoot, authorizeRuntimeRootPath, displayRelative, loadAuthorizedRecords,
  normalizeRuntimeRootAccessInput, readRuntimeFilePreview, resolveRuntimeTarget,
  isDirectoryPath, processCurrentDir, revalidateRuntimeRoot, runtimeRootById, runtimeRootIdentity, runtimeRootsForSession,
  saveAuthorizedRecords, saveWorkspaceRecord, setSkillTrust, tempRoot, validateWorkspaceAccess,
  workspaceRoot, WORKSPACE_ROOT_KEY, type RuntimeRootDeps,
} from './src/runtime-roots.ts';
import {
  normalizeExpectedSha256, removeArtifactFile as removeArtifactFileBound, restoreArtifactFromBackup,
} from './src/write-backups.ts';
import { parseMutationReceipt, rollback } from './src/workspace-change-set.ts';
import { ApprovalManager } from './src/approval-manager.ts';
import { WorkspaceCoordinator } from './src/workspace/coordinator.ts';
import { CompletionOutbox } from './src/workspace/completion-outbox.ts';
import { createTransformSandboxBackend } from './src/tools/transform-sandbox.ts';
import { WorkspaceFsContribution } from './src/tools/workspace-fs-contribution.ts';
import {
  codeNavigationContribution, fileManagerContribution, lspNavigationContribution, runtimeRootRequestContribution,
  shellPreflightContribution, localShellExecuteContribution, gitContribution, gitShellChannel,
} from './src/tools/lane-tool-contributions.ts';
import type {} from '../agent-skills/api.ts';
import { createAgentWorkspaceToolExecutors, createVfsResolver, deleteWorkspaceIndexWithConn, workspaceCardReadScope } from './api.ts';
import type {} from '../vfs/api.ts';
import type {} from '../vfs-repos/api.ts';
import type {} from '../media/api.ts';
import type {} from '../backup/api.ts';
import type {} from '../chat/api.ts';
import type { VfsService } from '../vfs/api.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import type { DocsService } from '../media/api.ts';
import type { AgentCardReadScopeService, AgentVfsResolver, RuntimeRootsService, WorkspaceChatSessionDeletion } from './api.ts';

const DEFAULT_SESSION = 'session-preview';

function fail(error: unknown): never {
  throw new CommandError(error instanceof Error ? error.message : String(error));
}

function guard<T>(operation: () => T): T {
  try { return operation(); } catch (error) { fail(error); }
}

export default definePlugin({
  meta: {
    id: 'dstu.agent-workspace',
    lane: 'L05-agent-workspace',
    provides: ['agentApproval', 'agentWorkspace', 'agentWorkspaceTools', 'agentVfsResolver', 'agentCompletionOutbox', 'runtimeRoots', 'agentTransformSandbox', 'agentCardReadScope'],
    commands: [
      'chat_v2_authorize_runtime_root', 'chat_v2_delete_artifact', 'chat_v2_list_runtime_directory',
      'chat_v2_list_runtime_roots', 'chat_v2_read_runtime_file', 'chat_v2_reset_workspace_root',
      'chat_v2_resolve_runtime_path', 'chat_v2_revert_artifact_write', 'chat_v2_revert_workspace_change',
      'chat_v2_revoke_runtime_root', 'chat_v2_set_skill_trust', 'chat_v2_set_workspace_root',
    ],
  },
  inject: ['settings', 'storage'],
  apply(ctx) {
    ctx.effect(() => {
      const registration = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn);
      return () => registration.dispose();
    });
    ctx.provide('agentTransformSandbox', createTransformSandboxBackend(
      () => ctx.get('nativeSandbox'),
    ));
    // Resolve dependencies on each call so runtime-root IPC does not depend on
    // media startup order and a reloaded VFS never leaves a stale DB handle.
    const vfsResolver = (): AgentVfsResolver => {
      const vfs = ctx.get('vfs') as VfsService | undefined;
      const vfsRepo = ctx.get('vfsRepo') as VfsReposService | undefined;
      const docs = ctx.get('docs') as DocsService | undefined;
      if (!vfs || !vfsRepo || !docs) throw new Error('VFS resolver requires vfs, vfsRepo and docs services');
      return createVfsResolver(vfs, { vfsRepo, docs }, ctx.logger);
    };
    ctx.provide('agentVfsResolver', {
      resolveVfsRefToBlocks: async (ref, multimodal) => vfsResolver().resolveVfsRefToBlocks(ref, multimodal),
      resolveVfsRefToContent: async (ref, multimodal) => vfsResolver().resolveVfsRefToContent(ref, multimodal),
      resolveContextRefDataToBlocks: async (data, multimodal) => vfsResolver().resolveContextRefDataToBlocks(data, multimodal),
      resolveContextRefDataToContent: async (data, multimodal) => vfsResolver().resolveContextRefDataToContent(data, multimodal),
    } satisfies AgentVfsResolver);
    ctx.provide('agentApproval', new ApprovalManager(ctx.logger));
    // F3 owns chat_v2 V20260908 migration. This provider only performs the Rust
    // outbox operations; L04 owns completion closure and dispatcher scheduling.
    ctx.provide('agentCompletionOutbox', new CompletionOutbox(() => ctx.storage.database('chat_v2')));
    const coordinator = new WorkspaceCoordinator({
      workspacesDir: path.join(ctx.storage.locations.activeDir, 'workspaces'),
      io: {
        open: dbPath => ctx.storage.openFile(dbPath, { profile: 'workspace' }),
        close: db => ctx.storage.close(db as DatabaseHandle),
      },
      chatV2Db: ctx.storage.database('chat_v2'),
      logger: ctx.logger,
      emitter: (event, payload) => { ctx.backendEvents.emit(event, payload); },
      runtimeRootCleanup: sessionId => cleanupSessionRuntimeRoots(ctx.app.dataDir, sessionId),
      operationGuard: () => {
        const governance = ctx.get('governance');
        if (!governance) throw new Error('Workspace deletion requires governance.tryAcquireOperationGuard(delete_propagation)');
        try { return governance.tryAcquireOperationGuard('delete_propagation'); } catch (error) {
          // coordinator.rs:271 maps the provider Display to Err(String), not AppError wire.
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      },
      deleteChatSession: sessionId => {
        const chat = ctx.get('chatSession') as Partial<WorkspaceChatSessionDeletion> | undefined;
        if (typeof chat?.deleteSessionV2 !== 'function') throw new Error('chatSession.deleteSessionV2 is unavailable');
        chat.deleteSessionV2(sessionId);
      },
    });
    ctx.provide('agentWorkspace', coordinator);
    ctx.provide('agentCardReadScope', { lookup: workspaceCardReadScope } satisfies AgentCardReadScopeService);
    ctx.effect(() => () => { coordinator.dispose(); });
    // L04 的工具花名册经此服务实例化本 lane 的 executor；LSP 子进程随插件生命周期释放。
    const toolExecutors = createAgentWorkspaceToolExecutors(coordinator, ctx.logger, () => {
      const regex = ctx.get('nativeRegex');
      if (!regex) throw new Error('Code navigation requires nativeRegex service');
      return regex;
    }, () => ctx.get('nativeWindowsFiles'), () => ctx.get('nativeSandbox'));
    ctx.provide('agentWorkspaceTools', toolExecutors);
    ctx.effect(() => () => { toolExecutors.dispose(); });
    ctx.inject(['agentTools'], scope => {
      scope.effect(() => {
        const shell = toolExecutors.createShell();
        const registration = scope.agentTools.registerToolExecutors([
          localShellExecuteContribution(shell),
          gitContribution(toolExecutors.createGit(gitShellChannel(shell))),
          new WorkspaceFsContribution(toolExecutors.createWorkspaceFs()),
          lspNavigationContribution(toolExecutors.createLsp()),
          codeNavigationContribution(toolExecutors.createCodeNavigation()),
          fileManagerContribution(toolExecutors.createFileManager()),
          shellPreflightContribution(toolExecutors.createShellPreflight()),
          runtimeRootRequestContribution(toolExecutors.createRuntimeRootRequest()),
        ]);
        return () => {
          registration.dispose();
          // RUST-FIX(RF-S01-shell-orphaned-on-unload): unload and Host exit must not leave running shell process groups behind
          return shell.dispose();
        };
      });
    });
    const deps = (): RuntimeRootDeps => ({
      settings: ctx.settings as SettingsStore,
      windowsFiles: ctx.get('nativeWindowsFiles'),
      dataDir: ctx.app.dataDir,
      logger: ctx.logger,
    });
    ctx.provide('runtimeRoots', {
      rootById: (rootId, context) => {
        if (typeof context.session_id !== 'string') throw new Error('Runtime root lookup requires a session_id');
        const skillRoots = context.skill_package_roots == null ? null : new Map(Object.entries(context.skill_package_roots));
        return runtimeRootById(deps(), context.session_id, skillRoots, rootId, false);
      },
      revalidate: root => revalidateRuntimeRoot(deps().settings, root, ctx.get('nativeWindowsFiles')),
      isDirectory: isDirectoryPath,
      currentDir: processCurrentDir,
    } satisfies RuntimeRootsService);
    const roots = (sessionId?: string | null) =>
      runtimeRootsForSession(deps(), (sessionId == null ? '' : rustTrim(sessionId)) || DEFAULT_SESSION, false);

    ctx.commands.register<Commands['chat_v2_delete_artifact']['args'], Commands['chat_v2_delete_artifact']['result']>('chat_v2_delete_artifact', ({ sessionId, relativePath }) => guard(() => {
      const relative = normalizeRuntimeRelativePath(relativePath);
      if (!relative) throw new Error('A relative artifact path is required');
      const root = sessionRoot(ctx.app.dataDir, sessionId, 'artifact', false);
      if (!fs.existsSync(root.path)) throw new Error('No artifacts exist for this session yet');
      removeArtifactFile(root.path, relative);
      return { deleted: true, root_id: root.id, relative_path: displayRelative(relative) };
    }));

    ctx.commands.register<Commands['chat_v2_list_runtime_roots']['args'], Commands['chat_v2_list_runtime_roots']['result']>('chat_v2_list_runtime_roots', ({ sessionId }) => guard(() => roots(sessionId)));

    ctx.commands.register<Commands['chat_v2_set_workspace_root']['args'], Commands['chat_v2_set_workspace_root']['result']>('chat_v2_set_workspace_root', ({ path: rawPath, label, access, sessionId }) => guard(() => {
      const canonical = canonicalizeExistingDir(rawPath, 'workspace runtime root');
      const accessValue = normalizeRuntimeRootAccessInput(access);
      // RUST-FIX(RF-W02-workspace-contains-data-dir): Rust passes no data dir and only refuses critical paths.
      validateWorkspaceAccess(canonical, accessValue, ctx.app.dataDir);
      const trimmed = label == null ? undefined : rustTrim(label);
      const recordLabel = trimmed && trimmed.length > 0 ? trimmed : (path.basename(canonical) || 'Workspace');
      saveWorkspaceRecord(deps().settings, {
        path: canonical, label: recordLabel, access: accessValue, identity: runtimeRootIdentity(canonical, ctx.get('nativeWindowsFiles')),
      });
      return roots(sessionId);
    }));

    ctx.commands.register<Commands['chat_v2_reset_workspace_root']['args'], Commands['chat_v2_reset_workspace_root']['result']>('chat_v2_reset_workspace_root', ({ sessionId }) => guard(() => {
      try { deps().settings.delete(WORKSPACE_ROOT_KEY); } catch (error) {
        throw new Error(`Failed to reset workspace runtime root: ${error instanceof Error ? error.message : String(error)}`);
      }
      return roots(sessionId);
    }));

    ctx.commands.register<Commands['chat_v2_authorize_runtime_root']['args'], Commands['chat_v2_authorize_runtime_root']['result']>('chat_v2_authorize_runtime_root', ({ path: rawPath, label, sessionId }) => guard(() => {
      authorizeRuntimeRootPath(deps().settings, rawPath, label, ctx.get('nativeWindowsFiles'));
      return roots(sessionId);
    }));

    ctx.commands.register<Commands['chat_v2_revoke_runtime_root']['args'], Commands['chat_v2_revoke_runtime_root']['result']>('chat_v2_revoke_runtime_root', ({ rootId, sessionId }) => guard(() => {
      const records = loadAuthorizedRecords(deps().settings);
      const retained = records.filter(record => record.id !== rootId);
      if (retained.length === records.length) throw new Error('Authorized runtime root not found');
      saveAuthorizedRecords(deps().settings, retained);
      return roots(sessionId);
    }));

    ctx.commands.register<Commands['chat_v2_resolve_runtime_path']['args'], Commands['chat_v2_resolve_runtime_path']['result']>('chat_v2_resolve_runtime_path', ({ sessionId, rootId, relativePath }) => guard(() =>
      resolveRuntimeTarget(deps(), sessionId, rootId, relativePath, false)));

    ctx.commands.register<Commands['chat_v2_list_runtime_directory']['args'], Commands['chat_v2_list_runtime_directory']['result']>('chat_v2_list_runtime_directory', ({ sessionId, rootId, relativePath, cursor, limit }) => guard(() => {
      const relative = normalizeRuntimeRelativePath(relativePath);
      const offset = parseRuntimeDirectoryCursor(cursor);
      const root = runtimeRootById(deps(), sessionId, null, rootId ?? 'workspace', false);
      const rootCanon = revalidateRuntimeRoot(deps().settings, root, ctx.get('nativeWindowsFiles'));
      return listRuntimeDirectoryPage(root.id, rootCanon, relative, offset, limit ?? 40);
    }));

    ctx.commands.register<Commands['chat_v2_read_runtime_file']['args'], Commands['chat_v2_read_runtime_file']['result']>('chat_v2_read_runtime_file', ({ sessionId, rootId, relativePath, maxBytes }) => guard(() =>
      readRuntimeFilePreview(deps(), sessionId, rootId, relativePath, maxBytes)));

    ctx.commands.register<Commands['chat_v2_revert_artifact_write']['args'], Commands['chat_v2_revert_artifact_write']['result']>('chat_v2_revert_artifact_write', ({ sessionId, relativePath, backupRef, expectedAfterHash }) => guard(() => {
      const expected = normalizeExpectedSha256(expectedAfterHash);
      const relative = normalizeRuntimeRelativePath(relativePath);
      if (!relative) throw new Error('A relative artifact path is required');
      const root = artifactRoot(ctx.app.dataDir, sessionId, false);
      if (!fs.existsSync(root.path)) throw new Error('No artifacts exist for this session yet');
      const trimmedRef = backupRef == null ? null : rustTrim(backupRef) || null;
      const relativeDisplay = displayRelative(relative);
      if (trimmedRef !== null) {
        const temp = tempRoot(ctx.app.dataDir, sessionId, false);
        const bytesRestored = restoreArtifactFromBackup(root.path, temp.path, relative, trimmedRef, expected, ctx.get('nativeWindowsFiles'));
        return { reverted: true, mode: 'restored', root_id: root.id, relative_path: relativeDisplay, bytes_restored: bytesRestored };
      }
      removeArtifactFileBound(root.path, relative, expected, ctx.get('nativeWindowsFiles'));
      return { reverted: true, mode: 'deleted', root_id: root.id, relative_path: relativeDisplay };
    }));

    ctx.commands.register<Commands['chat_v2_revert_workspace_change']['args'], Commands['chat_v2_revert_workspace_change']['result']>('chat_v2_revert_workspace_change', ({ sessionId, receipt: rawReceipt }) => guard(() => {
      const receipt = parseMutationReceipt(rawReceipt);
      if (receipt.root_id !== 'workspace') throw new Error('Mutation receipt does not belong to the workspace root');
      const root = workspaceRoot(deps().settings, deps().logger, ctx.get('nativeWindowsFiles'), ctx.app.dataDir);
      if (!root.configured) throw new Error('Workspace root is not configured');
      if (root.access !== 'read_write') throw new Error('Workspace root is read-only');
      const rootCanon = revalidateRuntimeRoot(deps().settings, root, ctx.get('nativeWindowsFiles'));
      const temp = tempRoot(ctx.app.dataDir, sessionId, false);
      rollback(rootCanon, temp.path, receipt);
      return { reverted: true, root_id: root.id, change_id: receipt.change_id, receipt };
    }));

    ctx.commands.register<Commands['chat_v2_set_skill_trust']['args'], Commands['chat_v2_set_skill_trust']['result']>('chat_v2_set_skill_trust', ({ skillId, packageRoot, trusted }) => guard(() =>
      setSkillTrust(deps(), skillId, packageRoot, trusted)));
  },
});
