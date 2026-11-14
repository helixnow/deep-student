// Rust chatanki_executor.rs:106–189: the in-process registry of background card
// pipelines that are really running, keyed by anki_cards block id. The session
// delete gate uses it to tell a live pipeline from a crash leftover, and the
// kill switch cancels every registered pipeline through it.

/** `ChatAnkiPipelineGuard`: registered on creation, deregistered by `release()` (Rust `Drop`). */
export interface ChatAnkiPipelineGuard {
  readonly ankiBlockId: string;
  /** The guard's `CancellationToken`: kill switch cancel, or the tool call's own cancellation (child token). */
  isCancelled(): boolean;
  release(): void;
}

interface PipelineToken {
  cancelled: boolean;
  parentCancelled: (() => boolean) | null;
}

function tokenCancelled(token: PipelineToken): boolean {
  return token.cancelled || (token.parentCancelled?.() ?? false);
}

export class ChatAnkiPipelineRegistry {
  private readonly active = new Map<string, PipelineToken>();

  /** `ChatAnkiPipelineGuard::register`: a later registration for the same block replaces the earlier one. */
  register(ankiBlockId: string, parentCancelled: (() => boolean) | null): ChatAnkiPipelineGuard {
    const token: PipelineToken = { cancelled: false, parentCancelled };
    this.active.set(ankiBlockId, token);
    return {
      ankiBlockId,
      isCancelled: () => tokenCancelled(token),
      // `Drop` removes the key, whichever registration currently holds it.
      release: () => { this.active.delete(ankiBlockId); },
    };
  }

  /** `is_chatanki_pipeline_active`. */
  isActive(ankiBlockId: string): boolean {
    return this.active.has(ankiBlockId);
  }

  /** `cancel_all_active_chatanki_pipelines`: non-destructive cancel; returns how many were newly cancelled. */
  cancelAll(reason: string, warn: (message: string) => void): number {
    let cancelled = 0;
    for (const [ankiBlockId, token] of this.active) {
      if (tokenCancelled(token)) continue;
      token.cancelled = true;
      cancelled += 1;
      warn(`[ChatAnkiToolExecutor] cancel_all_active_chatanki_pipelines: cancelled pipeline for block ${ankiBlockId} (reason: ${reason})`);
    }
    return cancelled;
  }
}
