import { describe, expect, it } from 'vitest';

import {
  buildHiddenDraftSessionMetadata,
  clearHiddenDraftSessionMetadata,
  getDraftSessionScope,
  getDraftSessionStorageKey,
  isHiddenDraftSessionMetadata,
} from '../../../src/chat-v2/pages/draftSession';

describe('draft session metadata', () => {
  it('marks a session as a hidden draft while preserving existing metadata', () => {
    const metadata = buildHiddenDraftSessionMetadata({ pinned: true }, 'chat:ungrouped');

    expect(metadata).toEqual({
      pinned: true,
      chatV2Draft: {
        hidden: true,
        scope: 'chat:ungrouped',
        version: 1,
      },
    });
    expect(isHiddenDraftSessionMetadata(metadata)).toBe(true);
  });

  it('removes only the hidden draft marker when promoting the session', () => {
    const promoted = clearHiddenDraftSessionMetadata({
      pinned: true,
      chatV2Draft: {
        hidden: true,
        scope: 'chat:ungrouped',
        version: 1,
      },
    });

    expect(promoted).toEqual({ pinned: true });
    expect(clearHiddenDraftSessionMetadata({
      chatV2Draft: {
        hidden: true,
        scope: 'chat:ungrouped',
        version: 1,
      },
    })).toBeNull();
  });

  it('scopes one reusable draft per chat mode and group', () => {
    expect(getDraftSessionScope('chat', null)).toBe('chat:ungrouped');
    expect(getDraftSessionScope('chat', '')).toBe('chat:ungrouped');
    expect(getDraftSessionScope('chat', 'grp_biology')).toBe('chat:group:grp_biology');
    expect(getDraftSessionStorageKey('chat:ungrouped')).toBe('chat-v2-draft-session-id:chat:ungrouped');
  });
});
