/**
 * 本地 shell 执行环境失败从 Host 到工具卡片的整条链：真实 agent-workspace 执行器（操作系统拒绝启动进程）
 * 发出的 tool_call 错误文本，经前端 eventBridge 与 tool_call 处理器写进真实 ChatStore，
 * 再由 mcp_tool 卡片渲染出界面语言的提示（RF-S01-shell-environment-failure 的前端一环）。
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import i18next, { type i18n as I18n } from 'i18next';
import type { StoreApi } from 'zustand';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import enChatV2 from '@/locales/en-US/chatV2.json';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import { createChatStore } from '@/features/chat/core/store/createChatStore';
import type { ChatStore } from '@/features/chat/core/types';
import {
  clearBridgeState,
  clearEventContext,
  clearProcessedEventIds,
  handleBackendEventWithSequence,
  registerBridgeStoreResolver,
  resetBridgeState,
} from '@/features/chat/core/middleware/eventBridge';
import '@/features/chat/plugins/events/toolCall';
import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';
import { createWorkspaceHost } from '../../../host/plugins/agent-workspace/tests/host-support';
import { tempRoot } from '../../../host/plugins/agent-workspace/src/runtime-roots';
import type { ToolResultInfo } from '../../../host/plugins/agent-workspace/src/tools/shared';
import {
  LocalShellExecuteExecutor,
  type ShellExecuteContext,
  type SpawnProcess,
} from '../../../host/plugins/agent-workspace/src/tools/shell-execute';

const holder = vi.hoisted(() => ({ i18n: null as I18n | null }));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string | string[]) => {
    const i18n = holder.i18n!;
    const t = i18n.getFixedT(null, ns ?? 'chatV2');
    (t as unknown as { i18n: I18n }).i18n = i18n;
    return { t, i18n };
  },
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const ID = 'RF-W09-shell-environment-failure-hint';
const HINT = {
  'zh-CN': '本地命令执行环境故障，命令没有运行，也没有改动任何文件。原样重试通常会同样失败。',
  'en-US': 'The local command environment failed; the command did not run and nothing was changed. Retrying it unchanged usually fails the same way.',
} as const;

/** Node 在子进程的 `error` 事件上报告启动失败，与真实的 EAGAIN 相同。 */
const refusingSpawn: SpawnProcess = spec => {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn ${spec.program} EAGAIN`), { code: 'EAGAIN', errno: -35, syscall: 'spawn' })));
  return child;
};

/** 真实执行器的 tool-call 路径：返回发给前端的错误文本与落库的块结果。 */
async function hostShellFailure(): Promise<{ emitted: string[]; result: ToolResultInfo }> {
  const { host, storage } = await createWorkspaceHost({ native: false });
  try {
    const sessionId = 'environment';
    const cwd = tempRoot(host.app.dataDir, sessionId, true).path;
    const emitted: string[] = [];
    const ctx: ShellExecuteContext = {
      sessionId, dataDir: host.app.dataDir, settings: host.ctx.settings,
      authority: ['craft', 'full_access'], shellAuthorityAdmission: ['craft', 'full_access'],
      shellGuardApproved: true, blockId: 'blk_shell',
      emitToolCallError: message => { emitted.push(message); },
      saveToolBlock: () => undefined,
    };
    const executor = new LocalShellExecuteExecutor(undefined, () => undefined, refusingSpawn);
    const result = await executor.execute({ id: 'call_shell', name: 'builtin-local_shell_execute', arguments: {
      command: 'echo hi', cwd, track_file_changes: false, timeout_ms: 10_000,
    } }, ctx);
    return { emitted, result };
  } finally { storage.dispose(); await host.dispose(); }
}

const SESSION = 'sess_shell_env_failure';
const MSG = 'msg_shell_env_failure';
let store: StoreApi<ChatStore>;
let unregister: () => void;

beforeAll(async () => {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    ns: ['chatV2', 'common'],
    defaultNS: 'chatV2',
    resources: {
      'zh-CN': { chatV2: zhChatV2, common: zhCommon },
      'en-US': { chatV2: enChatV2, common: enCommon },
    },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  holder.i18n = i18n;
});

afterEach(async () => {
  unregister?.();
  clearProcessedEventIds(SESSION);
  clearEventContext(SESSION);
  clearBridgeState(SESSION);
  vi.restoreAllMocks();
  await holder.i18n!.changeLanguage('zh-CN');
});

describe(ID, () => {
  it.skipIf(process.platform === 'win32')(
    `${ID}: a spawn the OS refuses reaches the tool card, through the Host executor and the event bridge, with the hint in both languages`,
    async () => {
      const { emitted, result } = await hostShellFailure();
      expect(emitted).toHaveLength(1);
      const error = emitted[0];
      expect(result).toMatchObject({ success: false, output: null, error });
      // 卡片只认开头的标记：执行器到卡片之间不得再加前缀（tool-pack-executor 原样 emitToolCallError(result.error)）。
      expect(error).toMatch(/^LOCAL_SHELL_ENVIRONMENT_FAILURE \(stage=spawn, code=EAGAIN\): /);

      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      store = createChatStore(SESSION);
      store.setState({ currentStreamingMessageId: MSG } as Partial<ChatStore>);
      resetBridgeState(SESSION);
      unregister = registerBridgeStoreResolver(SESSION, () => store.getState());
      handleBackendEventWithSequence(store.getState(), {
        sequenceId: 0, type: 'tool_call', phase: 'start', messageId: MSG, blockId: 'blk_shell',
        payload: { toolName: 'builtin-local_shell_execute', toolInput: { command: 'echo hi' }, toolCallId: 'call_shell' },
      });
      handleBackendEventWithSequence(store.getState(), {
        sequenceId: 1, type: 'tool_call', phase: 'error', blockId: 'blk_shell', error,
      });

      const block = store.getState().blocks.get('blk_shell');
      expect(block).toMatchObject({ type: 'mcp_tool', status: 'error', error });

      for (const lng of ['zh-CN', 'en-US'] as const) {
        await holder.i18n!.changeLanguage(lng);
        const { container, unmount } = render(<McpToolBlockComponent block={block!} />);
        expect(screen.getByText(HINT[lng])).toBeInTheDocument();
        expect(container.textContent).toContain(error);
        unmount();
      }
    },
  );
});
