import { describe, expect, it } from 'vitest';
import {
  isStoreSubagentSession,
  isSubagentSession,
  isSubagentSessionId,
} from '../subagentSession';

describe('subagent session SSOT', () => {
  it('recognizes legacy and current session ID prefixes', () => {
    expect(isSubagentSessionId('agent_worker_1')).toBe(true);
    expect(isSubagentSessionId('subagent_research_1')).toBe(true);
    expect(isSubagentSessionId('sess_normal')).toBe(false);
  });

  it('recognizes persisted subagent semantics independently of session ID', () => {
    expect(isSubagentSession({ sessionId: 'sess_normal', mode: 'subagent' })).toBe(true);
    expect(isSubagentSession({
      sessionId: 'sess_normal',
      mode: 'chat',
      metadata: { is_subagent: true },
    })).toBe(true);
    expect(isSubagentSession({ sessionId: 'sess_normal', mode: 'chat' })).toBe(false);
  });

  it('recognizes subagent mode from store fields with a normal session ID', () => {
    expect(isStoreSubagentSession({
      sessionId: 'sess_normal',
      mode: 'subagent',
      sessionMetadata: null,
    })).toBe(true);
  });
});
