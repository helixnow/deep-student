import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanRustTypes, scanRustWrites, typeTextFeatures, resolveJsonSource } from '../lib/rust-scan.mjs';
import { loadHost, scanHostWrites, scanHashInputs } from '../lib/host-scan.mjs';

const RUST = {
  'src-tauri/crates/dstu-x/src/model.rs': `
use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_page: Option<usize>,
    pub percent: f32,
    pub note: Option<String>,
    pub extra: std::collections::HashMap<String, Score>,
    #[serde(skip)]
    pub internal: u8,
}
#[derive(Serialize)]
pub struct Score { pub value: f64, pub at: chrono::DateTime<chrono::Utc> }
#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Kind { A { n: u64 }, B }
#[cfg(test)]
mod tests {
    #[derive(Serialize)]
    struct Fake { x: f64 }
}
`,
  'src-tauri/crates/dstu-x/src/repo.rs': `
fn save(conn: &Connection, id: &str, progress: &Progress) -> Result<()> {
    let json = serde_json::to_string(&progress).unwrap_or_default();
    conn.execute(
        "UPDATE files SET processing_progress = ?1, updated_at = ?2 WHERE id = ?3",
        params![json, now(), id],
    )?;
    let mut stmt = conn.prepare("INSERT INTO logs (id, payload_json) VALUES (?1, ?2)")?;
    stmt.execute(rusqlite::params![id, serde_json::to_string(&Kind::B)?])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    fn t(conn: &Connection) { conn.execute("UPDATE files SET processing_progress = ?1", params![serde_json::to_string(&1).unwrap()]).unwrap(); }
}
`,
};

test('Rust 类型扫描：字段顺序、rename_all、skip、风险特征（跳过 #[cfg(test)]）', async () => {
  const files = Object.keys(RUST);
  const { types } = await scanRustTypes('/', files, (f) => RUST[f]);
  assert.ok(!types.has('Fake'));
  const p = types.get('Progress')[0];
  assert.deepEqual(p.fields.map((f) => f.wire), ['stage', 'currentPage', 'percent', 'note', 'extra']);
  assert.equal(p.line, 5);
  const feats = typeTextFeatures(types, 'Progress', 'dstu-x');
  assert.deepEqual(feats.get('option-omit'), ['.currentPage']);
  assert.deepEqual(feats.get('option-null'), ['.note']);
  assert.deepEqual(feats.get('f32'), ['.percent']);
  assert.deepEqual(feats.get('hashmap'), ['.extra']);
  assert.deepEqual(feats.get('f64'), ['.extra.value']);
  assert.deepEqual(feats.get('chrono'), ['.extra.at']);
  assert.deepEqual(typeTextFeatures(types, 'Kind', 'dstu-x').get('enum-repr'), ['$']);
  assert.deepEqual(typeTextFeatures(types, 'Vec<f64>', 'dstu-x').get('f64'), ['[]']);

  const writes = await scanRustWrites('/', types, files, (f) => RUST[f]);
  const progress = writes.filter((w) => w.column === 'processing_progress');
  assert.equal(progress.length, 1, 'cfg(test) 写入不计');
  assert.equal(progress[0].valueType, 'Progress');
  assert.equal(progress[0].line, 5);
  const log = writes.find((w) => w.table === 'logs');
  assert.equal(log.column, 'payload_json');
  assert.equal(log.valueType, 'Kind');
});

test('resolveJsonSource：内联、局部变量、Value::to_string、json!', () => {
  assert.deepEqual(resolveJsonSource('serde_json::to_string(&a.b(c)).unwrap()', ''), { how: 'to_string', value: 'a.b(c)' });
  assert.equal(resolveJsonSource('s', 'let s = serde_json::to_string_pretty(&cfg)?;\n').how, 'to_string_pretty');
  assert.equal(resolveJsonSource('v.to_string()', 'let v = json!({"a": 1});\n').how, 'Value::to_string');
  assert.equal(resolveJsonSource('name', 'let name = other();\n'), undefined);
});

const HOST = {
  'host/plugins/demo/repository/files.ts': `
export function saveProgress(db: SqlExecutor, id: string, progressJson: string): void {
  db.run('UPDATE files SET processing_progress = ?1, updated_at = ?2 WHERE id = ?3', [progressJson, now(), id]);
}
const INSERT_LOG = \`INSERT INTO logs (id, payload_json) VALUES (?, ?)\`;
export function log(db: SqlExecutor, id: string, payload: unknown) {
  const text = payload === undefined ? null : JSON.stringify(payload);
  db.run(INSERT_LOG, [id, text]);
  db.run('INSERT INTO cfg (k, v) VALUES ($k, $v)', { $k: id, $v: toRustJson(payload, schema) });
}
`,
  'host/plugins/demo/src/service.ts': `
export function tick(db: SqlExecutor) {
  saveProgress(db, 'f', JSON.stringify({ stage: 'x', percent: 85 }));
}
`,
};

test('宿主扫描：SQL 写入 → 列 → JSON 来源（跨函数参数、局部变量、命名参数、安全写法）', () => {
  const ctx = loadHost('/', Object.keys(HOST), (f) => HOST[f]);
  const writes = scanHostWrites(ctx);
  const progress = writes.find((w) => w.column === 'processing_progress');
  assert.equal(progress.plugin, 'demo');
  assert.equal(progress.line, 3);
  assert.equal(progress.sources.length, 1);
  const [src] = progress.sources;
  assert.equal(src.writer, 'JSON.stringify');
  assert.equal(src.file, 'host/plugins/demo/src/service.ts');
  assert.equal(src.line, 3);
  assert.deepEqual(src.keys.map((k) => k.key), ['stage', 'percent']);
  assert.match(src.via[0], /^saveProgress\(…\)@host\/plugins\/demo\/src\/service\.ts:3$/);

  const log = writes.find((w) => w.table === 'logs' && w.column === 'payload_json');
  assert.equal(log.sources[0].writer, 'JSON.stringify');
  assert.equal(log.sources[0].line, 7);
  assert.equal(writes.find((w) => w.table === 'cfg' && w.column === 'v').sources[0].writer, 'safe:toRustJson');
  assert.deepEqual(writes.find((w) => w.table === 'logs' && w.column === 'id').sources, []);
});

test('哈希输入：JSON.stringify 直接或经局部变量进入 createHash/sha256，日志等不计', () => {
  const files = {
    'host/plugins/q/src/a.ts': [
      "export function fp(c: Cfg) { return createHash('sha256').update(JSON.stringify(snap(c)), 'utf8').digest('hex'); }",
      'export function key(v: unknown) { const text = JSON.stringify(v); return sha256Hex(text); }',
      'export function log(v: unknown) { console.log(JSON.stringify(v)); }',
    ].join('\n'),
  };
  const hits = scanHashInputs(loadHost('/', Object.keys(files), (f) => files[f]));
  assert.deepEqual(hits.map((h) => [h.line, h.fn, h.arg]), [[1, 'fp', 'snap(c)'], [2, 'key', 'v']]);
});
