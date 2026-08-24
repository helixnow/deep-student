/**
 * 表格块 — 从 columns + row objects 构建意图，丢掉不在 columns 的字段
 */

import type { GenerativeUIIntent } from '../types';
import type { TableColumn } from '../components/TableBlock';

export interface TableIntentLabels {
  metaTitle?: string;
  emptyLabel?: string;
}

export interface TableIntentInput {
  id?: string;
  title?: string;
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  emptyLabel?: string;
  caption?: string;
  labels: TableIntentLabels;
}

function pickKnownFields(
  row: Record<string, string | number>,
  columnKeys: Set<string>,
): Record<string, string | number> {
  const next: Record<string, string | number> = {};
  for (const key of columnKeys) {
    const value = row[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

export function buildTableIntent(input: TableIntentInput): GenerativeUIIntent {
  const columns = input.columns.slice(0, 12);
  const columnKeys = new Set(columns.map((column) => column.key));
  const rows = input.rows.slice(0, 50).map((row) => pickKnownFields(row, columnKeys));

  return {
    version: '1',
    meta: input.labels.metaTitle
      ? {
          title: input.labels.metaTitle,
        }
      : undefined,
    blocks: [
      {
        type: 'table',
        id: input.id,
        props: {
          title: input.title,
          columns,
          rows,
          emptyLabel: input.emptyLabel ?? input.labels.emptyLabel,
          caption: input.caption,
        },
      },
    ],
  };
}
