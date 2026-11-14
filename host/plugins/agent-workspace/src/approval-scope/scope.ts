/** 审批作用域标识与指纹：移植 approval_scope.rs 的 scope identity 分支。 */
import type { JsonValue } from '../../api.ts';
import { asciiLower, effectiveRuntimeRootId } from '../runtime-path-values.ts';
import { rustTrim, takeChars } from '../../../../platform/util/index.ts';
import {
  asJsonObject, byteLength, type JsonObject, jsonField, jsonPresent, jsonStringField,
  jsonToString, rawHash, rawHashBody, type RuntimeApprovalScope, sortedStrings,
  extractStrField, compareUtf8, cloneJson, ROOT_BINDING_FIELD, ROOT_PATH_FIELD,
  ROOT_ACCESS_FIELD, ROOT_SESSION_SCOPED_FIELD, READABLE_ROOTS_FIELD,
  DEFAULT_AGENT_SKILLS_BASE, buildToolKey, toolSourceNamespace,
} from './core.ts';
import {
  isLocalShellExecuteTool, redactShellCommandForDisplay,
  semanticToolShortName, isShellRuntimeToolForArgs, neverRememberApprovalForArgs,
} from './classification.ts';
import {
  normalizedShellExecutionControls, normalizedShellRuntimeLocation, platformSandboxContract,
  shellEnvApprovalFacts, shellEnvPlanHash, shellSkillRootId,
} from './env.ts';
import { analyzeShellCommand, commandPrefix } from './shell-analysis.ts';

import { extractSortedStringArray, extractGenericScopeIdentity, canonicalScopeValue,
  filteredArgsFingerprint, shellScopeFingerprint } from './fingerprints.ts';

function skillInstallSourceSummary(args: JsonValue): string | null {
  const source = jsonField(args, 'source');
  if (source === undefined) return null;
  const url = jsonStringField(source, 'url');
  if (url !== null) {
    const trimmed = rustTrim(url);
    if (trimmed === '') return null;
    if (byteLength(trimmed) > 80) {
      let taken = '';
      let bytes = 0;
      for (const ch of trimmed) {
        const size = byteLength(ch);
        if (bytes + size > 80) break;
        taken += ch;
        bytes += size;
      }
      return `${taken}…`;
    }
    return trimmed;
  }
  const rootId = extractStrField(source, ['root_id', 'rootId']);
  if (rootId === null) return null;
  const pathValue = extractStrField(source, ['path']);
  if (pathValue === null) return null;
  return `${asciiLower(rootId)}:${pathValue.replaceAll('\\', '/')}`;
}

function makeSkillInstallApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  const install = jsonField(args, 'install');
  const isMarketInstall = short === 'skill_market_download_and_scan'
    && typeof install === 'boolean' && install;
  if (short !== 'skill_install' && !isMarketInstall) return null;
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const expectedSha256 = extractStrField(args, [
    'expected_sha256', 'expectedSha256', 'expected_package_sha256', 'expectedPackageSha256',
  ]);
  if (expectedSha256 === null) return null;
  const declaredRisk = extractStrField(args, ['declared_risk_level', 'declaredRiskLevel'])
    ?? (isMarketInstall ? 'unknown' : 'low');
  const skillId = extractStrField(args, ['skill_id', 'skillId'])
    ?? (isMarketInstall ? extractStrField(args, ['slug']) : null);
  let sourceSummary: string | null;
  if (isMarketInstall) {
    const slug = extractStrField(args, ['slug']);
    if (slug === null) return null;
    const version = extractStrField(args, ['version']) ?? 'latest';
    sourceSummary = `skill_market:${slug}@${version}`;
  } else {
    sourceSummary = skillInstallSourceSummary(args);
  }
  return {
    kind: 'skill_install',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(expectedSha256),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: isMarketInstall,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    ...(sourceSummary !== null ? { sourceSummary } : {}),
    expectedSha256Prefix: takeChars(expectedSha256, 12),
    declaredRiskLevel: declaredRisk,
    ...(skillId !== null ? { skillId } : {}),
  };
}

function makeSkillWorkshopApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  if (short !== 'skill_workshop_apply') return null;
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const proposalId = extractStrField(args, ['proposal_id', 'proposalId']);
  if (proposalId === null) return null;
  const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
  if (contentSha256 === null) return null;
  const proposalRevision = extractStrField(args, ['expected_proposal_revision', 'expectedProposalRevision']);
  if (proposalRevision === null) return null;
  const skillId = extractStrField(args, ['skill_id', 'skillId']);
  if (skillId === null) return null;
  const approvalIdentity = `${proposalId}:${skillId}:${contentSha256}:${proposalRevision}`;
  return {
    kind: 'skill_workshop',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(approvalIdentity),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: false,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    sourceSummary: proposalId,
    expectedSha256Prefix: takeChars(contentSha256, 12),
    skillId,
  };
}

function makeSkillLifecycleApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  if (short !== 'skill_remove' && short !== 'skill_trust_request') return null;
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const skillId = extractStrField(args, ['skill_id', 'skillId']);
  if (skillId === null) return null;

  let approvalIdentity: string;
  let sourceSummary: string | null;
  let shaPrefix: string | null;
  let declaredRisk: string | null;
  if (short === 'skill_trust_request') {
    const expectedSha256 = extractStrField(args, ['expected_package_sha256', 'expectedPackageSha256']);
    if (expectedSha256 === null) return null;
    const risk = extractStrField(args, ['declared_risk_level', 'declaredRiskLevel']) ?? 'low';
    const reason = extractStrField(args, ['reason']);
    sourceSummary = reason === null ? null : takeChars(reason, 120);
    approvalIdentity = `trust:${skillId}:${expectedSha256}:${risk}`;
    shaPrefix = takeChars(expectedSha256, 12);
    declaredRisk = risk;
  } else {
    approvalIdentity = `remove:${skillId}`;
    sourceSummary = `${DEFAULT_AGENT_SKILLS_BASE}/${skillId}`;
    shaPrefix = null;
    declaredRisk = null;
  }

  return {
    kind: 'skill_lifecycle',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(approvalIdentity),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: false,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    ...(sourceSummary !== null ? { sourceSummary } : {}),
    ...(shaPrefix !== null ? { expectedSha256Prefix: shaPrefix } : {}),
    ...(declaredRisk !== null ? { declaredRiskLevel: declaredRisk } : {}),
    skillId,
  };
}

function makeCustomAgentApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  if (short !== 'custom_agent_apply' && short !== 'custom_agent_remove') return null;
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const fileName = extractStrField(args, ['file_name', 'fileName']);
  if (fileName === null) return null;

  let approvalIdentity: string;
  let sourceSummary: string | null;
  let shaPrefix: string | null;
  if (short === 'custom_agent_apply') {
    const proposalId = extractStrField(args, ['proposal_id', 'proposalId']);
    if (proposalId === null) return null;
    const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
    if (contentSha256 === null) return null;
    const proposalRevision = extractStrField(args, ['expected_proposal_revision', 'expectedProposalRevision']);
    if (proposalRevision === null) return null;
    const summary = extractStrField(args, ['change_summary', 'changeSummary']);
    sourceSummary = summary === null
      ? `workspaces/agents/${fileName}`
      : takeChars(summary, 160);
    approvalIdentity = `apply:${proposalId}:${fileName}:${contentSha256}:${proposalRevision}`;
    shaPrefix = takeChars(contentSha256, 12);
  } else {
    const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
    if (contentSha256 === null) return null;
    approvalIdentity = `remove:${fileName}:${contentSha256}`;
    sourceSummary = `workspaces/agents/${fileName}`;
    shaPrefix = takeChars(contentSha256, 12);
  }

  return {
    kind: 'custom_agent',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(approvalIdentity),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: false,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    ...(sourceSummary !== null ? { sourceSummary } : {}),
    ...(shaPrefix !== null ? { expectedSha256Prefix: shaPrefix } : {}),
  };
}

function makeMcpManageApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  let canonical: 'mcp_server_update' | 'mcp_server_remove';
  if (toolName === 'mcp_server_update' || short === 'mcp_server_update') {
    canonical = 'mcp_server_update';
  } else if (toolName === 'mcp_server_remove' || short === 'mcp_server_remove') {
    canonical = 'mcp_server_remove';
  } else {
    return null;
  }
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const serverId = extractStrField(args, ['server_id', 'serverId']);
  if (serverId === null) return null;

  let approvalIdentity: string;
  let sourceSummary: string;
  let revisionPrefix: string | null;
  if (canonical === 'mcp_server_remove') {
    const expectedTransport = extractStrField(args, ['expected_transport', 'expectedTransport']);
    if (expectedTransport === null) return null;
    const expectedRevision = extractStrField(args, ['expected_entry_revision', 'expectedEntryRevision']);
    if (expectedRevision === null) return null;
    approvalIdentity = `remove:${serverId}:${expectedTransport}:${expectedRevision}`;
    sourceSummary = `${serverId} (transport=${expectedTransport})`;
    revisionPrefix = takeChars(expectedRevision, 12);
  } else {
    const encoded = jsonToString(args);
    const object = asJsonObject(args);
    const changedFields = object === null
      ? []
      : Object.keys(object).filter(key => key !== 'server_id' && key !== 'serverId' && key !== 'reason');
    approvalIdentity = `update:${serverId}:${rawHash(encoded)}`;
    sourceSummary = `${serverId}: [${changedFields.join(', ')}]`;
    revisionPrefix = null;
  }

  return {
    kind: 'mcp_manage',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(approvalIdentity),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: false,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    sourceSummary,
    ...(revisionPrefix !== null ? { expectedSha256Prefix: revisionPrefix } : {}),
  };
}

function makeAutomationProposeApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const [, short] = toolSourceNamespace(toolName, null);
  if (short !== 'automation_propose' && toolName !== 'automation_propose') return null;
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const name = extractStrField(args, ['name']);
  if (name === null) return null;
  const schedule = jsonField(args, 'schedule');
  const scheduleSummary = schedule === undefined ? '-' : jsonToString(schedule);
  return {
    kind: 'automation',
    toolSource,
    toolName: shortToolName,
    rootId: '-',
    cwd: '-',
    commandPrefix: '-',
    commandHash: rawHashBody(`${name}|${scheduleSummary}`),
    envPlanHash: '-',
    timeoutMs: 0,
    maxOutputBytes: 0,
    trackFileChanges: false,
    riskLevel,
    networkAllowed: false,
    hasShellOperators: false,
    usesScriptRunner: false,
    firstToken: null,
    skillRootId: null,
    rememberDisabled: true,
    sourceSummary: name,
  };
}

