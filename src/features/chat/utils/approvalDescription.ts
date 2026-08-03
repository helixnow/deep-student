import type { TFunction } from 'i18next';

type ApprovalArguments = Record<string, unknown>;

function stringArg(
  args: ApprovalArguments,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function shortToolName(toolName: string): string {
  return toolName.replace(/^builtin[-:]/, '');
}

function translated(
  t: TFunction,
  key: string,
  params: Record<string, unknown>,
  fallback: string,
): string {
  return t(`approval.descriptions.${key}`, {
    ...params,
    defaultValue: fallback,
  });
}

/**
 * Resolve approval copy in the renderer, where the active i18next locale is
 * authoritative. Rust intentionally does not receive or guess a global locale.
 * The backend description remains the fallback for old/partial payloads.
 */
export function getLocalizedApprovalDescription(
  toolName: string,
  args: ApprovalArguments,
  fallback: string,
  t: TFunction,
): string {
  const tool = shortToolName(toolName);
  const value = (key: string, params: Record<string, unknown> = {}) =>
    translated(t, key, params, fallback);

  if (
    ['execute_command', 'bash', 'shell', 'shell_execute', 'local_shell_execute', 'local_shell_preflight']
      .includes(tool)
  ) {
    return value('shell', { command: stringArg(args, 'command') ?? '…' });
  }

  switch (tool) {
    case 'note_set':
      return value('noteSet', { noteId: stringArg(args, 'noteId', 'note_id') ?? '?' });
    case 'note_replace':
      return value('noteReplace', { search: stringArg(args, 'search') ?? '…' });
    case 'file_write':
      return value('fileWrite', { path: stringArg(args, 'path') ?? '?' });
    case 'workspace_artifact_write':
      return value('artifactWrite', { path: stringArg(args, 'path') ?? '?' });
    case 'file_manager_commit':
      return value('fileManagerCommit', {
        root: stringArg(args, 'root_id', 'rootId') ?? 'workspace',
        plan: stringArg(args, 'plan_id', 'planId') ?? '?',
      });
    case 'file_manager_restore': {
      const receipt = args.receipt;
      const receiptArgs = receipt && typeof receipt === 'object'
        ? receipt as ApprovalArguments
        : {};
      return value('fileManagerRestore', {
        path: stringArg(receiptArgs, 'originalPath', 'original_path') ?? '?',
      });
    }
    case 'file_delete':
      return value('fileDelete', { path: stringArg(args, 'path') ?? '?' });
    case 'browser_open':
      return value('browserOpen', { url: stringArg(args, 'url') ?? '?' });
    case 'browser_navigate':
      return value('browserNavigate', { url: stringArg(args, 'url') ?? '?' });
    case 'browser_click':
      return value('browserClick', {
        element: stringArg(args, 'element') ?? '?',
        ref: stringArg(args, 'ref') ?? '?',
      });
    case 'browser_file_upload':
      return value('browserFileUpload', {
        count: Array.isArray(args.files) ? args.files.length : 0,
        element: stringArg(args, 'element') ?? '?',
      });
    case 'browser_type':
      return value('browserType', {
        element: stringArg(args, 'element') ?? '?',
        ref: stringArg(args, 'ref') ?? '?',
      });
    case 'browser_snapshot':
    case 'browser_scroll':
    case 'browser_back':
    case 'browser_close':
      return value('browserOperation', { tool: toolName });
    case 'media_transcribe': {
      const source = args.source && typeof args.source === 'object'
        ? args.source as ApprovalArguments
        : args;
      const handle = (
        source.object_handle && typeof source.object_handle === 'object'
          ? source.object_handle
          : source.objectHandle && typeof source.objectHandle === 'object'
            ? source.objectHandle
            : source
      ) as ApprovalArguments;
      return value('mediaTranscribe', {
        file: stringArg(handle, 'displayName', 'display_name', 'relativePath', 'relative_path') ?? '?',
      });
    }
    case 'skill_set_enabled': {
      const enabled = args.enabled === true;
      return value(enabled ? 'skillEnable' : 'skillDisable', {
        skillId: stringArg(args, 'skill_id', 'skillId') ?? '?',
      });
    }
    case 'skill_remove':
      return value('skillRemove', {
        skillId: stringArg(args, 'skill_id', 'skillId') ?? '?',
      });
    case 'skill_trust_request': {
      const reason = stringArg(args, 'reason');
      return value(reason ? 'skillTrustWithReason' : 'skillTrust', {
        skillId: stringArg(args, 'skill_id', 'skillId') ?? '?',
        reason,
      });
    }
    case 'mcp_server_update': {
      const fields = Object.keys(args)
        .filter((key) => !['server_id', 'serverId', 'reason'].includes(key))
        .join(', ');
      return value(fields ? 'mcpUpdateWithFields' : 'mcpUpdate', {
        serverId: stringArg(args, 'server_id', 'serverId') ?? '?',
        fields,
      });
    }
    case 'mcp_server_set_enabled':
      return value(args.enabled === true ? 'mcpEnable' : 'mcpDisable', {
        serverId: stringArg(args, 'server_id', 'serverId') ?? '?',
      });
    case 'mcp_server_remove':
      return value('mcpRemove', {
        serverId: stringArg(args, 'server_id', 'serverId') ?? '?',
        transport: stringArg(args, 'expected_transport', 'expectedTransport') ?? '?',
      });
    case 'custom_agent_propose': {
      const action = stringArg(args, 'action') ?? 'propose';
      if (action === 'list') return value('customAgentList');
      if (action === 'reject') {
        return value('customAgentReject', {
          proposalId: stringArg(args, 'proposal_id', 'proposalId') ?? '?',
        });
      }
      return value('customAgentPropose', {
        fileName: stringArg(args, 'file_name', 'fileName') ?? '?',
      });
    }
    case 'custom_agent_apply': {
      const summary = stringArg(args, 'change_summary', 'changeSummary');
      return value(summary ? 'customAgentApplyWithSummary' : 'customAgentApply', {
        fileName: stringArg(args, 'file_name', 'fileName') ?? '?',
        summary,
      });
    }
    case 'custom_agent_remove': {
      const title = stringArg(args, 'title');
      return value(title ? 'customAgentRemoveWithTitle' : 'customAgentRemove', {
        fileName: stringArg(args, 'file_name', 'fileName') ?? '?',
        title,
      });
    }
    default:
      return value('generic', { tool: toolName });
  }
}
