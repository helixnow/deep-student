import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import vector from '../index.ts';

describe('LanceDB 0.22.1 real native provider', () => {
  it('creates fixed f32 vectors, appends duplicates, projects/filters, searches and reopens persisted tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f7-lance-'));
    const host = await createTestHost({ plugins: [vector] });
    try {
      const connection = await host.ctx.vector.connect(root);
      expect(await host.ctx.vector.connect(root)).toBe(connection);
      const table = await connection.createTableWithSchema!('vectors_1792', [
        { name: 'id', type: 'utf8', nullable: false }, { name: 'text', type: 'utf8', nullable: false },
        { name: 'generation', type: 'int64', nullable: false }, { name: 'metadata', type: 'utf8', nullable: true },
        { name: 'embedding', type: 'vector', dimension: 2, nullable: false },
      ]);
      const item = { id: 'a', text: '机器学习', generation: 9007199254740993n, metadata: null, embedding: [1, 0] };
      await table.add([item, item, { id: 'b', text: '历史课程', generation: 2n, metadata: '{}', embedding: [0, 1] }]);
      expect(await table.countRows()).toBe(3);
      const fields = (await table.schema!()).fields;
      expect(fields.find(f => f.name === 'embedding')?.type).toMatch(/FixedSizeList\[2\]<Float32>/u);
      expect(await table.query({ filter: "id = 'a'", columns: ['generation'] }))
        .toEqual([{ generation: 9007199254740993n }, { generation: 9007199254740993n }]);
      const nearest = await table.search([1, 0], { column: 'embedding', metric: 'cosine', limit: 1,
        columns: ['id'], bypassVectorIndex: true });
      expect(nearest[0]?.id).toBe('a');
      expect(nearest[0]?._distance).toBeCloseTo(0);
      await table.addColumns!([['extra', 'CAST(NULL AS STRING)']]);
      expect((await table.schema!()).fields.some(f => f.name === 'extra')).toBe(true);
      await table.delete("id = 'a'");
      expect(await table.countRows()).toBe(1);
      connection.close();
      const reopened = await host.ctx.vector.connect(root);
      expect(await reopened.tableNames()).toEqual(['vectors_1792']);
      expect(await (await reopened.openTable('vectors_1792')).countRows()).toBe(1);
      expect(reopened.hasTableDirectory!('vectors_1792')).toBe(true);
      await mkdir(join(root, 'corrupt.lance'));
      expect(reopened.hasTableDirectory!('corrupt')).toBe(true);
      await expect(reopened.openTable('corrupt')).rejects.toThrow();
      await reopened.dropTable('vectors_1792');
      expect(reopened.hasTableDirectory!('vectors_1792')).toBe(false);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('creates the Rust ngram 2..4 non-prefix FTS and retains the engine score', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f7-lance-fts-'));
    const host = await createTestHost({ plugins: [vector] });
    try {
      const table = await (await host.ctx.vector.connect(root)).createTableWithSchema!('texts', [
        { name: 'text', type: 'utf8', nullable: false }, { name: 'id', type: 'utf8', nullable: false },
      ]);
      await table.add([{ text: '机器学习原理', id: 'cjk' }, { text: '历史课程', id: 'history' }]);
      await table.createIndex!(['text'], 'fts-ngram');
      await table.createIndex!(['id'], 'btree');
      const result = await table.fullTextSearch!('学习', { columns: ['id'], limit: 5 });
      expect(result.map(r => r.id)).toEqual(['cjk']);
      expect(typeof result[0]?._score).toBe('number');
      await table.optimizeAll!({ olderThanDays: 7, deleteUnverified: false });
      expect(await table.countRows()).toBe(2);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('persists actual 1792/2560-dimensional Float32 vectors and rejects a mismatched dimension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f7-lance-dim-'));
    const host = await createTestHost({ plugins: [vector] });
    try {
      const connection = await host.ctx.vector.connect(root);
      for (const dimension of [1792, 2560]) {
        const name = `vectors_${dimension}`;
        const table = await connection.createTableWithSchema!(name, [
          { name: 'id', type: 'utf8', nullable: false },
          { name: 'embedding', type: 'vector', dimension, nullable: false },
        ]);
        const embedding = new Array<number>(dimension).fill(0);
        embedding[0] = 0.1;
        embedding[dimension - 1] = 1;
        await table.add([{ id: 'row', embedding }]);
        expect((await table.schema!()).fields.find(field => field.name === 'embedding')?.type)
          .toBe(`FixedSizeList[${dimension}]<Float32>`);
        const saved = await table.query({ columns: ['embedding'] });
        expect((saved[0]!.embedding as number[]).length).toBe(dimension);
        expect((saved[0]!.embedding as number[])[0]).toBe(Math.fround(0.1));
        expect((saved[0]!.embedding as number[])[dimension - 1]).toBe(1);
        await expect(table.add([{ id: 'wrong', embedding: [1, 0] }])).rejects
          .toThrow(`Vector column 'embedding' dimension mismatch: expected ${dimension}, got 2`);
        await expect(table.add([{ id: 'valid', embedding }, { id: 'wrong-tail', embedding: [1] }])).rejects
          .toThrow(`Vector column 'embedding' dimension mismatch: expected ${dimension}, got 1`);
        expect(await table.countRows()).toBe(1);
      }
      expect(await connection.tableNames()).toEqual(['vectors_1792', 'vectors_2560']);
      connection.close();
      const reopened = await host.ctx.vector.connect(root);
      expect(await (await reopened.openTable('vectors_2560')).countRows()).toBe(1);
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
