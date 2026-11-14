import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import type { Model2HistoryMessage } from '../api.ts';

describe('model2_pipeline.rs history construction service', () => {
  it('keeps tools, empty reasoning, transient barriers and request-only injection in the production service', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const history: Model2HistoryMessage[] = [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'round', thinking_content: '', thought_signature: 'sig',
          tool_call: { id: 'c1', tool_name: 'lookup', args_json: { q: 'a' } },
          metadata: { openai_responses_reasoning_item: { type: 'reasoning', id: 'r1' } } },
        { role: 'tool', content: 'found', tool_result: { call_id: 'c1' } },
        { role: 'user', content: 'new' }, { role: 'user', content: 'question' },
        { role: 'user', content: '<skill>unchanged</skill>', metadata: { kind: 'skill_instruction', hidden: true } },
      ];
      const snapshot = structuredClone(history);
      const config = makeConfig({ model: 'deepseek-chat', modelAdapter: 'deepseek', providerType: 'deepseek', isReasoning: true });
      const messages = host.ctx.llmModel2Messages.build(config, history, 'system', true, ['  <graph>&text  ']);
      expect(messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }] });
      expect(messages[2]).toMatchObject({ role: 'assistant', reasoning_content: '', thought_signature: 'sig',
        response_reasoning_item: { type: 'reasoning', id: 'r1' }, tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{"q":"a"}' } }] });
      expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'found' });
      // model2_pipeline.rs:5796-5801 json! with workspace serde_json preserve_order: the request bytes keep this key order.
      expect(JSON.stringify(messages[3])).toBe('{"role":"tool","tool_call_id":"c1","content":"found"}');
      expect(messages[4]).toEqual({ role: 'user', content: 'new\n\nquestion\n\n<injected_context>\n&lt;graph&gt;&amp;text\n</injected_context>' });
      expect(messages[5]).toEqual({ role: 'user', content: '<skill>unchanged</skill>' });
      expect(history).toEqual(snapshot);
    } finally { await host.dispose(); }
  });

  it('preserves multimodal precedence and attachment text in legacy user messages', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const config = makeConfig({ isMultimodal: true });
      const messages = host.ctx.llmModel2Messages.build(config, [
        { role: 'user', content: 'not used', multimodal_content: [{ type: 'text', text: 'interleaved' },
          { type: 'image_url', mediaType: 'image/png', base64: 'data' }] },
        { role: 'assistant', content: 'next' },
        { role: 'user', content: 'text', doc_attachments: [{ name: 'doc', text_content: 'attachment' }],
          image_base64: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')] },
      ], 'system', false, []);
      expect(messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'interleaved' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,data' } }] });
      expect(messages[3]).toMatchObject({ content: [
        { type: 'text', text: 'text\n\n--- 附件内容 ---\n\n【文档: doc】\nattachment' },
        { type: 'image_url', image_url: { url: expect.stringContaining('data:image/png;base64,') } },
      ] });
    } finally { await host.dispose(); }
  });
});
