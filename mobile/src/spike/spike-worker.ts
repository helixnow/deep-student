/**
 * 存储 spike（S1–S6）：在真实 Worker + OPFS 中测量 SQLite WASM 的行为，结果交给 Playwright 断言。
 * 每个实验独立捕获错误并原样上报，便于在报告中引用。
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

async function attempt(fn: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const POOL_DIR = '.dstu-spike';

async function runSpike(): Promise<Record<string, unknown>> {
  const started = performance.now();
  const sqlite3 = await sqlite3InitModule();
  const initMs = performance.now() - started;
  const { capi, wasm } = sqlite3;

  const poolStarted = performance.now();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'dstu-spike', directory: POOL_DIR, clearOnInit: true, initialCapacity: 8 });
  const poolMs = performance.now() - poolStarted;
  const open = (file: string) => new pool.OpfsSAHPoolDb(file);

  const report: Record<string, unknown> = { initMs, poolMs, libVersion: capi.sqlite3_libversion(), sourceId: capi.sqlite3_sourceid() };

  // S1：编译选项、trigram、DEFENSIVE 默认值。
  report.s1 = await attempt(() => {
    const db = open('/s1.db');
    try {
      const compileOptions = db.selectValues('PRAGMA compile_options') as string[];
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram'); INSERT INTO t VALUES ('深度学习伴侣'), ('错题本复习');");
      const trigram = db.selectValues("SELECT x FROM t WHERE t MATCH '学习伴'");
      const like = db.selectValues("SELECT x FROM t WHERE x LIKE '%题本%'");
      const defensive = wasm.scopedAllocCall(() => {
        const out = wasm.scopedAlloc(4);
        wasm.poke32(out, -1);
        capi.sqlite3_db_config(db.pointer!, capi.SQLITE_DBCONFIG_DEFENSIVE, -1, out);
        return wasm.peek32(out);
      });
      const bigint = db.selectValue('SELECT 9007199254740993');
      return { compileOptions, trigram, like, defensive, bigintType: typeof bigint, bigint: String(bigint) };
    } finally {
      db.close();
    }
  });

  // S2：同一 Worker 内对同一文件开两条连接。
  report.s2 = await attempt(() => {
    const a = open('/s2.db');
    const b = open('/s2.db');
    const steps: Record<string, unknown> = {};
    try {
      a.exec('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT); INSERT INTO kv VALUES (\'base\', \'1\');');
      steps.bSeesCommitted = b.selectValue("SELECT v FROM kv WHERE k='base'");
      a.exec('BEGIN IMMEDIATE; INSERT INTO kv VALUES (\'pending\', \'a\');');
      steps.bSeesUncommitted = b.selectValue("SELECT count(*) FROM kv WHERE k='pending'");
      try {
        b.exec('BEGIN IMMEDIATE');
        steps.bBeginImmediate = 'acquired';
        b.exec('ROLLBACK');
      } catch (error) {
        steps.bBeginImmediate = (error as Error).message;
      }
      try {
        b.exec("INSERT INTO kv VALUES ('from-b', 'b')");
        steps.bAutocommitWrite = 'written';
      } catch (error) {
        steps.bAutocommitWrite = (error as Error).message;
      }
      a.exec('COMMIT');
      steps.afterCommit = b.selectValues('SELECT k FROM kv ORDER BY k');
      steps.integrity = a.selectValue('PRAGMA integrity_check');
      return steps;
    } finally {
      a.close();
      b.close();
    }
  });

  // S3：journal_mode 可选值。
  report.s3 = await attempt(() => {
    const db = open('/s3.db');
    try {
      const wal = db.selectValue('PRAGMA journal_mode=WAL');
      const lockingExclusive = db.selectValue('PRAGMA locking_mode=EXCLUSIVE');
      const walExclusive = db.selectValue('PRAGMA journal_mode=WAL');
      db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1);');
      const checkpoint = db.selectArray('PRAGMA wal_checkpoint(TRUNCATE)');
      db.selectValue('PRAGMA locking_mode=NORMAL');
      const truncate = db.selectValue('PRAGMA journal_mode=TRUNCATE');
      return { wal, lockingExclusive, walExclusive, checkpoint, truncate, files: pool.getFileNames() };
    } finally {
      db.close();
    }
  });

  // S5：VACUUM INTO 导出 + 导出文件字节。
  report.s5 = await attempt(() => {
    const db = open('/s5.db');
    try {
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('hello'), ('世界');");
      db.exec("VACUUM INTO '/s5-export.db'");
      const bytes = pool.exportFile('/s5-export.db');
      const header = new TextDecoder().decode(bytes.subarray(0, 15));
      const pageSize = (bytes[16]! << 8) | bytes[17]!;
      return { exportedBytes: bytes.byteLength, header, pageSize, poolFiles: pool.getFileNames(), capacity: pool.getCapacity() };
    } finally {
      db.close();
    }
  });

  // S6：WASM 堆 + JS 堆（Chromium 非标准 performance.memory，若可用）。
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  report.s6 = {
    wasmHeapBytes: wasm.heap8u().byteLength,
    jsHeapUsed: memory?.usedJSHeapSize ?? null,
    jsHeapTotal: memory?.totalJSHeapSize ?? null,
  };
  return report;
}

type JournalMode = 'truncate' | 'wal-exclusive';

/** 打开连接后、首次读库之前设置日志模式（WAL 无共享内存时必须先进入 EXCLUSIVE 锁模式）。 */
function journalPragmas(mode: JournalMode): string {
  return mode === 'truncate' ? 'PRAGMA journal_mode=TRUNCATE;' : 'PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;';
}

