// Rust: chatanki_executor.rs:1775–1836 + dstu-agent workspace/card_read_scope.rs.
// L04 installs workspace read grants in L05's public registry. Read that same
// owner state; a private map here would silently hide real worker grants.
import type { AnkiCard, ChatAnkiCardRepository } from '../api.ts';
import type { ChatAnkiReviewSelector } from './executor-args.ts';
import { errorText } from './execution.ts';
import { workspaceCardReadScope } from '../../agent-workspace/portable.ts';

export const STATUS_NOT_FOUND = 'blocks.ankiCards.errors.statusNotFound';

/** Write paths never consult the scope: this is the strict ownership check. */
export function verifyDocumentOwnership(
  repo: ChatAnkiCardRepository, documentId: string, sessionId: string,
  warn?: (message: string) => void,
): void {
  let owned = false;
  try { owned = repo.isDocumentOwnedBySession(documentId, sessionId); }
  catch (caught) {
    // chatanki_executor.rs:1783–1789: 查询失败记录 warn，但对调用方仍返回 statusNotFound。
    warn?.(`[ChatAnkiToolExecutor] verify_document_ownership failed for document ${documentId}: ${errorText(caught)}`);
    owned = false;
  }
  if (!owned) throw new Error(STATUS_NOT_FOUND);
}

/**
 * Read preflight for get_cards/status: caller-owned document, else a scoped
 * workspace coordinator's fully-owned document; everything else stays hidden.
 */
export function resolveChatankiReadSession(
  repo: ChatAnkiCardRepository, documentId: string, callerSessionId: string,
  warn?: (message: string) => void, info?: (message: string) => void,
): string {
  if (verifyDocumentOwnershipOk(repo, documentId, callerSessionId, warn)) return callerSessionId;
  const scope = workspaceCardReadScope(callerSessionId);
  if (scope !== null && verifyDocumentOwnershipOk(repo, documentId, scope.coordinatorSessionId, warn)) {
    // chatanki_executor.rs:1826-1832: only the coordinator-scope branch logs a hit.
    info?.('[ChatAnkiToolExecutor] read-only coordinator scope hit:'
      + ` worker=${callerSessionId}, workspace=${scope.workspaceId},`
      + ` coordinator=${scope.coordinatorSessionId}, document=${documentId}`);
    return scope.coordinatorSessionId;
  }
  throw new Error(STATUS_NOT_FOUND);
}

function verifyDocumentOwnershipOk(
  repo: ChatAnkiCardRepository, documentId: string, sessionId: string,
  warn?: (message: string) => void,
): boolean {
  // Rust uses verify_document_ownership(...).is_ok(): reuse its one query and
  // one warn-on-query-error path rather than swallowing the DB exception here.
  try { verifyDocumentOwnership(repo, documentId, sessionId, warn); return true; }
  catch { return false; }
}

export function loadOwnedChatankiCard(
  repo: ChatAnkiCardRepository, cardId: string, sessionId: string,
  warn?: (message: string) => void,
): { card: AnkiCard; documentId: string } {
  let owned: { card: AnkiCard; documentId: string } | null = null;
  try { owned = repo.loadOwnedCard(cardId, sessionId); }
  catch (caught) {
    // chatanki_executor.rs:12117–12136: repository failures log warn, then the
    // caller still answers statusNotFound (never leaks document existence).
    warn?.(`[ChatAnkiToolExecutor] Failed to resolve card ownership for ${cardId}:`
      + ` ${errorText(caught)}`);
    owned = null;
  }
  if (owned === null) throw new Error(STATUS_NOT_FOUND);
  return owned;
}

export function verifyAgentReviewCardOwnership(
  repo: ChatAnkiCardRepository, cardId: string, sessionId: string,
  warn?: (message: string) => void,
): void {
  loadOwnedChatankiCard(repo, cardId, sessionId, warn);
}

export interface ResolvedReviewSelection {
  cardIds: string[];
  expectedDocumentId: string | null;
}

/**
 * chatanki_executor.rs:12146–12175: document selectors re-resolve the live set
 * inside L15's transaction; card selectors preflight every owned card and its
 * full document ownership before enqueueing.
 */
export function resolveReviewSelection(
  repo: ChatAnkiCardRepository,
  sessionId: string,
  selector: ChatAnkiReviewSelector,
): ResolvedReviewSelection {
  if (selector.kind === 'document') {
    verifyDocumentOwnership(repo, selector.documentId, sessionId);
    return { cardIds: [], expectedDocumentId: selector.documentId };
  }
  const verifiedDocuments = new Set<string>();
  for (const cardId of selector.cardIds) {
    const owned = loadOwnedChatankiCard(repo, cardId, sessionId);
    if (!verifiedDocuments.has(owned.documentId)) {
      verifyDocumentOwnership(repo, owned.documentId, sessionId);
      verifiedDocuments.add(owned.documentId);
    }
  }
  return { cardIds: [...selector.cardIds], expectedDocumentId: null };
}
