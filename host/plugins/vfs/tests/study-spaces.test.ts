import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  AnchorEdgeRecord,
  AnchorEdgesDeleteResult,
  AnchorEdgesUpsertResult,
  DstuNode,
  InboxFolderSummary,
  StudySpaceMount,
  StudySpaceProfile,
  VfsFolder,
} from '../api.ts';
import { buildLanceFilterExprFull } from '../../vfs-index/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: mount real L10 notes plugin for VFS integration tests
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: mount real L11 vfs-repos plugin for VFS integration tests
import reposPlugin from '../../vfs-repos/index.ts';

describe('Study Space profiles, zero-copy mounts, RAG mount scope, and anchor edges', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-study-spaces-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally {
      source.dispose();
    }
  }, 120_000);

  afterAll(() => {
    fs.rmSync(template, { recursive: true, force: true });
  }, 120_000);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-study-spaces-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({
      plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin],
      provide: { storage },
      app: { dataDir: root },
    });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);

  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const createFolder = (title: string, parentId?: string) =>
    invoke<VfsFolder>('dstu_folder_create', {
      title,
      ...(parentId === undefined ? {} : { parentId }),
    });

  const seedNoteWithIndex = (
    noteId: string,
    title: string,
    body: string,
    options: { deletedAt?: string | null; updatedAt?: string } = {},
  ): string => {
    const resourceId = `res_${noteId}`;
    conn.run(
      `INSERT INTO resources
         (id, hash, type, source_id, source_table, storage_mode, data, metadata_json,
          ref_count, created_at, updated_at, deleted_at, index_state)
       VALUES (?1, ?2, 'note', ?3, 'notes', 'inline', ?4, ?5, 0, 1, 1, ?6, 'pending')`,
      [
        resourceId,
        `hash_${noteId}`,
        noteId,
        body,
        JSON.stringify({ title }),
        options.deletedAt !== null && options.deletedAt !== undefined ? 1 : null,
      ],
    );
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4, ?5, NULL)`,
      [
        noteId,
        resourceId,
        title,
        options.updatedAt ?? '2026-01-02T00:00:00.000Z',
        options.deletedAt ?? null,
      ],
    );
    conn.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
          created_at, updated_at)
       VALUES (?1, ?2, 0, ?3, 'native', 1, 'indexed', 1, 1)`,
      [`unit_${noteId}`, resourceId, body],
    );
    conn.run(
      `INSERT INTO vfs_index_segments
         (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
          created_at, updated_at)
       VALUES (?1, ?2, 0, 'text', 128, ?3, ?4, 1, 1)`,
      [`seg_${noteId}`, `unit_${noteId}`, `row_${noteId}`, body],
    );
    return resourceId;
  };

  const seedMembership = (folderId: string | null, itemType: string, itemId: string) =>
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
       VALUES (?1, ?2, ?3, ?4, 0, 1)`,
      [`fi_${itemId}`, folderId, itemType, itemId],
    );

  it('provisions fld_inbox idempotently with sort_order -1000 and orders it first in root dstu_list', async () => {
    const mathFolder = await createFolder('高等数学');
    const physicsFolder = await createFolder('大学物理');

    const first = await invoke<InboxFolderSummary>('vfs_ensure_inbox_folder');
    expect(first).toEqual({ id: 'fld_inbox', title: 'Inbox' });
    const changesBefore = conn.pluck('SELECT COUNT(*) FROM __change_log');

    const second = await invoke<InboxFolderSummary>('vfs_ensure_inbox_folder');
    expect(second).toEqual({ id: 'fld_inbox', title: 'Inbox' });
    expect(conn.pluck('SELECT COUNT(*) FROM __change_log')).toBe(changesBefore);

    const inboxRow = conn.get<{ sort_order: number; parent_id: string | null; deleted_at: number | null }>(
      `SELECT sort_order, parent_id, deleted_at FROM folders WHERE id = 'fld_inbox'`,
    );
    expect(inboxRow).toEqual({
      sort_order: -1000,
      parent_id: null,
      deleted_at: null,
    });

    const rootNodes = await invoke<DstuNode[]>('dstu_list', { path: '/' });
    expect(rootNodes.map((node) => node.id)).toEqual(['fld_inbox', mathFolder.id, physicsFolder.id]);

    // Soft-deleting fld_inbox and re-running ensureInboxFolder revives it cleanly
    conn.run(`UPDATE folders SET deleted_at = 1700000000000 WHERE id = 'fld_inbox'`);
    const revived = await invoke<InboxFolderSummary>('vfs_ensure_inbox_folder');
    expect(revived).toEqual({ id: 'fld_inbox', title: 'Inbox' });
    const revivedRow = conn.get<{ deleted_at: number | null }>(`SELECT deleted_at FROM folders WHERE id = 'fld_inbox'`);
    expect(revivedRow?.deleted_at).toBeNull();
  });

  it('validates StudySpaceProfile bounds, supports upsert/list/get, and cascade soft-deletes mounts on profile delete', async () => {
    const mathFolder = await createFolder('高等数学');
    const physicsFolder = await createFolder('大学物理');
    seedNoteWithIndex('note_shared', '线性代数基础', '特征值与特征向量');
    seedMembership(mathFolder.id, 'note', 'note_shared');

    expect(await invoke<StudySpaceProfile | null>('vfs_study_space_get_profile', { spaceId: 'grp_physics' })).toBeNull();

    const created = await invoke<StudySpaceProfile>('vfs_study_space_upsert_profile', {
      input: {
        spaceId: 'grp_physics',
        rootFolderId: physicsFolder.id,
      },
    });
    expect(created).toMatchObject({
      spaceId: 'grp_physics',
      rootFolderId: physicsFolder.id,
      examDate: null,
      dailyBudgetMinutes: 45,
      targetRetention: 0.9,
      workbenchLayoutPreset: 'split_reader_chat',
      defaultDeckId: null,
      memoryScope: 'space_and_global',
    });

    const updated = await invoke<StudySpaceProfile>('vfs_study_space_upsert_profile', {
      input: {
        spaceId: 'grp_physics',
        rootFolderId: physicsFolder.id,
        examDate: '2026-12-20',
        dailyBudgetMinutes: 90,
        targetRetention: 0.93,
        workbenchLayoutPreset: 'practice_review',
        defaultDeckId: '大学物理::电磁学',
        memoryScope: 'space_isolated',
      },
    });
    expect(updated).toMatchObject({
      spaceId: 'grp_physics',
      rootFolderId: physicsFolder.id,
      examDate: '2026-12-20',
      dailyBudgetMinutes: 90,
      targetRetention: 0.93,
      workbenchLayoutPreset: 'practice_review',
      defaultDeckId: '大学物理::电磁学',
      memoryScope: 'space_isolated',
    });

    const allProfiles = await invoke<StudySpaceProfile[]>('vfs_study_space_list_profiles');
    expect(allProfiles.map((p) => p.spaceId)).toEqual(['grp_physics']);

    // Validation bounds: dailyBudgetMinutes (5..480) & targetRetention (0.70..0.97)
    await expect(
      invoke('vfs_study_space_upsert_profile', {
        input: { spaceId: 'grp_bad', rootFolderId: physicsFolder.id, dailyBudgetMinutes: 4 },
      }),
    ).rejects.toContain('dailyBudgetMinutes');
    await expect(
      invoke('vfs_study_space_upsert_profile', {
        input: { spaceId: 'grp_bad', rootFolderId: physicsFolder.id, dailyBudgetMinutes: 481 },
      }),
    ).rejects.toContain('dailyBudgetMinutes');
    await expect(
      invoke('vfs_study_space_upsert_profile', {
        input: { spaceId: 'grp_bad', rootFolderId: physicsFolder.id, targetRetention: 0.69 },
      }),
    ).rejects.toContain('targetRetention');
    await expect(
      invoke('vfs_study_space_upsert_profile', {
        input: { spaceId: 'grp_bad', rootFolderId: physicsFolder.id, targetRetention: 0.98 },
      }),
    ).rejects.toContain('targetRetention');

    // Add a mount for grp_physics and verify profile delete cascades soft-delete to mounts
    await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'note',
        itemId: 'note_shared',
      },
    });
    expect((await invoke<StudySpaceMount[]>('vfs_space_mount_list', { spaceId: 'grp_physics' })).length).toBe(1);

    const deleted = await invoke<boolean>('vfs_study_space_delete_profile', { spaceId: 'grp_physics' });
    expect(deleted).toBe(true);
    expect(await invoke<StudySpaceProfile | null>('vfs_study_space_get_profile', { spaceId: 'grp_physics' })).toBeNull();
    expect(await invoke<StudySpaceMount[]>('vfs_space_mount_list', { spaceId: 'grp_physics' })).toEqual([]);
  });

  it('preserves zero-copy folder_items uniqueness, overlays mounted items/folders in dstu_list, rejects self/cyclic mounts, and expands RAG scope', async () => {
    const mathFolder = await createFolder('数学空间');
    const mathFormulasFolder = await createFolder('微积分公式表', mathFolder.id);
    const physicsFolder = await createFolder('物理空间');
    const physicsOpticsFolder = await createFolder('光学', physicsFolder.id);

    const calcResId = seedNoteWithIndex('note_calc', '多元微积分笔记', '拉格朗日乘数法与梯度散度定理');
    seedMembership(mathFolder.id, 'note', 'note_calc');

    const formulaResId = seedNoteWithIndex('note_formula', '高斯公式推导', '曲面积分与三重积分转换高斯散度');
    seedMembership(mathFormulasFolder.id, 'note', 'note_formula');

    const trashedResId = seedNoteWithIndex('note_trashed', '已归档草稿', '废弃草稿内容');
    seedMembership(mathFolder.id, 'note', 'note_trashed');

    // Verify canonical folder_items active unique index remains untouched
    const activeIdx = conn.pluck<number>(
      `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_folder_items_item_active_unique'`,
    );
    expect(activeIdx).toBe(1);

    // Before mounting: FTS retrieval scoped to physicsFolder does NOT return note_calc
    const beforeRag = await host.ctx.retrieval.search({
      queryText: '拉格朗日乘数法',
      queryImageBase64: null,
      queryImageMediaType: null,
      queryModality: 'text',
      topK: 5,
      folderIds: [physicsFolder.id],
      resourceIds: null,
      resourceTypes: null,
    });
    expect(beforeRag.result.hits).toHaveLength(0);

    // Mount note_calc into physicsFolder
    const mount = await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'note',
        itemId: 'note_calc',
      },
    });
    expect(mount).toMatchObject({
      spaceId: 'grp_physics',
      targetFolderId: physicsFolder.id,
      itemType: 'note',
      itemId: 'note_calc',
    });

    // Idempotent duplicate add returns existing active mount
    const duplicateMount = await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'note',
        itemId: 'note_calc',
      },
    });
    expect(duplicateMount.id).toBe(mount.id);

    // Zero-Copy Invariant: folder_items active row count for note_calc MUST stay 1!
    const activeFolderItemsCount = conn.pluck<number>(
      `SELECT COUNT(*) FROM folder_items WHERE item_id = 'note_calc' AND deleted_at IS NULL`,
    );
    expect(activeFolderItemsCount).toBe(1);

    // Also mount mathFormulasFolder and note_trashed (then soft-delete note_trashed)
    const folderMount = await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'folder',
        itemId: mathFormulasFolder.id,
      },
    });
    await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'note',
        itemId: 'note_trashed',
      },
    });
    conn.run(`UPDATE notes SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = 'note_trashed'`);
    conn.run(`UPDATE resources SET deleted_at = 1700000000000 WHERE id = ?1`, [trashedResId]);

    // dstu_list on physicsFolder overlays note_calc and mathFormulasFolder, while omitting trashed note_trashed
    const physicsList = await invoke<DstuNode[]>('dstu_list', {
      path: '/物理空间',
      options: { folderId: physicsFolder.id },
    });
    const listedIds = physicsList.map((n) => n.id);
    expect(listedIds).toContain(physicsOpticsFolder.id);
    expect(listedIds).toContain(mathFormulasFolder.id);
    expect(listedIds).toContain('note_calc');
    expect(listedIds).not.toContain('note_trashed');

    const mountedNoteNode = physicsList.find((n) => n.id === 'note_calc')!;
    expect(mountedNoteNode.metadata).toMatchObject({
      isMounted: true,
      mountId: mount.id,
      mountSpaceId: 'grp_physics',
      canonicalFolderId: mathFolder.id,
    });

    const mountedFolderNode = physicsList.find((n) => n.id === mathFormulasFolder.id)!;
    expect(mountedFolderNode.type).toBe('folder');
    expect(mountedFolderNode.metadata).toMatchObject({
      isMounted: true,
      mountId: folderMount.id,
      mountSpaceId: 'grp_physics',
      canonicalParentId: mathFolder.id,
    });

    // Self-mount & cycle rejections
    await expect(
      invoke('vfs_space_mount_add', {
        input: {
          spaceId: 'grp_math',
          targetFolderId: mathFolder.id,
          itemType: 'note',
          itemId: 'note_calc',
        },
      }),
    ).rejects.toContain('VALIDATION_ERROR');

    await expect(
      invoke('vfs_space_mount_add', {
        input: {
          spaceId: 'grp_physics',
          targetFolderId: physicsFolder.id,
          itemType: 'folder',
          itemId: physicsFolder.id,
        },
      }),
    ).rejects.toContain('VALIDATION_ERROR');

    await expect(
      invoke('vfs_space_mount_add', {
        input: {
          spaceId: 'grp_physics',
          targetFolderId: physicsFolder.id,
          itemType: 'folder',
          itemId: physicsOpticsFolder.id,
        },
      }),
    ).rejects.toContain('VALIDATION_ERROR');

    await expect(
      invoke('vfs_space_mount_add', {
        input: {
          spaceId: 'grp_physics',
          targetFolderId: physicsOpticsFolder.id,
          itemType: 'folder',
          itemId: physicsFolder.id,
        },
      }),
    ).rejects.toContain('VALIDATION_ERROR');

    // Verify resolveMountScopeForFolders & VfsLanceStore.buildFilterExprFull
    const resolvedScope = host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [physicsFolder.id]);
    expect(resolvedScope.effectiveFolderIds).toEqual(
      expect.arrayContaining([physicsFolder.id, physicsOpticsFolder.id, mathFormulasFolder.id]),
    );
    expect(resolvedScope.mountedResourceIds).toEqual([calcResId]);

    expect(
      buildLanceFilterExprFull({
        folderIds: [physicsFolder.id],
        mountedResourceIds: resolvedScope.mountedResourceIds,
      }),
    ).toBe(`(folder_id IN ('${physicsFolder.id}') OR resource_id IN ('${calcResId}'))`);
    expect(buildLanceFilterExprFull({ folderIds: [physicsFolder.id] })).toBe(
      `folder_id = '${physicsFolder.id}'`,
    );
    expect(buildLanceFilterExprFull({ folderIds: [physicsFolder.id, physicsOpticsFolder.id] })).toBe(
      `folder_id IN ('${physicsFolder.id}', '${physicsOpticsFolder.id}')`,
    );

    // Zero-reindex RAG retrieval immediately finds BOTH mounted note_calc AND note_formula inside mounted folder!
    const mountedNoteRag = await host.ctx.retrieval.search({
      queryText: '拉格朗日乘数法',
      queryImageBase64: null,
      queryImageMediaType: null,
      queryModality: 'text',
      topK: 5,
      folderIds: [physicsFolder.id],
      resourceIds: null,
      resourceTypes: null,
    });
    expect(mountedNoteRag.result.hits.map((h) => h.hit.identity.resourceId)).toEqual([calcResId]);

    const mountedFolderRag = await host.ctx.retrieval.search({
      queryText: '高斯散度',
      queryImageBase64: null,
      queryImageMediaType: null,
      queryModality: 'text',
      topK: 5,
      folderIds: [physicsFolder.id],
      resourceIds: null,
      resourceTypes: null,
    });
    expect(mountedFolderRag.result.hits.map((h) => h.hit.identity.resourceId)).toEqual([formulaResId]);

    // Unmount note_calc from physicsFolder -> disappears from physicsFolder listing and physics RAG while mathFolder stays intact
    const removed = await invoke<boolean>('vfs_space_mount_remove', { mountId: mount.id });
    expect(removed).toBe(true);

    const afterUnmountList = await invoke<DstuNode[]>('dstu_list', {
      path: '/物理空间',
      options: { folderId: physicsFolder.id },
    });
    expect(afterUnmountList.map((n) => n.id)).not.toContain('note_calc');

    const canonicalMathList = await invoke<DstuNode[]>('dstu_list', {
      path: '/数学空间',
      options: { folderId: mathFolder.id },
    });
    expect(canonicalMathList.map((n) => n.id)).toContain('note_calc');

    const afterUnmountRag = await host.ctx.retrieval.search({
      queryText: '拉格朗日乘数法',
      queryImageBase64: null,
      queryImageMediaType: null,
      queryModality: 'text',
      topK: 5,
      folderIds: [physicsFolder.id],
      resourceIds: null,
      resourceTypes: null,
    });
    expect(afterUnmountRag.result.hits).toHaveLength(0);

    // Re-mounting after soft-delete revives cleanly without unique index collision
    const remounted = await invoke<StudySpaceMount>('vfs_space_mount_add', {
      input: {
        spaceId: 'grp_physics',
        targetFolderId: physicsFolder.id,
        itemType: 'note',
        itemId: 'note_calc',
      },
    });
    expect(remounted.id).toBe(mount.id);
  });

  it('upserts, queries by multi-ID target, updates on conflict, and prunes vfs_anchor_edges by source', async () => {
    const upsertRes = await invoke<AnchorEdgesUpsertResult>('vfs_anchor_edges_upsert', {
      edges: [
        {
          sourceKind: 'mindmap',
          sourceResourceId: 'mm_42',
          sourceSubId: 'node_1',
          sourceAnchor: {
            kind: 'mindmap',
            resourceId: 'mm_42',
            nodeId: 'node_1',
            label: '牛顿第二定律',
          },
          sourceLabel: '牛顿第二定律推导框图',
          targetAnchor: {
            kind: 'pdf',
            resourceId: 'tb_physics',
            page: 12,
            rect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
            quote: 'F = dp / dt',
          },
          studySpaceId: 'grp_physics',
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          sourceKind: 'mindmap',
          sourceResourceId: 'mm_42',
          sourceSubId: 'node_2',
          sourceAnchorUri: 'ds-anchor://v1/mindmap/mm_42?node=node_2',
          sourceLabel: '动量守恒节点',
          targetKind: 'pdf',
          targetResourceId: 'res_tb_physics',
          targetLocatorKey: 'p:15',
          targetPage: 15,
          targetAnchorUri: 'ds-anchor://v1/pdf/res_tb_physics?page=15',
          studySpaceId: 'grp_physics',
          createdAt: 2000,
          updatedAt: 2000,
        },
        {
          sourceKind: 'note',
          sourceResourceId: 'note_99',
          sourceSubId: 'blk_7',
          sourceAnchor: {
            kind: 'note',
            resourceId: 'note_99',
            blockId: 'blk_7',
          },
          sourceLabel: '课堂录音重点摘录',
          targetAnchor: {
            kind: 'media',
            resourceId: 'tb_physics',
            startMs: 862000,
            endMs: 869500,
          },
          createdAt: 3000,
          updatedAt: 3000,
        },
      ],
    });
    expect(upsertRes).toEqual({ upserted: 3 });

    // Query PDF backlinks across both DSTU selectionSourceId ('tb_physics') and VFS resourceId ('res_tb_physics')
    const pdfEdges = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', {
      targetResourceIds: ['tb_physics', 'res_tb_physics'],
      targetKind: 'pdf',
    });
    expect(pdfEdges).toHaveLength(2);
    expect(pdfEdges[0]).toMatchObject({
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_42',
      sourceSubId: 'node_1',
      sourceLabel: '牛顿第二定律推导框图',
      targetKind: 'pdf',
      targetResourceId: 'tb_physics',
      targetLocatorKey: 'p:12',
      targetPage: 12,
      targetRect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
      studySpaceId: 'grp_physics',
    });
    expect(pdfEdges[0]!.edgeId).toMatch(/^edge_[0-9a-f]{16}$/);
    expect(pdfEdges[1]!.targetResourceId).toBe('res_tb_physics');
    expect(pdfEdges[1]!.targetPage).toBe(15);

    // Re-upserting node_1 updates label in-place via deterministic edge_id without adding rows
    await invoke<AnchorEdgesUpsertResult>('vfs_anchor_edges_upsert', {
      edges: [
        {
          sourceKind: 'mindmap',
          sourceResourceId: 'mm_42',
          sourceSubId: 'node_1',
          sourceAnchor: {
            kind: 'mindmap',
            resourceId: 'mm_42',
            nodeId: 'node_1',
            label: '牛顿第二定律',
          },
          sourceLabel: '更新后的牛顿第二定律节点',
          targetAnchor: {
            kind: 'pdf',
            resourceId: 'tb_physics',
            page: 12,
            rect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
            quote: 'F = dp / dt',
          },
          studySpaceId: 'grp_physics',
          createdAt: 1000,
          updatedAt: 4000,
        },
      ],
    });

    const afterUpdate = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', {
      targetResourceIds: ['tb_physics', 'res_tb_physics'],
      targetKind: 'pdf',
    });
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate[0]!.sourceLabel).toBe('更新后的牛顿第二定律节点');

    // Prune stale edges for mindmap mm_42 while keeping node_1's edgeId
    const pruned = await invoke<AnchorEdgesDeleteResult>('vfs_anchor_edges_delete_by_source', {
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_42',
      keepEdgeIds: [pdfEdges[0]!.edgeId],
    });
    expect(pruned).toEqual({ deleted: 1 });

    const remainingPdf = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', {
      targetResourceIds: ['tb_physics', 'res_tb_physics'],
      targetKind: 'pdf',
    });
    expect(remainingPdf.map((e) => e.edgeId)).toEqual([pdfEdges[0]!.edgeId]);

    // Media edge from note_99 is untouched
    const mediaEdges = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', {
      targetResourceIds: ['tb_physics'],
      targetKind: 'media',
    });
    expect(mediaEdges).toHaveLength(1);
    expect(mediaEdges[0]).toMatchObject({
      sourceKind: 'note',
      sourceResourceId: 'note_99',
      targetLocatorKey: 'ms:862000',
      targetStartMs: 862000,
      targetEndMs: 869500,
    });

    // Deleting all edges for mm_42 without keepEdgeIds clears the remaining edge
    const deletedAll = await invoke<AnchorEdgesDeleteResult>('vfs_anchor_edges_delete_by_source', {
      sourceKind: 'mindmap',
      sourceResourceId: 'mm_42',
    });
    expect(deletedAll).toEqual({ deleted: 1 });
    expect(
      await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', {
        targetResourceIds: ['tb_physics', 'res_tb_physics'],
        targetKind: 'pdf',
      }),
    ).toEqual([]);
  });

  it('retrieves grandchildren from canonical roots, mounted trees, and nested mounts, excluding deleted branches', async () => {
    const root = await createFolder('空间');
    const child = await createFolder('章节', root.id);
    const grandchild = await createFolder('小节', child.id);
    const shared = await createFolder('共享');
    const sharedChild = await createFolder('共享子目录', shared.id);
    const sharedGrandchild = await createFolder('共享孙目录', sharedChild.id);
    const nested = await createFolder('嵌套挂载');
    const dead = await createFolder('删除分支', root.id);
    const hiddenChild = await createFolder('不可见小节', dead.id);
    const expected = [grandchild, sharedGrandchild, nested].map((folder, index) => {
      const id = `note_nested_${index}`;
      const resource = seedNoteWithIndex(id, '嵌套资料', 'nestedscopeunique');
      seedMembership(folder.id, 'note', id);
      return resource;
    });
    seedNoteWithIndex('note_hidden_branch', '删除分支资料', 'nestedscopeunique');
    seedMembership(hiddenChild.id, 'note', 'note_hidden_branch');
    for (const [target, item, spaceId] of [[root, shared, 'space_root'], [shared, nested, 'space_shared']] as const) {
      await invoke('vfs_space_mount_add', { input: { spaceId, targetFolderId: target.id, itemType: 'folder', itemId: item.id } });
    }
    conn.run('UPDATE folders SET deleted_at = 1 WHERE id = ?1', [dead.id]);
    const scope = host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [root.id, root.id]);
    expect(new Set(scope.effectiveFolderIds)).toEqual(new Set([root, child, grandchild, shared, sharedChild, sharedGrandchild, nested].map(f => f.id)));
    const response = await host.ctx.retrieval.search({ queryText: 'nestedscopeunique', queryImageBase64: null,
      queryImageMediaType: null, queryModality: 'text', topK: 10, folderIds: [root.id], resourceIds: null, resourceTypes: null });
    expect(new Set(response.result.hits.map(hit => hit.hit.identity.resourceId))).toEqual(new Set(expected));
    expect(host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [dead.id]).effectiveFolderIds).toEqual([]);
    conn.run('UPDATE folders SET deleted_at = 1 WHERE id = ?1', [root.id]);
    expect(host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [root.id]).effectiveFolderIds).toEqual([]);
  });

  it('rejects overlay cycles, ancestor/descendant overlap, deleted folders and Inbox atomically', async () => {
    const a = await createFolder('A');
    const b = await createFolder('B');
    const child = await createFolder('B子', b.id);
    const grandchild = await createFolder('B孙', child.id);
    const dead = await createFolder('已删除');
    conn.run('UPDATE folders SET deleted_at = 1 WHERE id = ?1', [dead.id]);
    const mount = (spaceId: string, targetFolderId: string, itemId: string) => invoke('vfs_space_mount_add', {
      input: { spaceId, targetFolderId, itemType: 'folder', itemId },
    });
    await mount('space_a', a.id, b.id);
    await expect(mount('space_b', b.id, a.id)).rejects.toContain('VALIDATION_ERROR');
    await expect(mount('space_a', a.id, grandchild.id)).rejects.toContain('VALIDATION_ERROR');
    await expect(mount('space_b', grandchild.id, b.id)).rejects.toContain('VALIDATION_ERROR');
    await expect(mount('space_a', a.id, dead.id)).rejects.toContain('FOLDER_NOT_FOUND');
    await expect(mount('space_a', a.id, 'fld_inbox')).rejects.toContain('VALIDATION_ERROR');
    expect(conn.pluck('SELECT COUNT(*) FROM vfs_space_mounts WHERE deleted_at IS NULL')).toBe(1);
  });

  it('preserves profile fields on partial updates and rejects invalid root folders', async () => {
    const root = await createFolder('目标空间');
    const repo = host.ctx.vfsRepo.studySpaces;
    repo.upsertProfile(conn, { spaceId: 'space_partial', rootFolderId: root.id,
      dailyBudgetMinutes: 90, targetRetention: 0.95, examDate: '2026-12-01', defaultDeckId: 'deck_1' });
    const updated = repo.upsertProfile(conn, { spaceId: 'space_partial', rootFolderId: root.id, memoryScope: 'space_isolated' });
    expect(updated).toMatchObject({ dailyBudgetMinutes: 90, targetRetention: 0.95,
      examDate: '2026-12-01', defaultDeckId: 'deck_1', memoryScope: 'space_isolated' });
    expect(() => repo.upsertProfile(conn, { spaceId: 'space_invalid', rootFolderId: 'fld_missing' })).toThrow('FOLDER_NOT_FOUND');
    expect(() => repo.upsertProfile(conn, { spaceId: 'space_invalid', rootFolderId: 'fld_inbox' })).toThrow('VALIDATION_ERROR');
  });

  it('hides a mounted soft-deleted source even before its resource row is tombstoned', async () => {
    const root = await createFolder('目标');
    const resourceId = seedNoteWithIndex('note_soft_source', '草稿', 'softsourceunique');
    await invoke('vfs_space_mount_add', { input: { spaceId: 'space_soft', targetFolderId: root.id, itemType: 'note', itemId: 'note_soft_source' } });
    expect(host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [root.id]).mountedResourceIds).toEqual([resourceId]);
    conn.run("UPDATE notes SET deleted_at = '2026-11-11' WHERE id = 'note_soft_source'");
    expect(host.ctx.vfsRepo.studySpaces.resolveMountScopeForFolders(conn, [root.id]).mountedResourceIds).toEqual([]);
  });

  it('keeps distinct excerpts on the same PDF page and node, updates explicit edge IDs, and tolerates corrupt rect JSON', async () => {
    const base = { sourceKind: 'mindmap', sourceResourceId: 'mm_same', sourceSubId: 'node_same',
      sourceAnchor: { kind: 'mindmap', resourceId: 'mm_same', nodeId: 'node_same' } };
    const edges = [0.1, 0.5].map(x => ({ ...base, targetAnchor: { kind: 'pdf', resourceId: 'file_same', page: 218,
      rect: { x, y: 0.1, w: 0.2, h: 0.1 } } }));
    await invoke('vfs_anchor_edges_upsert', { edges });
    const records = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', { targetResourceIds: ['file_same'] });
    expect(records).toHaveLength(2);
    await invoke('vfs_anchor_edges_upsert', { edges: [{ ...edges[0], edgeId: records[0]!.edgeId, sourceLabel: '更新' }] });
    conn.run('UPDATE vfs_anchor_edges SET target_rect_json = ?1 WHERE edge_id = ?2', ['{broken', records[0]!.edgeId]);
    const after = await invoke<AnchorEdgeRecord[]>('vfs_anchor_edges_query_by_target', { targetResourceIds: ['file_same'] });
    expect(after).toHaveLength(2);
    expect(after.find(edge => edge.edgeId === records[0]!.edgeId)).toMatchObject({ sourceLabel: '更新', targetRect: null });
  });
});