/**
 * S3 崩溃恢复：已提交 `rows` 行后，开启一个未提交的大事务（cache_size=8 迫使脏页写出），
 * 然后由主线程 terminate 本 Worker。WAL 模式下关闭自动 checkpoint，已提交数据只存在于 -wal 中。
 */
async function prepareCrash(rows: number, mode: JournalMode): Promise<Record<string, unknown>> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `dstu-crash-${mode}`, directory: `.dstu-crash-${mode}`, clearOnInit: true });
  const db = new pool.OpfsSAHPoolDb('/crash.db');
  db.exec(journalPragmas(mode));
  if (mode === 'wal-exclusive') db.exec('PRAGMA wal_autocheckpoint=0;');
  db.exec('PRAGMA cache_size=8; CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT);');
  db.exec('BEGIN');
  const stmt = db.prepare('INSERT INTO t(body) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.bind([`row-${i}-${'x'.repeat(200)}`]).stepReset();
  stmt.finalize();
  db.exec('COMMIT');
  const committedSum = db.selectValue('SELECT sum(length(body)) FROM t');
  db.exec('BEGIN');
  db.exec("UPDATE t SET body = 'overwritten-' || id");
  db.exec('DELETE FROM t WHERE id % 3 = 0');
  // 刻意不提交，也不关闭连接。
  return { mode, journalMode: db.selectValue('PRAGMA journal_mode'), committedSum, files: pool.getFileNames() };
}

async function recoverCrash(rows: number, mode: JournalMode): Promise<Record<string, unknown>> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `dstu-crash-${mode}`, directory: `.dstu-crash-${mode}` });
  const filesBefore = pool.getFileNames();
  const db = new pool.OpfsSAHPoolDb('/crash.db');
  if (mode === 'wal-exclusive') db.exec(journalPragmas(mode));
  try {
    return {
      mode,
      filesBefore,
      integrity: db.selectValue('PRAGMA integrity_check'),
      count: db.selectValue('SELECT count(*) FROM t'),
      expectedCount: rows,
      sum: db.selectValue('SELECT sum(length(body)) FROM t'),
      overwritten: db.selectValue("SELECT count(*) FROM t WHERE body LIKE 'overwritten-%'"),
      filesAfter: pool.getFileNames(),
    };
  } finally {
    db.close();
  }
}

/** S2 跨 Worker：同一 pool 目录只能被一个 Worker 安装（SAH 独占）。 */
async function holdPool(): Promise<Record<string, unknown>> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'dstu-hold', directory: '.dstu-hold' });
  return { capacity: pool.getCapacity() };
}

self.onmessage = async (event: MessageEvent<{ op: string; rows?: number; mode?: JournalMode }>) => {
  const { op, rows = 4000, mode = 'truncate' } = event.data;
  const result = await attempt(() =>
    op === 'spike' ? runSpike()
      : op === 'crash-prepare' ? prepareCrash(rows, mode)
        : op === 'crash-recover' ? recoverCrash(rows, mode)
          : holdPool());
  self.postMessage({ op, result });
};
