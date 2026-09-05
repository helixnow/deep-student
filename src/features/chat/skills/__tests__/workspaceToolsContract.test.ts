import { describe, expect, it } from 'vitest';

import { subagentWorkerSkill } from '../builtin-tools/subagent-worker';
import { workspaceToolsSkill } from '../builtin-tools/workspace-tools';

const WORKSPACE_QUERY_TYPES = ['agents', 'messages', 'documents', 'context', 'tasks', 'all'] as const;

const MUTATION_TOOLS = [
  'builtin-workspace_file_write',
  'builtin-workspace_file_move',
  'builtin-workspace_file_delete',
  'builtin-workspace_change_revert',
] as const;

const GIT_TOOLS = [
  'builtin-git_status',
  'builtin-git_diff',
  'builtin-git_log',
  'builtin-git_branch',
  'builtin-git_commit',
] as const;

const CODE_NAVIGATION_TOOLS = [
  'builtin-workspace_text_search',
  'builtin-workspace_symbol_outline',
  'builtin-workspace_lsp_definition',
  'builtin-workspace_lsp_references',
  'builtin-workspace_lsp_hover',
  'builtin-workspace_lsp_document_symbols',
] as const;

describe('workspace mutation tool contracts', () => {
  it('exposes paged UTF-8 workspace_file_read with offset and expected_hash', () => {
    const tool = workspaceToolsSkill.embeddedTools.find((item) => item.name === 'builtin-workspace_file_read');
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: {
        offset?: { type?: string; minimum?: number; default?: number };
        max_bytes?: { type?: string; minimum?: number; maximum?: number };
        expected_hash?: { type?: string };
      };
    };
    expect(schema.required).toEqual(['path']);
    expect(schema.properties?.offset?.minimum).toBe(0);
    expect(schema.properties?.offset?.default).toBe(0);
    expect(schema.properties?.max_bytes?.minimum).toBe(1);
    expect(schema.properties?.max_bytes?.maximum).toBe(1048576);
    expect(schema.properties?.expected_hash?.type).toBe('string');
    expect(tool?.description).toContain('next_offset');
    expect(tool?.description).toContain('sha256');
    expect(workspaceToolsSkill.content).toContain('offset/max_bytes');
  });

  it('exposes every auditable workspace mutation tool to the model', () => {
    const names = workspaceToolsSkill.embeddedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(MUTATION_TOOLS));
  });

  it('requires stale-write guards for move and delete', () => {
    for (const name of ['builtin-workspace_file_move', 'builtin-workspace_file_delete']) {
      const tool = workspaceToolsSkill.embeddedTools.find((item) => item.name === name);
      const required = (tool?.inputSchema as { required?: string[] })?.required ?? [];
      expect(required).toContain('expected_current_hash');
    }
  });

  it('exposes the structured git tool group and requires explicit commit paths', () => {
    const names = workspaceToolsSkill.embeddedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(GIT_TOOLS));

    const commit = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-git_commit',
    );
    const schema = commit?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: { paths?: { minItems?: number }; message?: { maxLength?: number } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['message', 'paths']));
    expect(schema.properties?.paths?.minItems).toBe(1);
    expect(commit?.description).toContain('不会隐式 add -A');
  });

  it('documents branch read/write sensitivity and safe deletion', () => {
    const branch = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-git_branch',
    );
    expect(branch?.description).toContain('action=list');
    expect(branch?.description).toContain('High');
    expect(branch?.description).toContain('-d');
  });

  it('exposes native cross-platform code navigation with bounded schemas', () => {
    const names = workspaceToolsSkill.embeddedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(CODE_NAVIGATION_TOOLS));

    const search = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-workspace_text_search',
    );
    const searchSchema = search?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: { max_results?: { maximum?: number }; query?: { maxLength?: number } };
    };
    expect(searchSchema.additionalProperties).toBe(false);
    expect(searchSchema.required).toEqual(['query']);
    expect(searchSchema.properties?.query?.maxLength).toBe(500);
    expect(searchSchema.properties?.max_results?.maximum).toBe(500);
    expect(search?.description).toContain('不依赖 rg/shell');

    const outline = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-workspace_symbol_outline',
    );
    expect(outline?.description).toContain('不是编译器/LSP');

    const definition = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-workspace_lsp_definition',
    );
    const definitionSchema = definition?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: { line?: { minimum?: number }; column?: { minimum?: number } };
    };
    expect(definitionSchema.additionalProperties).toBe(false);
    expect(definitionSchema.required).toEqual(['path', 'line', 'column']);
    expect(definitionSchema.properties?.line?.minimum).toBe(1);
    expect(definitionSchema.properties?.column?.minimum).toBe(1);
    expect(definition?.description).toContain('rust-analyzer');

    const documentSymbols = workspaceToolsSkill.embeddedTools.find(
      (tool) => tool.name === 'builtin-workspace_lsp_document_symbols',
    );
    expect(documentSymbols?.description).toContain('workspace_symbol_outline');
  });

  it('accepts either a complete mutation receipt or a shell change set for rollback', () => {
    const tool = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-workspace_change_revert',
    );
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: { receipt?: { required?: string[] } };
      oneOf?: Array<{ required?: string[] }>;
    };
    expect(schema.properties?.receipt?.required).toEqual(
      expect.arrayContaining(['change_id', 'root_id', 'op', 'relative_path', 'bytes']),
    );
    expect(schema.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['receipt'] }),
        expect.objectContaining({ required: ['change_set'] }),
      ]),
    );
  });

  it('describes the real non-interactive shell contract on macOS and Windows', () => {
    expect(workspaceToolsSkill.content).toContain('/bin/sh -c');
    expect(workspaceToolsSkill.content).toContain('pwsh.exe -NoProfile -NonInteractive');
    expect(workspaceToolsSkill.content).toContain('Windows PowerShell 5.1');
    expect(workspaceToolsSkill.content).toContain('Git Bash');
    expect(workspaceToolsSkill.content).toContain('UTF-8');
    expect(workspaceToolsSkill.content).toContain('没有 PTY、stdin 或持久 shell session');
    expect(workspaceToolsSkill.content).toContain('网络默认禁止');
  });

  it('uses platform-correct SKILL_DIR syntax and describes conditional Linux support', () => {
    expect(workspaceToolsSkill.content).toContain('$env:SKILL_DIR');
    expect(workspaceToolsSkill.content).toContain('$SKILL_DIR');
    // Linux 桌面通过 bubblewrap 沙箱支持本地 shell（运行时探测，缺失即 fail-closed）
    expect(workspaceToolsSkill.content).toContain('bubblewrap');
    expect(workspaceToolsSkill.content).toContain('其余平台（移动端）当前不支持本地 shell');
    expect(workspaceToolsSkill.content).not.toContain('其他平台当前不支持本地 shell');
  });

  it('routes shell approval through the backend instead of conversational confirmation', () => {
    const preflight = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_preflight',
    );
    const execute = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_execute',
    );
    expect(preflight?.description).toContain('直接提交 local_shell_execute');
    expect(preflight?.description).toContain('不要在正文自行索要确认');
    expect(execute?.description).toContain('后端按会话档位');
    expect(execute?.description).toContain('allow_network=true');
    expect(workspaceToolsSkill.content).toContain('完全访问会同时免除普通 shell 审批');
    expect(workspaceToolsSkill.content).toContain('取消本地 shell 的 runtime root、文件系统和网络沙箱边界');
    expect(workspaceToolsSkill.content).not.toContain('每次真实执行都必须经过用户审批');
  });

  it('exposes subagent_call as a single-task tool with optional workspace/profile/wait', () => {
    const subagent = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-subagent_call',
    );
    const schema = subagent?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<
        string,
        { type?: string; enum?: string[]; default?: unknown; maxLength?: number; description?: string }
      >;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['task']);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'task',
      'workspace_id',
      'profile',
      'resume_agent_session_id',
      'skill_id',
      'model',
      'context',
      'wait',
    ]);
    expect(schema.properties?.task?.maxLength).toBe(20000);
    // C6: profile 不再是 enum，而是自由字符串（内建三型 + 自定义 profile name）
    expect(schema.properties?.profile?.type).toBe('string');
    expect(schema.properties?.profile?.enum).toBeUndefined();
    expect(schema.properties?.profile?.description).toContain('自定义');
    // C7: 续跑参数与 resumed 返回键
    expect(schema.properties?.resume_agent_session_id?.type).toBe('string');
    expect(schema.properties?.resume_agent_session_id?.description).toContain('resumed');
    expect(schema.properties?.wait?.default).toBe(true);
    expect(subagent?.description).toContain('默认 wait=true');
    expect(subagent?.description).toContain('auto_created_workspace');
    // C8: 描述提及 token 归集
    expect(subagent?.description).toContain('token_usage');
  });

  it('replaces the mandatory-sleep guidance with the delegation decision tree', () => {
    expect(workspaceToolsSkill.content).not.toContain('必须立即调用 builtin-coordinator_sleep');
    expect(workspaceToolsSkill.content).toContain('子代理委托决策树');
    expect(workspaceToolsSkill.content).toContain('wait: false');
    const sleep = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-coordinator_sleep',
    );
    expect(sleep?.description).toContain('wait=false');
    expect(sleep?.description).not.toContain('【必需】');
  });

  it('keeps fan-out sleep and background auto-wake guidance distinct in the decision tree', () => {
    const content = workspaceToolsSkill.content;

    // 第 2 条：并行 fan-out 本回合汇总 → coordinator_sleep
    expect(content).toMatch(/并行 fan-out 且本回合要汇总结果/);
    expect(content).toMatch(/2\.\s+\*\*并行 fan-out 且本回合要汇总结果\*\*[\s\S]*?coordinator_sleep/);

    // 第 3 条：后台异步 → 不要 sleep + 自动唤醒
    expect(content).toMatch(/后台异步（自己还有活/);
    expect(content).toMatch(/3\.\s+\*\*后台异步[\s\S]*?不要[\s\S]*?coordinator_sleep/);
    expect(content).toContain('内部唤醒回合');
    expect(content).toContain('聊天界面不出现伪用户消息');
    expect(content).toContain('[子代理完成通知]');

    // 「等待子代理」小节：不要 sleep 明确限定在第 3 条
    expect(content).toMatch(/后台异步（决策树第 3 条）[\s\S]*?不要 sleep/);
    expect(content).toMatch(/coordinator_sleep\*\*（决策树第 2 条）/);
  });

  it('documents background dispatch with tasks polling and auto-wake', () => {
    // 后台异步派发：查询任务状态 + 空闲自动唤醒（每完成一个唤一次）
    expect(workspaceToolsSkill.content).toContain('后台异步');
    expect(workspaceToolsSkill.content).toContain('query_type="tasks"');
    expect(workspaceToolsSkill.content).toContain('内部唤醒回合');
    expect(workspaceToolsSkill.content).toContain('[子代理完成通知]');

    const query = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-workspace_query',
    );
    const schema = query?.inputSchema as {
      properties?: { query_type?: { enum?: string[] } };
    };
    expect(schema.properties?.query_type?.enum).toEqual([...WORKSPACE_QUERY_TYPES]);

    const subagent = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-subagent_call',
    );
    const subagentSchema = subagent?.inputSchema as {
      properties?: { wait?: { description?: string } };
    };
    expect(subagentSchema.properties?.wait?.description).toContain('自动唤醒');
  });

  it('aligns subagent-worker workspace_query query_type with workspace-tools', () => {
    const query = subagentWorkerSkill.embeddedTools.find(
      (item) => item.name === 'builtin-workspace_query',
    );
    const schema = query?.inputSchema as {
      properties?: { query_type?: { enum?: string[]; description?: string } };
    };
    expect(schema.properties?.query_type?.enum).toEqual([...WORKSPACE_QUERY_TYPES]);
    expect(schema.properties?.query_type?.description).toContain('tasks');
  });

  it('defaults parent environment inheritance to deny', () => {
    const execute = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_execute',
    );
    const schema = execute?.inputSchema as {
      properties?: { inherit_env?: { default?: boolean; description?: string } };
    };
    expect(schema.properties?.inherit_env?.default).toBe(false);
    expect(schema.properties?.inherit_env?.description).toContain('sanitized allowlist');
  });
});
