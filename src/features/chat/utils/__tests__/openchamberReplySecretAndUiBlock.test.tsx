// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ReplyCommandActionButton,
  ReplyCommandLoopController,
  SECRET_ENV_CACHE_TTL_MS,
  SECRET_FILE_MODE,
  SECRET_FILE_TTL_MS,
  SecretRequestCard,
  SecretVaultSessionManager,
  canShowReplyCommandRunButton,
  redactSecretsFromCommandOutput,
  type SecretResolutionResult,
} from '@/features/chat/utils/replyCommandAndSecretLoop';
import {
  MultiCardDecisionCollector,
  buildOnNotDrawnAutoHealResult,
  detectOpenUILangSyntaxErrors,
  ensureAwaitAnswerSubmitButton,
} from '@/features/generative-ui/openui-lang/multiCardDecisionAndHeal';
import {
  isOpenUIComponentNode,
  parseOpenUILang,
  type OpenUIComponentNode,
} from '@/features/generative-ui/openui-lang/parser';
import {
  assertSandboxSafe,
  prepareFaithfulHtmlMaterial,
  ProgressCommandCoalescer,
} from '@/features/learning-hub/utils/faithfulHtmlMaterialAndCoalescer';

describe('wave6 secret continuation and HTML sandbox regressions', () => {
  it('redacts truncated leading secret prefixes with the correct KMP orientation', () => {
    expect(redactSecretsFromCommandOutput('abcde', [{ label: 'TOKEN', value: 'abcdefgh' }], { cutAtStart: true })).toBe('[secret:TOKEN]');
    expect(redactSecretsFromCommandOutput('abc', [{ label: 'TOKEN', value: 'abcdefgh' }], { cutAtStart: true })).toBe('abc');
  });

  it('redacts every continuation and note field, including note metadata', () => {
    const secret = 'private-token';
    const onTriggerContinuation = vi.fn();
    const controller = new ReplyCommandLoopController({
      redactOutput: (text) => redactSecretsFromCommandOutput(text, [{ label: 'TOKEN', value: secret }]),
      onTriggerContinuation,
    });
    const anchor = controller.startRun('reply', `echo ${secret}`);
    expect(JSON.stringify(controller.buildSessionNoteMessage(anchor))).not.toContain(secret);
    const payload = controller.settleRunAndBuildContinuation(anchor.shellMessageId, { exitCode: 0, stdout: secret, stderr: secret, stoppedByUser: false });
    expect(payload?.command).toBe('echo [secret:TOKEN]');
    expect(payload?.stdout).toBe('[secret:TOKEN]');
    expect(payload?.stderr).toBe('[secret:TOKEN]');
    expect(JSON.stringify(onTriggerContinuation.mock.calls)).not.toContain(secret);
  });

  it('marks signal termination as failed without triggering continuation', () => {
    const onTriggerContinuation = vi.fn();
    const controller = new ReplyCommandLoopController({ onTriggerContinuation });
    const run = controller.startRun('reply', 'sleep 100');
    expect(controller.settleRunAndBuildContinuation(run.shellMessageId, { exitCode: null, stdout: '', stderr: '', stoppedByUser: false })).toBeNull();
    expect(controller.getRunState(run.shellMessageId)?.status).toBe('failed');
    expect(onTriggerContinuation).not.toHaveBeenCalled();
  });

  it('drops active foreign namespaces and decodes CSS before resource filtering', () => {
    const result = prepareFaithfulHtmlMaterial(String.raw`<svg><animate attributeName="href"/><foreignObject><p>bad</p></foreignObject></svg><math><mtext>bad</mtext></math><style>@\69mport "https://evil.test/a.css"; .x{background:u\72l(https://evil.test/a)}</style><p style="background:u\72l(https://evil.test/b)">safe</p>`, { allowRemoteResources: false });
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    expect(doc.querySelector('svg,math,animate,foreignobject')).toBeNull();
    expect(doc.querySelector('style')?.textContent).not.toContain('evil.test');
    expect(doc.querySelector('p')?.getAttribute('style')).toContain('url(about:invalid)');
    expect(result.materialBlocks.map((block) => block.text)).toEqual(['safe']);
    expect(() => assertSandboxSafe('allow-scripts allow-same-origin')).toThrow();
    expect(() => assertSandboxSafe('allow-scripts')).not.toThrow();
    expect(() => assertSandboxSafe(result.sandboxAttribute)).not.toThrow();
  });

  it('retains failed progress for retry without replacing a newer pending update', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const c = new ProgressCommandCoalescer({ send });
    const first = c.enqueue({ scopeId: 's', resourceId: 'r', field: 'position', value: 1 });
    await c.flush();
    await c.flush();
    expect(send).toHaveBeenNthCalledWith(2, first);

    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, no) => { reject = no; });
    const send2 = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const other = new ProgressCommandCoalescer({ send: send2 });
    other.enqueue({ scopeId: 's', resourceId: 'r', field: 'position', value: 1 });
    const flushing = other.flush();
    await Promise.resolve();
    const newest = other.enqueue({ scopeId: 's', resourceId: 'r', field: 'position', value: 2 });
    reject(new Error('offline'));
    await flushing;
    await other.flush();
    expect(send2).toHaveBeenLastCalledWith(newest);
    await c.dispose();
    await other.dispose();
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      defaultVal?: string | Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const template = typeof defaultVal === 'string' ? defaultVal : key;
      const vars = (typeof defaultVal === 'object' ? defaultVal : options) ?? {};
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
        vars[k] !== undefined ? String(vars[k]) : '',
      );
    },
  }),
}));

