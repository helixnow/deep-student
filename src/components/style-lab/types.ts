/** 扫描数据类型定义 */

export type ComponentScanEntry = {
  id: string;
  label: string;
  target: boolean;
  refs: number;
  files: number;
  topFiles: string[];
  totalFileCount: number;
};

export type CssMetricEntry = {
  id: string;
  label: string;
  count: number;
  files: number;
  topFiles: string[];
  totalFileCount: number;
};

export type MigrationProgressEntry = {
  id: string;
  label: string;
  targetRefs: number;
  legacyRefs: number;
  total: number;
  percentage: number;
  targetIds: string[];
  legacyIds: string[];
};

export type ScanData = {
  generatedAt: string;
  scanDurationMs: number;
  summary: {
    totalFiles: number;
    tsxFiles: number;
    cssFiles?: number;
  };
  components: Record<string, ComponentScanEntry>;
  cssMetrics: Record<string, CssMetricEntry>;
  migrationProgress: MigrationProgressEntry[];
};
