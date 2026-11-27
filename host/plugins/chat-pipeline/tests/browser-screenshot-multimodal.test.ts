import { describe, expect, it, vi } from 'vitest';
import type { ToolResultInfo } from '../../chat/api.ts';
import { withToolResultBudget } from '../../../kernel/agent-api.ts';
import {
  BROWSER_SCREENSHOT_IMAGE_METADATA_KIND,
  MAX_BROWSER_SCREENSHOT_IMAGE_BYTES,
  buildBrowserScreenshotImageInjection,
  collectBrowserScreenshotCandidate,
  insertOrReplaceBrowserScreenshotMessage,
  isBrowserScreenshotImageMessage,
} from '../src/retrieval-images.ts';
import type { LegacyChatMessage } from '../src/microcompact.ts';
import { ToolRounds, type ToolExecutionPorts } from '../src/tool-round.ts';
import type { ToolRoundState } from '../src/tool-loop.ts';
import { PipelineContext } from '../src/pipeline-context.ts';
import type { ChatV2StreamingAdapter } from '../src/llm-adapter.ts';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const JPEG_BYTES = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);

function screenshotToolResult(
  callId: string,
  overrides: Partial<Record<string, unknown>> = {},
  toolName = 'builtin-browser_screenshot',
): ToolResultInfo {
  return {
    toolCallId: callId,
    toolName,
    input: { annotate: true },
    success: true,
    output: {
      ok: true,
      action: 'screenshot',
      available: true,
      capability: 'cdp_screenshot',
      session_id: 'bs-1',
      url: 'https://example.com/page',
      width: 1280,
      height: 720,
      mime_type: 'image/png',
      annotated: true,
      artifact_path: '/artifacts/browser-screenshots/shot-1.png',
      locator: 'runtime://artifacts/browser-screenshots/shot-1.png',
      object_handle: null,
      ...overrides,
    },
  };
}

