import type { InkBoardDraftRecord } from '@/features/ink/boardDrafts';
import type { InkDraftRecord } from '@/features/ink/drafts';
import type { InkBoardChunk, InkPage } from '@/features/ink/types';

export const INK_DRAFT_DOCUMENT_ID = 'fixture-ink-draft-document';
export const INK_DRAFT_PAGE_ID = 'fixture-ink-draft-page';
export const INK_DRAFT_STORAGE_KEY = `${INK_DRAFT_DOCUMENT_ID}\u0000${INK_DRAFT_PAGE_ID}`;

const inkPageFixture: InkPage = {
  schema_version: 1,
  page_id: INK_DRAFT_PAGE_ID,
  objects: [
    {
      id: 'fixture-kept-stroke',
      author: 'user',
      created_at: 1,
      content: {
        kind: 'stroke',
        samples: [
          { x: 12, y: 20, pressure: 0.5 },
          { x: 108, y: 20, pressure: 0.5 },
        ],
        style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
      },
    },
  ],
};

export const INK_DRAFT_PAGES_FIXTURE: InkDraftRecord = {
  document_id: INK_DRAFT_DOCUMENT_ID,
  page_id: INK_DRAFT_PAGE_ID,
  base_revision: 'revision-v1-fixture',
  sequence: 1,
  page: inkPageFixture,
  updated_at: 1,
};

const boardChunkFixture: InkBoardChunk = {
  schema_version: 2,
  chunk_id: 'fixture-board-chunk',
  objects: [
    {
      id: 'fixture-board-rect',
      author: 'user',
      created_at: 2,
      z_index: 1,
      content: {
        kind: 'rect',
        rect: { x: 10, y: 20, width: 30, height: 40 },
        color: '#0000ffff',
        width: 2,
      },
    },
  ],
};

export const INK_DRAFT_DELTA_FIXTURE: InkBoardDraftRecord = {
  document_id: 'fixture-ink-board-document',
  page_id: 'fixture-ink-board-page',
  base_revision: 'revision-v2-fixture',
  sequence: 2,
  changed: [boardChunkFixture],
  deleted: ['fixture-deleted-board-object'],
  updated_at: 2,
};

export const INK_DRAFT_SEQ3_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_DELTA_FIXTURE,
  sequence: 3,
  changed: [{ ...boardChunkFixture, chunk_id: 'fixture-board-chunk-newer' }],
  updated_at: 3,
};

export const INK_DRAFT_SEQ1_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_DELTA_FIXTURE,
  sequence: 1,
  changed: [{ ...boardChunkFixture, chunk_id: 'fixture-board-chunk-stale' }],
  updated_at: 1,
};

export const INK_DRAFT_SEQ2_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_DELTA_FIXTURE,
  sequence: 2,
  changed: [{ ...boardChunkFixture, chunk_id: 'fixture-board-chunk-late' }],
  updated_at: 2,
};

export const INK_DRAFT_SEQ3_CONFLICT_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_SEQ3_FIXTURE,
  changed: [{ ...boardChunkFixture, chunk_id: 'fixture-board-chunk-equal-conflict' }],
};

export const INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_SEQ3_FIXTURE,
  owner: 'new-session',
};

export const INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE: InkBoardDraftRecord = {
  ...INK_DRAFT_SEQ3_FIXTURE,
  sequence: 4,
  changed: [{ ...boardChunkFixture, chunk_id: 'fixture-board-chunk-old-owner' }],
  owner: 'old-session',
  updated_at: 4,
};

export type InkDraftDatabaseSnapshot = {
  name: string;
  version: number;
  objectStoreNames: string[];
  databaseNames: string[];
  oldPage: ({ key: string } & InkDraftRecord) | undefined;
  delta: InkBoardDraftRecord | undefined;
};
