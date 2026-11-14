import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSqlWrite } from '../lib/sql.mjs';

const cols = (w) => w.columns.map((c) => `${c.column}=${c.param ? (c.param.index ?? `:${c.param.name}`) : '-'}`);

test('INSERT：列与 ?N / ? 对应（? 取已出现最大编号 + 1），表达式内的参数也算', () => {
  const w = parseSqlWrite(`INSERT OR REPLACE INTO main.fsrs_review_logs (id, a, b, c, d) VALUES (?1, ?2, COALESCE(?4, 'x'), datetime('now'), ?)`);
  assert.equal(w.op, 'insert');
  assert.equal(w.table, 'fsrs_review_logs');
  assert.deepEqual(cols(w), ['id=1', 'a=2', 'b=4', 'c=-', 'd=5']);
});

test('INSERT … ON CONFLICT DO UPDATE SET 的参数也映射到列', () => {
  const w = parseSqlWrite('INSERT INTO t ("k", v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, extra_json = ?3');
  assert.deepEqual(cols(w), ['k=1', 'v=2', 'extra_json=3']);
});

test('UPDATE … SET … WHERE：只取 SET 子句，命名参数', () => {
  const w = parseSqlWrite('UPDATE anki_decks SET config_json = :config, updated_at = @now WHERE id = $id');
  assert.equal(w.op, 'update');
  assert.equal(w.table, 'anki_decks');
  assert.deepEqual(cols(w), ['config_json=:config', 'updated_at=:now']);
  const n = parseSqlWrite('UPDATE files SET processing_progress = ?1, updated_at = ?2 WHERE id = ?3');
  assert.deepEqual(cols(n), ['processing_progress=1', 'updated_at=2']);
});

test('INSERT … SELECT，引号与括号中的逗号不拆分', () => {
  const w = parseSqlWrite("INSERT INTO t (a, b) SELECT json_object('x', ?1), ? FROM u WHERE z = 'a,b'");
  assert.deepEqual(cols(w), ['a=1', 'b=2']);
});

test('非写语句、DDL、模板占位返回 undefined 或无参数列', () => {
  assert.equal(parseSqlWrite('SELECT * FROM t WHERE a = ?'), undefined);
  assert.equal(parseSqlWrite('CREATE TABLE t (a)'), undefined);
  const w = parseSqlWrite('INSERT INTO t (a, b) VALUES ${placeholders}');
  assert.equal(w.table, 't');
  assert.deepEqual(cols(w), ['a=-', 'b=-']);
});