export function makeRuntimeApprovalScope(
  toolName: string,
  args: JsonValue,
  riskLevel: string,
): RuntimeApprovalScope | null {
  const special = makeSkillInstallApprovalScope(toolName, args, riskLevel)
    ?? makeSkillWorkshopApprovalScope(toolName, args, riskLevel)
    ?? makeSkillLifecycleApprovalScope(toolName, args, riskLevel)
    ?? makeCustomAgentApprovalScope(toolName, args, riskLevel)
    ?? makeMcpManageApprovalScope(toolName, args, riskLevel)
    ?? makeAutomationProposeApprovalScope(toolName, args, riskLevel);
  if (special !== null) return special;

  if (!isShellRuntimeToolForArgs(toolName, args)) return null;
  const command = jsonStringField(args, 'command');
  if (command === null) return null;
  const analysis = analyzeShellCommand(command);
  const [displayCommand, containsPotentialSecret] = redactShellCommandForDisplay(command);
  const displayAnalysis = analyzeShellCommand(displayCommand);
  const [toolSource, shortToolName] = toolSourceNamespace(toolName, args);
  const isLocalShell = isLocalShellExecuteTool(toolName, args);
  const isExternalMcp = toolSource.startsWith('mcp');
  const [rootId, cwd]: [string, string] = isLocalShell ? normalizedShellRuntimeLocation(args) : ['-', '-'];
  const allowNetwork = jsonPresent(args, ['allow_network', 'allowNetwork']);
  const networkAllowed = typeof allowNetwork === 'boolean' ? allowNetwork : false;
  const [timeoutMs, maxOutputBytes, trackFileChanges] = normalizedShellExecutionControls(args);
  const rememberDisabled = neverRememberApprovalForArgs(toolName, args) ? true : undefined;
  const sandbox = platformSandboxContract();
  const envFacts = isLocalShell ? shellEnvApprovalFacts(args) : null;

  let sandboxBackend: string;
  let shellKind: string | undefined;
  let outputEncoding: string | undefined;
  let executionLocation: string;
  let sandboxEnforced: boolean;
  if (isLocalShell) {
    sandboxBackend = sandbox.backend;
    shellKind = sandbox.shellKind;
    outputEncoding = sandbox.outputEncoding;
    executionLocation = 'local_device';
    sandboxEnforced = true;
  } else if (isExternalMcp) {
    sandboxBackend = 'external_mcp_uncontrolled';
    shellKind = undefined;
    outputEncoding = undefined;
    executionLocation = 'external_mcp';
    sandboxEnforced = false;
  } else {
    sandboxBackend = 'local_tool_uncontrolled';
    shellKind = undefined;
    outputEncoding = undefined;
    executionLocation = 'local_device';
    sandboxEnforced = false;
  }

  const skillRootId = isLocalShell ? shellSkillRootId(args) : null;
  const rootPath = isLocalShell ? extractStrField(args, [ROOT_PATH_FIELD]) : null;
  const rootAccess = isLocalShell ? extractStrField(args, [ROOT_ACCESS_FIELD]) : null;
  const rootSessionScopedRaw = isLocalShell ? jsonField(args, ROOT_SESSION_SCOPED_FIELD) : undefined;
  const rootSessionScoped = typeof rootSessionScopedRaw === 'boolean' ? rootSessionScopedRaw : null;
  const rootBindingRaw = isLocalShell ? extractStrField(args, [ROOT_BINDING_FIELD]) : null;
  const rootBinding = rootBindingRaw === null ? null : takeChars(rootBindingRaw, 16);
  const readableRootsRaw = isLocalShell ? jsonField(args, READABLE_ROOTS_FIELD) : undefined;
  const readableRoots = Array.isArray(readableRootsRaw)
    ? readableRootsRaw.filter((item): item is string => typeof item === 'string')
    : null;

  return {
    kind: 'shell',
    toolSource,
    toolName: shortToolName,
    rootId,
    cwd,
    commandPrefix: displayAnalysis.commandPrefix,
    commandHash: rawHashBody(analysis.trimmed),
    envPlanHash: envFacts === null ? '-' : envFacts[0],
    ...(envFacts !== null ? { inheritEnv: envFacts[1] } : {}),
    ...(envFacts !== null ? { inheritedEnvKeys: envFacts[2] } : {}),
    ...(envFacts !== null ? { explicitEnvKeys: envFacts[3] } : {}),
    timeoutMs,
    maxOutputBytes,
    trackFileChanges,
    riskLevel,
    networkAllowed,
    hasShellOperators: analysis.hasShellOperators,
    usesScriptRunner: analysis.usesScriptRunner,
    firstToken: analysis.firstToken,
    skillRootId,
    ...(rootPath !== null ? { rootPath } : {}),
    ...(rootAccess !== null ? { rootAccess } : {}),
    ...(rootSessionScoped !== null ? { rootSessionScoped } : {}),
    ...(rootBinding !== null ? { rootBinding } : {}),
    ...(readableRoots !== null ? { readableRoots } : {}),
    ...(containsPotentialSecret ? { containsPotentialSecret: true } : {}),
    sandboxBackend,
    ...(shellKind !== undefined ? { shellKind } : {}),
    ...(outputEncoding !== undefined ? { outputEncoding } : {}),
    executionLocation,
    sandboxEnforced,
    ...(rememberDisabled !== undefined ? { rememberDisabled } : {}),
  };
}

