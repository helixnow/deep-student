/** 移植 dstu-storage/src/migration/script_checker.rs 的 #[test] 与 mod.rs::test_all_migration_scripts_pass_checker。 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_MIGRATION_SET_ORDER, DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from '../migration/definitions/index.ts';
import {
  checkMigrationScript,
  dangerRuleFromStr,
  detectDangerousStatements,
  parseDangerAcks,
  type DangerFinding,
  type DangerRule,
} from '../migration/script-checker.ts';

const rulesOf = (f: DangerFinding[]): DangerRule[] => f.map((x) => x.rule);

describe('script_checker.rs', () => {
  it('test_check_missing_cleanup', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            INSERT INTO foo_new SELECT * FROM foo;
            DROP TABLE foo;
            ALTER TABLE foo_new RENAME TO foo;
        `,
    );
    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.rule === 'table_rebuild_cleanup')).toBe(true);
  });
  it('test_check_with_cleanup', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS foo_new;

            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            INSERT INTO foo_new SELECT * FROM foo;
            DROP TABLE foo;
            ALTER TABLE foo_new RENAME TO foo;
        `,
    );
    expect(r.passed, JSON.stringify(r.errors)).toBe(true);
  });
  it('test_check_fk_without_cleanup', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `,
    );
    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.rule === 'fk_orphan_cleanup')).toBe(true);
  });
  it('test_check_fk_with_cleanup', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS child_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM child WHERE parent_id NOT IN (SELECT id FROM parent);

            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `,
    );
    expect(r.passed, JSON.stringify(r.errors)).toBe(true);
  });
  it('test_check_fk_in_brand_new_table_passes', () => {
    const r = checkMigrationScript(
      'V20260308__add_todo_tables.sql',
      `
            CREATE TABLE IF NOT EXISTS todo_items (
                id TEXT PRIMARY KEY,
                todo_list_id TEXT NOT NULL,
                parent_id TEXT,
                FOREIGN KEY (todo_list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES todo_items(id) ON DELETE SET NULL
            );
        `,
    );
    expect(r.passed, JSON.stringify(r.errors)).toBe(true);
  });
  it('test_check_fk_outside_table_body_not_exempted', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            DROP TABLE IF EXISTS child_new;
            CREATE TABLE IF NOT EXISTS settings (
                k TEXT PRIMARY KEY,
                v TEXT
            );

            INSERT INTO schema_notes(txt)
            VALUES ('FOREIGN KEY (parent_id) REFERENCES parent(id)');
        `,
    );
    expect(r.errors.some((e) => e.rule === 'fk_orphan_cleanup')).toBe(true);
  });
  it('test_check_fk_rebuild_after_brand_new_table_still_checked', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            CREATE TABLE IF NOT EXISTS settings (
                k TEXT PRIMARY KEY
            );

            CREATE TABLE legacy_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `,
    );
    expect(r.errors.some((e) => e.rule === 'fk_orphan_cleanup')).toBe(true);
  });
  it('test_skip_check_marker', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            -- @skip-check: table_rebuild_cleanup
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
        `,
    );
    expect(r.passed).toBe(true);
  });
  it('test_skip_all_checks', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            -- @skip-check: all
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            CREATE TABLE bar (id TEXT);
        `,
    );
    expect(r.passed).toBe(true);
  });
  it('test_idempotent_create_warning', () => {
    const r = checkMigrationScript('test.sql', 'CREATE TABLE foo (id TEXT PRIMARY KEY);');
    expect(r.passed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.rule === 'idempotent_create')).toBe(true);
  });
  it('test_real_migration_script', () => {
    const r = checkMigrationScript(
      'V20260202__add_segments_fk.sql',
      `
            -- ============================================================================
            -- V20260202: 为 vfs_index_segments 添加 unit_id 外键约束
            -- ============================================================================

            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS vfs_index_segments_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM vfs_index_segments
            WHERE unit_id NOT IN (SELECT id FROM vfs_index_units);

            -- STEP 2: 创建新表
            CREATE TABLE vfs_index_segments_new (
                id TEXT PRIMARY KEY,
                unit_id TEXT NOT NULL,
                FOREIGN KEY (unit_id) REFERENCES vfs_index_units(id) ON DELETE CASCADE
            );

            -- STEP 3: 复制数据
            INSERT INTO vfs_index_segments_new SELECT * FROM vfs_index_segments;

            -- STEP 4: 替换表
            DROP TABLE vfs_index_segments;
            ALTER TABLE vfs_index_segments_new RENAME TO vfs_index_segments;
        `,
    );
    expect(r.passed, JSON.stringify(r.errors)).toBe(true);
  });
  it('test_init_script_skips_checks', () => {
    const sql = `
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE posts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX idx_posts_user ON posts(user_id);
        `;
    expect(checkMigrationScript('V20260130__init.sql', sql).passed).toBe(true);
    expect(checkMigrationScript('vfs:init', sql).passed).toBe(true);
  });
  it('test_reinitialize_not_treated_as_init', () => {
    expect(checkMigrationScript('V20260201__reinitialize_cache.sql', 'CREATE TABLE foo_new (id TEXT PRIMARY KEY);').passed).toBe(false);
  });
  it('test_create_index_warning', () => {
    const r = checkMigrationScript('test.sql', 'CREATE INDEX idx_foo ON bar(col);\nCREATE UNIQUE INDEX idx_bar ON baz(col);');
    expect(r.warnings.some((w) => w.rule === 'idempotent_index')).toBe(true);
  });
  it('test_create_index_with_if_not_exists', () => {
    const r = checkMigrationScript(
      'test.sql',
      'CREATE INDEX IF NOT EXISTS idx_foo ON bar(col);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_bar ON baz(col);',
    );
    expect(r.warnings.some((w) => w.rule === 'idempotent_index')).toBe(false);
  });
  it('test_danger_delete_without_where', () => {
    expect(rulesOf(detectDangerousStatements('V20260601__purge.sql', 'DELETE FROM users;'))).toContain('delete_without_where');
    expect(rulesOf(detectDangerousStatements('V20260601__purge.sql', 'DELETE FROM users WHERE deleted_at IS NOT NULL;'))).not.toContain(
      'delete_without_where',
    );
  });
  it('test_danger_drop_table_and_column', () => {
    const rules = rulesOf(detectDangerousStatements('V20260601__drop.sql', 'DROP TABLE legacy; ALTER TABLE users DROP COLUMN age;'));
    expect(rules).toContain('drop_table');
    expect(rules).toContain('drop_column');
    expect(rulesOf(detectDangerousStatements('V20260601__cleanup.sql', 'DROP TABLE IF EXISTS users_new;'))).not.toContain('drop_table');
  });
  it('test_danger_unique_constraint', () => {
    expect(rulesOf(detectDangerousStatements('V20260601__uniq.sql', 'CREATE UNIQUE INDEX idx_users_email ON users(email);'))).toContain(
      'unique_constraint',
    );
    const rules = rulesOf(
      detectDangerousStatements(
        'V20260601__rebuild.sql',
        `
            DROP TABLE IF EXISTS t_new;
            CREATE TABLE t_new (id TEXT, email TEXT UNIQUE);
            INSERT INTO t_new SELECT * FROM t;
            DROP TABLE t;
            ALTER TABLE t_new RENAME TO t;
            `,
      ),
    );
    expect(rules).toContain('unique_constraint');
    expect(rules).toContain('table_rebuild');
  });
  it('test_danger_add_not_null_and_backfill', () => {
    const rules = rulesOf(
      detectDangerousStatements(
        'V20260601__add_col.sql',
        `
            ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
            UPDATE users SET role = 'admin' WHERE is_admin = 1;
            `,
      ),
    );
    expect(rules).toContain('add_not_null_column');
    expect(rules).toContain('add_column_backfill');
    expect(detectDangerousStatements('V20260601__add_col.sql', 'ALTER TABLE users ADD COLUMN nickname TEXT;')).toEqual([]);
  });
  it('test_danger_init_script_exempt', () => {
    expect(detectDangerousStatements('V20260130__init.sql', 'DROP TABLE legacy; DELETE FROM old_stuff;')).toEqual([]);
  });
  it('test_danger_comments_and_strings_not_flagged', () => {
    const sql = `
            -- DROP TABLE users （只是注释）
            /* DELETE FROM users */
            INSERT INTO audit_log(msg) VALUES ('DROP TABLE users');
        `;
    expect(detectDangerousStatements('V20260601__log.sql', sql)).toEqual([]);
  });
  it('test_danger_ack_annotation', () => {
    const f = detectDangerousStatements(
      'V20260601__drop.sql',
      `
            -- @danger-ack: drop_table reason="legacy 表已由新表替代，确认无引用"
            DROP TABLE legacy;
        `,
    );
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe('drop_table');
    expect(f[0]!.acknowledged).toBe(true);
  });
  it('test_allow_data_change_alias', () => {
    const f = detectDangerousStatements(
      'V20260601__drop.sql',
      `
            -- @allow-data-change: drop_table reason="别名注解等价于 @danger-ack"
            DROP TABLE legacy;
        `,
    );
    expect(f.length).toBe(1);
    expect(f[0]!.acknowledged).toBe(true);
  });
  it('test_danger_ack_multiple_rules_and_unknown', () => {
    const [acks, unknown] = parseDangerAcks('-- @danger-ack: drop_table, delete_without_where reason="x"\n-- @danger-ack: drop_tables\n');
    expect(acks.has('drop_table')).toBe(true);
    expect(acks.has('delete_without_where')).toBe(true);
    expect(unknown).toEqual(['drop_tables']);
  });
  it('test_danger_rule_roundtrip', () => {
    for (const rule of [
      'delete_without_where',
      'drop_table',
      'drop_column',
      'unique_constraint',
      'add_not_null_column',
      'table_rebuild',
      'add_column_backfill',
    ] as const) {
      expect(dangerRuleFromStr(rule)).toBe(rule);
    }
  });
  it('test_fk_cleanup_with_not_exists', () => {
    const r = checkMigrationScript(
      'test.sql',
      `
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS child_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM child WHERE NOT EXISTS (SELECT 1 FROM parent WHERE parent.id = child.parent_id);

            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        `,
    );
    expect(r.passed, JSON.stringify(r.errors)).toBe(true);
  });
});

describe('migration/mod.rs', () => {
  it('test_all_migration_scripts_pass_checker', () => {
    const sets = loadMigrationSets(DEFAULT_MIGRATIONS_DIR);
    const failures: string[] = [];
    for (const n of ALL_MIGRATION_SET_ORDER) {
      for (const m of sets[n].migrations) {
        const name = `${n}:${m.name}`;
        const r = checkMigrationScript(name, m.sql);
        if (!r.passed) failures.push(`${name}: ${r.errors.map((e) => `[${e.rule}] ${e.message}`).join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('unacknowledged dangers equal the grandfathered dangers in migration-lock.json', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, 'migration-lock.json'), 'utf8')) as {
      entries: Array<{ database: string; name: string; path: string; dangers: string[] }>;
    };
    const diffs: string[] = [];
    for (const e of lock.entries) {
      const sql = fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, e.path), 'utf8');
      const found = [...new Set(detectDangerousStatements(path.basename(e.path), sql).filter((f) => !f.acknowledged).map((f) => f.rule))].sort();
      const expected = [...new Set(e.dangers)].sort();
      if (JSON.stringify(found) !== JSON.stringify(expected)) diffs.push(`${e.path}: ts=${found} lock=${expected}`);
    }
    expect(diffs).toEqual([]);
  });
});
