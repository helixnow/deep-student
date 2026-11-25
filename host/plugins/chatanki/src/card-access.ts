// Rust: chatanki_executor.rs:1775–1836 + dstu-agent workspace/card_read_scope.rs.
// L04 installs workspace read grants in L05's public registry. Read that same
// owner state; a private map here would silently hide real worker grants.
import type { AnkiCard, ChatAnkiCardRepository, ChatAnkiDocumentTaskRepository } from '../api.ts';
import type { ChatAnkiReviewSelector } from './executor-args.ts';
import { humanizeChatAnkiError } from './errors.ts';
import { errorText } from './execution.ts';
import { workspaceCardReadScope } from '../../agent-workspace/portable.ts';

export const STATUS_NOT_FOUND = 'blocks.ankiCards.errors.statusNotFound';
export const STATUS_NOT_FOUND_MESSAGE = humanizeChatAnkiError(STATUS_NOT_FOUND);

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
  if (!owned) throw new Error(STATUS_NOT_FOUND_MESSAGE);
}

/**
 * Returns true when `documentId` has live tasks and no chat session owns any of
 * them (e.g. cards manually created in Flashcards Library or imported via APKG/CSV).
 * Documents owned by another chat session always return false.
 */
export function isUnownedLibraryDocument(
  documents: Partial<Pick<ChatAnkiDocumentTaskRepository, 'getTasksForDocument' | 'getDocumentSessionSource'>> | null | undefined,
  documentId: string,
  warn?: (message: string) => void,
): boolean {
  if (
    documents === null
    || documents === undefined
    || typeof documents.getTasksForDocument !== 'function'
    || typeof documents.getDocumentSessionSource !== 'function'
  ) {
    return false;
  }
  try {
    const tasks = documents.getTasksForDocument(documentId);
    if (tasks.length === 0) return false;
    const owner = documents.getDocumentSessionSource(documentId);
    return owner === null || owner.trim().length === 0;
  } catch (caught) {
    warn?.(`[ChatAnkiToolExecutor] library document lookup failed for ${documentId}: ${errorText(caught)}`);
    return false;
  }
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
  throw new Error(STATUS_NOT_FOUND_MESSAGE);
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
  if (owned === null) throw new Error(STATUS_NOT_FOUND_MESSAGE);
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
