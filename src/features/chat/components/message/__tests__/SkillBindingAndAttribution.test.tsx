import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { BoundSkillChipsBar } from '../../../skills/components/BoundSkillChipsBar';
import {
  SkillAttributionPill,
  clearPersistedMessageSkillSnapshots,
} from '../SkillAttributionPill';
import { skillRegistry } from '../../../skills/registry';
import type { SkillDefinition } from '../../../skills/types';
import { MessageItem } from '../../MessageItem';
import type { Block, ChatStore, Message } from '@/features/chat/core/types';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../MemoryKernelAttributionPill', () => ({
  MemoryKernelAttributionPill: () => null,
  invalidateMemoryKernelAttributionCache: vi.fn(),
  clearPersistedMessageMemorySnapshots: vi.fn(),
}));

function registerDemoSkill(id: string, name: string): SkillDefinition {
  const skill: SkillDefinition = {
    id,
    name,
    description: `${name} description`,
    content: `# ${name}`,
    location: 'global',
    sourcePath: `/tmp/skills/${id}/SKILL.md`,
    isBuiltin: false,
  };
  skillRegistry.register(skill);
  return skill;
}

describe('S4-06 Chat-side bound skill chips, one-click unbind, and per-message skill attribution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPersistedMessageSkillSnapshots();
    skillRegistry.clear();
  });

  it('renders visible bound skill chips with accessible one-click unbind (×) and clear-all controls', () => {
    registerDemoSkill('feynman-tutor', '费曼导师');
    registerDemoSkill('exam-drill', '错题精练');

    const onUnbindSkill = vi.fn();
    const onClearAll = vi.fn();
    const onOpenSelector = vi.fn();

    render(
      <BoundSkillChipsBar
        skillIds={['feynman-tutor', 'exam-drill']}
        onUnbindSkill={onUnbindSkill}
        onClearAll={onClearAll}
        onOpenSelector={onOpenSelector}
      />,
    );

    expect(screen.getByTestId('bound-skill-chips-bar')).toBeInTheDocument();
    expect(screen.getByTestId('bound-skill-chip-feynman-tutor')).toHaveTextContent('费曼导师');
    expect(screen.getByTestId('bound-skill-chip-exam-drill')).toHaveTextContent('错题精练');

    // One-click unbind button has accessible label & invokes onUnbindSkill without opening selector
    const unbindBtn = screen.getByTestId('unbind-skill-feynman-tutor');
    expect(unbindBtn.getAttribute('aria-label')).toContain('费曼导师');
    fireEvent.click(unbindBtn);
    expect(onUnbindSkill).toHaveBeenCalledWith('feynman-tutor');
    expect(onOpenSelector).not.toHaveBeenCalled();

    // Clear-all unbinds all active skills
    fireEvent.click(screen.getByTestId('unbind-all-skills'));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it('captures per-message skill attribution on assistant messages and keeps historical badges immutable after later unbind/switch', async () => {
    registerDemoSkill('feynman-tutor', '费曼导师');
    registerDemoSkill('essay-polisher', '作文润色');

    const { rerender } = render(
      <div>
        <SkillAttributionPill
          sessionId="sess-skill-attr"
          messageId="msg-a1"
          sessionActiveSkillIds={['feynman-tutor']}
          sessionSkillStateJson={JSON.stringify({ manualPinnedSkillIds: ['feynman-tutor'] })}
        />
      </div>,
    );

    const turn1Badge = await screen.findByTestId('skill-attribution-pill');
    expect(turn1Badge).toHaveTextContent('费曼导师');

    fireEvent.click(turn1Badge);
    expect(await screen.findByTestId('skill-attribution-item-feynman-tutor')).toHaveTextContent('费曼导师');
    fireEvent.click(turn1Badge); // close popover

    // User unbinds 'feynman-tutor' and binds 'essay-polisher' for Turn 2
    rerender(
      <div>
        <SkillAttributionPill
          key="remounted-msg-a1"
          sessionId="sess-skill-attr"
          messageId="msg-a1"
          sessionActiveSkillIds={['essay-polisher']}
          sessionSkillStateJson={JSON.stringify({ manualPinnedSkillIds: ['essay-polisher'] })}
        />
        <SkillAttributionPill
          sessionId="sess-skill-attr"
          messageId="msg-a2"
          sessionActiveSkillIds={['essay-polisher']}
          sessionSkillStateJson={JSON.stringify({ manualPinnedSkillIds: ['essay-polisher'] })}
        />
        <SkillAttributionPill
          sessionId="sess-skill-attr"
          messageId="msg-a3-none"
          sessionActiveSkillIds={[]}
          sessionSkillStateJson={JSON.stringify({ manualPinnedSkillIds: [] })}
        />
      </div>,
    );

    const badges = await screen.findAllByTestId('skill-attribution-pill');
    // msg-a1 (费曼导师) + msg-a2 (作文润色); msg-a3-none renders no badge
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('费曼导师');
    expect(badges[0]).not.toHaveTextContent('作文润色');
    expect(badges[1]).toHaveTextContent('作文润色');
  });

  it('renders persisted per-message skill attribution from message._meta inside MessageItem even after session unbinds all skills', async () => {
    registerDemoSkill('feynman-tutor', '费曼导师');

    const userMsg: Message = {
      id: 'msg-u1',
      role: 'user',
      blockIds: ['blk-u1'],
      timestamp: Date.now() - 1000,
    };
    const assistantMsg: Message = {
      id: 'msg-a1',
      role: 'assistant',
      blockIds: ['blk-a1'],
      timestamp: Date.now(),
      _meta: {
        modelId: 'deepseek-chat',
        skillSnapshotAfter: {
          manualPinnedSkillIds: ['feynman-tutor'],
          version: 2,
        },
      },
    };
    const userBlock: Block = {
      id: 'blk-u1',
      messageId: 'msg-u1',
      type: 'content',
      status: 'success',
      content: '用费曼法解释熵增定律',
    } as Block;
    const assistantBlock: Block = {
      id: 'blk-a1',
      messageId: 'msg-a1',
      type: 'content',
      status: 'success',
      content: '想象一个整理好的房间逐渐变乱……',
    } as Block;

    const store = createStore<ChatStore>(() => ({
      sessionId: 'sess-msg-skill-meta',
      mode: 'chat',
      sessionMetadata: {},
      sessionStatus: 'idle',
      activeSkillIds: [], // Session has already unbound all skills!
      skillStateJson: JSON.stringify({ manualPinnedSkillIds: [], version: 3 }),
      activeBlockIds: new Set<string>(),
      messageOrder: ['msg-u1', 'msg-a1'],
      messageMap: new Map([
        ['msg-u1', userMsg],
        ['msg-a1', assistantMsg],
      ]),
      blocks: new Map([
        ['blk-u1', userBlock],
        ['blk-a1', assistantBlock],
      ]),
      getDisplayBlockIds: (id: string) => (id === 'msg-a1' ? ['blk-a1'] : ['blk-u1']),
      getMessage: (id: string) => (id === 'msg-a1' ? assistantMsg : userMsg),
      switchVariant: vi.fn(),
      cancelVariant: vi.fn(),
      retryVariant: vi.fn(),
      deleteVariant: vi.fn(),
      stopAllVariants: vi.fn(),
      retryAllVariants: vi.fn(),
      setModelRetryTarget: vi.fn(),
      setPanelState: vi.fn(),
    } as unknown as ChatStore));

    render(
      <MessageItem
        messageId="msg-a1"
        store={store}
        isFirst={false}
        isLatest={true}
      />,
    );

    const badge = await screen.findByTestId('skill-attribution-pill');
    expect(badge).toHaveTextContent('费曼导师');

    // Even if user later binds a totally different skill in the store, msg-a1's badge stays immutable
    act(() => {
      registerDemoSkill('math-solver', '数学解题');
      store.setState({
        activeSkillIds: ['math-solver'],
        skillStateJson: JSON.stringify({ manualPinnedSkillIds: ['math-solver'], version: 4 }),
      });
    });

    expect(screen.getByTestId('skill-attribution-pill')).toHaveTextContent('费曼导师');
    expect(screen.getByTestId('skill-attribution-pill')).not.toHaveTextContent('数学解题');
  });
});
