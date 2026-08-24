import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from '../registry';
import { formatGenerativeStatValue } from '../utils/formatGenerativeNumber';

const TABLE_ALIGN = ['left', 'center', 'right'] as const;

const ALIGN_CLASS = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

export const tableColumnSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  align: z.enum(TABLE_ALIGN).optional(),
});

export const tableBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  columns: z.array(tableColumnSchema).min(1).max(12),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(0).max(50),
  emptyLabel: z.string().max(80).optional(),
  caption: z.string().max(200).optional(),
});

export type TableColumn = z.infer<typeof tableColumnSchema>;
export type TableBlockProps = z.infer<typeof tableBlockPropsSchema>;

export const TABLE_BLOCK_TYPE = 'table';

function stringifyCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function isNumericCell(value: unknown): value is number {
  return typeof value === 'number';
}

export function TableBlock({ id, title, columns, rows, emptyLabel, caption }: TableBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const resolvedEmpty = emptyLabel ?? t('blocks.table.empty');
  const resolvedCaption = caption?.trim() || t('a11y.table_caption');
  const isEmpty = rows.length === 0;

  return (
    <Card
      className="min-w-0"
      data-testid="generative-ui-table"
      data-generative-table
      data-table-id={id}
      data-empty={isEmpty || undefined}
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.table_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        <div className="overflow-x-auto">
          <Table>
            <TableCaption dir="auto">{resolvedCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead
                    key={column.key}
                    scope="col"
                    dir="auto"
                    className={ALIGN_CLASS[column.align ?? 'left']}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isEmpty ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-center text-sm text-muted-foreground"
                  >
                    {resolvedEmpty}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, rowIndex) => (
                  <TableRow key={rowIndex}>
                    {columns.map((column) => {
                      const raw = row[column.key];
                      const numeric = isNumericCell(raw);
                      return (
                        <TableCell
                          key={column.key}
                          data-table-cell
                          data-numeric={numeric ? 'true' : undefined}
                          dir="auto"
                          className={cn(
                            ALIGN_CLASS[column.align ?? 'left'],
                            numeric && 'tabular-nums',
                          )}
                        >
                          {numeric ? formatGenerativeStatValue(raw) : stringifyCell(raw)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/** 测试 / 按需注册。不写入 blocks/index.ts，避免破坏 EXPECTED_BLOCK_TYPES。 */
export function registerTableBlock(): void {
  generativeUIRegistry.register({
    type: TABLE_BLOCK_TYPE,
    component: TableBlock,
    propsSchema: tableBlockPropsSchema,
    description: '表格：列 schema + 行数据（允许流式 rows）',
    allowPartialRender: true,
  });
}