/**
 * 为已知工具类型提取作用域标识。
 *
 * 返回 null 表示 unknown tool 或已知工具缺关键识别字段（fail-closed）。
 */
export function extractScopeIdentity(toolName: string, args: JsonValue): [string, string] | null {
  const short = semanticToolShortName(toolName);
  const toolKey = buildToolKey(toolName, args);

  let fingerprint: string | null;
  switch (short) {
    // --- 笔记 / Canvas ---
    case 'note_set':
    case 'note_replace':
    case 'note_append':
    case 'note_delete':
    case 'note_update':
    case 'note_patch':
    case 'note_create':
    case 'canvas_note_set':
    case 'canvas_note_replace':
    case 'canvas_note_append':
    case 'canvas_note_create':
      fingerprint = extractStrField(args, ['noteId', 'note_id', 'id', 'canvasNoteId']);
      break;

    // --- 思维导图 ---
    case 'mindmap_create':
    case 'mindmap_update':
    case 'mindmap_edit_nodes':
    case 'mindmap_delete_nodes':
    case 'mindmap_delete':
    case 'mindmap_add_nodes':
    case 'mindmap_patch':
      fingerprint = extractStrField(args, ['mindmapId', 'mindmap_id', 'id']);
      break;

    // --- 题库 ---
    case 'qbank_delete_questions':
      fingerprint = extractSortedStringArray(args, 'question_ids');
      break;
    case 'qbank_create':
    case 'qbank_update':
    case 'qbank_delete':
    case 'qbank_patch':
    case 'qbank_import':
    case 'qbank_reset_progress':
    case 'qbank_export':
      fingerprint = extractStrField(args, ['qbankId', 'qbank_id', 'id']);
      break;

    // --- 复习计划 ---
    case 'review_delete':
      fingerprint = extractStrField(args, ['planId', 'plan_id', 'id']);
      break;

    // --- 用户待办 / 周期自动化 ---
    case 'user_todo_delete_list':
      fingerprint = extractStrField(args, ['listId', 'list_id', 'id']);
      break;
    case 'automation_delete':
      fingerprint = extractStrField(args, ['automationId', 'automation_id', 'id']);
      break;

    // Backup and cloud sync are always-confirm system operations.
    case 'backup_create':
    case 'sync_run':
      fingerprint = `args:${rawHash(jsonToString(canonicalScopeValue(args)))}`;
      break;

    // --- 记忆 ---
    case 'memory_write':
    case 'memory_write_smart':
    case 'memory_write_batch':
    case 'memory_update':
    case 'memory_update_by_id':
    case 'memory_delete':
      fingerprint = extractStrField(args, ['memoryId', 'memory_id', 'id'])
        ?? extractStrField(args, ['category', 'categoryName']);
      break;

    // --- 文件 ---
    case 'file_write':
    case 'file_delete':
    case 'file_patch':
    case 'file_append':
    case 'file_create':
      fingerprint = extractStrField(args, ['path', 'file_path', 'filepath']);
      break;

    // --- VFS 资源 ---
    case 'resource_create':
    case 'resource_update':
    case 'resource_delete':
      fingerprint = extractStrField(args, ['resourceId', 'resource_id', 'id']);
      break;
    case 'dstu_purge':
      fingerprint = extractStrField(args, ['path']);
      break;

    // --- Workspace filesystem runtime ---
    case 'workspace_artifact_write': {
      const target = extractStrField(args, ['path', 'file_path', 'filepath']);
      fingerprint = target === null
        ? null
        : `${extractStrField(args, ['root_id', 'rootId']) ?? 'artifacts'}:${target}`;
      break;
    }
    case 'workspace_file_write':
    case 'workspace_file_delete': {
      const target = extractStrField(args, ['path', 'file_path', 'filepath']);
      fingerprint = target === null ? null : `workspace:${target}`;
      break;
    }
    case 'workspace_file_move': {
      const source = extractStrField(args, ['source_path', 'sourcePath']);
      const destination = extractStrField(args, ['destination_path', 'destinationPath']);
      fingerprint = source === null || destination === null
        ? null
        : `workspace:${source}->${destination}`;
      break;
    }
    case 'workspace_change_revert':
      fingerprint = workspaceChangeRevertFingerprint(args);
      break;
    case 'file_manager_commit': {
      const root = extractStrField(args, ['root_id', 'rootId']);
      const preview = extractStrField(args, ['preview_sha256', 'previewSha256']);
      fingerprint = root === null || preview === null ? null : `${root}:${preview}`;
      break;
    }
    case 'file_manager_restore':
      fingerprint = fileManagerRestoreFingerprint(args);
      break;

    // --- 办公文档 ---
    case 'docx_create':
    case 'docx_edit':
    case 'docx_replace_text':
    case 'docx_replace':
    case 'docx_patch':
      fingerprint = extractStrField(args, ['fileId', 'file_id', 'docxId', 'docx_id', 'id', 'path']);
      break;
    case 'xlsx_create':
    case 'xlsx_edit_cells':
    case 'xlsx_replace_text':
    case 'xlsx_replace':
    case 'xlsx_patch':
      fingerprint = extractStrField(args, ['fileId', 'file_id', 'xlsxId', 'xlsx_id', 'id', 'path']);
      break;
    case 'pptx_create':
    case 'pptx_edit':
    case 'pptx_replace_text':
    case 'pptx_replace':
    case 'pptx_patch':
      fingerprint = extractStrField(args, ['fileId', 'file_id', 'pptxId', 'pptx_id', 'id', 'path']);
      break;

    // --- Shell / 命令 ---
    case 'execute_command':
    case 'bash':
    case 'shell':
    case 'shell_execute':
    case 'local_shell_execute':
    case 'local_shell_preflight':
      fingerprint = shellScopeFingerprint(toolName, args);
      break;

    // --- Workbench actions ---
    case 'workbench_act':
    case 'workbench_act_high':
      fingerprint = filteredArgsFingerprint(args, ['observationRevision', 'observation_revision']);
      break;
    case 'workbench_undo': {
      const token = extractStrField(args, ['undoToken', 'undo_token']);
      fingerprint = token === null ? null : `token=${token}`;
      break;
    }
    case 'workbench_open_app':
    case 'workbench_app_command':
    case 'workbench_close_window':
      fingerprint = filteredArgsFingerprint(args, []);
      break;

    case 'skill_install': {
      const sha = extractStrField(args, ['expected_sha256', 'expectedSha256']);
      fingerprint = sha === null ? null : `sha=${sha}`;
      break;
    }
    case 'skill_market_download_and_scan': {
      const installRaw = jsonField(args, 'install');
      const install = typeof installRaw === 'boolean' ? installRaw : false;
      const slug = extractStrField(args, ['slug']);
      const version = extractStrField(args, ['version']) ?? 'latest';
      const sha = extractStrField(args, ['expected_package_sha256', 'expectedPackageSha256']);
      fingerprint = install && slug !== null && sha !== null
        ? `slug=${slug}:version=${version}:sha=${sha}`
        : null;
      break;
    }
    case 'skill_workshop_apply': {
      const proposalId = extractStrField(args, ['proposal_id', 'proposalId']);
      const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
      const revision = extractStrField(args, ['expected_proposal_revision', 'expectedProposalRevision']);
      const skillId = extractStrField(args, ['skill_id', 'skillId']);
      fingerprint = proposalId !== null && skillId !== null && contentSha256 !== null && revision !== null
        ? `proposal=${proposalId}:skill=${skillId}:sha=${contentSha256}:revision=${revision}`
        : null;
      break;
    }

    // --- 技能生命周期 ---
    case 'skill_set_enabled': {
      const skillId = extractStrField(args, ['skill_id', 'skillId']);
      const enabledRaw = jsonField(args, 'enabled');
      const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : null;
      fingerprint = skillId !== null && enabled !== null ? `skill=${skillId}:enabled=${enabled}` : null;
      break;
    }
    case 'skill_remove': {
      const skillId = extractStrField(args, ['skill_id', 'skillId']);
      fingerprint = skillId === null ? null : `skill=${skillId}`;
      break;
    }
    case 'skill_trust_request': {
      const skillId = extractStrField(args, ['skill_id', 'skillId']);
      const packageSha256 = extractStrField(args, ['expected_package_sha256', 'expectedPackageSha256']);
      fingerprint = skillId !== null && packageSha256 !== null
        ? `skill=${skillId}:sha=${packageSha256}`
        : null;
      break;
    }

    // --- MCP server 生命周期 ---
    case 'mcp_server_set_enabled': {
      const serverId = extractStrField(args, ['server_id', 'serverId']);
      const enabledRaw = jsonField(args, 'enabled');
      const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : null;
      fingerprint = serverId !== null && enabled !== null ? `server=${serverId}:enabled=${enabled}` : null;
      break;
    }
    case 'mcp_server_update': {
      const serverId = extractStrField(args, ['server_id', 'serverId']);
      fingerprint = serverId === null ? null : `server=${serverId}:args:${rawHash(jsonToString(args))}`;
      break;
    }
    case 'mcp_server_remove': {
      const serverId = extractStrField(args, ['server_id', 'serverId']);
      const transport = extractStrField(args, ['expected_transport', 'expectedTransport']);
      const revision = extractStrField(args, ['expected_entry_revision', 'expectedEntryRevision']);
      fingerprint = serverId !== null && transport !== null && revision !== null
        ? `server=${serverId}:transport=${transport}:revision=${revision}`
        : null;
      break;
    }

    // --- 自定义子代理 persona ---
    case 'custom_agent_apply': {
      const proposalId = extractStrField(args, ['proposal_id', 'proposalId']);
      const fileName = extractStrField(args, ['file_name', 'fileName']);
      const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
      const revision = extractStrField(args, ['expected_proposal_revision', 'expectedProposalRevision']);
      fingerprint = proposalId !== null && fileName !== null && contentSha256 !== null && revision !== null
        ? `proposal=${proposalId}:file=${fileName}:sha=${contentSha256}:revision=${revision}`
        : null;
      break;
    }
    case 'custom_agent_remove': {
      const fileName = extractStrField(args, ['file_name', 'fileName']);
      const contentSha256 = extractStrField(args, ['expected_content_sha256', 'expectedContentSha256']);
      fingerprint = fileName !== null && contentSha256 !== null
        ? `file=${fileName}:sha=${contentSha256}`
        : null;
      break;
    }

    // --- 未知工具 ---
    default:
      fingerprint = extractGenericScopeIdentity(args);
      break;
  }

  if (fingerprint === null) return null;
  return [toolKey, fingerprint];
}

