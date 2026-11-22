import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeWorkshopError } from '../errors';
import { WorkshopConfirmationCard } from '../WorkshopConfirmationCard';
import { WorkshopProposalCard } from '../components/WorkshopProposalCard';
import { createWorkshopIntegration } from '../integration';
import type { WorkshopAdapter, WorkshopItem, WorkshopPlace } from '../types';

vi.mock('react-i18next', async () => (await import('../../plugin-manager/__tests__/i18nMock')).i18nMock());

function makeItem(overrides: Partial<WorkshopItem> = {}): WorkshopItem {
  return {
    id: 'workshop.demo',
    proposalId: 'prop-1',
    revision: 1,
    name: 'Demo Tool',
    version: '1.0.0',
    capabilities: [],
    changes: [],
    trust: 'full',
    phase: 'installed',
    ...overrides,
  };
}

describe('errors.ts runtime & activation classification (BUG-05)', () => {
  it.each([
    'render: TypeError: bad vnode',
    'filter: failed predicate',
    'report: custom crash',
    'callback: async rejection',
  ])('classifies %s as crashed', (msg) => {
    expect(describeWorkshopError(msg)).toMatchObject({ key: 'crashed', next: 'repair' });
  });

  it('classifies activate: failures as activationFailed', () => {
    expect(describeWorkshopError('activate: SyntaxError in ui bundle')).toMatchObject({
      key: 'activationFailed',
      next: 'repair',
    });
  });
});

describe('WorkshopProposalCard & WorkshopConfirmationCard place presentation (BUG-01b)', () => {
  afterEach(() => cleanup());

  it('hides the open button when places is explicitly empty, while preserving default for undefined places', () => {
    const emptyRender = render(
      <WorkshopProposalCard item={makeItem({ places: [] })} busy={false} onAction={vi.fn()} onRepair={vi.fn()} />,
    );
    expect(screen.queryByTestId('workshop-primary')).toBeNull();
    emptyRender.unmount();

    render(<WorkshopProposalCard item={makeItem({ places: undefined })} busy={false} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.getByTestId('workshop-primary')).toHaveAttribute('data-place', 'app');
  });

  it.each<[WorkshopPlace, string]>([
    [{ kind: 'pdfSelectionButton' }, '去 PDF 里试试'],
    [{ kind: 'slashCommand', command: 'quizMe' }, '去对话试 /quizMe'],
    [{ kind: 'slashCommand' }, '去对话输入 / 试试'],
    [{ kind: 'chatMessageAction' }, '去对话消息菜单试试'],
    [{ kind: 'reviewAction' }, '去复习卡片里试试'],
    [{ kind: 'desktopWidget' }, '去桌面小组件看看'],
    [{ kind: 'statusBarItem' }, '看顶部状态栏'],
    [{ kind: 'themeVariant' }, '去外观主题看看'],
    [{ kind: 'dashboardWidget' }, '去学习总览看看'],
  ])('renders localized primary action and confirmation location for %o', (place, expectedLabel) => {
    const { unmount } = render(
      <WorkshopProposalCard item={makeItem({ places: [place] })} busy={false} onAction={vi.fn()} onRepair={vi.fn()} />,
    );
    expect(screen.getByTestId('workshop-primary')).toHaveTextContent(expectedLabel);
    expect(screen.getByTestId('workshop-primary')).toHaveAttribute('data-place', place.kind);
    expect(screen.getByTestId('workshop-where')).toBeInTheDocument();
    unmount();

    const conf = render(
      <WorkshopConfirmationCard item={makeItem({ phase: 'ready', places: [place] })} onAction={vi.fn()} onRepair={vi.fn()} />,
    );
    expect(screen.getByTestId('workshop-where')).toBeInTheDocument();
    conf.unmount();
  });
});

describe('createWorkshopIntegration hasActive & Host storage ports (GAP-5)', () => {
  it('reports active phases accurately and exposes Host storedData / clearStoredData ports', async () => {
    const items: WorkshopItem[] = [makeItem({ phase: 'generating' })];
    const adapter: WorkshopAdapter = {
      list: vi.fn(async () => items),
      get: vi.fn(),
      act: vi.fn(),
      subscribe: () => () => undefined,
    };
    const storedData = vi.fn(async () => ({ keys: ['files/k1'], bytes: 42 }));
    const clearStoredData = vi.fn(async () => 1);
    const integration = createWorkshopIntegration({
      adapter,
      sessions: {
        bindSession: vi.fn(async () => {}),
        create: vi.fn(async () => ({ id: 's1' })),
        activateSkill: vi.fn(async () => true),
        navigate: vi.fn(),
      },
      reportError: vi.fn(),
      storedData,
      clearStoredData,
    });

    expect(await integration.workshop.hasActive?.()).toBe(true);
    items[0] = makeItem({ phase: 'installed' });
    expect(await integration.workshop.hasActive?.()).toBe(false);
    expect(await integration.workshop.storedData?.('workshop.demo')).toEqual({ keys: ['files/k1'], bytes: 42 });
    expect(await integration.workshop.clearStoredData?.('workshop.demo')).toBe(1);
  });
});
