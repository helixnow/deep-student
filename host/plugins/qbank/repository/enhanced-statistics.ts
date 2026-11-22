/**
 * `get_enhanced_statistics` 学习统计 SQL 查询（仓库层）。
 */
import type { DatabaseHandle, Row, SqlParams } from '../../../platform/storage/api.ts';

export interface BasicLearningStatistics {
  total_mistakes: number;
  tag_stats: Record<string, number>;
}

export interface MonthlyTrendPoint {
  month: string;
  count: number;
}

export interface EnhancedStatisticsDatabases {
  vfs?: DatabaseHandle | null;
  main?: DatabaseHandle | null;
  chatV2?: DatabaseHandle | null;
}

export interface LearningStatisticsSummary {
  basic_stats: BasicLearningStatistics;
  recent_additions: number;
  recent_growth: number;
  quality_score: number;
  monthly_trend: MonthlyTrendPoint[];
}

function safeCount(db: DatabaseHandle | null | undefined, sql: string, params: SqlParams = []): number {
  if (!db) return 0;
  try {
    const value = db.pluck<number>(sql, params);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    // SQLite aggregate failure returns zero per Rust unwrap_or_default parity.
    return 0;
  }
}

function safeAll(
  db: DatabaseHandle | null | undefined,
  sql: string,
  params: SqlParams = [],
): Row[] {
  if (!db) return [];
  try {
    return db.all<Row>(sql, params);
  } catch {
    // SQLite aggregate failure returns empty rows per Rust unwrap_or_default parity.
    return [];
  }
}

function addMonthlyRows(map: Map<string, number>, rows: Array<{ month?: unknown; count?: unknown }>): void {
  for (const row of rows) {
    if (typeof row.month === 'string' && /^\d{4}-\d{2}$/.test(row.month) && typeof row.count === 'number') {
      map.set(row.month, (map.get(row.month) ?? 0) + row.count);
    }
  }
}

