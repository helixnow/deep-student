/** Rust `CitationLedger::assign` (chat_v2/context.rs); field names follow the chat-pipeline port. */
export interface NumberingLedger {
  assign(group: string, identity: string): { type_index: number; is_new: boolean };
}

/** Per-reply ledger used when no chat pipeline registry is available. */
export class CitationLedger implements NumberingLedger {
  private readonly counters = new Map<string, number>();
  private readonly assignments = new Map<string, number>();

  assign(group: string, identity: string): { type_index: number; is_new: boolean } {
    const key = `${group}\u001f${identity}`;
    const existing = this.assignments.get(key);
    if (existing !== undefined) return { type_index: existing, is_new: false };
    const typeIndex = (this.counters.get(group) ?? 0) + 1;
    this.counters.set(group, typeIndex);
    this.assignments.set(key, typeIndex);
    return { type_index: typeIndex, is_new: true };
  }

  get size(): number {
    return this.assignments.size;
  }
}
