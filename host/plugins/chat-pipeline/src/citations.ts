import type { CitationAssignment, CitationLedger as Ledger, JsonValue } from '../api.ts';

/** Rust context.rs:118-207. All mutations are synchronous, matching the mutex critical section. */
export class CitationLedger implements Ledger {
  private readonly counters = new Map<string, number>();
  private readonly assignments = new Map<string, number>();
  assign(group: string, identity: string): CitationAssignment {
    const key = `${group}\u001f${identity}`;
    const existing = this.assignments.get(key);
    if (existing !== undefined) return { type_index: existing, is_new: false };
    const type_index = (this.counters.get(group) ?? 0) + 1;
    this.counters.set(group, type_index);
    this.assignments.set(key, type_index);
    return { type_index, is_new: true };
  }
  len(): number { return this.assignments.size; }
  isEmpty(): boolean { return this.assignments.size === 0; }
}

const ledgers = new Map<string, CitationLedger>();
export function citationLedgerForReply(sessionId: string, messageId: string, variantId?: string | null): CitationLedger {
  const key = `${sessionId}\u001f${messageId}\u001f${variantId ?? ''}`;
  const existing = ledgers.get(key);
  if (existing) return existing;
  const ledger = new CitationLedger();
  ledgers.set(key, ledger);
  while (ledgers.size > 64) ledgers.delete(ledgers.keys().next().value!);
  return ledger;
}

export function isRetrievalSourceTool(toolName: string): boolean {
  const stripped = toolName.startsWith('builtin-') ? toolName.slice(8) : toolName;
  return ['rag_search', 'multimodal_search', 'unified_search', 'web_search', 'arxiv_search', 'scholar_search', 'insight_recall'].includes(stripped);
}

export function sanitizeRetrievalOutputForLlm(toolName: string, output: JsonValue): JsonValue | null {
  if (!isRetrievalSourceTool(toolName) || output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const sanitized = structuredClone(output);
  delete sanitized.retrievalPlan;
  delete sanitized.capabilitySnapshot;
  if (Array.isArray(sanitized.sources)) for (const entry of sanitized.sources) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    delete entry.imageUrl;
    delete entry.imageCitation;
    delete entry.blob_hash;
    delete entry.retrievalProvenance;
    if (typeof entry.url !== 'string' || !(entry.url.startsWith('http://') || entry.url.startsWith('https://'))) delete entry.url;
  }
  return sanitized;
}
