import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'blocks.table.empty') return '暂无数据';
      if (key === 'a11y.table_caption') return '数据表';
      if (key === 'a11y.table_label') return '表格';
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  TABLE_BLOCK_TYPE,
  TableBlock,
  registerTableBlock,
  tableBlockPropsSchema,
} from '@/features/generative-ui/components/TableBlock';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { validateBlockProps } from '@/features/generative-ui/schema';
import { formatGenerativeStatValue } from '@/features/generative-ui/utils/formatGenerativeNumber';

beforeAll(() => {
  registerTableBlock();
});

const COLUMNS = [
  { key: 'name', label: '姓名' },
  { key: 'score', label: '分数', align: 'right' as const },
];

describe('tableBlock schema', () => {
  it('accepts 1–12 columns and 0–50 rows', () => {
    const maxCols = Array.from({ length: 12 }, (_, i) => ({
      key: `c${i}`,
      label: `列 ${i}`,
    }));
    expect(tableBlockPropsSchema.safeParse({ columns: maxCols, rows: [] }).success).toBe(true);
    expect(
      tableBlockPropsSchema.safeParse({
        columns: COLUMNS,
        rows: [{ name: 'Alice', score: 98 }],
      }).success,
    ).toBe(true);
  });

  it('rejects more than 12 columns', () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => ({
      key: `c${i}`,
      label: `列 ${i}`,
    }));
    const result = tableBlockPropsSchema.safeParse({ columns: tooMany, rows: [] });
    expect(result.success).toBe(false);
  });

  it('rejects empty columns', () => {
    expect(tableBlockPropsSchema.safeParse({ columns: [], rows: [] }).success).toBe(false);
  });
});

describe('TableBlock render', () => {
  it('renders column headers and row cells', () => {
    render(
      <TableBlock
        title="成绩"
        columns={COLUMNS}
        rows={[
          { name: 'Alice', score: 98 },
          { name: 'Bob', score: 87 },
        ]}
        caption="本周测验"
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '姓名' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '分数' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '98' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Bob' })).toBeInTheDocument();
    expect(screen.getByText('成绩')).toBeInTheDocument();
    expect(screen.getByText('本周测验').tagName).toBe('CAPTION');
    expect(document.querySelector('[data-generative-table]')).toBeTruthy();
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });

  it('shows empty string for missing column keys', () => {
    render(
      <TableBlock
        columns={COLUMNS}
        rows={[{ name: 'Carol' }, { score: 70 }]}
      />,
    );

    const rows = screen.getAllByRole('row');
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    const firstDataCells = rows[1]!.querySelectorAll('td');
    expect(firstDataCells[0]?.textContent).toBe('Carol');
    expect(firstDataCells[1]?.textContent).toBe('');
    const secondDataCells = rows[2]!.querySelectorAll('td');
    expect(secondDataCells[0]?.textContent).toBe('');
    expect(secondDataCells[1]?.textContent).toBe('70');
  });

  it('renders emptyLabel when there are no rows', () => {
    render(
      <TableBlock
        columns={COLUMNS}
        rows={[]}
        emptyLabel="没有记录"
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('数据表').tagName).toBe('CAPTION');
    expect(screen.getByText('没有记录')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-table]')?.getAttribute('data-empty')).toBe('true');
  });

  it('falls back to blocks.table.empty i18n when emptyLabel omitted', () => {
    render(<TableBlock columns={COLUMNS} rows={[]} />);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
  });

  it('applies tabular-nums on numeric cells', () => {
    const { container } = render(
      <TableBlock columns={COLUMNS} rows={[{ name: 'Dan', score: 100 }]} />,
    );
    const numericCell = Array.from(container.querySelectorAll('td')).find(
      (cell) => cell.textContent === '100',
    );
    expect(numericCell?.className).toContain('tabular-nums');
  });

  it('formats numeric cells with formatGenerativeStatValue and leaves strings as-is', () => {
    const expected = formatGenerativeStatValue(1200);
    render(
      <TableBlock
        columns={COLUMNS}
        rows={[{ name: 'hello', score: 1200 }]}
      />,
    );

    const numericCell = document.querySelector('[data-table-cell][data-numeric="true"]');
    expect(numericCell).toBeTruthy();
    expect(numericCell).toHaveTextContent(expected);
    expect(screen.getByRole('cell', { name: 'hello' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'hello' })).toHaveTextContent('hello');
  });
});

describe('table registry + renderer', () => {
  it('registers table with allowPartialRender for streaming rows', () => {
    const config = generativeUIRegistry.get(TABLE_BLOCK_TYPE);
    expect(config).toBeDefined();
    expect(config?.allowPartialRender).toBe(true);
    expect(config?.propsSchema).toBe(tableBlockPropsSchema);
  });

  it('renders through GenerativeUIRenderer after test-local register', () => {
    const validation = validateBlockProps(tableBlockPropsSchema, {
      title: '排名',
      columns: COLUMNS,
      rows: [{ name: 'Eve', score: 91 }],
    });
    expect(validation.ok).toBe(true);

    render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [
            {
              type: 'table',
              props: {
                title: '排名',
                columns: COLUMNS,
                rows: [{ name: 'Eve', score: 91 }],
              },
            },
          ],
        }}
        showChrome={false}
      />,
    );

    expect(screen.getByText('排名')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Eve' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '91' })).toBeInTheDocument();
  });
});