describe('1. ReplyCommandLoopController & canShowReplyCommandRunButton', () => {
  it('guards Run button visibility: only settled, non-peek bash/sh/zsh/shell code blocks pass', () => {
    // 流式中严禁展示运行按钮（防止半截命令被误执行）
    expect(
      canShowReplyCommandRunButton({
        isStreaming: true,
        language: 'bash',
        isPeekSurface: false,
        command: 'npm run test',
      }),
    ).toBe(false);

    // 预览浮窗（peek surface）严禁展示运行按钮
    expect(
      canShowReplyCommandRunButton({
        isStreaming: false,
        language: 'sh',
        isPeekSurface: true,
        command: 'ls -la',
      }),
    ).toBe(false);

    // 非 shell 语言与空白命令不展示
    expect(
      canShowReplyCommandRunButton({
        isStreaming: false,
        language: 'python',
        isPeekSurface: false,
        command: 'print(1)',
      }),
    ).toBe(false);
    expect(
      canShowReplyCommandRunButton({
        isStreaming: false,
        language: 'bash',
        isPeekSurface: false,
        command: '   ',
      }),
    ).toBe(false);

    // 已完整结束 + 主对话面 + bash/sh/zsh/shell 全部通过
    for (const lang of ['bash', 'sh', 'zsh', 'shell', 'BASH', 'language-zsh']) {
      expect(
        canShowReplyCommandRunButton({
          isStreaming: false,
          language: lang,
          isPeekSurface: false,
          command: 'cargo check --lib',
        }),
      ).toBe(true);
    }
  });

  it('mints strictly monotonic IDs, filters duplicate inline shell rows, and enforces single-shot continuation idempotency', () => {
    const fixedTime = 1_762_000_000_000;
    const triggeredPayloads: string[] = [];
    const controller = new ReplyCommandLoopController({
      now: () => fixedTime,
      onTriggerContinuation: (payload) => {
        triggeredPayloads.push(payload.id);
      },
    });

    // 阶段 1：同一毫秒连续启动两次运行，shellMessageId 与 continuationId 严格单调递增
    const anchor1 = controller.startRun('reply-msg-1', 'npx vitest run a.test.ts');
    const anchor2 = controller.startRun('reply-msg-1', 'npx vitest run b.test.ts');

    expect(anchor1.replyMessageId).toBe('reply-msg-1');
    expect(anchor1.continuationId > anchor1.shellMessageId.replace('msg_shell_', 'msg_cont_')).toBe(
      true,
    );
    expect(anchor2.shellMessageId > anchor1.shellMessageId).toBe(true);
    expect(anchor2.continuationId > anchor1.continuationId).toBe(true);

    // 阶段 2：主时间线去重 —— 已被内联输出框认领的 shellMessageId 被剔除，用户手动 shell 行与孤儿行保留
    const timelineRows = [
      { id: 'reply-msg-1', role: 'assistant' },
      { id: anchor1.shellMessageId, role: 'shell' },
      { id: anchor2.shellMessageId, role: 'shell' },
      { id: 'manual-user-shell-99', role: 'shell' },
    ];
    const filtered = controller.filterDuplicateShellTimelineRows(timelineRows);
    expect(filtered.map((r) => r.id)).toEqual(['reply-msg-1', 'manual-user-shell-99']);

    // 若所属 reply 不在当前已加载历史中，保留该 shell 行以防输出孤儿化不可见
    const anchorUnloaded = controller.startRun('reply-old-unloaded', 'uname -a');
    const withOrphan = controller.filterDuplicateShellTimelineRows(
      [
        { id: 'reply-msg-1', role: 'assistant' },
        { id: anchor1.shellMessageId, role: 'shell' },
        { id: anchorUnloaded.shellMessageId, role: 'shell' },
      ],
      { loadedReplyIds: new Set(['reply-msg-1']) },
    );
    expect(withOrphan.map((r) => r.id)).toEqual(['reply-msg-1', anchorUnloaded.shellMessageId]);

    // 阶段 3a：用户手动点击停止（stoppedByUser: true）时绝不自动续跑唤醒 Agent
    const stoppedContinuation = controller.settleRunAndBuildContinuation(anchor1.shellMessageId, {
      exitCode: 130,
      stdout: 'partial output',
      stderr: '',
      stoppedByUser: true,
    });
    expect(stoppedContinuation).toBeNull();
    expect(controller.getRunState(anchor1.shellMessageId)?.status).toBe('stopped');
    expect(triggeredPayloads).toHaveLength(0);

    // 阶段 3b：命令自然结束（stoppedByUser: false），首次结算触发自动续跑；后续重复调用（多端/事件流双监听）严格幂等只触发一次
    const firstSettle = controller.settleRunAndBuildContinuation(anchor2.shellMessageId, {
      exitCode: 0,
      stdout: 'PASS b.test.ts',
      stderr: '',
      stoppedByUser: false,
    });
    const duplicateSettle1 = controller.settleRunAndBuildContinuation(anchor2.shellMessageId, {
      exitCode: 0,
      stdout: 'PASS b.test.ts',
      stderr: '',
      stoppedByUser: false,
    });
    const duplicateSettle2 = controller.settleRunAndBuildContinuation(anchor2.shellMessageId, {
      exitCode: 0,
      stdout: 'PASS b.test.ts',
      stderr: '',
      stoppedByUser: false,
    });

    expect(firstSettle).not.toBeNull();
    expect(firstSettle?.id).toBe(anchor2.continuationId);
    expect(firstSettle?.synthetic).toBe(true);
    expect(duplicateSettle1).toBeNull();
    expect(duplicateSettle2).toBeNull();
    expect(triggeredPayloads).toEqual([anchor2.continuationId]);
  });

  it('renders ReplyCommandActionButton only when runnable and toggles run/stop handlers', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();

    const { rerender } = render(
      <ReplyCommandActionButton
        isStreaming
        language="bash"
        command="npm test"
        onRun={onRun}
        onStop={onStop}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <ReplyCommandActionButton
        isStreaming={false}
        language="bash"
        command="npm test"
        onRun={onRun}
        onStop={onStop}
      />,
    );
    const runBtn = screen.getByRole('button', { name: '运行命令' });
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalledTimes(1);

    rerender(
      <ReplyCommandActionButton
        isStreaming={false}
        language="bash"
        command="npm test"
        isRunning
        onRun={onRun}
        onStop={onStop}
      />,
    );
    const stopBtn = screen.getByRole('button', { name: '停止运行' });
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('2. SecretVaultSessionManager, SecretRequestCard & redactSecretsFromCommandOutput', () => {
  it('renders password-manager-shielded SecretRequestCard, hands off 0o600 24h file path with zero plaintext leak, and collapses to single-line summary', async () => {
    let clock = 1_762_500_000_000;
    const writtenFiles: Array<{ path: string; plaintext: string; mode: number }> = [];
    const vault = new SecretVaultSessionManager({
      now: () => clock,
      tempDir: '/tmp/opencode/test-secrets',
      onWriteControlledFile: (filePath, plaintext, mode) => {
        writtenFiles.push({ path: filePath, plaintext, mode });
      },
    });

    const resolvedPayloads: SecretResolutionResult[] = [];
    const rawSecret = 'sk-live-super-secret-99887766';

    const { container } = render(
      <SecretRequestCard
        sessionId="sess-1"
        callId="call-1"
        label="Cloudflare API Token"
        reason="用于部署边缘 Worker，不会写入项目文件"
        mode="file_path_handoff"
        vaultManager={vault}
        onResolved={(res) => {
          resolvedPayloads.push(res);
        }}
      />,
    );

    const input = screen.getByLabelText('临时密钥输入框') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autoComplete')).toBe('off');
    expect(input.getAttribute('data-1p-ignore')).toBe('true');
    expect(input.getAttribute('data-lpignore')).toBe('true');

    // 支持明文显隐切换，但绝不对外发送
    fireEvent.click(screen.getByRole('button', { name: '显示密钥' }));
    expect(input.getAttribute('type')).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: '隐藏密钥' }));
    expect(input.getAttribute('type')).toBe('password');

    fireEvent.change(input, { target: { value: rawSecret } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByTestId('secret-request-collapsed')).toBeTruthy();
    });

    // 卡片已坍缩为单行只读摘要，输入框消失且 DOM 中绝无密钥明文
    expect(screen.queryByLabelText('临时密钥输入框')).toBeNull();
    expect(container.textContent).not.toContain(rawSecret);
    expect(screen.getByTestId('secret-request-collapsed').textContent).toContain(
      'Cloudflare API Token',
    );

    // 校验工具返回载荷：仅包含受控文件路径、0o600 权限与 +24h 过期时间，绝不含明文
    expect(resolvedPayloads).toHaveLength(1);
    const handoff = resolvedPayloads[0];
    expect(JSON.stringify(handoff)).not.toContain(rawSecret);
    expect(handoff.mode).toBe('file_path_handoff');
    if (handoff.mode === 'file_path_handoff' && handoff.status === 'saved') {
      expect(handoff.fileMode).toBe(SECRET_FILE_MODE);
      expect(handoff.fileMode).toBe(0o600);
      expect(handoff.expiresAt).toBe(clock + SECRET_FILE_TTL_MS);
      expect(handoff.filePath.startsWith('/tmp/opencode/test-secrets/')).toBe(true);

      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0]).toEqual({
        path: handoff.filePath,
        plaintext: rawSecret,
        mode: 0o600,
      });

      // 24h 内文件元数据有效，满 24h 后自动过期清除
      expect(vault.getControlledFileMetadata(handoff.filePath)).not.toBeNull();
      clock += SECRET_FILE_TTL_MS;
      expect(vault.getControlledFileMetadata(handoff.filePath)).toBeNull();
    }
  });

  it('supports env_injection 10-minute memory lease, decline collapse, and redacts secrets (length >= 4) in stdout/stderr', async () => {
    let clock = 1_762_600_000_000;
    const vault = new SecretVaultSessionManager({ now: () => clock });
    const resolved: SecretResolutionResult[] = [];
    const dbSecret = 'pg_pass_987654';

    render(
      <SecretRequestCard
        sessionId="sess-env"
        callId="call-env-1"
        label="Database Password"
        reason="执行只读迁移校验"
        mode="env_injection"
        envName="DB_PASSWORD"
        vaultManager={vault}
        onResolved={(r) => {
          resolved.push(r);
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('临时密钥输入框'), {
      target: { value: dbSecret },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByTestId('secret-request-collapsed').getAttribute('data-secret-status')).toBe(
        'submitted',
      );
    });

    expect(JSON.stringify(resolved[0])).not.toContain(dbSecret);
    expect(vault.getCachedEnvSecret('sess-env', 'DB_PASSWORD')).toBe(dbSecret);

    // 会话级命令输出脱敏
    const rawLogs = `Connecting with ${dbSecret}... Error: auth failed for ${dbSecret}!`;
    expect(vault.redactSessionCommandOutput('sess-env', rawLogs)).toBe(
      'Connecting with [secret:DB_PASSWORD]... Error: auth failed for [secret:DB_PASSWORD]!',
    );

    // 9 分 59 秒仍命中内存租约；满 10 分钟立即自动驱逐
    clock += SECRET_ENV_CACHE_TTL_MS - 1_000;
    expect(vault.getCachedEnvSecret('sess-env', 'DB_PASSWORD')).toBe(dbSecret);
    clock += 1_000;
    expect(vault.getCachedEnvSecret('sess-env', 'DB_PASSWORD')).toBeNull();

    // 验证独立脱敏纯函数：长度 < 4 不替换，重叠/包含关系按最长密钥优先且不二次移位误伤
    const mixedOutput = 'short=abc token=ghp_1234567890 overlap=ghp_1234567890_ext end';
    const redacted = redactSecretsFromCommandOutput(mixedOutput, [
      { label: 'SHORT', value: 'abc' },
      { label: 'GH_BASE', value: 'ghp_1234567890' },
      { label: 'GH_EXT', value: 'ghp_1234567890_ext' },
    ]);
    expect(redacted).toBe('short=abc token=[secret:GH_BASE] overlap=[secret:GH_EXT] end');

    // 验证点击拒绝后同样坍缩为单行只读摘要
    const declinedList: SecretResolutionResult[] = [];
    render(
      <SecretRequestCard
        sessionId="sess-decline"
        callId="call-decline-1"
        label="Stripe Live Key"
        reason="检查账单状态"
        vaultManager={vault}
        onResolved={(r) => {
          declinedList.push(r);
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => {
      expect(declinedList).toHaveLength(1);
    });
    expect(declinedList[0].status).toBe('declined');
  });
});

describe('3. openui-lang MultiCardDecisionCollector, ensureAwaitAnswerSubmitButton & buildOnNotDrawnAutoHealResult', () => {
  it('collects multi-card reply decisions step-by-step, folds answered cards, supports notes/note-only/reopen/early-flush, and auto-synthesizes one payload on completion', () => {
    const dsl = `
      root = Stack([infoCard, dbCard, cacheCard, deployCard])
      infoCard = Card("架构概览", [Text("以下三项架构决策请逐一确认。")])
      dbCard = Card("数据库选型", [
        Text("主存储引擎选择"),
        Row([
          Button("PostgreSQL", "primary", "pg"),
          Button("SQLite", "secondary", "sqlite")
        ])
      ])
      cacheCard = Card("缓存策略", [
        Text("热点会话缓存"),
        Button("Redis", "primary", "redis"),
        Button("In-Memory", "secondary", "memory")
      ])
      deployCard = Card("发布通道", [
        Text("灰度比例控制"),
        Button("Canary 10%", "primary", "canary_10"),
        Button("Full Rollout", "secondary", "full")
      ])
    `;

    const autoSubmitted: unknown[] = [];
    const collector = new MultiCardDecisionCollector(dsl, {
      onAutoSubmit: (payload) => autoSubmitted.push(payload),
    });

    // 仅具名且包含带 value 的决策 Button 的 Card 入列（infoCard 被自动排除）
    const cards = collector.getCards();
    expect(cards.map((c) => c.cardId)).toEqual(['dbCard', 'cacheCard', 'deployCard']);
    expect(collector.getProgress()).toEqual({
      chosenCount: 0,
      totalCount: 3,
      isComplete: false,
    });

    // 第 1 张卡：先添备注再选按钮 -> 立即折叠为单行摘要，但尚未全部完成不触发自动提交
    collector.setCardNote('dbCard', '开启 WAL 模式');
    const step1 = collector.chooseCardOption('dbCard', 'PostgreSQL', 'pg');
    expect(step1.card.collapsed).toBe(true);
    expect(step1.card.summaryLine).toBe('数据库选型: PostgreSQL (开启 WAL 模式)');
    expect(step1.progress).toEqual({ chosenCount: 1, totalCount: 3, isComplete: false });
    expect(step1.autoSubmittedPayload).toBeNull();
    expect(autoSubmitted).toHaveLength(0);

    // 支持提前提交已选部分（flushChosenEarly）
    const earlyPayload = collector.flushChosenEarly();
    expect(earlyPayload).not.toBeNull();
    expect(earlyPayload?.partial).toBe(true);
    expect(earlyPayload?.synthetic).toBe(true);
    expect(earlyPayload?.skipped).toEqual(['cacheCard', 'deployCard']);

    // 支持 reopenCard 重新展开修改（保留原备注）
    const reopened = collector.reopenCard('dbCard');
    expect(reopened.collapsed).toBe(false);
    expect(reopened.chosenValue).toBeNull();
    expect(reopened.note).toBe('开启 WAL 模式');
    expect(collector.getProgress().chosenCount).toBe(0);

    // 重新选择第 1 张卡 + 第 2 张卡使用“仅用备注回答”
    collector.chooseCardOption('dbCard', 'SQLite', 'sqlite');
    const step2 = collector.answerCardWithNoteOnly('cacheCard', '复用进程内 LRU 即可，暂不引入外部组件');
    expect(step2.card.collapsed).toBe(true);
    expect(step2.card.answeredWithNoteOnly).toBe(true);
    expect(step2.progress).toEqual({ chosenCount: 2, totalCount: 3, isComplete: false });

    // 答完最后一张卡（chosenCount === totalCount = 3） -> 自动合成单条结构化回传载荷
    const step3 = collector.chooseCardOption('deployCard', 'Canary 10%', 'canary_10');
    expect(step3.progress).toEqual({ chosenCount: 3, totalCount: 3, isComplete: true });
    expect(autoSubmitted).toHaveLength(1);
    expect(step3.autoSubmittedPayload).toEqual({
      decisions: [
        {
          cardId: 'dbCard',
          title: '数据库选型',
          optionLabel: 'SQLite',
          optionValue: 'sqlite',
          answeredWithNoteOnly: false,
          note: '开启 WAL 模式',
        },
        {
          cardId: 'cacheCard',
          title: '缓存策略',
          optionLabel: null,
          optionValue: null,
          answeredWithNoteOnly: true,
          note: '复用进程内 LRU 即可，暂不引入外部组件',
        },
        {
          cardId: 'deployCard',
          title: '发布通道',
          optionLabel: 'Canary 10%',
          optionValue: 'canary_10',
          answeredWithNoteOnly: false,
        },
      ],
      notes: {
        dbCard: '开启 WAL 模式',
        cacheCard: '复用进程内 LRU 即可，暂不引入外部组件',
      },
      skipped: [],
      partial: false,
      synthetic: true,
      summaryText: expect.stringContaining('- 数据库选型: SQLite'),
    });
  });

  it('injects Button("Send", "primary", "submit") and note slot at root end or into the last Tab when awaitAnswer form omits Button', () => {
    // 场景 A：普通表单漏写 Button -> 补齐到根 Stack 末尾，不污染原 AST
    const plainFormProgram = parseOpenUILang(`
      root = Stack([
        Choice("env", ["staging", "prod"], "目标环境", false),
        Slider("replicas", 1, 8, "副本数", 1, 2)
      ])
    `);
    const originalRoot = plainFormProgram.root!;
    const patchedPlain = ensureAwaitAnswerSubmitButton(originalRoot, { awaitAnswer: true });

    expect(patchedPlain.injectedSubmitButton).toBe(true);
    expect(patchedPlain.injectedTarget).toBe('root');
    expect(patchedPlain.noteSlot).toEqual({
      target: 'root',
      index: 2,
      fieldName: 'note',
    });

    const patchedRootChildren = patchedPlain.root?.args[0] as OpenUIComponentNode[];
    expect(patchedRootChildren).toHaveLength(4);
    expect(patchedRootChildren[2]).toMatchObject({
      kind: 'component',
      name: 'Input',
      args: ['note', '', '', false],
    });
    expect(patchedRootChildren[3]).toMatchObject({
      kind: 'component',
      name: 'Button',
      args: ['Send', 'primary', 'submit'],
    });
    // 原 AST 未被原地修改
    expect((originalRoot.args[0] as unknown[]).length).toBe(2);

    // 场景 B：根容器末尾是 Tabs -> 精准注入到最后一个 Tab 的 children 末尾
    const tabsFormProgram = parseOpenUILang(`
      root = Stack([
        Text("分步配置向导"),
        Tabs([
          Tab("基础信息", [Input("serviceName", "服务名", "my-api")]),
          Tab("上线窗口", [DateInput("releaseAt", "发布时间", true)])
        ])
      ])
    `);
    const patchedTabs = ensureAwaitAnswerSubmitButton(tabsFormProgram.root!, true);
    expect(patchedTabs.injectedSubmitButton).toBe(true);
    expect(patchedTabs.injectedTarget).toBe('last_tab');
    expect(patchedTabs.noteSlot).toEqual({
      target: 'last_tab',
      tabIndex: 1,
      index: 1,
      fieldName: 'note',
    });

    const rootItems = patchedTabs.root?.args[0] as OpenUIComponentNode[];
    expect(rootItems).toHaveLength(2);
    const tabsNode = rootItems[1];
    const tabList = tabsNode.args[0] as OpenUIComponentNode[];
    const firstTabChildren = tabList[0].args[1] as OpenUIComponentNode[];
    const lastTabChildren = tabList[1].args[1] as OpenUIComponentNode[];

    // 第一个 Tab 保持不变，最后一个 Tab 末尾挂载了 note 槽位与主提交 Button
    expect(firstTabChildren).toHaveLength(1);
    expect(lastTabChildren).toHaveLength(3);
    expect(isOpenUIComponentNode(lastTabChildren[1]) && lastTabChildren[1].args[0]).toBe('note');
    expect(lastTabChildren[2]).toMatchObject({
      kind: 'component',
      name: 'Button',
      args: ['Send', 'primary', 'submit'],
    });

    // 场景 C：已有 Button 或纯展示块时不重复补齐 Button
    const pureDisplay = parseOpenUILang(`root = Stack([Stat("QPS", "1,240")])`);
    expect(ensureAwaitAnswerSubmitButton(pureDisplay.root!, true).injectedSubmitButton).toBe(false);
  });

  it('detects broken openui-lang syntax and builds structured onNotDrawn auto-heal result for same-turn repair', () => {
    const brokenProgram = `
      root = Stack([
        Card(title: "配置面板", children: [
          UnknownWidget("oops"),
          Text("未闭合字符串
        ])
    `;

    const detectedErrors = detectOpenUILangSyntaxErrors(brokenProgram);
    expect(detectedErrors.length).toBeGreaterThanOrEqual(2);
    expect(detectedErrors.some((e) => e.includes('Unterminated string'))).toBe(true);

    const namedArgProgram = `root = Stack([Card(title: "错用命名参数", [Text("hi")])])`;
    const namedArgErrors = detectOpenUILangSyntaxErrors(namedArgProgram);
    expect(namedArgErrors.some((e) => e.includes('Named arguments are not supported'))).toBe(true);

    const healResult = buildOnNotDrawnAutoHealResult(brokenProgram, detectedErrors);
    expect(healResult.answered).toBe(false);
    expect(healResult.notDrawn).toBe(true);
    expect(healResult.suppressRawSourceFallback).toBe(true);
    expect(healResult.errors).toEqual(detectedErrors);
    expect(healResult.autoHealPrompt).toContain('could not draw this openui-lang UI block');
    expect(healResult.autoHealPrompt).toContain('root = Stack([...])');
    expect(healResult.autoHealPrompt).toContain('positionally');
  });
});
