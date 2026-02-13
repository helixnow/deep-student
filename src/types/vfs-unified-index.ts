/**
 * VFS 统一索引类型定义
 */

/** 索引状态枚举 */
export type IndexState = 'pending' | 'indexing' | 'indexed' | 'failed' | 'disabled';

/** 各状态统计 */
export interface StateStats {
  pending: number;
  indexing: number;
  indexed: number;
  failed: number;
  disabled: number;
}

/** 维度统计 */
export interface DimensionStat {
  dimension: number;
  modality: string;
  count: number;
}

/** 索引状态总览 */
export interface IndexStatusSummary {
  totalUnits: number;
  textStats: StateStats;
  mmStats: StateStats;
  dimensions: DimensionStat[];
}

/** Unit 索引状态 */
export interface UnitIndexStatus {
  unitId: string;
  resourceId: string;
  unitIndex: number;
  hasImage: boolean;
  hasText: boolean;
  textSource: 'ocr' | 'native' | 'vl_summary' | null;
  textRequired: boolean;
  textState: IndexState;
  textError: string | null;
  textChunkCount: number;
  textEmbeddingDim: number | null;
  mmRequired: boolean;
  mmState: IndexState;
  mmError: string | null;
  mmEmbeddingDim: number | null;
  updatedAt: number;
}

/** 批量索引结果 */
export interface BatchIndexResult {
  successCount: number;
  failCount: number;
  total: number;
}

/** 向量维度信息 */
export interface EmbeddingDimInfo {
  dimension: number;
  modality: string;
  lanceTableName: string;
  recordCount: number;
}

/** 索引模式 */
export type IndexMode = 'text' | 'mm' | 'both';

/** 同步 Units 参数 */
export interface SyncUnitsParams {
  resourceId: string;
  resourceType: string;
  data?: string;
  ocrText?: string;
  ocrPagesJson?: string;
  blobHash?: string;
  pageCount?: number;
  extractedText?: string;
  previewJson?: string;
}
