import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import {
  INK_BOARD_DELTAS_STORE,
  INK_DRAFT_DB_NAME,
  INK_DRAFT_PAGES_STORE,
} from '../../../src/features/ink/inkDraftDatabase';
import { InkDraftDatabaseHarness } from './InkDraftDatabaseHarness';
import type { InkBoardDraftScenarioResult } from './InkDraftDatabaseHarness';
import {
  INK_DRAFT_DELTA_FIXTURE,
  INK_DRAFT_PAGES_FIXTURE,
  INK_DRAFT_SEQ1_FIXTURE,
  INK_DRAFT_SEQ2_FIXTURE,
  INK_DRAFT_SEQ3_CONFLICT_FIXTURE,
  INK_DRAFT_SEQ3_FIXTURE,
  INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE,
  INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE,
  INK_DRAFT_STORAGE_KEY,
} from './draftDatabaseFixtures';
import type { InkDraftDatabaseSnapshot } from './draftDatabaseFixtures';

test('upgrades a real v1 ink draft database to v2 in place, preserving pages and adding board deltas', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-prepare').click();
    await expect(status).toHaveAttribute('data-state', 'prepared');

    await component.getByTestId('ink-draft-db-open').click();
    await expect(status).toHaveAttribute('data-state', 'opened');

    const raw = await status.getAttribute('data-snapshot');
    if (!raw) throw new Error('The harness did not expose the upgraded database snapshot.');
    const snapshot = JSON.parse(raw) as InkDraftDatabaseSnapshot;

    expect(snapshot.name).toBe(INK_DRAFT_DB_NAME);
    expect(snapshot.version).toBe(2);
    expect(snapshot.objectStoreNames).toEqual([INK_BOARD_DELTAS_STORE, INK_DRAFT_PAGES_STORE].sort());
    expect(snapshot.oldPage).toEqual({ ...INK_DRAFT_PAGES_FIXTURE, key: INK_DRAFT_STORAGE_KEY });
    expect(snapshot.delta).toEqual(INK_DRAFT_DELTA_FIXTURE);
    expect(snapshot.databaseNames).toEqual([INK_DRAFT_DB_NAME]);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('does not leak the late success connection after a blocked v2 open', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-prepare').click();
    await expect(status).toHaveAttribute('data-state', 'prepared');

    await component.getByTestId('ink-draft-db-hold').click();
    await expect(status).toHaveAttribute('data-state', 'holding');

    await component.getByTestId('ink-draft-db-open-blocked').click();
    await expect(status).toHaveAttribute('data-state', 'blocked-rejected');
    await expect(status).toHaveAttribute('data-error', 'The ink draft store is blocked.');

    await component.getByTestId('ink-draft-db-release').click();
    await expect(status).toHaveAttribute('data-state', 'late-success');

    await component.getByTestId('ink-draft-db-delete').click();
    await expect(status).toHaveAttribute('data-state', 'deleted');
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('keeps the newer board draft when a stale sequence persists through another journal instance', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-stale').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([false, true]);
    expect(result.persists[1].error).toBeTruthy();
    expect(result.persists[1].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[1].reason).toBe('stale');
    expect(result.read).toEqual(INK_DRAFT_SEQ3_FIXTURE);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('does not resurrect a discarded board draft from a late stale sequence and leaves v1 pages intact', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-late').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([false, true]);
    expect(result.persists[1].error).toBeTruthy();
    expect(result.persists[1].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[1].reason).toBe('stale');
    expect(result.read).toBeNull();
    expect(result.pages).toEqual(INK_DRAFT_PAGES_FIXTURE);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('accepts an identical equal-sequence retry but rejects equal-sequence different content', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-equal').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([false, false, true]);
    expect(result.persists[2].error).toBeTruthy();
    expect(result.persists[2].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[2].reason).toBe('stale');
    expect(result.read).toEqual(INK_DRAFT_SEQ3_FIXTURE);
    expect(result.read).not.toEqual(INK_DRAFT_SEQ3_CONFLICT_FIXTURE);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('rejects an old owner even with a larger sequence and keeps the new owner draft', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-owner').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true]);
    expect(result.persists[0].error).toBeTruthy();
    expect(result.persists[0].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[0].reason).toBe('ownership');
    expect(result.read).toEqual(INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE);
    expect(result.read).not.toEqual(INK_DRAFT_SEQ4_OLD_OWNER_FIXTURE);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('claim adopts an existing owner draft without losing content and fences the previous owner', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-claim-existing').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    const claim = result.claims?.[0];
    expect(claim?.owner).toBe('claim-owner');
    expect(claim?.sequence_floor).toBe(3);
    expect(claim?.draft).toEqual({ ...INK_DRAFT_SEQ3_NEW_OWNER_FIXTURE, owner: 'claim-owner' });

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true, false]);
    expect(result.persists[0].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[0].reason).toBe('ownership');
    expect(result.read).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      sequence: 4,
      owner: 'claim-owner',
      updated_at: 4,
    });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('claim on missing state creates an owner tombstone and fences unowned and previous owners', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-claim-missing').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    const [firstClaim, secondClaim] = result.claims ?? [];
    expect(firstClaim?.owner).toBe('owner-a');
    expect(firstClaim?.sequence_floor).toBe(0);
    expect(firstClaim?.draft).toBeUndefined();
    expect(secondClaim?.owner).toBe('owner-b');
    expect(secondClaim?.sequence_floor).toBe(1);
    expect(secondClaim?.draft).toEqual({ ...INK_DRAFT_SEQ1_FIXTURE, owner: 'owner-b' });

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true, false, true, false]);
    expect(result.persists[0].errorName).toBe('DraftWriteRejectedError');
    expect(result.persists[0].reason).toBe('ownership');
    expect(result.persists[2].reason).toBe('ownership');
    expect(result.read).toEqual({ ...INK_DRAFT_SEQ2_FIXTURE, owner: 'owner-b' });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('claim is the only adopter for a legacy unowned draft and read does not mutate it', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-claim-legacy').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.reads?.[0]).toEqual(INK_DRAFT_SEQ3_FIXTURE);
    expect(result.storedRaw).toEqual(INK_DRAFT_SEQ3_FIXTURE);

    const claim = result.claims?.[0];
    expect(claim?.owner).toBe('claimer');
    expect(claim?.sequence_floor).toBe(3);
    expect(claim?.draft).toEqual({ ...INK_DRAFT_SEQ3_FIXTURE, owner: 'claimer' });

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true, true, false]);
    expect(result.persists[0].reason).toBe('ownership');
    expect(result.persists[1].reason).toBe('ownership');
    expect(result.read).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      sequence: 4,
      owner: 'claimer',
      updated_at: 4,
    });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('discard checks owner before sequence, preserves a newer draft, and tombstones the floor with owner', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-discard-owner').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    const [firstClaim, secondClaim] = result.claims ?? [];
    expect(firstClaim?.owner).toBe('owner-a');
    expect(firstClaim?.sequence_floor).toBe(0);
    expect(firstClaim?.draft).toBeUndefined();

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([false, true, false]);
    expect(result.discards?.map((attempt) => attempt.rejected)).toEqual([true, false, false]);
    expect(result.discards?.[0].errorName).toBe('DraftWriteRejectedError');
    expect(result.discards?.[0].reason).toBe('ownership');

    expect(result.reads?.[0]).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      sequence: 5,
      owner: 'owner-a',
      updated_at: 5,
    });
    expect(result.reads?.[1]).toBeNull();

    expect(secondClaim?.owner).toBe('owner-b');
    expect(secondClaim?.sequence_floor).toBe(5);
    expect(secondClaim?.draft).toBeUndefined();
    expect(result.persists[1].reason).toBe('ownership');
    expect(result.read).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      sequence: 6,
      owner: 'owner-b',
      updated_at: 6,
    });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('rejects envelopes whose key, inner draft id, or owner disagree without touching raw rows', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-corrupt-envelope').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.claimAttempts?.map((attempt) => attempt.rejected)).toEqual([true, true]);
    expect(result.claimAttempts?.[0].errorName).toBe('DraftStorageCorruptError');
    expect(result.claimAttempts?.[1].errorName).toBe('DraftStorageCorruptError');

    const snapshots = result.rawSnapshots ?? [];
    const rawA = snapshots.find((entry) => entry.document_id === 'fixture-corrupt-envelope-a')?.value;
    const rawB = snapshots.find((entry) => entry.document_id === 'fixture-corrupt-envelope-b')?.value;
    const rawC = snapshots.find((entry) => entry.document_id === 'fixture-corrupt-envelope-c')?.value;
    expect(rawA).toEqual({
      kind: 'draft',
      document_id: 'fixture-corrupt-envelope-a',
      owner: 'outer-owner',
      draft: {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: 'fixture-corrupt-envelope-b',
        owner: 'outer-owner',
      },
    });
    expect(rawB).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      document_id: 'fixture-corrupt-envelope-b',
      owner: 'inner-owner',
    });
    expect(rawC).toEqual({
      kind: 'draft',
      document_id: 'fixture-corrupt-envelope-c',
      owner: 'envelope-owner',
      draft: {
        ...INK_DRAFT_SEQ3_FIXTURE,
        document_id: 'fixture-corrupt-envelope-c',
        owner: 'draft-owner',
      },
    });
    expect(result.read).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      document_id: 'fixture-corrupt-envelope-b',
      owner: 'inner-owner',
    });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('rejects non-finite stored and incoming rect values instead of equating NaN with null', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-nonfinite').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true, true, true]);
    expect(result.persists[0].errorName).toBe('DraftStorageCorruptError');
    expect(result.persists[1].errorName).toBe('DraftStorageCorruptError');
    expect(result.persists[2].errorName).toBe('DraftStorageCorruptError');
    expect(result.read?.sequence).toBe(3);
    expect(result.read?.updated_at).toBe(3);
    expect(result.read?.changed[0].chunk_id).toBe('fixture-board-chunk-invalid-nonfinite');
    const content = result.read?.changed[0].objects[0].content as
      { rect?: { width?: number } } | undefined;
    expect(content?.rect?.width).toBe(4);
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('keeps the highest sequence when two journal instances persist seq3 and seq4 concurrently', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-concurrent').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.read?.sequence).toBe(4);
    expect(result.read?.changed[0].chunk_id).toBe('fixture-board-chunk-concurrent-four');
    expect(result.persists[1].rejected).toBe(false);
    expect(result.persists.some((attempt) => !attempt.rejected)).toBe(true);
    if (result.persists[0].rejected) {
      expect(result.persists[0].errorName).toBe('DraftWriteRejectedError');
      expect(result.persists[0].reason).toBe('stale');
    }
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});

