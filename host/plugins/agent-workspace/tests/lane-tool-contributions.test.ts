import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { createAgentWorkspaceToolExecutors } from '../api.ts';
import {
  LaneToolContribution, codeNavigationContribution, fileManagerContribution, lspNavigationContribution,
  runtimeRootRequestContribution, shellPreflightContribution,
} from '../src/tools/lane-tool-contributions.ts';

function l04Context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const settings = { get: () => null };
  return {
    session_id: 'sess_lane', message_id: 'msg_lane', block_id: 'blk_lane', variant_id: null,
    skill_package_roots: { 'skill:demo': '/skills/demo' }, shell_authority_admission: ['craft', 'relaxed'],
    cancellation_token: null, chat_v2_db: null,
    services: { get: (name: string) => (name === 'nativeWindowsFiles' ? 'windows-port' : undefined),
      app: { dataDir: '/data', version: '9.9.9' }, settings, logger: { warn: () => {} } },
    isCancelled: () => false,
    emitToolCallStart: () => {}, emitToolCallEnd: () => {}, emitToolCallError: () => {}, saveToolBlock: () => {},
    ...overrides,
  } as unknown as ExecutionContext;
}

describe('agent-workspace roster contributions', () => {
  it('projects the L04 context and delegates only the optional methods the executor defines', async () => {
    let seen: Record<string, unknown> | undefined;
    const contribution = new LaneToolContribution({
      name: () => 'ProbeExecutor', canHandle: name => name === 'probe', sensitivityLevel: () => 'high',
      concurrencyClass: () => 'read_only',
      execute: async (call, context: Record<string, unknown>) => {
        seen = context;
        return { toolCallId: call.id, toolName: call.name, input: call.arguments, output: null, success: true } as ToolResultInfo;
      },
    }, context => ({ sessionId: context.session_id, roots: context.skill_package_roots }));
    expect(contribution.sensitivityLevel('probe')).toBe('high');
    expect(contribution.concurrencyClass?.('probe')).toBe('read_only');
    expect(contribution.managesCancellation).toBeUndefined();
    await contribution.execute({ id: 'c', name: 'probe', arguments: {} }, l04Context());
    expect(seen).toEqual({ sessionId: 'sess_lane', roots: { 'skill:demo': '/skills/demo' } });
  });

  it('L4: refuses an executor that does not declare its sensitivity instead of defaulting to low', () => {
    const undeclared = { name: () => 'Undeclared', canHandle: () => true, execute: async () => ({}) as ToolResultInfo };
    expect(() => new LaneToolContribution(undeclared as never, context => context))
      .toThrow('Undeclared must declare sensitivityLevel; lane contributions never default to low');
  });

  it('L4: forwards call-level and dynamic sensitivity only when the executor defines them', () => {
    const base = { name: () => 'Dynamic', canHandle: () => true, sensitivityLevel: () => 'high' as const,
      execute: async () => ({}) as ToolResultInfo };
    const dynamic = new LaneToolContribution({ ...base,
      sensitivityLevelForCall: (_name: string, args: unknown) => ((args as { safe?: boolean }).safe ? 'medium' : 'high'),
      hasDynamicSensitivity: () => true }, context => context);
    expect(dynamic.sensitivityLevelForCall?.('tool', { safe: true })).toBe('medium');
    expect(dynamic.sensitivityLevelForCall?.('tool', {})).toBe('high');
    expect(dynamic.hasDynamicSensitivity?.('tool')).toBe(true);
    const fixed = new LaneToolContribution(base, context => context);
    expect(fixed.sensitivityLevelForCall).toBeUndefined();
    expect(fixed.hasDynamicSensitivity).toBeUndefined();
  });

  it('wraps the real lane executors under their Rust roster names with Rust sensitivity', () => {
    const factory = createAgentWorkspaceToolExecutors({} as never);
    try {
      const contributions = [
        lspNavigationContribution(factory.createLsp()), codeNavigationContribution(factory.createCodeNavigation()),
        fileManagerContribution(factory.createFileManager()), shellPreflightContribution(factory.createShellPreflight()),
        runtimeRootRequestContribution(factory.createRuntimeRootRequest()),
      ];
      expect(contributions.map(contribution => contribution.name())).toEqual([
        'LspNavigationExecutor', 'CodeNavigationExecutor', 'FileManagerExecutor', 'LocalShellPreflightExecutor',
        'RuntimeRootRequestExecutor',
      ]);
      expect(contributions[0]!.managesCancellation?.('lsp_definition')).toBe(true);
      expect(contributions[4]!.sensitivityLevel('runtime_root_request')).toBe('high');
      expect(contributions[3]!.sensitivityLevel('local_shell_preflight')).toBe('low');
    } finally {
      factory.dispose();
    }
  });

  it('preflight receives the admitted authority tuple; LSP receives the run signal', async () => {
    const captured: Record<string, unknown>[] = [];
    const capture = (name: string) => ({ name: () => name, canHandle: () => true, sensitivityLevel: () => 'low' as const,
      execute: async (_call: unknown, context: Record<string, unknown>) => { captured.push(context); return {} as ToolResultInfo; } });
    const controller = new AbortController();
    const ctx = l04Context({ cancellation_token: controller.signal });
    await shellPreflightContribution(capture('LocalShellPreflightExecutor') as never).execute({ id: 'a', name: 'x', arguments: {} }, ctx);
    await lspNavigationContribution(capture('LspNavigationExecutor') as never).execute({ id: 'b', name: 'x', arguments: {} }, ctx);
    expect(captured[0]).toMatchObject({ sessionId: 'sess_lane', dataDir: '/data', windowsFiles: 'windows-port',
      blockId: 'blk_lane', authority: ['craft', 'relaxed'], preferredRuntimeRootId: null });
    expect((captured[0]!.skillPackageRoots as Map<string, string>).get('skill:demo')).toBe('/skills/demo');
    expect(captured[1]).toMatchObject({ appVersion: '9.9.9', signal: controller.signal });
  });
});
