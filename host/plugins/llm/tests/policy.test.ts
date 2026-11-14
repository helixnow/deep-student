import { describe, expect, it } from 'vitest';
import { defaultFailoverPolicy, decodeFailoverPolicy } from '../src/policy.ts';

describe('routing.rs', () => {
  it('policy_deserializes_from_empty_object', () => {
    const policy = decodeFailoverPolicy('{}');
    expect(policy).toEqual(defaultFailoverPolicy());
    expect(policy.enabled).toBe(true);
    expect(policy.autoDegradeChat).toBe(false);
    expect(policy.keyCooldownSecs).toBe(60);
  });
  it('policy_roundtrip', () => {
    const policy = defaultFailoverPolicy();
    policy.autoDegradeChat = true;
    policy.defaultFallbacks = ['m-b'];
    policy.taskFallbacks.chat_title = ['m-cheap'];
    policy.purposeModels.compaction = 'm-cheap';
    expect(decodeFailoverPolicy(JSON.stringify(policy))).toEqual(policy);
  });
});
