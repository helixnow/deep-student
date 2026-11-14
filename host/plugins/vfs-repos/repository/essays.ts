/** Port of dstu-vfs essay_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type EssayRepository,
  type JsonValue,
  type ResourceLocation,
  type VfsCreateEssayParams,
  type VfsCreateEssaySessionParams,
  type VfsEssay,
  type VfsEssaySession,
  type VfsFolderItem,
} from '../api.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { ResourceRepo } from './resources.ts';
import { utcTimestamp } from './timestamps.ts';
import { rs, toRustJson, type RustSchema } from '../../../platform/serde-compat/index.ts';

const ESSAY_COLUMNS = `id, resource_id, title, essay_type,
  grading_result_json, score, session_id, round_number,
  grade_level, custom_prompt, dimension_scores_json,
  is_favorite, created_at, updated_at`;
const SESSION_COLUMNS = `id, title, essay_type, grade_level, custom_prompt,
  total_rounds, latest_score, is_favorite, created_at, updated_at, deleted_at`;


function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}

function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function optionalNumber(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : null;
}
function parseJson(raw: string | null): JsonValue | undefined {
  if (raw === null) return undefined;
  try { return JSON.parse(raw) as JsonValue; }
  catch { return undefined; }
}
/**
 * The only Rust writer is dstu-tutor essay_grading/pipeline.rs:525: `grading_result` is
 * `json!({"result", "overall_score": Option<f32>, "dimension_scores": Option<String>})` and
 * `dimension_scores` is a parsed `ParsedScore` (types.rs:44), so their f32 fields carry `.0`.
 * Values of any other shape are written as a plain `serde_json::Value`.
 */
const GRADING_RESULT_JSON: RustSchema = rs.union(rs.valueObject({ overall_score: rs.option(rs.f32) }), rs.value());
const DIMENSION_SCORES_JSON: RustSchema = rs.union(
  rs.valueObject({ total: rs.f32, max_total: rs.f32, dimensions: rs.vec(rs.valueObject({ score: rs.f32, max_score: rs.f32 })) }),
  rs.value(),
);

function serializeJson(value: JsonValue | null | undefined, schema: RustSchema): string | null {
  if (value === null || value === undefined) return null;
  try { return toRustJson(value, schema); }
  catch { return ''; }
}