function localYmd(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 聚合学习记录核心指标（对齐仪表盘 coreStats / coreCharts 字段口径，按 localtime 分桶）。 */
export function queryLearningStatistics(
  databases: EnhancedStatisticsDatabases,
  now: Date = new Date(),
): LearningStatisticsSummary {
  const { vfs, main } = databases;
  const recent7Start = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const prev7Start = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13));
  const prev7End = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  const questionsTotal = safeCount(vfs, 'SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL');
  const notesTotal = safeCount(vfs, 'SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL');
  const cardsTotal = safeCount(main, 'SELECT COUNT(*) FROM anki_cards WHERE deleted_at IS NULL');
  const totalRecords = questionsTotal + notesTotal + cardsTotal;

  const tagStats: Record<string, number> = {};
  for (const row of safeAll(
    vfs,
    `SELECT json_each.value AS tag, COUNT(*) AS total
     FROM questions, json_each(questions.tags)
     WHERE questions.deleted_at IS NULL AND TRIM(CAST(json_each.value AS TEXT)) <> ''
     GROUP BY json_each.value`,
  )) {
    if (typeof row.tag === 'string' && typeof row.total === 'number' && row.total > 0) {
      tagStats[row.tag] = (tagStats[row.tag] ?? 0) + row.total;
    }
  }
  for (const row of safeAll(
    vfs,
    `SELECT json_each.value AS tag, COUNT(*) AS total
     FROM notes, json_each(notes.tags)
     WHERE notes.deleted_at IS NULL AND notes.tags IS NOT NULL AND TRIM(CAST(json_each.value AS TEXT)) <> ''
     GROUP BY json_each.value`,
  )) {
    if (typeof row.tag === 'string' && typeof row.total === 'number' && row.total > 0) {
      tagStats[row.tag] = (tagStats[row.tag] ?? 0) + row.total;
    }
  }
  for (const row of safeAll(
    main,
    `SELECT json_each.value AS tag, COUNT(*) AS total
     FROM anki_cards, json_each(anki_cards.tags_json)
     WHERE anki_cards.deleted_at IS NULL AND anki_cards.tags_json IS NOT NULL AND TRIM(CAST(json_each.value AS TEXT)) <> ''
     GROUP BY json_each.value`,
  )) {
    if (typeof row.tag === 'string' && typeof row.total === 'number' && row.total > 0) {
      tagStats[row.tag] = (tagStats[row.tag] ?? 0) + row.total;
    }
  }

  const recentAdditions =
    safeCount(vfs, `SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1`, [recent7Start])
    + safeCount(vfs, `SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1`, [recent7Start])
    + safeCount(main, `SELECT COUNT(*) FROM anki_cards WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1`, [recent7Start]);

  const prevAdditions =
    safeCount(vfs, `SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1 AND DATE(created_at, 'localtime') <= ?2`, [prev7Start, prev7End])
    + safeCount(vfs, `SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1 AND DATE(created_at, 'localtime') <= ?2`, [prev7Start, prev7End])
    + safeCount(main, `SELECT COUNT(*) FROM anki_cards WHERE deleted_at IS NULL AND DATE(created_at, 'localtime') >= ?1 AND DATE(created_at, 'localtime') <= ?2`, [prev7Start, prev7End]);

  const recentGrowth = prevAdditions > 0
    ? Math.round(((recentAdditions - prevAdditions) / prevAdditions) * 100)
    : recentAdditions > 0
      ? 100
      : 0;

  const taggedQuestions = safeCount(
    vfs,
    `SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags <> '' AND tags <> '[]'`,
  );
  const explainedQuestions = safeCount(
    vfs,
    `SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL AND explanation IS NOT NULL AND TRIM(explanation) <> ''`,
  );
  const taggedNotes = safeCount(
    vfs,
    `SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND tags IS NOT NULL AND tags <> '' AND tags <> '[]'`,
  );
  const taggedCards = safeCount(
    main,
    `SELECT COUNT(*) FROM anki_cards WHERE deleted_at IS NULL AND tags_json IS NOT NULL AND TRIM(tags_json) <> '' AND tags_json <> '[]'`,
  );
  const qualityDenominator = totalRecords + questionsTotal;
  const qualityNumerator = taggedQuestions + explainedQuestions + taggedNotes + taggedCards;
  const qualityScore = qualityDenominator > 0
    ? Math.min(100, Math.round((qualityNumerator / qualityDenominator) * 100))
    : 0;

  const monthlyMap = new Map<string, number>();
  addMonthlyRows(monthlyMap, safeAll(vfs, `SELECT STRFTIME('%Y-%m', created_at, 'localtime') AS month, COUNT(*) AS count FROM questions WHERE deleted_at IS NULL AND created_at IS NOT NULL GROUP BY STRFTIME('%Y-%m', created_at, 'localtime')`));
  addMonthlyRows(monthlyMap, safeAll(vfs, `SELECT STRFTIME('%Y-%m', created_at, 'localtime') AS month, COUNT(*) AS count FROM notes WHERE deleted_at IS NULL AND created_at IS NOT NULL GROUP BY STRFTIME('%Y-%m', created_at, 'localtime')`));
  addMonthlyRows(monthlyMap, safeAll(main, `SELECT STRFTIME('%Y-%m', created_at, 'localtime') AS month, COUNT(*) AS count FROM anki_cards WHERE deleted_at IS NULL AND created_at IS NOT NULL GROUP BY STRFTIME('%Y-%m', created_at, 'localtime')`));

  const monthlyTrend: MonthlyTrendPoint[] = [...monthlyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-12)
    .map(([month, count]) => ({ month, count }));

  return {
    basic_stats: {
      total_mistakes: totalRecords,
      tag_stats: tagStats,
    },
    recent_additions: recentAdditions,
    recent_growth: recentGrowth,
    quality_score: qualityScore,
    monthly_trend: monthlyTrend,
  };
}
