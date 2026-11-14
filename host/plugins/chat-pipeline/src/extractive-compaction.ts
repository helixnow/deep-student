export interface CompactionMessage {
  id?: string;
  role: string;
  content?: unknown;
  tool_calls?: readonly unknown[];
  tool_call?: unknown;
  tool_result?: unknown;
  tool_call_id?: string;
  checkpoint?: unknown;
  status?: string;
  interrupted?: boolean;
}

export interface ConversationTurnUnit<M extends CompactionMessage = CompactionMessage> {
  readonly id: string;
  readonly messages: readonly M[];
  readonly protected: boolean;
}

function requiresProtection(message: CompactionMessage): boolean {
  return message.role === 'tool' || Boolean(message.tool_calls?.length || message.tool_call
    || message.tool_result || message.tool_call_id || message.checkpoint || message.interrupted)
    || ['pending', 'suspended', 'interrupted', 'incomplete', 'running'].includes(message.status ?? '');
}

/** Leading system messages are outside turns and always retained by the planner. */
export function buildConversationTurnUnits<M extends CompactionMessage>(
  messages: readonly M[],
): ConversationTurnUnit<M>[] {
  const groups: Array<{ id: string; messages: M[] }> = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') groups.push({ id: message.id ?? `turn:${index}`, messages: [message] });
    else groups.at(-1)?.messages.push(message);
  }
  return groups.map((group, index) => ({ ...group,
    protected: index >= groups.length - 2 || group.messages.some(requiresProtection) }));
}

export interface TurnDecision { turnId: string; omitProbability: number }
export interface CompactionBatch {
  currentQuestion: string;
  recentTurns: Array<{ id: string; messages: Array<{ role: string; content: string }> }>;
  turns: Array<{ id: string; messages: Array<{ role: string; content: string }> }>;
}
export type TurnDecider = (batch: CompactionBatch) => Promise<readonly TurnDecision[]>;
export interface ExtractiveCompactionPlan<M extends CompactionMessage> {
  turns: readonly ConversationTurnUnit<M>[];
  omittedTurnIds: readonly string[];
  messages: readonly M[];
}

const MAX_BYTES = 30_000;
const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const textTurn = (turn: ConversationTurnUnit): CompactionBatch['turns'][number] => ({
  id: turn.id,
  messages: turn.messages.map(message => ({ role: message.role,
    content: typeof message.content === 'string' ? message.content : '' })),
});

/** Extractive, session-local plans; no summaries and no changes to source history. */
export class ExtractiveTurnCompactor {
  private readonly cache = new Map<string, Map<string, { source: string; omit: boolean }>>();
  private readonly decide: TurnDecider;

  constructor(decide: TurnDecider) {
    this.decide = decide;
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) this.cache.clear();
    else this.cache.delete(conversationId);
  }

  async compact<M extends CompactionMessage>(messages: readonly M[], options: {
    conversationId: string; currentQuestion?: string;
  }): Promise<ExtractiveCompactionPlan<M>> {
    const turns = buildConversationTurnUnits(messages);
    let cache = this.cache.get(options.conversationId);
    if (!cache) { cache = new Map(); this.cache.set(options.conversationId, cache); }
    const sources = new Map(turns.map(turn => [turn.id, JSON.stringify(turn.messages)]));
    for (const [id, entry] of cache) {
      if (sources.get(id) !== entry.source) cache.delete(id);
    }
    const candidates = turns.slice(0, -2).slice(-32).filter(turn => !turn.protected && !cache.has(turn.id));
    const base = { currentQuestion: options.currentQuestion ?? '', recentTurns: turns.slice(-2).map(textTurn) };
    const batches: CompactionBatch[] = [];
    let batch: CompactionBatch = { ...base, turns: [] };
    for (const turn of candidates) {
      const text = textTurn(turn);
      // Include the complete envelope and protected recent context in the byte budget.
      if (byteLength({ ...base, turns: [text] }) > MAX_BYTES) continue;
      if (byteLength({ ...batch, turns: [...batch.turns, text] }) > MAX_BYTES) {
        batches.push(batch);
        batch = { ...base, turns: [] };
        if (batches.length === 4) break;
      }
      batch.turns.push(text);
    }
    if (batch.turns.length && batches.length < 4) batches.push(batch);
    // At most four requests, all independent. Failure retains the original turns.
    const results = await Promise.allSettled(batches.map(item => this.decide(item)));
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      for (const turn of batches[index]!.turns) {
        const decisions = result.value.filter(decision => decision.turnId === turn.id);
        // Missing, conflicting, non-finite and out-of-range probabilities never omit.
        const probability = decisions.length === 1 ? decisions[0]!.omitProbability : NaN;
        const omit = Number.isFinite(probability) && probability >= 0.95 && probability <= 1;
        cache.set(turn.id, { source: sources.get(turn.id)!, omit });
      }
    });
    const omitted = turns.filter(turn => !turn.protected && cache.get(turn.id)?.omit);
    const omittedMessages = new Set(omitted.flatMap(turn => [...turn.messages]));
    return { turns, omittedTurnIds: omitted.map(turn => turn.id),
      messages: messages.filter(message => !omittedMessages.has(message)) };
  }
}
