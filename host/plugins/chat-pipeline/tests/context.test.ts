import { describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import { CitationLedger } from '../src/citations.ts';
import {
  buildInjectedContextBlocks, buildRuntimeFactsBlock, buildUserContentFromContextRefs,
  collectInjectedContextTextAndImages, combinedUserContent, convertToContextRefs,
  wrapUserMessageText,
} from '../src/context.ts';
import type { SendContextRef } from '../../../../contracts/ipc/generated/_shared.ts';
import type { JsonValue } from '../api.ts';
import { localShellContractForPlatform } from '../src/local-shell-contract.ts';

describe('context.rs::citation_tests', () => {
  it('ledger_reuses_index_for_same_identity_across_calls', () => {
    const ledger = new CitationLedger();
    expect(ledger.assign('rag', 'res:doc_a|c:0')).toEqual({ type_index: 1, is_new: true });
    expect(ledger.assign('rag', 'res:doc_b|c:1')).toEqual({ type_index: 2, is_new: true });
    expect(ledger.assign('rag', 'res:doc_a|c:0')).toEqual({ type_index: 1, is_new: false });
    expect(ledger.assign('rag', 'res:doc_c|c:0')).toEqual({ type_index: 3, is_new: true });
  });
  it('ledger_counts_groups_independently', () => {
    const ledger = new CitationLedger();
    expect(ledger.assign('rag', 'res:a').type_index).toBe(1);
    expect(ledger.assign('multimodal', 'res:a|p:0').type_index).toBe(1);
    expect(ledger.assign('memory', 'note:x').type_index).toBe(1);
    expect(ledger.assign('rag', 'res:b').type_index).toBe(2);
  });
  it('ledger_registry_is_stable_per_reply_and_isolated_per_variant', async () => {
    const host = await createPipelineHost();
    try {
      const service = host.ctx['chatPipeline'];
      const execution = service.createPipelineContext({ sessionId: 'sess_ct', content: 'Hello' });
      expect(execution.sessionId).toBe('sess_ct');
      expect(execution.runtimeFacts).toContain('<runtime_facts>');
      service.citationLedgerForReply('sess_ct', 'msg_ct_1').assign('rag', 'res:shared');
      expect(service.citationLedgerForReply('sess_ct', 'msg_ct_1').assign('rag', 'res:shared'))
        .toEqual({ type_index: 1, is_new: false });
      expect(service.citationLedgerForReply('sess_ct', 'msg_ct_1', 'var_1').assign('rag', 'res:shared').is_new).toBe(true);
    } finally { await host.dispose(); }
  });
  it('sanitize_strips_local_paths_and_diagnostics_but_keeps_web_urls', async () => {
    const host = await createPipelineHost();
    try {
      const output = {
        success: true, retrievalPlan: { routes: [] }, capabilitySnapshot: { profiles: [] },
        sources: <JsonValue[]>[
          { citationTag: '[图片-1]', url: 'asset://localhost/blobs/abc.png', imageUrl: 'asset://localhost/blobs/abc.png',
            imageCitation: '![Page 1](asset://localhost/blobs/abc.png)', blob_hash: 'deadbeef',
            retrievalProvenance: [{ routeId: 'mm' }], snippet: 'page text', readResourceId: 'res_1' },
          { citationTag: '[搜索-1]', url: 'https://example.com/article', snippet: 'web text' },
        ],
      };
      expect(host.ctx['chatPipeline'].sanitizeRetrievalOutputForLlm('builtin-unified_search', output)).toEqual({
        success: true, sources: [
          { citationTag: '[图片-1]', snippet: 'page text', readResourceId: 'res_1' },
          { citationTag: '[搜索-1]', url: 'https://example.com/article', snippet: 'web text' },
        ],
      });
      expect(output.sources[0]).toHaveProperty('imageUrl');
    } finally { await host.dispose(); }
  });
  it('sanitize_skips_non_retrieval_tools', async () => {
    const host = await createPipelineHost();
    try {
      const output = { sources: [{ imageUrl: 'asset://x' }] };
      expect(host.ctx['chatPipeline'].sanitizeRetrievalOutputForLlm('builtin-note_read', output)).toBeNull();
      expect(host.ctx['chatPipeline'].sanitizeRetrievalOutputForLlm('mcp_custom_tool', output)).toBeNull();
    } finally { await host.dispose(); }
  });
  it('test_runtime_facts_platform_contract_covers_desktop_platforms', async () => {
    const host = await createPipelineHost();
    try {
      const contract = host.ctx['chatPipeline'].localShellContractForPlatform;
      expect(contract('macos')).toMatchObject({ invocation: '/bin/sh -c', shell_kind: 'posix_sh' });
      expect(contract('windows')).toMatchObject({
        invocation: 'pwsh.exe -NoProfile -NonInteractive -EncodedCommand; fallback powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand',
        shell_kind: 'windows_powershell', output_encoding: 'utf-8',
      });
      expect(contract('linux')).toMatchObject({ invocation: '/bin/sh -c', sandbox_backend: 'linux_bwrap',
        shell_kind: 'posix_sh', output_encoding: 'utf-8', execution_supported: true });
      expect(contract('android')).toMatchObject({ sandbox_backend: 'unavailable', execution_supported: false });
    } finally { await host.dispose(); }
  });
});

it('estimate_message_tokens_includes_tool_payload: production uses nativeTokenizer', async () => {
  const host = await createPipelineHost();
  try {
    const text = 'hello '.repeat(100);
    const message = { id: 'msg_tokens', sessionId: 's', role: 'assistant' as const,
      blockIds: ['b'], timestamp: 0 };
    const blocks = new Map([['msg_tokens', [{ id: 'b', messageId: 'msg_tokens',
      type: 'content', status: 'success', blockIndex: 0, content: text }]]]);
    expect(host.ctx.chatPipeline.estimateMessageTokens(message, blocks, 'gpt-4o'))
      .toBe(host.ctx.nativeTokenizer.estimateTokensWithModel(`${text}\n`, 'gpt-4o'));
  } finally { await host.dispose(); }
});

describe('context.rs::turn_volatile_tests', () => {
  const FIXED_FACTS = '<runtime_facts>\n当前日期: 2026-08-23\n</runtime_facts>';

  function buildUserText(volatile?: string | null): string {
    const blocks = buildInjectedContextBlocks(FIXED_FACTS, [], volatile);
    const { text, images } = collectInjectedContextTextAndImages(blocks);
    expect(images).toEqual([]);
    return wrapUserMessageText('同一个问题', text);
  }

  it('injected_context_carries_turn_volatile_blocks', () => {
    const volatile = '<active_todos>\n以下是用户当前的待办事项：\n1. 复习\n</active_todos>';
    const combined = buildUserText(volatile);

    // user_query comes first and carries no volatile content.
    const queryEnd = combined.indexOf('</user_query>');
    expect(queryEnd).toBeGreaterThanOrEqual(0);
    expect(combined.slice(0, queryEnd)).not.toContain('active_todos');

    // Volatile blocks live inside <injected_context>.
    const injectedStart = combined.indexOf('<injected_context>');
    const injectedEnd = combined.indexOf('</injected_context>');
    expect(injectedStart).toBeGreaterThanOrEqual(0);
    expect(injectedEnd).toBeGreaterThan(injectedStart);
    const injected = combined.slice(injectedStart, injectedEnd);
    expect(injected).toContain('<runtime_facts>');
    expect(injected).toContain(volatile);
  });

  it('cross_turn_changes_stay_inside_injected_context', () => {
    const round1 = buildUserText('<context>\n[知识库-1] 第一轮命中\n</context>');
    const round2 = buildUserText('<context>\n[知识库-1] 第二轮命中\n</context>');

    const prefix1 = round1.slice(0, round1.indexOf('<injected_context>'));
    const prefix2 = round2.slice(0, round2.indexOf('<injected_context>'));
    expect(prefix1).toBe(prefix2);
    expect(round1).toContain('第一轮命中');
    expect(round1).not.toContain('第二轮命中');
    expect(round2).toContain('第二轮命中');
    expect(round2).not.toContain('第一轮命中');
  });

  it('runtime_facts_with_date_live_inside_injected_context', () => {
    const facts = buildRuntimeFactsBlock('讲讲牛顿第二定律');
    expect(facts.startsWith('<runtime_facts>')).toBe(true);
    expect(facts).toContain('当前日期: ');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      + `-${String(now.getDate()).padStart(2, '0')}`;
    expect(facts).toContain(today);

    const blocks = buildInjectedContextBlocks(facts, [], null);
    const { text, images } = collectInjectedContextTextAndImages(blocks);
    expect(images).toEqual([]);
    const combined = wrapUserMessageText('讲讲牛顿第二定律', text);

    // runtime_facts sits inside <injected_context> and never leaks into user_query.
    const injectedStart = combined.indexOf('<injected_context>');
    const injectedEnd = combined.indexOf('</injected_context>');
    const factsPos = combined.indexOf('<runtime_facts>');
    expect(injectedStart).toBeGreaterThanOrEqual(0);
    expect(factsPos).toBeGreaterThan(injectedStart);
    expect(factsPos).toBeLessThan(injectedEnd);
    const queryEnd = combined.indexOf('</user_query>');
    expect(combined.slice(0, queryEnd)).not.toContain('runtime_facts');
    expect(combined.slice(0, queryEnd)).not.toContain(today);
  });

  it('time_sensitive_query_upgrades_runtime_fact_precision', () => {
    const normal = buildRuntimeFactsBlock('讲讲牛顿第二定律');
    expect(normal).toContain('当前日期: ');
    expect(normal).not.toContain('当前时间: ');

    const sensitive = buildRuntimeFactsBlock('今天是几号？');
    expect(sensitive).toContain('当前时间: ');
  });

  it('empty_turn_volatile_keeps_previous_block_shape', () => {
    const none = buildInjectedContextBlocks(FIXED_FACTS, [], null);
    expect(none).toHaveLength(1);
    // Empty string equals no volatile blocks: no empty text block appended.
    const empty = buildInjectedContextBlocks(FIXED_FACTS, [], '');
    expect(empty).toHaveLength(1);
  });
});

describe('chat_v2/pipeline_tests.rs::tests (runtime facts)', () => {
  const now = new Date('2026-03-04T05:06:07.000Z');

  it('test_runtime_facts_uses_full_time_for_time_sensitive_query', () => {
    const runtimeFacts = buildRuntimeFactsBlock('今天是周几？现在几点？', { now });
    expect(runtimeFacts).toContain('<runtime_facts>');
    expect(runtimeFacts).toContain('当前时间:');
    expect(runtimeFacts).toContain('时区:');
    expect(runtimeFacts).not.toContain('当前日期:');
  });

  it('test_runtime_facts_uses_date_only_for_non_time_sensitive_query', () => {
    const runtimeFacts = buildRuntimeFactsBlock('请解释牛顿第二定律', { now });
    expect(runtimeFacts).toContain('<runtime_facts>');
    expect(runtimeFacts).toContain('当前日期:');
    expect(runtimeFacts).toContain('时区:');
    expect(runtimeFacts).not.toContain('当前时间:');
  });

  it('test_runtime_facts_describes_non_interactive_shell_limits', () => {
    const platform = 'macos';
    const runtimeFacts = buildRuntimeFactsBlock('检查项目状态', { now, platform });
    const shell = localShellContractForPlatform(platform);

    expect(runtimeFacts).toContain(`platform: ${platform}`);
    expect(runtimeFacts).toContain(`local_shell: ${shell.invocation ?? 'none'}`);
    expect(runtimeFacts).toContain(`shell_kind: ${shell.shell_kind}`);
    expect(runtimeFacts).toContain(`sandbox_backend: ${shell.sandbox_backend}`);
    expect(shell.output_encoding).toBe('utf-8');
    expect(runtimeFacts).toContain(`execution_supported: ${shell.execution_supported}`);
    expect(runtimeFacts).toContain('non_interactive: true');
    expect(runtimeFacts).toContain('pty_available: false');
    expect(runtimeFacts).toContain('persistent_shell_session: false');
    expect(runtimeFacts).toContain('network_default: deny');
  });
});

describe('chat_v2/pipeline_tests.rs::tests (context refs)', () => {
  function sendRef(resourceId: string, typeId: string, blocks: SendContextRef['formattedBlocks']):
  SendContextRef {
    return {
      resourceId,
      hash: `hash_${resourceId}`,
      typeId,
      formattedBlocks: blocks,
    };
  }

  const fixedNow = new Date('2026-03-04T05:06:07.000Z');

  it('test_build_user_content_from_context_refs', () => {
    const refs = [
      sendRef('res_1', 'note', [{ type: 'text', text: 'Note content 1' }]),
      sendRef('res_2', 'card', [
        { type: 'text', text: 'Card content' },
        { type: 'text', text: 'Card details' },
      ]),
    ];

    const blocks = buildUserContentFromContextRefs(refs);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Note content 1' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'Card content' });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Card details' });
  });

  it('test_build_user_content_empty_refs', () => {
    expect(buildUserContentFromContextRefs([])).toEqual([]);
  });

  it('test_convert_to_context_refs', () => {
    const sendRefs = [
      sendRef('res_abc', 'note', [{ type: 'text', text: 'Should be discarded' }]),
    ];
    const contextRefs = convertToContextRefs(sendRefs);
    expect(contextRefs).toHaveLength(1);
    expect(contextRefs[0]!.resourceId).toBe('res_abc');
    expect(contextRefs[0]!.hash).toBe('hash_res_abc');
    expect(contextRefs[0]!.typeId).toBe('note');
    // formattedBlocks are transient and never enter the snapshot.
    expect(contextRefs[0]).not.toHaveProperty('formattedBlocks');
  });

  it('test_get_combined_user_content', () => {
    const refs = [
      sendRef('res_note_1', 'note', [{ type: 'text', text: '笔记内容第一段' }]),
      sendRef('res_note_2', 'card', [{ type: 'text', text: '题目内容' }]),
    ];
    const { text, images } = combinedUserContent('用户输入的问题', refs, { now: fixedNow });

    expect(text).toContain('<runtime_facts>');
    expect(text).toContain('当前日期:');
    expect(text).toContain('时区:');
    expect(text).toContain('笔记内容第一段');
    expect(text).toContain('题目内容');
    expect(text).toContain('用户输入的问题');
    expect(text.indexOf('用户输入的问题')).toBeLessThan(text.indexOf('笔记内容第一段'));
    expect(images).toEqual([]);
  });

  it('test_get_combined_user_content_with_images', () => {
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
      + '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const refs = [
      sendRef('res_img_1', 'image', [
        { type: 'image', mediaType: 'image/png', base64: imageBase64 },
      ]),
      sendRef('res_note_1', 'note', [{ type: 'text', text: '图片相关说明' }]),
    ];
    const { text, images } = combinedUserContent('描述这张图片', refs, { now: fixedNow });

    expect(text).toContain('<runtime_facts>');
    expect(text).toContain('图片相关说明');
    expect(text).toContain('描述这张图片');
    expect(images).toHaveLength(1);
    expect(images[0]!.startsWith('iVBORw')).toBe(true);
  });

  it('test_get_combined_user_content_empty_refs', () => {
    const { text, images } = combinedUserContent('简单问题', [], { now: fixedNow });

    expect(text).toContain('<user_query>\n简单问题\n</user_query>');
    expect(text).toContain('<runtime_facts>');
    expect(text).toContain('当前日期:');
    expect(images).toEqual([]);
  });
});
