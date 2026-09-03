import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ActivityTimeline } from '@/features/chat/components/ActivityTimeline';
import type { Block } from '@/features/chat/core/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'timeline.tool.preparing': 'Preparing...',
        'timeline.tool.pending': 'Pending',
        'timeline.tool.running': 'Running...',
        'timeline.tool.success': 'Completed',
        'timeline.tool.completed': `Completed${typeof params?.ms === 'number' ? ` in ${params.ms}ms` : ''}`,
        'timeline.tool.failed': 'Failed',
        'timeline.tool.input': 'Input Parameters',
        'timeline.tool.output': 'Output Result',
        'timeline.tool.noOutput': 'No output',
        'timeline.tool.contentLabel': 'Tool details',
        'timeline.tool.moreParams': `More ${params?.count ?? 0} params`,
        'timeline.tool.arrayResult': `Array (${params?.count ?? 0})`,
        'timeline.tool.objectResult': 'Object result',
        'timeline.tool.emptyResult': 'Empty result',
        'timeline.tool.itemsResult': `${params?.count ?? 0} results`,
        'timeline.tool.moreItems': `More ${params?.count ?? 0} items`,
        'timeline.tool.loadedSkills': 'Loaded skills',
        'timeline.tool.loadedTools': 'Loaded tools',
        'timeline.tool.loadSkillsMessage': 'Skills loaded successfully.',
      };
      return translations[key] || key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/features/chat/utils/toolDisplayName', () => ({
  getReadableToolName: (name: string) => name,
  getExternalToolProviderName: () => undefined,
}));

function createToolBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'tool-1',
    type: 'mcp_tool',
    status: 'success',
    messageId: 'msg-1',
    toolName: 'load_skills',
    toolInput: { skills: ['deep-student'] },
    toolOutput: {
      status: 'success',
      loaded_skill_ids: ['canvas-note', 'deep-student', 'knowledge-retrieval'],
      loaded_tool_names: ['builtin-note_create', 'builtin-memory_search'],
      message: 'Skills loaded successfully.',
    },
    startedAt: Date.now(),
    endedAt: Date.now() + 10,
    ...overrides,
  };
}

describe('ActivityTimeline load_skills summary', () => {
  it('renders loaded skills instead of a raw JSON preview in the timeline summary', () => {
    render(<ActivityTimeline blocks={[createToolBlock()]} />);

    fireEvent.click(screen.getByRole('button', { name: /load_skills/i }));

    expect(screen.getByText('Loaded skills')).toBeInTheDocument();
    expect(screen.getByText('canvas-note')).toBeInTheDocument();
    expect(screen.getByText('deep-student')).toBeInTheDocument();
    expect(screen.getByText('knowledge-retrieval')).toBeInTheDocument();
    expect(screen.getByText('Loaded tools')).toBeInTheDocument();
    expect(screen.getByText('builtin-note_create')).toBeInTheDocument();
    expect(screen.getByText('Skills loaded successfully.')).toBeInTheDocument();
    expect(screen.queryByText(/\{"status":"success","loaded_skill_ids":/)).not.toBeInTheDocument();
  });

  it('renders loaded skills for nested load_skills results', () => {
    render(
      <ActivityTimeline
        blocks={[
          createToolBlock({
            toolInput: { skills: ['vfs-memory'] },
            toolOutput: {
              result: {
                status: 'success',
                loaded_skill_ids: ['vfs-memory'],
                loaded_tool_names: ['builtin-memory_delete', 'builtin-memory_search'],
                message: 'Skills loaded successfully.',
              },
            },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /load_skills/i }));

    expect(screen.getByText('Loaded skills')).toBeInTheDocument();
    expect(screen.getByText('vfs-memory')).toBeInTheDocument();
    expect(screen.getByText('builtin-memory_delete')).toBeInTheDocument();
    expect(screen.queryByText(/\{"result":\{"status":"success"/)).not.toBeInTheDocument();
  });
});
