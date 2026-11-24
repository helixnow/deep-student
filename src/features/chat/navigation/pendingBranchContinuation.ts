/**
 * Pending one-shot follow-up actions after branching into a newly created session.
 * Stored independently from pendingChatNavigation.ts so test mocks of that module stay unaffected.
 */

export type BranchContinuationAction =
  | { type: 'regenerate_last' }
  | { type: 'resend_last_edited'; content: string };

const pendingBranchContinuations = new Map<string, BranchContinuationAction>();

export function setPendingBranchContinuation(
  sessionId: string,
  action: BranchContinuationAction,
): void {
  if (!sessionId) return;
  pendingBranchContinuations.set(sessionId, action);
}

export function consumePendingBranchContinuation(
  sessionId: string,
): BranchContinuationAction | null {
  const action = pendingBranchContinuations.get(sessionId);
  if (!action) return null;
  pendingBranchContinuations.delete(sessionId);
  return action;
}

export function clearPendingBranchContinuationsForTest(): void {
  pendingBranchContinuations.clear();
}
