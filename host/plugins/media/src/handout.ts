import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim } from './transcript.ts';

const MAX_PROMPT_CHARS = 120_000;

export class CancellationToken {
  _cancelled = false;
  _listeners: Array<(value: boolean) => void> = [];
  isCancelled(): boolean { return this._cancelled; }
  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const listener of this._listeners) listener(true);
    this._listeners = [];
  }
  /** `tokio_util::sync::CancellationToken::cancelled` 的等待侧。 */
  cancelled(): Promise<void> {
    if (this._cancelled) return Promise.resolve();
    return new Promise(resolve => this._listeners.push(() => resolve()));
  }
}

/** `src/cmd/handout.rs:26-39` 的进程内注册表。 */
export class HandoutRegistry {
  _tokens = new Map<string, CancellationToken>();
  tokenFor(requestId: string | null | undefined): CancellationToken {
    if (requestId === null || requestId === undefined || requestId === '') return new CancellationToken();
    let token = this._tokens.get(requestId);
    if (token === undefined) { token = new CancellationToken(); this._tokens.set(requestId, token); }
    return token;
  }
  cancel(requestId: string): null { this.tokenFor(requestId).cancel(); return null; }
  release(requestId: string): null { this._tokens.delete(requestId); return null; }
}

export function checkPrompt(prompt: string): void {
  if (rustTrim(prompt) === '') throw new CommandError(AppError.validation('prompt is empty'));
  if ([...prompt].length > MAX_PROMPT_CHARS) throw new CommandError(AppError.validation('prompt too long'));
}

function cancelled(): CommandError {
  return new CommandError(AppError.validation('cancelled'));
}

/** `run_cancellable`（handout.rs:45-62）：取消即放弃在途调用。 */
export async function runCancellable(
  token: CancellationToken,
  future: Promise<{ assistant_message: string; cancelled: boolean }>
    | (() => Promise<{ assistant_message: string; cancelled: boolean }>),
): Promise<string> {
  if (token.isCancelled()) throw cancelled();
  // A future is only started once the token is known live (Rust never polls it otherwise).
  const running = typeof future === 'function' ? future() : future;
  const cancelledPromise = token.cancelled().then(() => { throw cancelled(); });
  // Whichever side loses the select! is dropped: its later settlement must not surface.
  running.catch(() => undefined);
  cancelledPromise.catch(() => undefined);
  const out = await Promise.race([running, cancelledPromise]);
  if (out.cancelled) throw cancelled();
  return out.assistant_message;
}
