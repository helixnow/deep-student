import { describe, expect, it } from 'vitest';

import {
  canReferenceToChat,
  mapSourceToResourceType,
  type SourceDatabase,
} from '@/components/notes/learningHubApi';

describe('learningHubApi source-db contracts', () => {
  it('supports modern source databases in type contracts', () => {
    const chatV2: Extract<SourceDatabase, 'chat_v2'> = 'chat_v2';
    const examSessions: Extract<SourceDatabase, 'exam_sessions'> = 'exam_sessions';

    expect(chatV2).toBe('chat_v2');
    expect(examSessions).toBe('exam_sessions');
  });

  it('maps sourceDb to stable resource type contracts', () => {
    expect(mapSourceToResourceType('notes')).toEqual({ resourceType: 'note', typeId: 'note' });
    expect(mapSourceToResourceType('textbooks')).toEqual({ resourceType: 'file', typeId: 'textbook' });
    expect(mapSourceToResourceType('mistakes')).toEqual({ resourceType: 'file', typeId: 'file' });
    expect(mapSourceToResourceType('chat_v2')).toEqual({ resourceType: 'file', typeId: 'file' });
    expect(mapSourceToResourceType('exam_sessions')).toEqual({ resourceType: 'exam', typeId: 'exam' });
  });

  it('allows all supported source databases to reference into chat', () => {
    const sourceDbs: SourceDatabase[] = ['notes', 'textbooks', 'mistakes', 'chat_v2', 'exam_sessions'];

    sourceDbs.forEach((sourceDb) => {
      expect(canReferenceToChat({ sourceDb })).toBe(true);
    });

    expect(canReferenceToChat({})).toBe(false);
  });
});