describe('browser_screenshot multimodal vision injection', () => {
  it('injects a hidden transient user image wrapped in <untrusted_web_content>', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const message = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_shot_1')],
      {
        imageBudget: 4,
        imagesInRequest: 0,
        readArtifactBytes: async () => PNG_BYTES,
        logger,
      },
    );

    expect(message).not.toBeNull();
    expect(message!.role).toBe('user');
    expect(isBrowserScreenshotImageMessage(message!)).toBe(true);
    expect(message!.content).toContain('<untrusted_web_content source="https://example.com/page" kind="browser_screenshot">');
    expect(message!.content).toContain('</untrusted_web_content>');
    expect(message!.multimodal_content).toHaveLength(2);
    expect(message!.multimodal_content![0]).toEqual({
      type: 'text',
      text: message!.content,
    });
    expect(message!.multimodal_content![1]).toEqual({
      type: 'image_url',
      mediaType: 'image/png',
      base64: Buffer.from(PNG_BYTES).toString('base64'),
    });
    expect(message!.metadata).toMatchObject({
      kind: BROWSER_SCREENSHOT_IMAGE_METADATA_KIND,
      hidden: true,
      canonicalContent: [
        {
          type: 'image_ref',
          image_id: 'browser_screenshot:call_shot_1',
          mime_type: 'image/png',
        },
      ],
    });
  });

  it('supports bare browser_screenshot tool name, enforces imageBudget, byte cap, and valid image bytes', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };

    // Bare name works.
    const bare = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_bare', { url: 'https://bare.example' }, 'browser_screenshot')],
      {
        imageBudget: 2,
        imagesInRequest: 1,
        readArtifactBytes: async () => JPEG_BYTES,
        logger,
      },
    );
    expect(bare).not.toBeNull();
    expect(bare!.multimodal_content![1]).toMatchObject({
      type: 'image_url',
      mediaType: 'image/jpeg',
    });

    // Exhausted imageBudget blocks injection.
    const exhausted = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_budget')],
      {
        imageBudget: 2,
        imagesInRequest: 2,
        readArtifactBytes: async () => PNG_BYTES,
        logger,
      },
    );
    expect(exhausted).toBeNull();

    // Oversized screenshot (> 4 MiB) is skipped with a warning.
    const oversized = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_big')],
      {
        imageBudget: 4,
        imagesInRequest: 0,
        readArtifactBytes: async () => new Uint8Array(MAX_BROWSER_SCREENSHOT_IMAGE_BYTES + 1),
        logger,
      },
    );
    expect(oversized).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('oversized browser screenshot'));

    // Non-image bytes are skipped.
    const invalidBytes = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_txt')],
      {
        imageBudget: 4,
        imagesInRequest: 0,
        readArtifactBytes: async () => new TextEncoder().encode('not-an-image'),
        logger,
      },
    );
    expect(invalidBytes).toBeNull();

    // Unavailable screenshot output is skipped.
    const unavailable = await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_unavail', { available: false, artifact_path: null })],
      {
        imageBudget: 4,
        imagesInRequest: 0,
        readArtifactBytes: async () => PNG_BYTES,
        logger,
      },
    );
    expect(unavailable).toBeNull();
  });

  it('replaces older transient browser screenshot messages so at most 1 stays active', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const shot1 = (await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_1', { url: 'https://example.com/1' })],
      { imageBudget: 4, imagesInRequest: 0, readArtifactBytes: async () => PNG_BYTES, logger },
    ))!;
    const shot2 = (await buildBrowserScreenshotImageInjection(
      [screenshotToolResult('call_2', { url: 'https://example.com/2' })],
      { imageBudget: 4, imagesInRequest: 0, readArtifactBytes: async () => JPEG_BYTES, logger },
    ))!;

    const messages: LegacyChatMessage[] = [
      { role: 'user', content: 'Inspect page' },
      { role: 'tool', content: '{}', tool_result: { call_id: 'call_1', ok: true } },
    ];
    expect(insertOrReplaceBrowserScreenshotMessage(messages, 'call_1', shot1)).toBe(true);
    expect(messages.filter(isBrowserScreenshotImageMessage)).toHaveLength(1);
    expect(messages[2]!.content).toContain('https://example.com/1');

    messages.push({ role: 'tool', content: '{}', tool_result: { call_id: 'call_2', ok: true } });
    expect(insertOrReplaceBrowserScreenshotMessage(messages, 'call_2', shot2)).toBe(true);

    const activeScreenshots = messages.filter(isBrowserScreenshotImageMessage);
    expect(activeScreenshots).toHaveLength(1);
    expect(activeScreenshots[0]!.content).toContain('https://example.com/2');
    expect(messages.at(-1)).toBe(shot2);
  });

  it('ToolRounds injects screenshot only for multimodal models and replaces previous round batch', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let callCounter = 0;

    const makePorts = (): ToolExecutionPorts => ({
      gate: {
        killSwitchError: () => null,
        executionPolicyAllows: () => true,
        trustedAutomationError: () => null,
        trustedAutomationPreauthorized: () => false,
        isLocalShell: () => false,
        isExternalMcp: () => false,
        immutableGuard: () => null,
        shellCommandDecision: () => null,
        resolveLocalShellApprovalArguments: () => ({ ok: true, value: null }),
        runtimeRootBinding: () => null,
        runtimeScopeKey: () => '',
        baseSensitivity: () => 'low',
        effectiveSensitivity: () => 'low',
        authorityState: () => ({ authorityMode: 'craft', permissionPreset: 'full_access', plan: null }) as never,
        consumePlanBinding: () => false,
        newPendingPlan: () => ({}) as never,
        setPlanState: () => {},
        isPrivilegeEscalation: () => false,
        neverRememberApproval: () => false,
        redactForDisplay: (_name, args) => args,
        runtimeApprovalScope: () => ({}),
        approvalManager: null,
        planGates: {} as never,
      },
      concurrencyClass: () => 'read_only',
      execute: async (call) => {
        callCounter += 1;
        return screenshotToolResult(call.id, {
          url: `https://example.com/step-${callCounter}`,
          artifact_path: `/artifacts/step-${callCounter}.png`,
        });
      },
      vfsFileExists: () => null,
      persistTodoList: () => undefined,
      resolveToolAuthoringConfig: async () => null,
      finalizeTaskCompletion: () => undefined,
      onTaskFinalized: () => undefined,
      saveIntermediateResultsWithRetry: async () => false,
      buildRetrievalPageImageInjection: () => null,
      buildBrowserScreenshotImageInjection: (results, budget) => buildBrowserScreenshotImageInjection(results, {
        imageBudget: budget.imageBudget,
        imagesInRequest: budget.imagesInRequest,
        readArtifactBytes: async () => PNG_BYTES,
        logger,
      }),
      resolveActiveApiConfig: async () => null,
      log: logger,
    });

    const adapter = {
      getAccumulatedReasoning: () => null,
      getAccumulatedContent: () => '',
      getTextSegments: () => [],
      finalizeAll: () => undefined,
      getThoughtSignature: () => null,
      getResponseReasoningItems: () => [],
    } as unknown as ChatV2StreamingAdapter;

    const emitter = {
      registerBlockEventMeta: () => undefined,
      emitStartWithMeta: () => undefined,
      emitEndWithMeta: () => undefined,
      emitErrorWithMeta: () => undefined,
    } as unknown as Parameters<ToolRounds['run']>[0]['emitter'];

    const makeState = (): ToolRoundState => ({
      injectedSkillIds: new Set(),
      inLoopSkillBatches: [],
      retrievalPageImageBatches: [],
      browserScreenshotBatch: null,
      retrievalPageImageBudget: null,
      cumulativeSkillAudit: {
        injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [], estimatedTokens: 0, skillStateVersion: 0,
      },
      previousEmptyRequiredTools: new Set(),
    });

    const rounds = new ToolRounds(makePorts());

    // Non-multimodal model: must NOT inject browser screenshot.
    const textCtx = new PipelineContext({
      sessionId: 'sess-text', content: 'check', userContextRefs: null, pathMap: null,
      workspaceId: null, options: null, assistantMessageId: 'asst-1', userMessageId: 'user-1',
    });
    textCtx.executionSnapshot = {
      resolvedModelId: 'text-only',
      resolvedModelIsMultimodal: false,
      generationPlan: { route: 'text', imageBudget: 4 },
    } as unknown as PipelineContext['executionSnapshot'];
    const textState = makeState();
    await rounds.run({
      ctx: textCtx, emitter, adapter,
      toolCalls: [{ id: 'tc_text', name: 'builtin-browser_screenshot', arguments: {} }],
      recursionDepth: 0, frozenToolSchemas: new Map(), mcpToolNameMapping: new Map(),
      state: textState, injectWorkspaceMessages: () => undefined,
    });
    expect(textState.browserScreenshotBatch).toBeNull();

    // Multimodal model: injects screenshot and overwrites batch on subsequent round.
    const mmCtx = new PipelineContext({
      sessionId: 'sess-mm', content: 'check', userContextRefs: null, pathMap: null,
      workspaceId: null, options: null, assistantMessageId: 'asst-2', userMessageId: 'user-2',
    });
    mmCtx.executionSnapshot = {
      resolvedModelId: 'vision-model',
      resolvedModelIsMultimodal: true,
      generationPlan: { route: 'multimodal', imageBudget: 4 },
    } as unknown as PipelineContext['executionSnapshot'];
    const mmState = makeState();

    await rounds.run({
      ctx: mmCtx, emitter, adapter,
      toolCalls: [{ id: 'tc_mm_1', name: 'builtin-browser_screenshot', arguments: {} }],
      recursionDepth: 0, frozenToolSchemas: new Map(), mcpToolNameMapping: new Map(),
      state: mmState, injectWorkspaceMessages: () => undefined,
    });
    expect(mmState.browserScreenshotBatch).not.toBeNull();
    expect(mmState.browserScreenshotBatch![0]).toBe('tc_mm_1');
    expect(mmState.browserScreenshotBatch![1].content).toContain('https://example.com/step-2');

    await rounds.run({
      ctx: mmCtx, emitter, adapter,
      toolCalls: [{ id: 'tc_mm_2', name: 'builtin-browser_screenshot', arguments: {} }],
      recursionDepth: 1, frozenToolSchemas: new Map(), mcpToolNameMapping: new Map(),
      state: mmState, injectWorkspaceMessages: () => undefined,
    });
    expect(mmState.browserScreenshotBatch![0]).toBe('tc_mm_2');
    expect(mmState.browserScreenshotBatch![1].content).toContain('https://example.com/step-3');
  });

  it('collectBrowserScreenshotCandidate recovers preBudgetOutput when result.output is budget-degraded', () => {
    const raw = screenshotToolResult('call_budgeted', {
      url: 'https://example.com/very-long-screenshot-url',
      artifact_path: '/artifacts/browser-screenshots/full-shot.png',
      extra_items: Array.from({ length: 40 }, (_, i) => ({ idx: i, text: 'x'.repeat(60) })),
    });
    const budgeted = withToolResultBudget(raw, 1024);
    expect((budgeted.output as Record<string, unknown>).truncated).toBe(true);
    expect((budgeted.output as Record<string, unknown>).artifact_path).toBeUndefined();

    const candidate = collectBrowserScreenshotCandidate([budgeted]);
    expect(candidate).not.toBeNull();
    expect(candidate!.toolCallId).toBe('call_budgeted');
    expect(candidate!.artifactPath).toBe('/artifacts/browser-screenshots/full-shot.png');
    expect(candidate!.url).toBe('https://example.com/very-long-screenshot-url');
  });
});
