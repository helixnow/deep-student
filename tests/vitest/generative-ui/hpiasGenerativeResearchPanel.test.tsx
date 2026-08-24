import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { useHpiasStore } from '@/stores/researchStore';
import { HpiasGenerativeResearchPanel } from '@/features/generative-ui/components/HpiasGenerativeResearchPanel';
import { playStyleLabHpiasDemo } from '@/features/generative-ui/demo/styleLabHpiasDemo';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('HpiasGenerativeResearchPanel', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders empty fallback before session starts', () => {
    render(
      <HpiasGenerativeResearchPanel
        emptyFallback={<span data-testid="empty">empty</span>}
      />,
    );
    expect(screen.getByTestId('empty')).toBeInTheDocument();
  });

  it('renders research plan after hpias events', () => {
    vi.useFakeTimers();
    render(<HpiasGenerativeResearchPanel question="Demo?" />);

    act(() => {
      playStyleLabHpiasDemo(useHpiasStore.getState().actions.handleEvent, 10);
    });

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(document.querySelector('[data-generative-research-plan]')).toBeTruthy();
    expect(document.querySelector('[data-generative-block="steps"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-steps]')).toBeTruthy();
  });

  it('keeps session A live after session B becomes the active store session', () => {
    render(
      <HpiasGenerativeResearchPanel
        sessionId="s-a"
        question="Session A?"
        emptyFallback={<span data-testid="empty">empty</span>}
      />,
    );

    act(() => {
      const handleEvent = useHpiasStore.getState().actions.handleEvent;
      handleEvent({ type: 'session_started', session_id: 's-a', question: 'A' });
      handleEvent({
        type: 'plan_generated',
        session_id: 's-a',
        round: 1,
        plan: { core: { queries: ['keep-session-a'] } },
      });
      handleEvent({ type: 'session_started', session_id: 's-b', question: 'B' });
      handleEvent({
        type: 'plan_generated',
        session_id: 's-b',
        round: 1,
        plan: { core: { queries: ['clobber-session-b'] } },
      });
    });

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getAllByText('keep-session-a').length).toBeGreaterThan(0);
    expect(screen.queryByText('clobber-session-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('empty')).not.toBeInTheDocument();
  });

  it('ignores a store session that does not match the expected sessionId', () => {
    vi.useFakeTimers();
    render(
      <HpiasGenerativeResearchPanel
        sessionId="other-session"
        question="Demo?"
        emptyFallback={<span data-testid="empty">empty</span>}
      />,
    );

    act(() => {
      playStyleLabHpiasDemo(useHpiasStore.getState().actions.handleEvent, 10);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(screen.getByTestId('empty')).toBeInTheDocument();
    expect(screen.queryByTestId('hpias-generative-research-panel')).not.toBeInTheDocument();
  });

  it('wires copy-intent on the action-bar alongside research actions', () => {
    vi.useFakeTimers();
    render(<HpiasGenerativeResearchPanel question="Demo?" />);

    act(() => {
      playStyleLabHpiasDemo(useHpiasStore.getState().actions.handleEvent, 10);
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'action.copy_intent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'research.actions.copy_report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'research.actions.export_plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'research.actions.export_intent' })).toBeInTheDocument();
  });
});