function rowToEssay(row: Row): VfsEssay {
  const title = optionalText(row.title);
  const essayType = optionalText(row.essay_type);
  const gradingResult = parseJson(optionalText(row.grading_result_json));
  const score = optionalNumber(row.score);
  const sessionId = optionalText(row.session_id);
  const gradeLevel = optionalText(row.grade_level);
  const customPrompt = optionalText(row.custom_prompt);
  const dimensionScores = parseJson(optionalText(row.dimension_scores_json));
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    ...(title === null ? {} : { title }),
    ...(essayType === null ? {} : { essayType }),
    ...(gradingResult === undefined ? {} : { gradingResult }),
    ...(score === null ? {} : { score }),
    ...(sessionId === null ? {} : { sessionId }),
    roundNumber: optionalNumber(row.round_number) ?? 1,
    ...(gradeLevel === null ? {} : { gradeLevel }),
    ...(customPrompt === null ? {} : { customPrompt }),
    isFavorite: (optionalNumber(row.is_favorite) ?? 0) !== 0,
    ...(dimensionScores === undefined ? {} : { dimensionScores }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToSession(row: Row): VfsEssaySession {
  const latestScore = optionalNumber(row.latest_score);
  const deletedAt = optionalText(row.deleted_at);
  return {
    id: String(row.id),
    title: String(row.title),
    essay_type: optionalText(row.essay_type) ?? '',
    grade_level: optionalText(row.grade_level) ?? '',
    custom_prompt: optionalText(row.custom_prompt),
    total_rounds: Number(row.total_rounds),
    ...(latestScore === null ? {} : { latest_score: latestScore }),
    is_favorite: Number(row.is_favorite) !== 0,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    ...(deletedAt === null ? {} : { deleted_at: deletedAt }),
  };
}

function mapRows<T>(rows: readonly Row[], map: (row: Row) => T): T[] {
  const result: T[] = [];
  for (const row of rows) {
    try { result.push(map(row)); }
    catch (error) { logWarn('Row parse error (essay_repo):', error); }
  }
  return result;
}

function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export class EssayRepo implements EssayRepository {
  private readonly folders = new FolderRepo();
  private readonly resources = new ResourceRepo();

  listEssays(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsEssay[] {
    return databaseResult(() => {
      let sql = `SELECT e.id, e.resource_id, e.title, e.essay_type,
          e.grading_result_json, e.score, e.session_id, e.round_number,
          e.grade_level, e.custom_prompt, e.dimension_scores_json,
          e.is_favorite, e.created_at, e.updated_at
        FROM essays e
        WHERE 1=1 AND e.deleted_at IS NULL`;
      const params: (string | number)[] = [];
      let paramIndex = 1;
      if (search !== null) {
        sql += ` AND (e.title LIKE ?${paramIndex} ESCAPE '\\' OR EXISTS (SELECT 1 FROM resources r WHERE r.id = e.resource_id AND r.data LIKE ?${paramIndex + 1} ESCAPE '\\'))`;
        const pattern = `%${escapeLikePattern(search)}%`;
        params.push(pattern, pattern);
        paramIndex += 2;
      }
      sql += ` ORDER BY e.updated_at DESC LIMIT ?${paramIndex} OFFSET ?${paramIndex + 1}`;
      params.push(limit, offset);
      return mapRows(conn.all<Row>(sql, params), rowToEssay);
    });
  }

  listEssaysBySession(conn: SqlExecutor, sessionId: string): VfsEssay[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT ${ESSAY_COLUMNS}
      FROM essays
      WHERE session_id = ?1 AND deleted_at IS NULL
      ORDER BY round_number ASC, created_at ASC`, [sessionId]), rowToEssay));
  }

  getEssay(conn: SqlExecutor, essayId: string): VfsEssay | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${ESSAY_COLUMNS} FROM essays
        WHERE id = ?1 AND deleted_at IS NULL`, [essayId]);
      return row === undefined ? null : rowToEssay(row);
    });
  }

  getEssayContent(conn: SqlExecutor, essayId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT r.data
        FROM essays e
        JOIN resources r ON e.resource_id = r.id
        WHERE e.id = ?1 AND e.deleted_at IS NULL`, [essayId]);
      return row === undefined ? null : optionalText(row.data);
    });
  }

  searchEssays(conn: SqlExecutor, query: string, limit: number): VfsEssay[] {
    return this.listEssays(conn, query, limit, 0);
  }

  createEssay(conn: SqlExecutor, params: VfsCreateEssayParams): VfsEssay {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const essay = this.createEssayInternal(conn, params);
        conn.exec('COMMIT');
        return essay;
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  createEssayWithConn(conn: SqlExecutor, params: VfsCreateEssayParams): VfsEssay {
    return databaseResult(() => this.createEssayInternal(conn, params));
  }

  private createEssayInternal(conn: SqlExecutor, params: VfsCreateEssayParams): VfsEssay {
    const sessionId = params.sessionId ?? null;
    const roundNumber = params.roundNumber ?? 1;
    if (sessionId !== null) {
      const existingId = conn.pluck<string>(
        'SELECT id FROM essays WHERE session_id = ?1 AND round_number = ?2 AND deleted_at IS NULL',
        [sessionId, roundNumber]);
      if (existingId !== undefined) {
        const existing = this.getEssay(conn, existingId);
        if (existing !== null) return existing;
      }
    }

    const resource = this.resources.createOrReuse(conn, 'essay', params.content, null, 'essays', null);
    const essayId = `essay_${nanoid(10)}`;
    const now = utcTimestamp();
    const grading = serializeJson(params.gradingResult, GRADING_RESULT_JSON);
    const dimensions = serializeJson(params.dimensionScores, DIMENSION_SCORES_JSON);
    const title = params.title ?? null;
    const essayType = params.essayType ?? null;
    const score = params.score ?? null;
    const gradeLevel = params.gradeLevel ?? null;
    const customPrompt = params.customPrompt ?? null;

    conn.run(`INSERT INTO essays (id, resource_id, title, essay_type,
        grading_result_json, score, session_id, round_number,
        grade_level, custom_prompt, dimension_scores_json,
        created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    [essayId, resource.resourceId, title, essayType, grading, score, sessionId,
      roundNumber, gradeLevel, customPrompt, dimensions, now, now]);

    conn.run('UPDATE resources SET source_id = ?1 WHERE id = ?2', [essayId, resource.resourceId]);

    if (sessionId !== null) this.updateSessionStatsWithConn(conn, sessionId, score, now);

    return {
      id: essayId,
      resourceId: resource.resourceId,
      ...(title === null ? {} : { title }),
      ...(essayType === null ? {} : { essayType }),
      ...(params.gradingResult === null || params.gradingResult === undefined ? {} : { gradingResult: params.gradingResult }),
      ...(score === null ? {} : { score }),
      ...(sessionId === null ? {} : { sessionId }),
      roundNumber,
      ...(gradeLevel === null ? {} : { gradeLevel }),
      ...(customPrompt === null ? {} : { customPrompt }),
      isFavorite: false,
      ...(params.dimensionScores === null || params.dimensionScores === undefined ? {} : { dimensionScores: params.dimensionScores }),
      createdAt: now,
      updatedAt: now,
    };
  }

  private updateSessionStatsWithConn(conn: SqlExecutor, sessionId: string, latestScore: number | null,
    now: string = utcTimestamp()): void {
    const totalRounds = Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM essays WHERE session_id = ?1 AND deleted_at IS NULL', [sessionId]) ?? 0);
    conn.run(`UPDATE essay_sessions
      SET total_rounds = ?1, latest_score = COALESCE(?2, latest_score), updated_at = ?3
      WHERE id = ?4`, [totalRounds, latestScore, now, sessionId]);
  }

  updateGradingResult(conn: SqlExecutor, essayId: string, gradingResult: JsonValue,
    score: number | null): void {
    databaseResult(() => {
      let grading: string;
      try { grading = toRustJson(gradingResult, GRADING_RESULT_JSON); }
      catch (error) {
        throw new VfsRepositoryError('VFS_SERIALIZATION',
          `Serialization error: ${error instanceof Error ? error.message : String(error)}`);
      }
      const updated = conn.run(
        'UPDATE essays SET grading_result_json = ?1, score = ?2, updated_at = ?3 WHERE id = ?4',
        [grading, score, utcTimestamp(), essayId]).changes;
      if (updated === 0) throw notFound('Essay', essayId);
    });
  }

  updateTitle(conn: SqlExecutor, essayId: string, title: string): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE essays SET title = ?1, updated_at = ?2 WHERE id = ?3',
        [title, utcTimestamp(), essayId]).changes;
      if (updated === 0) throw notFound('Essay', essayId);
    });
  }

  deleteEssay(conn: SqlExecutor, essayId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        'UPDATE essays SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
        [now, essayId]).changes;
      if (updated === 0) {
        let alreadyDeleted = false;
        try {
          alreadyDeleted = Number(conn.pluck<number>(
            'SELECT EXISTS(SELECT 1 FROM essays WHERE id = ?1 AND deleted_at IS NOT NULL)',
            [essayId]) ?? 0) !== 0;
        } catch (error) {
          logWarn('[VFS::EssayRepo] Failed to check soft-delete state:', error);
        }
        if (!alreadyDeleted) throw notFound('Essay', essayId);
      }
    });
  }

  purgeEssay(conn: SqlExecutor, essayId: string): void {
    databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        this.purgeEssayWithConn(conn, essayId);
        conn.exec('COMMIT');
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  purgeEssayWithConn(conn: SqlExecutor, essayId: string): void {
    databaseResult(() => {
      const resourceRow = conn.get<Row>(
        'SELECT resource_id FROM essays WHERE id = ?1', [essayId]);
      const resourceId = resourceRow === undefined ? null : optionalText(resourceRow.resource_id);
      const deleted = conn.run('DELETE FROM essays WHERE id = ?1', [essayId]).changes;
      if (deleted === 0) throw notFound('Essay', essayId);

      conn.run("DELETE FROM folder_items WHERE item_type = 'essay' AND item_id = ?1", [essayId]);

      if (resourceId !== null) {
        let refCount = 0;
        try {
          refCount = Number(conn.pluck<number>(
            'SELECT COUNT(*) FROM essays WHERE resource_id = ?1', [resourceId]) ?? 0);
        } catch (error) {
          logWarn('[VFS::EssayRepo] Failed to count resource references:', error);
        }
        if (refCount === 0) {
          purgeIndexArtifactsByResource(conn, resourceId);
          conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
        }
      }
    });
  }

  restoreEssay(conn: SqlExecutor, essayId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        'UPDATE essays SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL',
        [now, essayId]).changes;
      if (updated === 0) throw notFound('Essay', essayId);
      conn.run(`UPDATE folder_items SET deleted_at = NULL, updated_at = ?1
        WHERE item_type = 'essay' AND item_id = ?2 AND deleted_at IS NOT NULL`,
      [Date.now(), essayId]);
    });
  }

  listDeletedEssays(conn: SqlExecutor, limit: number, offset: number): VfsEssay[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT e.id, e.resource_id, e.title, e.essay_type,
        e.grading_result_json, e.score, e.session_id, e.round_number,
        e.grade_level, e.custom_prompt, e.dimension_scores_json,
        e.is_favorite, e.created_at, e.updated_at
      FROM essays e
      WHERE e.deleted_at IS NOT NULL
      ORDER BY e.deleted_at DESC
      LIMIT ?1 OFFSET ?2`, [limit, offset]), rowToEssay));
  }

  createSession(conn: SqlExecutor, params: VfsCreateEssaySessionParams): VfsEssaySession {
    return databaseResult(() => this.createSessionInternal(conn, params));
  }

  createSessionWithConn(conn: SqlExecutor, params: VfsCreateEssaySessionParams): VfsEssaySession {
    return databaseResult(() => this.createSessionInternal(conn, params));
  }

  private createSessionInternal(conn: SqlExecutor, params: VfsCreateEssaySessionParams): VfsEssaySession {
    const sessionId = `essay_session_${nanoid(10)}`;
    const now = utcTimestamp();
    const essayType = params.essayType ?? null;
    const gradeLevel = params.gradeLevel ?? null;
    const customPrompt = params.customPrompt ?? null;
    conn.run(`INSERT INTO essay_sessions (id, title, essay_type, grade_level, custom_prompt,
        total_rounds, is_favorite, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?7)`,
    [sessionId, params.title, essayType, gradeLevel, customPrompt, now, now]);
    return {
      id: sessionId,
      title: params.title,
      essay_type: essayType ?? '',
      grade_level: gradeLevel ?? '',
      custom_prompt: customPrompt,
      total_rounds: 0,
      is_favorite: false,
      created_at: now,
      updated_at: now,
    };
  }

  createSessionInFolder(conn: SqlExecutor, params: VfsCreateEssaySessionParams,
    folderId: string | null): VfsEssaySession {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
          throw notFound('Folder', folderId);
        }
        const session = this.createSessionInternal(conn, params);
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType: 'essay',
          itemId: session.id,
          sortOrder: 0,
          createdAt: Date.now(),
        };
        this.folders.addItemToFolder(conn, folderItem);
        conn.exec('COMMIT');
        return session;
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  getSession(conn: SqlExecutor, sessionId: string): VfsEssaySession | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${SESSION_COLUMNS} FROM essay_sessions
        WHERE id = ?1 AND deleted_at IS NULL`, [sessionId]);
      return row === undefined ? null : rowToSession(row);
    });
  }

  listSessions(conn: SqlExecutor, limit: number, offset: number): VfsEssaySession[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT ${SESSION_COLUMNS}
      FROM essay_sessions
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ?1 OFFSET ?2`, [limit, offset]), rowToSession));
  }

  countSessions(conn: SqlExecutor): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM essay_sessions WHERE deleted_at IS NULL') ?? 0));
  }

  updateSession(conn: SqlExecutor, sessionId: string, title: string | null,
    isFavorite: boolean | null, essayType: string | null, gradeLevel: string | null,
    customPrompt: string | null): void {
    databaseResult(() => {
      const now = utcTimestamp();
      let exists = false;
      try {
        exists = Number(conn.pluck<number>(
          'SELECT EXISTS(SELECT 1 FROM essay_sessions WHERE id = ?1)', [sessionId]) ?? 0) !== 0;
      } catch (error) {
        logWarn('[VFS::EssayRepo] Failed to check session existence:', error);
      }
      if (!exists) throw notFound('EssaySession', sessionId);
      if (title !== null) {
        conn.run('UPDATE essay_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3',
          [title, now, sessionId]);
      }
      if (isFavorite !== null) {
        conn.run('UPDATE essay_sessions SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
          [isFavorite ? 1 : 0, now, sessionId]);
      }
      if (essayType !== null) {
        conn.run('UPDATE essay_sessions SET essay_type = ?1, updated_at = ?2 WHERE id = ?3',
          [essayType, now, sessionId]);
      }
      if (gradeLevel !== null) {
        conn.run('UPDATE essay_sessions SET grade_level = ?1, updated_at = ?2 WHERE id = ?3',
          [gradeLevel, now, sessionId]);
      }
      if (customPrompt !== null) {
        conn.run('UPDATE essay_sessions SET custom_prompt = ?1, updated_at = ?2 WHERE id = ?3',
          [customPrompt, now, sessionId]);
      }
    });
  }

  purgeSession(conn: SqlExecutor, sessionId: string): number {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const count = this.purgeSessionWithConn(conn, sessionId);
        conn.exec('COMMIT');
        return count;
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  purgeSessionWithConn(conn: SqlExecutor, sessionId: string): number {
    return databaseResult(() => {
      const resourceIds = conn.all<Row>(
        'SELECT resource_id FROM essays WHERE session_id = ?1', [sessionId]).flatMap(row => {
        try {
          const value = optionalText(row.resource_id);
          return value === null ? [] : [value];
        } catch (error) {
          logWarn('Row parse error (essay_repo):', error);
          return [];
        }
      });
      const deletedEssays = conn.run('DELETE FROM essays WHERE session_id = ?1', [sessionId]).changes;
      conn.run('DELETE FROM essay_sessions WHERE id = ?1', [sessionId]);
      conn.run("DELETE FROM folder_items WHERE item_type = 'essay' AND item_id = ?1", [sessionId]);
      for (const resourceId of resourceIds) {
        let refCount = 0;
        try {
          refCount = Number(conn.pluck<number>(
            'SELECT COUNT(*) FROM essays WHERE resource_id = ?1', [resourceId]) ?? 0);
        } catch (error) {
          logWarn('[VFS::EssayRepo] Failed to count resource references:', error);
        }
        if (refCount === 0) {
          purgeIndexArtifactsByResource(conn, resourceId);
          conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
        }
      }
      return deletedEssays;
    });
  }

  deleteSession(conn: SqlExecutor, sessionId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        'UPDATE essay_sessions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
        [now, sessionId]).changes;
      if (updated === 0) {
        let alreadyDeleted = false;
        try {
          alreadyDeleted = Number(conn.pluck<number>(
            'SELECT EXISTS(SELECT 1 FROM essay_sessions WHERE id = ?1 AND deleted_at IS NOT NULL)',
            [sessionId]) ?? 0) !== 0;
        } catch (error) {
          logWarn('[VFS::EssayRepo] Failed to check soft-delete state:', error);
        }
        if (!alreadyDeleted) throw notFound('EssaySession', sessionId);
      }
    });
  }

  deleteSessionWithFolderItem(conn: SqlExecutor, sessionId: string): void {
    databaseResult(() => {
      this.deleteSession(conn, sessionId);
      conn.run(`UPDATE folder_items SET deleted_at = ?1, updated_at = ?2
        WHERE item_type = 'essay' AND item_id = ?3 AND deleted_at IS NULL`,
      [utcTimestamp(), Date.now(), sessionId]);
    });
  }

  restoreSession(conn: SqlExecutor, sessionId: string): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE essay_sessions SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL',
        [sessionId]).changes;
      if (updated === 0) throw notFound('EssaySession', sessionId);
      conn.run(`UPDATE folder_items SET deleted_at = NULL, updated_at = ?1
        WHERE item_type = 'essay' AND item_id = ?2 AND deleted_at IS NOT NULL`,
      [Date.now(), sessionId]);
    });
  }

  listDeletedSessions(conn: SqlExecutor, limit: number, offset: number): VfsEssaySession[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT ${SESSION_COLUMNS}
      FROM essay_sessions
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
      LIMIT ?1 OFFSET ?2`, [limit, offset]), rowToSession));
  }

  getRoundsBySession(conn: SqlExecutor, sessionId: string): VfsEssay[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT ${ESSAY_COLUMNS}
      FROM essays
      WHERE session_id = ?1 AND deleted_at IS NULL
      ORDER BY round_number ASC, created_at ASC`, [sessionId]), rowToEssay));
  }

  countRoundsBySession(conn: SqlExecutor, sessionId: string): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM essays WHERE session_id = ?1 AND deleted_at IS NULL',
      [sessionId]) ?? 0));
  }

  listRoundsBySession(conn: SqlExecutor, sessionId: string, limit: number, offset: number): VfsEssay[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT ${ESSAY_COLUMNS}
      FROM essays
      WHERE session_id = ?1 AND deleted_at IS NULL
      ORDER BY round_number ASC, created_at ASC
      LIMIT ?2 OFFSET ?3`, [sessionId, limit, offset]), rowToEssay));
  }

  getLatestRoundNumber(conn: SqlExecutor, sessionId: string): number {
    return databaseResult(() => {
      let round = 0;
      try {
        round = Number(conn.pluck<number>(
          'SELECT COALESCE(MAX(round_number), 0) FROM essays WHERE session_id = ?1 AND deleted_at IS NULL',
          [sessionId]) ?? 0);
      } catch (error) {
        logWarn('[VFS::EssayRepo] Failed to read latest round:', error);
      }
      return round;
    });
  }

  getRound(conn: SqlExecutor, sessionId: string, roundNumber: number): VfsEssay | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${ESSAY_COLUMNS} FROM essays
        WHERE session_id = ?1 AND round_number = ?2 AND deleted_at IS NULL`,
      [sessionId, roundNumber]);
      return row === undefined ? null : rowToEssay(row);
    });
  }

  toggleSessionFavorite(conn: SqlExecutor, sessionId: string): boolean {
    return databaseResult(() => {
      const row = conn.get<Row>(
        'SELECT is_favorite FROM essay_sessions WHERE id = ?1', [sessionId]);
      if (row === undefined) throw notFound('EssaySession', sessionId);
      const newState = Number(row.is_favorite) === 0;
      const updated = conn.run(
        'UPDATE essay_sessions SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [newState ? 1 : 0, utcTimestamp(), sessionId]).changes;
      if (updated === 0) throw notFound('EssaySession', sessionId);
      return newState;
    });
  }

  createEssayInFolder(conn: SqlExecutor, params: VfsCreateEssayParams,
    folderId: string | null): VfsEssay {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
          throw notFound('Folder', folderId);
        }
        const essay = this.createEssayInternal(conn, params);
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType: 'essay',
          itemId: essay.id,
          sortOrder: 0,
          createdAt: Date.now(),
        };
        this.folders.addItemToFolder(conn, folderItem);
        conn.exec('COMMIT');
        return essay;
      } catch (error) {
        rollbackIgnoringFailure(conn);
        throw error;
      }
    });
  }

  deleteEssayWithFolderItem(conn: SqlExecutor, essayId: string): void {
    databaseResult(() => {
      this.deleteEssay(conn, essayId);
      conn.run(`UPDATE folder_items SET deleted_at = ?1, updated_at = ?2
        WHERE item_type = 'essay' AND item_id = ?3 AND deleted_at IS NULL`,
      [utcTimestamp(), Date.now(), essayId]);
    });
  }

  listEssaysByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsEssay[] {
    return databaseResult(() => mapRows(conn.all<Row>(`SELECT e.id, e.resource_id, e.title, e.essay_type,
        e.grading_result_json, e.score, e.session_id, e.round_number,
        e.grade_level, e.custom_prompt, e.dimension_scores_json,
        e.is_favorite, e.created_at, e.updated_at
      FROM essays e
      JOIN folder_items fi ON fi.item_type = 'essay' AND fi.item_id = e.id
      WHERE fi.folder_id IS ?1
      ORDER BY fi.sort_order ASC, e.updated_at DESC
      LIMIT ?2 OFFSET ?3`, [folderId, limit, offset]), rowToEssay));
  }

  getEssayLocation(conn: SqlExecutor, essayId: string): ResourceLocation | null {
    return databaseResult(() => this.folders.getResourceLocation(conn, 'essay', essayId));
  }

  listAllEssays(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsEssay[] {
    return this.listEssays(conn, search, limit, offset);
  }
}
