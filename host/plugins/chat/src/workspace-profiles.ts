/** Rust workspace_handlers.rs:2639-2696; parsing/validation is owned by L05. */
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { utf8Decode, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { chatLocalFs } from './local-fs.ts';
import { AgentProfileResolver, DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID,
  validatePersonaModelConfig } from '../../agent-workspace/portable.ts';
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import { chatWorkspaceRuntime } from './runtime-roots.ts';
import type { ListAgentProfilesResponse } from '../api.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { requireCoordinator } from './workspace-actions.ts';
import { atomicWrite, resolvePersonaPath, validatePersonaContent, withCustomAgentFileLock } from '../../agent-orchestration/portable.ts';
import type { AgentProfileFileResponse, SaveAgentProfileFileResponse } from '../api.ts';
import type { LLMManager } from '../../llm/api.ts';
import { validUtf8Prefix } from '../../../platform/util/portable.ts';

export function listAgentProfiles(
  coordinator: WorkspaceCoordinator | undefined, log: ChatLogger,
): ListAgentProfilesResponse {
  const agentsDir = requireCoordinator(coordinator).customAgentsDir();
  try { chatLocalFs().mkdirp(agentsDir); }
  catch (error) {
    log.warn(`[Workspace::handlers] Failed to ensure custom agents dir ${agentsDir}: ${ioMessage(error)}`);
  }
  const builtin = [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID].flatMap(id => {
    const profile = AgentProfileResolver.builtIn(id);
    return profile === null ? [] : [{ id: profile.id, description: profile.description,
      model: profile.model, toolCount: profile.allowedTools.length }];
  });
  const seen = new Set<string>();
  const customFiles = chatWorkspaceRuntime().listCustomAgentFiles(agentsDir, log).map(file => {
    const active = file.profile !== null && !seen.has(file.profile.id);
    if (file.profile !== null) seen.add(file.profile.id);
    return { fileName: file.fileName, bytes: file.bytes, modifiedAt: file.modifiedAt,
      ...file.summary, toolCount: file.profile?.allowedTools.length ?? null,
      valid: file.profile !== null, active };
  });
  return { builtin, customFiles, agentsDir };
}

export function readAgentProfileFile(coordinator: WorkspaceCoordinator | undefined, fileName: string): AgentProfileFileResponse {
  const path = resolvePersonaPath(requireCoordinator(coordinator).customAgentsDir(), fileName);
  if (!chatLocalFs().exists(path)) throw new Error('PROFILE_FILE_NOT_FOUND');
  let bytes: Uint8Array;
  try { bytes = chatLocalFs().readBytes(path); }
  catch (error) { throw new Error(`Failed to read profile file '${fileName}': ${ioMessage(error)}`); }
  if (validUtf8Prefix(bytes) !== null) throw new Error(`Failed to read profile file '${fileName}': stream did not contain valid UTF-8`);
  return { fileName, content: utf8Decode(bytes) };
}

export async function deleteAgentProfileFile(coordinator: WorkspaceCoordinator | undefined, fileName: string, log: ChatLogger): Promise<void> {
  const path = resolvePersonaPath(requireCoordinator(coordinator).customAgentsDir(), fileName);
  await withCustomAgentFileLock(() => {
    if (!chatLocalFs().exists(path)) throw new Error('PROFILE_FILE_NOT_FOUND');
    try { chatLocalFs().unlink(path); }
    catch (error) { throw new Error(`Failed to delete profile file '${fileName}': ${ioMessage(error)}`); }
    log.info(`[Workspace::handlers] Deleted custom agent profile '${fileName}' via settings`);
  });
}

/** workspace_handlers.rs:2743-2785; all persona policy and file ownership stays with L05/L06. */
export async function saveAgentProfileFile(coordinator: WorkspaceCoordinator | undefined,
  llm: Pick<LLMManager, 'getApiConfigs'>, fileName: string, content: string,
  overwrite: boolean, log: ChatLogger): Promise<SaveAgentProfileFileResponse> {
  const { name, model } = validatePersonaContent(content);
  const warnings: unknown[] = [];
  if (model !== null) {
    let configs;
    try { configs = await llm.getApiConfigs(); }
    catch (error) {
      warnings.push({ code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE', model_id: model,
        message: `Failed to read the model catalog: ${errorText(error)}. The profile was saved, but runtime will require this exact model configuration and will not fall back.` });
    }
    if (configs !== undefined) validatePersonaModelConfig(model, configs);
  }
  const path = resolvePersonaPath(requireCoordinator(coordinator).customAgentsDir(), fileName);
  return withCustomAgentFileLock(() => {
    if (!overwrite && chatLocalFs().exists(path)) throw new Error('PROFILE_FILE_EXISTS');
    const bytes = utf8Encode(content);
    atomicWrite(path, bytes);
    log.info(`[Workspace::handlers] Saved custom agent profile '${fileName}' (${bytes.length} bytes) via settings`);
    return { fileName, agentName: name, bytes: bytes.length, warnings };
  });
}