function workspaceChangeRevertFingerprint(args: JsonValue): string | null {
  const receipt = asJsonObject(jsonField(args, 'receipt') ?? null);
  if (receipt !== null) {
    const changeId = receipt['change_id'];
    const rootId = receipt['root_id'];
    if (typeof changeId === 'string' && typeof rootId === 'string') {
      const serialized = jsonToString(canonicalScopeValue(receipt));
      return `${rootId}:${changeId}:${rawHash(serialized)}`;
    }
  }
  const changeSet = asJsonObject(jsonField(args, 'change_set') ?? null);
  if (changeSet !== null) {
    const changeId = changeSet['id'];
    if (typeof changeId === 'string') {
      const serialized = jsonToString(canonicalScopeValue(changeSet));
      return `workspace:${changeId}:${rawHash(serialized)}`;
    }
  }
  return null;
}

function fileManagerRestoreFingerprint(args: JsonValue): string | null {
  const receipt = asJsonObject(jsonField(args, 'receipt') ?? null);
  if (receipt === null) return null;
  const rootValue = receipt['rootId'] ?? receipt['root_id'];
  if (typeof rootValue !== 'string') return null;
  const receiptValue = receipt['receiptId'] ?? receipt['receipt_id'];
  if (typeof receiptValue !== 'string') return null;
  const serialized = jsonToString(canonicalScopeValue(receipt));
  return `${rootValue}:${receiptValue}:${rawHash(serialized)}`;
}

// ============================================================================
// Shell 解析 / 策略
// ============================================================================
