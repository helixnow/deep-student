import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkshopConfirmationCard } from '../WorkshopConfirmationCard';
import { WorkshopProposalCard, workshopDiagnostics } from '../components/WorkshopProposalCard';
import { describeWorkshopError } from '../errors';
import { workshopItem, type WorkshopCard } from '../host-adapter';
import type { WorkshopItem } from '../types';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<object>()), ...(await import('../../plugin-manager/__tests__/i18nMock')).i18nMock() }));

const item: WorkshopItem = {
  id: 'workshop.plugin-1', proposalId: 'p1', revision: 3, name: '番茄钟', version: '', description: '25 分钟专注计时',
  capabilities: [], changes: ['开始 / 暂停'], trust: 'full', phase: 'proposed',
};

describe('workshop usability lines on the card', () => {
  it('F13 / F15 / F14: built-in difference, what cannot be done, what instead, and the time estimate', () => {
    render(<WorkshopConfirmationCard item={{ ...item, limits: ['复习界面里没有放按钮的位置'], alternatives: ['放到状态栏'],
      builtinDifference: '内置专注计时只计时；这个会记番茄数', estimate: { minMinutes: 1, maxMinutes: 3 } }} onAction={vi.fn()} />);
    expect(screen.getByTestId('workshop-builtin-difference').textContent).toBe('和内置功能的区别：内置专注计时只计时；这个会记番茄数');
    expect(screen.getByText('做不到的部分')).toBeInTheDocument();
    expect(screen.getByText('复习界面里没有放按钮的位置')).toBeInTheDocument();
    expect(screen.getByText('改成这样')).toBeInTheDocument();
    expect(screen.getByTestId('workshop-estimate').textContent).toBe('预计 1–3 分钟做好');
  });

  it('F14: after a run, the time and tokens it used', () => {
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'ready', version: '1.0.0', generation: { durationMs: 130_000, tokens: 12_300, attempts: 1 } }} onAction={vi.fn()} />);
    expect(screen.getByTestId('workshop-generation-stats').textContent).toMatch(/^这次用了 2 分 10 秒，约 12,300 tokens$/);
    expect(screen.queryByTestId('workshop-estimate')).toBeNull();
  });

  it('F7: after three failed rounds the card offers a minimal version and copies diagnostics', () => {
    const onAction = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const failed: WorkshopItem = { ...item, phase: 'failed', error: 'WORKSHOP_TRUNCATED: the answer was cut off', generation: { durationMs: 1000, attempts: 3 } };
    render(<WorkshopProposalCard item={failed} onAction={onAction} onRepair={vi.fn()} />);
    expect(screen.getByTestId('workshop-error').getAttribute('data-error-key')).toBe('truncated');
    fireEvent.click(screen.getByTestId('workshop-reduce'));
    expect(onAction).toHaveBeenCalledWith('reduce');
    fireEvent.click(screen.getByTestId('workshop-diagnostics'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('error key: truncated'));
    expect(workshopDiagnostics(failed)).toContain('last run: 3 round(s)');
  });

  it('F7: a build failure offers a smaller version even on the first attempt', () => {
    render(<WorkshopProposalCard item={{ ...item, phase: 'failed', error: 'WORKSHOP_INVALID: x', generation: { durationMs: 1000, attempts: 1 } }} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.getByTestId('workshop-reduce')).toBeVisible();
  });

  it('F21 / F7 error keys', () => {
    expect(describeWorkshopError('WORKSHOP_SECRET: description contains what looks like an API key').key).toBe('secret');
    expect(describeWorkshopError('SyntaxError: Unexpected end of JSON input').key).toBe('truncated');
  });

  it('maps the new wire fields onto the item', () => {
    const card = { kind: 'dstu-plugin-workshop', id: 'p1', pluginId: 'workshop.plugin-1', sessionId: 'A', title: '番茄钟', description: 'd',
      template: 'learning-tool', state: 'failed', revision: 3, version: null, capabilities: [], changes: [], trust: 'full', source: 'workshop',
      risk: '', check: null, error: 'x', previousVersion: null, createdAt: '', updatedAt: '', limits: ['a'], alternatives: ['b'], builtinDifference: 'c',
      estimate: { minMinutes: 1, maxMinutes: 3 }, generation: { startedAt: '', durationMs: 5, tokens: 9, attempts: 3 }, boundSessions: ['B'] } as WorkshopCard;
    expect(workshopItem(card)).toMatchObject({ limits: ['a'], alternatives: ['b'], builtinDifference: 'c', estimate: { minMinutes: 1, maxMinutes: 3 },
      generation: { durationMs: 5, tokens: 9, attempts: 3 }, boundSessions: ['B'] });
  });
});
