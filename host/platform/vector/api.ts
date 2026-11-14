/** Low-level Lance boundary; business table schemas and repositories belong to L11/L17. */
export type VectorValue = string | number | bigint | boolean | null | number[];
export type VectorRow = Record<string, VectorValue>;
export interface VectorColumn {
  name: string;
  type: 'utf8' | 'float32' | 'float64' | 'int32' | 'int64' | 'bool' | 'vector';
  nullable: boolean;
  dimension?: number;
}
export interface VectorTable {
  add(rows: VectorRow[]): Promise<void>;
  delete(predicate: string): Promise<void>;
  countRows(predicate?: string): Promise<number>;
  query(options: { filter?: string; columns?: string[]; limit?: number }): Promise<VectorRow[]>;
  search(vector: number[], options: {
    column: string; metric: 'cosine' | 'l2' | 'dot'; limit: number;
    filter?: string; columns?: string[]; bypassVectorIndex?: boolean; refineFactor?: number;
  }): Promise<VectorRow[]>;
  schema?(): Promise<{ fields: readonly { name: string; type?: string; nullable?: boolean }[] }>;
  addColumns?(expressions: readonly (readonly [string, string])[]): Promise<void>;
  createIndex?(columns: readonly string[], kind: string): Promise<void>;
  fullTextSearch?(text: string, options: { columns?: string[]; filter?: string; limit: number }): Promise<VectorRow[]>;
  /** The installed Node binding exposes all-actions optimize only, not separate compact/prune/index. */
  optimizeAll?(options?: { olderThanDays?: number; deleteUnverified?: boolean }): Promise<void>;
}
export interface VectorConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<VectorTable>;
  /** Pass the owner's explicit schema; no business table-name/schema inference. */
  createTableWithSchema?(name: string, columns: readonly VectorColumn[]): Promise<VectorTable>;
  hasTableDirectory?(name: string): boolean;
  dropTable(name: string): Promise<void>;
  close(): void;
}
export interface VectorService { connect(path: string): Promise<VectorConnection> }
declare module '@deepseek-ai/cordis' {
  interface Context { vector: VectorService }
}
