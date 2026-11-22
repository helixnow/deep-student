import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({ AnkiTemplateCardFace: () => <div data-testid="card-face" /> }));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({ useAnkiTemplateLoader: () => ({ template: null, loading: false }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/tts', () => ({ speak: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }));

let mobileChromeFlag = false;
let mobileRightActions: React.ReactNode = null;
vi.mock('@/features/flashcards/useFlashcardsMobileChrome', () => ({
  useFlashcardsMobileChrome: (options: { rightActions?: React.ReactNode }) => {
    mobileRightActions = options.rightActions ?? null;
    return mobileChromeFlag;
  },
}));

import { StatusBarItems } from '@/features/workbench/components/StatusBarItems';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { ReviewSessionScreen } from '@/features/flashcards/screens/ReviewSessionScreen';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';

describe('statusbar.items & review.cardActions B7 slots (BUG-01a)', () => {
  let kernel: UiKernel;

  beforeEach(async () => {
    cleanup();
    mobileChromeFlag = false;
    mobileRightActions = null;
    vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
    vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', timeLeft: 1500, sessionCountUp: undefined });
    kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await kernel.dispose();
  });

  it('renders contributed statusbar.items with wb-menubar-item props', async () => {
    const plugin = defineUiPlugin({
      meta: { id: 'community.statusbar', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('statusbar.items', {
          id: 'streak-pill',
          value: {
            component: ({ className }: { className?: string }) => (
              <span data-testid="plugin-statusbar-item" className={className}>Streak 5d</span>
            ),
          },
        });
      },
    });
    await act(async () => { await kernel.install(plugin, { origin: 'community' }); });

    render(
      <UiKernelProvider kernel={kernel}>
        <StatusBarItems dueCount={0} taskCount={0} automation={null} />
      </UiKernelProvider>,
    );

    const item = await screen.findByTestId('plugin-statusbar-item');
    expect(item).toHaveTextContent('Streak 5d');
    expect(item).toHaveClass('wb-menubar-item');
  });

  it('renders review.cardActions in desktop toolbar and mobile menu and reports errors', async () => {
    const runSpy = vi.fn();
    const ReviewIcon = ({ size }: { size?: number }) => <span data-testid="review-plugin-icon" data-size={size}>H</span>;
    const plugin = defineUiPlugin({
      meta: { id: 'community.review-tool', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('review.cardActions', {
          id: 'mnemonic-hint',
          value: {
            label: 'Mnemonic Hint',
            icon: ReviewIcon,
            run: runSpy,
          },
        });
        ctx.ui.contribute('review.cardActions', {
          id: 'broken-hint',
          value: {
            label: 'Broken Review Action',
            run: () => { throw new Error('review card boom'); },
          },
        });
      },
    });
    await act(async () => { await kernel.install(plugin, { origin: 'community' }); });

    useFsrsReviewStore.setState({
      screen: 'session',
      sessionMode: 'due',
      queue: [{
        id: 'card-7',
        ankiCardId: 'anki-9',
        front: 'Front Q',
        back: 'Back A',
        tags: ['physics'],
        deckName: 'Default',
        cardType: 'basic',
        intervalDays: 1,
        dueAt: new Date().toISOString(),
        reps: 1,
        lapses: 0,
      } as any],
      queueIndex: 0,
      flipped: true,
      loading: false,
      ratingBusy: false,
      error: null,
      errorKind: null,
    });

    const user = userEvent.setup();
    render(
      <UiKernelProvider kernel={kernel}>
        <ReviewSessionScreen />
      </UiKernelProvider>,
    );

    const desktopBtn = await screen.findByRole('button', { name: 'Mnemonic Hint' });
    expect(screen.getByTestId('review-plugin-icon')).toBeInTheDocument();
    await user.click(desktopBtn);
    expect(runSpy).toHaveBeenCalledWith({
      cardId: 'card-7',
      noteCardId: 'anki-9',
      front: 'Front Q',
      back: 'Back A',
      tags: ['physics'],
      flipped: true,
    });

    await user.click(screen.getByRole('button', { name: 'Broken Review Action' }));
    await waitFor(() => {
      expect(kernel.errors.list('community.review-tool').some(r => r.phase === 'report' && r.slot === 'review.cardActions')).toBe(true);
    });

    cleanup();
    runSpy.mockClear();
    mobileChromeFlag = true;
    render(
      <UiKernelProvider kernel={kernel}>
        <ReviewSessionScreen />
      </UiKernelProvider>,
    );
    expect(mobileRightActions).toBeTruthy();
    const mobileRender = render(<UiKernelProvider kernel={kernel}>{mobileRightActions}</UiKernelProvider>);
    const trigger = mobileRender.getAllByRole('button').at(-1)!;
    await user.click(trigger);
    await user.click(await screen.findByText('Mnemonic Hint'));
    expect(runSpy).toHaveBeenCalledWith({
      cardId: 'card-7',
      noteCardId: 'anki-9',
      front: 'Front Q',
      back: 'Back A',
      tags: ['physics'],
      flipped: true,
    });
  });
});
