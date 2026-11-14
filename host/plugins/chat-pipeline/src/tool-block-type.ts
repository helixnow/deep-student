/** context.rs:899–933 — semantic tool block type shared by live and replay callers. */
export function getBlockTypeForToolStatic(toolName: string): string {
  const name = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : toolName;
  if (name.startsWith('workbench_')
    || name === 'note_append' || name === 'note_replace' || name === 'note_set'
    || name === 'mindmap_edit_nodes') return 'workbench_ops';
  switch (name) {
    case 'rag_search': case 'multimodal_search': case 'unified_search': return 'rag';
    case 'memory_search': return 'memory';
    case 'web_search': return 'web_search';
    case 'insight_recall': return 'insight_recall';
    case 'arxiv_search': case 'scholar_search': return 'academic_search';
    case 'image_generate': return 'image_gen';
    case 'render_generative_ui': return 'generative_ui';
    case 'coordinator_sleep': return 'sleep';
    case 'subagent_call': case 'super_dispatch_worker': case 'super_message_worker': return 'subagent_embed';
    case 'workspace_send': return 'workspace_send';
    case 'ask_user': return 'ask_user';
    case 'qbank_generate_questions': return 'qbank_questions';
    default: return 'mcp_tool';
  }
}
