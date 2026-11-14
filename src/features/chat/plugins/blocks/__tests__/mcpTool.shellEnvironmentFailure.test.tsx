/**
 * 工具卡片对本地 shell 执行环境失败（RF-S01-shell-environment-failure）的提示。
 * 用真实 i18next 实例加载 zh-CN / en-US 的 chatV2 词条，两种语言都看到界面语言的提示；
 * 后端原文照旧完整显示。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import i18next, { type i18n as I18n } from 'i18next';
import zhChatV2 from '@/locales/zh-CN/chatV2.json';
import enChatV2 from '@/locales/en-US/chatV2.json';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import type { Block } from '@/features/chat/core/types';

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

import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';

const ID = 'RF-W09-shell-environment-failure-hint';

const ENVIRONMENT_FAILURE = 'LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=spawn, code=EAGAIN): '
  + 'Failed to execute local shell command: spawn /bin/zsh EAGAIN\n'
  + 'This is a failure of the local shell execution environment, not of the command. '
  + 'The command did not run, so there is no exit code or output and nothing was changed.';
const GIT_COMMIT_FAILURE = 'git add succeeded but git commit could not start: '
  + 'LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=sandbox_setup): Failed to write the Seatbelt profile';
const COMMAND_FAILURE = 'Exit code 2';
/** failureErrorForLlm（agent-workspace shell-output.ts）的格式：命令跑了、失败了，stderr 尾部恰好带着这个标记。 */
const COMMAND_FAILURE_ECHOING_MARKER = 'Exit code 1\n'
  + `stderr (tail): FAIL tests/shell.test.ts > reports a refused spawn\nexpected error: ${ENVIRONMENT_FAILURE}`;

const HINT = {
  'zh-CN': '本地命令执行环境故障，命令没有运行，也没有改动任何文件。原样重试通常会同样失败。',
  'en-US': 'The local command environment failed; the command did not run and nothing was changed. Retrying it unchanged usually fails the same way.',
} as const;

function errorBlock(error: string, toolName = 'builtin-local_shell_execute'): Block {
  return {
    id: 'blk-env',
    type: 'mcp_tool',
    status: 'error',
    messageId: 'msg-1',
    toolName,
    toolInput: { command: 'ls' },
    error,
    startedAt: 1,
    endedAt: 2,
  };
}

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
  await holder.i18n!.changeLanguage('zh-CN');
});

describe(ID, () => {
  for (const lng of ['zh-CN', 'en-US'] as const) {
    it(`${ID}: ${lng} shows the hint under a full environment-failure message, which stays verbatim`, async () => {
      await holder.i18n!.changeLanguage(lng);
      const { container } = render(<McpToolBlockComponent block={errorBlock(ENVIRONMENT_FAILURE)} />);

      expect(screen.getByText(HINT[lng])).toBeInTheDocument();
      expect(container.textContent).toContain(ENVIRONMENT_FAILURE);
    });

    it(`${ID}: ${lng} shows the hint when git_commit prefixes the environment failure`, async () => {
      await holder.i18n!.changeLanguage(lng);
      render(<McpToolBlockComponent block={errorBlock(GIT_COMMIT_FAILURE, 'builtin-git_commit')} />);

      expect(screen.getByText(HINT[lng])).toBeInTheDocument();
      expect(screen.getByText(GIT_COMMIT_FAILURE)).toBeInTheDocument();
    });

    it(`${ID}: ${lng} shows no hint for a command's own non-zero exit`, async () => {
      await holder.i18n!.changeLanguage(lng);
      render(<McpToolBlockComponent block={errorBlock(COMMAND_FAILURE)} />);

      expect(screen.getByText(COMMAND_FAILURE)).toBeInTheDocument();
      expect(screen.queryByText(HINT['zh-CN'])).not.toBeInTheDocument();
      expect(screen.queryByText(HINT['en-US'])).not.toBeInTheDocument();
    });

    it(`${ID}: ${lng} shows no hint when a command that did run printed the marker in its output`, async () => {
      await holder.i18n!.changeLanguage(lng);
      const { container } = render(<McpToolBlockComponent block={errorBlock(COMMAND_FAILURE_ECHOING_MARKER)} />);

      expect(container.textContent).toContain('LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=spawn');
      expect(screen.queryByText(HINT['zh-CN'])).not.toBeInTheDocument();
      expect(screen.queryByText(HINT['en-US'])).not.toBeInTheDocument();
    });
  }

  it(`${ID}: without the copy in any language the card falls back to the plain error, showing no key`, async () => {
    const i18n = holder.i18n!;
    const saved = { zh: i18n.getResource('zh-CN', 'chatV2', 'blocks.mcpTool'), en: i18n.getResource('en-US', 'chatV2', 'blocks.mcpTool') };
    const strip = (lng: string, section: Record<string, unknown>) => {
      const { shellEnvironmentFailure: _drop, ...rest } = section;
      i18n.addResourceBundle(lng, 'chatV2', { blocks: { mcpTool: rest } }, false, true);
    };
    try {
      strip('zh-CN', saved.zh);
      strip('en-US', saved.en);
      const { container } = render(<McpToolBlockComponent block={errorBlock(ENVIRONMENT_FAILURE)} />);

      expect(container.textContent).toContain(ENVIRONMENT_FAILURE);
      expect(container.textContent).not.toContain('shellEnvironmentFailure');
      expect(screen.queryByText(HINT['zh-CN'])).not.toBeInTheDocument();
      expect(screen.queryByText(HINT['en-US'])).not.toBeInTheDocument();
    } finally {
      i18n.addResourceBundle('zh-CN', 'chatV2', { blocks: { mcpTool: saved.zh } }, true, true);
      i18n.addResourceBundle('en-US', 'chatV2', { blocks: { mcpTool: saved.en } }, true, true);
    }
  });

  it(`${ID}: a successful shell block shows no hint`, async () => {
    render(<McpToolBlockComponent block={{ ...errorBlock(ENVIRONMENT_FAILURE), status: 'success', error: undefined, toolOutput: { success: true, exit_code: 0, stdout: 'ok', stderr: '' } }} />);

    expect(screen.queryByText(HINT['zh-CN'])).not.toBeInTheDocument();
  });
});
