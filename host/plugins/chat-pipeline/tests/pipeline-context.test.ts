import { describe, expect, it } from 'vitest';
import { PipelineContext } from '../src/pipeline-context.ts';

const request = () => ({ sessionId: 'sess_test', content: 'Test message' });

describe('pipeline_tests.rs::PipelineContext', () => {
  it('test_pipeline_context_creation', () => {
    const ctx = new PipelineContext(request());
    expect(ctx.sessionId).toBe('sess_test');
    expect(ctx.userContent).toBe('Test message');
    expect(ctx.userMessageId).toMatch(/^msg_/);
    expect(ctx.assistantMessageId).toMatch(/^msg_/);
  });

  it('test_pipeline_context_elapsed', async () => {
    const ctx = new PipelineContext(request());
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(ctx.elapsedMs()).toBeGreaterThanOrEqual(10);
  });

  it('test_pipeline_context_generated_blocks', () => {
    expect(new PipelineContext(request()).generatedBlocks).toEqual([]);
  });

  it('test_pipeline_context_with_options', () => {
    const ctx = new PipelineContext({ ...request(), options: { contextLimit: 10, modelId: 'gpt-4' } });
    expect(ctx.options.contextLimit).toBe(10);
    expect(ctx.options.modelId).toBe('gpt-4');
  });

  it('test_pipeline_context_with_frontend_ids', () => {
    const ctx = new PipelineContext({ sessionId: 'sess_test123', content: '测试内容',
      userMessageId: 'msg_frontend_user_123', assistantMessageId: 'msg_frontend_assistant_456',
      options: { modelId: 'test-model', enableThinking: true } });
    expect(ctx.userMessageId).toBe('msg_frontend_user_123');
    expect(ctx.assistantMessageId).toBe('msg_frontend_assistant_456');
    expect(ctx.sessionId).toBe('sess_test123');
    expect(ctx.userContent).toBe('测试内容');
    expect(ctx.options.modelId).toBe('test-model');
    expect(ctx.options.enableThinking).toBe(true);
  });

  it('test_pipeline_context_generates_ids_when_not_provided', () => {
    const ctx = new PipelineContext(request());
    expect(ctx.userMessageId).toMatch(/^msg_/);
    expect(ctx.assistantMessageId).toMatch(/^msg_/);
    expect(ctx.userMessageId).not.toBe(ctx.assistantMessageId);
  });

  it('test_pipeline_context_add_tool_results', () => {
    const ctx = new PipelineContext(request());
    expect(ctx.toolResults).toEqual([]);
    ctx.addToolResults([{ toolCallId: 'call_1', blockId: 'blk_test_1', toolName: 'test',
      input: {}, output: {}, success: true, durationMs: 100 }]);
    expect(ctx.toolResults).toHaveLength(1);
    ctx.addToolResults([{ toolCallId: 'call_2', blockId: 'blk_test_2', toolName: 'test2',
      input: {}, output: {}, success: false, error: 'error' }]);
    expect(ctx.toolResults).toHaveLength(2);
    expect([...ctx.dirtyInterleavedBlockIds]).toEqual(['blk_test_1', 'blk_test_2']);
  });

  it('test_pipeline_context_with_user_context_refs', () => {
    const userContextRefs = [{ resourceId: 'res_test', hash: 'hash_test', typeId: 'note',
      formattedBlocks: [{ type: 'text' as const, text: 'Test' }] }];
    const ctx = new PipelineContext({ ...request(), userContextRefs, options: { userContextRefs } });
    expect(ctx.userContextRefs).toHaveLength(1);
    expect(ctx.userContextRefs[0]!.resourceId).toBe('res_test');
    userContextRefs[0]!.resourceId = 'later';
    expect(ctx.userContextRefs[0]!.resourceId).toBe('res_test');
  });
});
