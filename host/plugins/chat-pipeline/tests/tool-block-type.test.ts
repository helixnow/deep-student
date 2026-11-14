import { describe, expect, it } from 'vitest';
import { getBlockTypeForToolStatic } from '../api.ts';
import { PipelineContext } from '../src/pipeline-context.ts';
import { createPipelineHost } from './chat-host.ts';

describe('context.rs:899 get_block_type_for_tool_static', () => {
  it('block_type_mapping_for_render_generative_ui_is_generative_ui', async () => {
    const host = await createPipelineHost();
    try {
      for (const name of ['render_generative_ui', 'builtin-render_generative_ui']) {
        expect(getBlockTypeForToolStatic(name), name).toBe('generative_ui');
        expect(host.ctx.chatPipeline.getBlockTypeForToolStatic(name), name).toBe('generative_ui');
        expect(PipelineContext.getBlockTypeForToolStatic(name), name).toBe('generative_ui');
      }
    } finally { await host.dispose(); }
  });

  it('preserves the complete semantic tool mapping and external namespaces', () => {
    const groups: Record<string, string[]> = {
      workbench_ops: ['workbench_apply', 'workbench_', 'note_append', 'note_replace', 'note_set', 'mindmap_edit_nodes'],
      rag: ['rag_search', 'multimodal_search', 'unified_search'],
      memory: ['memory_search'], web_search: ['web_search'], insight_recall: ['insight_recall'],
      academic_search: ['arxiv_search', 'scholar_search'], image_gen: ['image_generate'],
      generative_ui: ['render_generative_ui'], sleep: ['coordinator_sleep'],
      subagent_embed: ['subagent_call', 'super_dispatch_worker', 'super_message_worker'],
      workspace_send: ['workspace_send'], ask_user: ['ask_user'], qbank_questions: ['qbank_generate_questions'],
    };
    for (const [type, names] of Object.entries(groups)) {
      for (const name of names) {
        expect(getBlockTypeForToolStatic(name), name).toBe(type);
        expect(getBlockTypeForToolStatic(`builtin-${name}`), name).toBe(type);
        expect(getBlockTypeForToolStatic(`mcp_${name}`), name).toBe('mcp_tool');
      }
    }
    for (const name of ['', 'unknown', ' render_generative_ui ', 'builtin:render_generative_ui',
      'builtin-builtin-render_generative_ui', 'mcp.tools.render_generative_ui']) {
      expect(getBlockTypeForToolStatic(name), name).toBe('mcp_tool');
    }
  });
});