test('rejects cyclic and over-deep draft payloads without changing valid raw drafts', async ({ mount }) => {
  const component = await mount(<InkDraftDatabaseHarness />);
  const status = component.getByTestId('ink-draft-db-status');
  try {
    await component.getByTestId('ink-draft-db-scenario-resource-boundary').click();
    await expect(status).toHaveAttribute('data-state', 'scenario-done');

    const raw = await status.getAttribute('data-result');
    if (!raw) throw new Error('The harness did not expose the board draft read result.');
    const result = JSON.parse(raw) as InkBoardDraftScenarioResult;

    expect(result.persists.map((attempt) => attempt.rejected)).toEqual([true, true]);
    expect(result.persists[0].errorName).toBe('DraftStorageCorruptError');
    expect(result.persists[1].errorName).toBe('DraftStorageCorruptError');

    const snapshots = result.rawSnapshots ?? [];
    const rawCycle = snapshots.find((entry) => entry.document_id === 'fixture-resource-cycle')?.value;
    const rawDepth = snapshots.find((entry) => entry.document_id === 'fixture-resource-depth')?.value;
    expect(rawCycle).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      document_id: 'fixture-resource-cycle',
    });
    expect(rawDepth).toEqual({
      ...INK_DRAFT_SEQ3_FIXTURE,
      document_id: 'fixture-resource-depth',
    });
  } finally {
    await component.getByTestId('ink-draft-db-cleanup').click();
    await expect(status).toHaveAttribute('data-state', 'cleaned');
  }
});
