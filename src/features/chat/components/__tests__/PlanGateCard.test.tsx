import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlanGateCard } from '../PlanGateCard';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('PlanGateCard', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('invokes chat_v2_plan_gate_respond on confirm and keeps aria-busy', async () => {
    let resolveInvoke!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvoke = () => resolve(undefined);
        }),
    );
    const onResolved = vi.fn();

    render(
      <PlanGateCard
        sessionId="sess_1"
        request={{
          planId: 'plan_abc',
          toolCallId: 'call_1',
          toolName: 'builtin-note_delete',
          summary: 'Delete a note',
          timeoutSeconds: 60,
        }}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /确认执行|Confirm/i }));

    await waitFor(() => {
      expect(screen.getByTestId('plan-gate-card')).toHaveAttribute('aria-busy', 'true');
    });
    expect(screen.getByRole('button', { name: /确认执行|Confirm/i })).toBeDisabled();

    resolveInvoke();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_plan_gate_respond', {
        sessionId: 'sess_1',
        planId: 'plan_abc',
        toolCallId: 'call_1',
        approved: true,
        reason: null,
      });
    });
    expect(onResolved).toHaveBeenCalledWith(true);
    // Stay busy until parent unmounts via plan_gate end event.
    expect(screen.getByTestId('plan-gate-card')).toHaveAttribute('aria-busy', 'true');
  });

  it('invokes reject without remember/global flags', async () => {
    render(
      <PlanGateCard
        sessionId="sess_1"
        request={{
          planId: 'plan_abc',
          toolCallId: 'call_1',
          toolName: 'builtin-note_delete',
          summary: 'Delete a note',
          timeoutSeconds: 60,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /拒绝|Reject/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_plan_gate_respond', {
        sessionId: 'sess_1',
        planId: 'plan_abc',
        toolCallId: 'call_1',
        approved: false,
        reason: 'user_rejected',
      });
    });
    const payload = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('remember');
    expect(payload).not.toHaveProperty('rememberSession');
    expect(payload).not.toHaveProperty('global_bypass');
  });

  it('exposes alertdialog a11y labels and live countdown', () => {
    render(
      <PlanGateCard
        sessionId="sess_1"
        request={{
          planId: 'plan_abc',
          toolCallId: 'call_1',
          toolName: 'builtin-note_delete',
          summary: 'Delete a note',
          timeoutSeconds: 60,
        }}
      />,
    );

    const dialog = screen.getByRole('alertdialog', { name: '确认执行计划' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByTestId('plan-gate-countdown')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: /确认执行|Confirm/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拒绝|Reject/i })).toBeInTheDocument();
  });

  it('moves focus into the dialog, traps Tab, and rejects on Escape', async () => {
    render(
      <PlanGateCard
        sessionId="sess_1"
        request={{
          planId: 'plan_abc',
          toolCallId: 'call_1',
          toolName: 'builtin-note_delete',
          summary: 'Delete a note',
          timeoutSeconds: 60,
        }}
      />,
    );

    const reject = screen.getByRole('button', { name: /拒绝|Reject/i });
    const approve = screen.getByRole('button', { name: /确认执行|Confirm/i });
    await waitFor(() => expect(reject).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(approve).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(reject).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'chat_v2_plan_gate_respond',
        expect.objectContaining({ approved: false, reason: 'user_rejected' }),
      );
    });
  });

  it('restores focus when the gate unmounts', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(
      <PlanGateCard
        sessionId="sess_1"
        request={{
          planId: 'plan_abc',
          toolCallId: 'call_1',
          toolName: 'builtin-note_delete',
          summary: 'Delete a note',
          timeoutSeconds: 60,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /拒绝|Reject/i })).toHaveFocus());

    unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});
