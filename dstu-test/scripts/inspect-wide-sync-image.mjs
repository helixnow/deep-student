#!/usr/bin/env node
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAURI_LAB_HOME = process.env.TAURI_LAB_HOME
  ? path.resolve(process.env.TAURI_LAB_HOME)
  : path.join(os.homedir(), 'Library', 'Application Support', 'tauri-lab');

const APP_SUPPORT_REL = path.join('Library', 'Application Support', 'com.deepstudent.app');
const DEFAULT_SLOT = 'slotA';

function parseArgs(argv) {
  const args = {
    slot: DEFAULT_SLOT,
    mode: 'seed',
    json: false,
    strict: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--no-strict') {
      args.strict = false;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  node dstu-test/scripts/inspect-wide-sync-image.mjs --image <image-id> [--slot slotA] [--mode seed|hydrated] [--json]
  node dstu-test/scripts/inspect-wide-sync-image.mjs --instance <instance-id> [--slot slotA] [--mode seed|hydrated] [--json]
  node dstu-test/scripts/inspect-wide-sync-image.mjs --slot-root <path> [--mode seed|hydrated] [--json]

Audits whether a Deep Student data image has enough high-signal rows for broad cloud-sync regression.

Modes:
  seed      strict source image audit: requires change-log UPDATE/DELETE chains and boundary/local table coverage.
  hydrated  reader-device audit after real UI download: verifies final synced state, FK/orphan/conflict health, blobs, and business rows.`;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSlotRoot(args) {
  if (args.slotRoot) return path.resolve(args.slotRoot);
  if (args.home) return path.join(path.resolve(args.home), APP_SUPPORT_REL, 'slots', args.slot);
  if (args.image) return path.join(TAURI_LAB_HOME, 'images', args.image, 'data', APP_SUPPORT_REL, 'slots', args.slot);
  if (args.instance) {
    const registry = readJsonFile(path.join(TAURI_LAB_HOME, 'registry.json'));
    const instance = registry.instances?.[args.instance];
    if (!instance) throw new Error(`Unknown tauri-lab instance: ${args.instance}`);
    return path.join(instance.home, APP_SUPPORT_REL, 'slots', args.slot);
  }
  throw new Error(`Missing target.\n${usage()}`);
}

function sqlite(dbPath, sql, options = {}) {
  const args = ['-readonly', '-cmd', '.timeout 5000'];
  if (options.json) args.push('-json');
  args.push(dbPath);
  const result = childProcess.spawnSync('sqlite3', args, {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed for ${dbPath}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableExists(dbPath, table) {
  const rows = JSON.parse(sqlite(dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name=${lit(table)};`, { json: true }) || '[]');
  return rows.length > 0;
}

function columnExists(dbPath, table, column) {
  if (!tableExists(dbPath, table)) return false;
  const rows = JSON.parse(sqlite(dbPath, `PRAGMA table_info(${quoteIdent(table)});`, { json: true }) || '[]');
  return rows.some(row => row.name === column);
}

function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function scalar(dbPath, sql) {
  const rows = JSON.parse(sqlite(dbPath, sql, { json: true }) || '[]');
  const first = rows[0] || {};
  return Number(Object.values(first)[0] || 0);
}

function rows(dbPath, sql) {
  return JSON.parse(sqlite(dbPath, sql, { json: true }) || '[]');
}

function dbPaths(slotRoot) {
  return {
    vfs: path.join(slotRoot, 'databases', 'vfs.db'),
    chat: path.join(slotRoot, 'chat_v2.db'),
    mistakes: path.join(slotRoot, 'mistakes.db'),
    llm: path.join(slotRoot, 'llm_usage.db'),
  };
}

function requireDbFiles(paths) {
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${name} database: ${file}`);
  }
}

function fkErrors(dbPath) {
  return rows(dbPath, 'PRAGMA foreign_key_check;');
}

function changeLogDistribution(dbPath) {
  if (!tableExists(dbPath, '__change_log')) return [];
  return rows(dbPath, `
    SELECT table_name, operation, COUNT(*) AS count
    FROM __change_log
    GROUP BY table_name, operation
    ORDER BY table_name, operation;
  `);
}

function count(dbPath, table, where = '1=1') {
  if (!tableExists(dbPath, table)) return 0;
  return scalar(dbPath, `SELECT COUNT(*) AS count FROM ${quoteIdent(table)} WHERE ${where};`);
}

function distinctCount(dbPath, table, column, where = '1=1') {
  if (!tableExists(dbPath, table) || !columnExists(dbPath, table, column)) return 0;
  return scalar(dbPath, `SELECT COUNT(DISTINCT ${quoteIdent(column)}) AS count FROM ${quoteIdent(table)} WHERE ${where};`);
}

function firstBlobFileState(slotRoot, dbPath) {
  if (!tableExists(dbPath, 'blobs')) return { checked: false, exists: false };
  const blobRows = rows(dbPath, 'SELECT hash, relative_path FROM blobs ORDER BY created_at LIMIT 3;');
  const checked = blobRows.map(row => {
    const file = path.join(slotRoot, 'vfs_blobs', row.relative_path);
    return { hash: row.hash, relative_path: row.relative_path, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
  });
  return {
    checked: checked.length > 0,
    exists: checked.some(row => row.exists),
    rows: checked,
  };
}

function workspaceFileState(slotRoot) {
  const workspaceRoot = path.join(slotRoot, 'workspaces');
  if (!fs.existsSync(workspaceRoot)) {
    return { root: workspaceRoot, files: 0, bytes: 0, samples: [] };
  }
  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.db'))
    .map(entry => {
      const file = path.join(workspaceRoot, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, bytes: stat.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    root: workspaceRoot,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    samples: entries.slice(0, 5),
  };
}

function syncConflictRows(dbPath) {
  if (!tableExists(dbPath, '__sync_conflicts')) return 0;
  if (columnExists(dbPath, '__sync_conflicts', 'resolution_status')) {
    return count(dbPath, '__sync_conflicts', "resolution_status IS NULL OR resolution_status NOT IN ('resolved', 'ignored')");
  }
  if (columnExists(dbPath, '__sync_conflicts', 'resolved_at')) {
    return count(dbPath, '__sync_conflicts', 'resolved_at IS NULL');
  }
  if (columnExists(dbPath, '__sync_conflicts', 'status')) {
    return count(dbPath, '__sync_conflicts', "status IS NULL OR status NOT IN ('resolved', 'ignored')");
  }
  return count(dbPath, '__sync_conflicts');
}

function collectAudit(slotRoot) {
  const paths = dbPaths(slotRoot);
  requireDbFiles(paths);

  const vfs = paths.vfs;
  const chat = paths.chat;
  const mistakes = paths.mistakes;
  const llm = paths.llm;

  const compressedOrphans = columnExists(vfs, 'files', 'compressed_blob_hash')
    ? count(vfs, 'files', "compressed_blob_hash IS NOT NULL AND compressed_blob_hash NOT IN (SELECT hash FROM blobs)")
    : 0;

  return {
    slot_root: slotRoot,
    databases: Object.fromEntries(Object.entries(paths).map(([name, dbPath]) => [name, {
      path: dbPath,
      foreign_key_errors: fkErrors(dbPath),
      open_sync_conflicts: syncConflictRows(dbPath),
      change_log: changeLogDistribution(dbPath),
    }])),
    workspaces: workspaceFileState(slotRoot),
    vfs: {
      folders: count(vfs, 'folders'),
      resources: count(vfs, 'resources'),
      notes: count(vfs, 'notes'),
      files: count(vfs, 'files'),
      blobs: count(vfs, 'blobs'),
      blob_file_state: firstBlobFileState(slotRoot, vfs),
      file_blob_orphans: count(vfs, 'files', "blob_hash IS NOT NULL AND blob_hash NOT IN (SELECT hash FROM blobs)"),
      compressed_blob_orphans: compressedOrphans,
      compressed_blob_refs: columnExists(vfs, 'files', 'compressed_blob_hash') ? count(vfs, 'files', 'compressed_blob_hash IS NOT NULL') : 0,
      image_files: count(vfs, 'files', "mime_type LIKE 'image/%' OR type = 'image'"),
      folder_items: count(vfs, 'folder_items'),
      exam_sheets: count(vfs, 'exam_sheets'),
      questions: count(vfs, 'questions'),
      question_types: distinctCount(vfs, 'questions', 'question_type'),
      answer_submissions: count(vfs, 'answer_submissions'),
      review_plans: count(vfs, 'review_plans'),
      todo_lists: count(vfs, 'todo_lists'),
      todo_items: count(vfs, 'todo_items'),
      todo_parent_edges: count(vfs, 'todo_items', "parent_id IS NOT NULL"),
      todo_cross_list_parents: tableExists(vfs, 'todo_items') ? scalar(vfs, `
        SELECT COUNT(*) AS count
        FROM todo_items child
        JOIN todo_items parent ON parent.id = child.parent_id
        WHERE child.todo_list_id != parent.todo_list_id;
      `) : 0,
      pomodoro_records: count(vfs, 'pomodoro_records'),
      translations: count(vfs, 'translations'),
      essays: count(vfs, 'essays'),
      essay_sessions: count(vfs, 'essay_sessions'),
      mindmaps: count(vfs, 'mindmaps'),
      mindmap_versions: count(vfs, 'mindmap_versions'),
      soft_deleted_rows: [
        ['folders', 'deleted_at'],
        ['notes', 'deleted_at'],
        ['todo_items', 'deleted_at'],
        ['todo_lists', 'deleted_at'],
      ].reduce((sum, [table, col]) => sum + (columnExists(vfs, table, col) ? count(vfs, table, `${col} IS NOT NULL`) : 0), 0),
      delete_change_log_rows: count(vfs, '__change_log', "operation = 'DELETE'"),
      multi_change_records: tableExists(vfs, '__change_log') ? scalar(vfs, `
        SELECT COUNT(*) AS count
        FROM (
          SELECT table_name, record_id
          FROM __change_log
          GROUP BY table_name, record_id
          HAVING COUNT(*) > 1
        );
      `) : 0,
      boundary_rows: [
        ['question_sync_conflicts', '1=1'],
        ['question_sync_logs', '1=1'],
        ['memory_config', '1=1'],
        ['vfs_indexing_config', '1=1'],
        ['memory_audit_log', '1=1'],
        ['memory_write_idempotency', '1=1'],
        ['mindmap_versions', '1=1'],
        ['question_history', '1=1'],
        ['review_history', '1=1'],
      ].reduce((sum, [table, where]) => sum + count(vfs, table, where), 0),
    },
    chat: {
      workspaces: count(chat, 'workspace_index'),
      groups: count(chat, 'chat_v2_session_groups'),
      sessions: count(chat, 'chat_v2_sessions'),
      deleted_sessions: count(chat, 'chat_v2_sessions', "persist_status = 'deleted' OR deleted_at IS NOT NULL"),
      messages: count(chat, 'chat_v2_messages'),
      blocks: count(chat, 'chat_v2_blocks'),
      block_types: distinctCount(chat, 'chat_v2_blocks', 'block_type'),
      variant_messages: columnExists(chat, 'chat_v2_messages', 'active_variant_id') ? count(chat, 'chat_v2_messages', "active_variant_id IS NOT NULL OR variants_json IS NOT NULL") : 0,
      error_blocks: columnExists(chat, 'chat_v2_blocks', 'error') ? count(chat, 'chat_v2_blocks', "status = 'error' OR error IS NOT NULL") : 0,
      attachments: count(chat, 'chat_v2_attachments'),
      session_mistakes: count(chat, 'chat_v2_session_mistakes'),
      resources: count(chat, 'resources'),
      delete_change_log_rows: count(chat, '__change_log', "operation = 'DELETE'"),
      session_mistake_multi_change_records: tableExists(chat, '__change_log') ? scalar(chat, `
        SELECT COUNT(*) AS count
        FROM (
          SELECT record_id
          FROM __change_log
          WHERE table_name = 'chat_v2_session_mistakes'
          GROUP BY record_id
          HAVING COUNT(*) > 1
        );
      `) : 0,
      boundary_rows: [
        ['chat_v2_session_state', '1=1'],
        ['chat_v2_todo_lists', '1=1'],
        ['chat_v2_session_tags', '1=1'],
        ['sleep_block', '1=1'],
        ['subagent_task', '1=1'],
        ['chat_v2_compactions', '1=1'],
      ].reduce((sum, [table, where]) => sum + count(chat, table, where), 0),
    },
    mistakes: {
      mistakes: count(mistakes, 'mistakes'),
      deleted_mistakes: count(mistakes, 'mistakes', "deleted_at IS NOT NULL"),
      anki_cards: count(mistakes, 'anki_cards'),
      chat_messages: count(mistakes, 'chat_messages'),
      document_tasks: count(mistakes, 'document_tasks'),
      review_sessions: count(mistakes, 'review_sessions'),
      review_session_mistakes: count(mistakes, 'review_session_mistakes'),
      review_analyses: count(mistakes, 'review_analyses'),
      review_chat_messages: count(mistakes, 'review_chat_messages'),
      delete_change_log_rows: count(mistakes, '__change_log', "operation = 'DELETE'"),
      composite_key_multi_change_records: tableExists(mistakes, '__change_log') ? scalar(mistakes, `
        SELECT COUNT(*) AS count
        FROM (
          SELECT record_id
          FROM __change_log
          WHERE table_name = 'review_session_mistakes'
          GROUP BY record_id
          HAVING COUNT(*) > 1
        );
      `) : 0,
      boundary_rows: [
        ['temp_sessions', '1=1'],
        ['settings', '1=1'],
        ['rag_configurations', '1=1'],
        ['custom_anki_templates', '1=1'],
        ['rag_sub_libraries', '1=1'],
        ['document_control_states', '1=1'],
        ['search_logs', '1=1'],
        ['exam_sheet_sessions', '1=1'],
      ].reduce((sum, [table, where]) => sum + count(mistakes, table, where), 0),
      json_rich_messages: count(mistakes, 'chat_messages', "tool_call IS NOT NULL OR tool_result IS NOT NULL OR graph_sources IS NOT NULL OR image_base64 IS NOT NULL"),
    },
    llm: {
      usage_logs: count(llm, 'llm_usage_logs'),
      usage_daily: count(llm, 'llm_usage_daily'),
      providers: distinctCount(llm, 'llm_usage_logs', 'provider'),
      models: distinctCount(llm, 'llm_usage_logs', 'model'),
      statuses: distinctCount(llm, 'llm_usage_logs', 'status'),
      token_sources: distinctCount(llm, 'llm_usage_logs', 'token_source'),
      caller_types: distinctCount(llm, 'llm_usage_logs', 'caller_type'),
      errors: count(llm, 'llm_usage_logs', "status != 'success'"),
      delete_change_log_rows: count(llm, '__change_log', "operation = 'DELETE'"),
      multi_change_records: tableExists(llm, '__change_log') ? scalar(llm, `
        SELECT COUNT(*) AS count
        FROM (
          SELECT table_name, record_id
          FROM __change_log
          GROUP BY table_name, record_id
          HAVING COUNT(*) > 1
        );
      `) : 0,
    },
  };
}

function addCheck(checks, name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function evaluateSeed(audit) {
  const checks = [];
  for (const [name, db] of Object.entries(audit.databases)) {
    addCheck(checks, `${name}: foreign keys`, db.foreign_key_errors.length === 0, `${db.foreign_key_errors.length} errors`);
    addCheck(checks, `${name}: no open sync conflicts`, db.open_sync_conflicts === 0, `${db.open_sync_conflicts} open conflicts`);
  }

  addCheck(checks, 'vfs: blob metadata rows', audit.vfs.blobs >= 3, `${audit.vfs.blobs} blobs`);
  addCheck(checks, 'vfs: blob bytes exist', audit.vfs.blob_file_state.exists, JSON.stringify(audit.vfs.blob_file_state.rows || []));
  addCheck(checks, 'vfs: files reference existing blobs', audit.vfs.file_blob_orphans === 0 && audit.vfs.compressed_blob_orphans === 0 && audit.vfs.compressed_blob_refs >= 1, `blob=${audit.vfs.file_blob_orphans}, compressed=${audit.vfs.compressed_blob_orphans}, compressed_refs=${audit.vfs.compressed_blob_refs}`);
  addCheck(checks, 'vfs: multimodal file breadth', audit.vfs.image_files >= 1, `image_files=${audit.vfs.image_files}`);
  addCheck(checks, 'vfs: question set breadth', audit.vfs.exam_sheets >= 1 && audit.vfs.questions >= 5 && audit.vfs.question_types >= 5, `${audit.vfs.questions} questions, ${audit.vfs.question_types} types`);
  addCheck(checks, 'vfs: answer and review rows', audit.vfs.answer_submissions >= 5 && audit.vfs.review_plans >= 5, `answers=${audit.vfs.answer_submissions}, plans=${audit.vfs.review_plans}`);
  addCheck(checks, 'vfs: todo hierarchy', audit.vfs.todo_lists >= 1 && audit.vfs.todo_parent_edges >= 2 && audit.vfs.todo_cross_list_parents === 0, `edges=${audit.vfs.todo_parent_edges}, cross_list=${audit.vfs.todo_cross_list_parents}`);
  addCheck(checks, 'vfs: folder/resource links', audit.vfs.folder_items >= 5 && audit.vfs.resources >= 5, `folder_items=${audit.vfs.folder_items}, resources=${audit.vfs.resources}`);
  addCheck(checks, 'vfs: learning app spread', audit.vfs.translations >= 1 && audit.vfs.essays >= 1 && audit.vfs.mindmaps >= 1, `translations=${audit.vfs.translations}, essays=${audit.vfs.essays}, mindmaps=${audit.vfs.mindmaps}`);
  addCheck(checks, 'vfs: tombstones and multi-change rows', audit.vfs.soft_deleted_rows >= 1 && audit.vfs.delete_change_log_rows >= 1 && audit.vfs.multi_change_records >= 1, `soft=${audit.vfs.soft_deleted_rows}, deletes=${audit.vfs.delete_change_log_rows}, multi=${audit.vfs.multi_change_records}`);
  addCheck(checks, 'vfs: boundary table rows', audit.vfs.boundary_rows >= 9, `boundary_rows=${audit.vfs.boundary_rows}`);

  addCheck(checks, 'chat: multi-block conversation', audit.chat.sessions >= 2 && audit.chat.messages >= 3 && audit.chat.blocks >= 4 && audit.chat.block_types >= 3, `sessions=${audit.chat.sessions}, blocks=${audit.chat.blocks}, types=${audit.chat.block_types}`);
  addCheck(checks, 'chat: attachments and learning links', audit.chat.attachments >= 1 && audit.chat.session_mistakes >= 1 && audit.chat.resources >= 1, `attachments=${audit.chat.attachments}, session_mistakes=${audit.chat.session_mistakes}`);
  addCheck(checks, 'chat: grouping/workspace/deleted session', audit.chat.workspaces >= 1 && audit.chat.groups >= 1 && audit.chat.deleted_sessions >= 1, `workspaces=${audit.chat.workspaces}, groups=${audit.chat.groups}, deleted=${audit.chat.deleted_sessions}`);
  addCheck(checks, 'chat: variants/errors/deletes', audit.chat.variant_messages >= 1 && audit.chat.error_blocks >= 1 && audit.chat.delete_change_log_rows >= 1 && audit.chat.session_mistake_multi_change_records >= 1, `variants=${audit.chat.variant_messages}, errors=${audit.chat.error_blocks}, deletes=${audit.chat.delete_change_log_rows}, composite_multi=${audit.chat.session_mistake_multi_change_records}`);
  addCheck(checks, 'chat: boundary table rows', audit.chat.boundary_rows >= 6, `boundary_rows=${audit.chat.boundary_rows}`);

  addCheck(checks, 'mistakes: review lifecycle', audit.mistakes.mistakes >= 2 && audit.mistakes.anki_cards >= 2 && audit.mistakes.review_sessions >= 1 && audit.mistakes.review_analyses >= 1, `mistakes=${audit.mistakes.mistakes}, cards=${audit.mistakes.anki_cards}`);
  addCheck(checks, 'mistakes: deleted and chat coverage', audit.mistakes.deleted_mistakes >= 1 && audit.mistakes.chat_messages >= 2 && audit.mistakes.review_chat_messages >= 1, `deleted=${audit.mistakes.deleted_mistakes}, chat=${audit.mistakes.chat_messages}`);
  addCheck(checks, 'mistakes: composite/delete/json/boundary coverage', audit.mistakes.delete_change_log_rows >= 1 && audit.mistakes.composite_key_multi_change_records >= 1 && audit.mistakes.boundary_rows >= 8 && audit.mistakes.json_rich_messages >= 1, `deletes=${audit.mistakes.delete_change_log_rows}, composite_multi=${audit.mistakes.composite_key_multi_change_records}, boundary=${audit.mistakes.boundary_rows}, json_messages=${audit.mistakes.json_rich_messages}`);

  addCheck(checks, 'llm: provider/model/status breadth', audit.llm.usage_logs >= 8 && audit.llm.providers >= 2 && audit.llm.models >= 3 && audit.llm.statuses >= 4 && audit.llm.errors >= 1, `logs=${audit.llm.usage_logs}, providers=${audit.llm.providers}, models=${audit.llm.models}, statuses=${audit.llm.statuses}`);
  addCheck(checks, 'llm: token/caller/delete/daily coverage', audit.llm.token_sources >= 3 && audit.llm.caller_types >= 6 && audit.llm.delete_change_log_rows >= 1 && audit.llm.multi_change_records >= 1 && audit.llm.usage_daily >= 1, `token_sources=${audit.llm.token_sources}, caller_types=${audit.llm.caller_types}, deletes=${audit.llm.delete_change_log_rows}, multi=${audit.llm.multi_change_records}, daily=${audit.llm.usage_daily}`);

  return {
    ok: checks.every(check => check.ok),
    checks,
  };
}

function evaluateHydrated(audit) {
  const checks = [];
  for (const [name, db] of Object.entries(audit.databases)) {
    addCheck(checks, `${name}: foreign keys`, db.foreign_key_errors.length === 0, `${db.foreign_key_errors.length} errors`);
    addCheck(checks, `${name}: no open sync conflicts`, db.open_sync_conflicts === 0, `${db.open_sync_conflicts} open conflicts`);
  }

  addCheck(checks, 'vfs: blob metadata rows hydrated', audit.vfs.blobs >= 3, `${audit.vfs.blobs} blobs`);
  addCheck(checks, 'vfs: blob bytes hydrated', audit.vfs.blob_file_state.exists, JSON.stringify(audit.vfs.blob_file_state.rows || []));
  addCheck(checks, 'vfs: no blob orphans after download', audit.vfs.file_blob_orphans === 0 && audit.vfs.compressed_blob_orphans === 0, `blob=${audit.vfs.file_blob_orphans}, compressed=${audit.vfs.compressed_blob_orphans}`);
  addCheck(checks, 'vfs: compressed and image coverage hydrated', audit.vfs.compressed_blob_refs >= 1 && audit.vfs.image_files >= 1, `compressed_refs=${audit.vfs.compressed_blob_refs}, image_files=${audit.vfs.image_files}`);
  addCheck(checks, 'vfs: question set hydrated', audit.vfs.exam_sheets >= 1 && audit.vfs.questions >= 5 && audit.vfs.question_types >= 5 && audit.vfs.answer_submissions >= 5, `sheets=${audit.vfs.exam_sheets}, questions=${audit.vfs.questions}, types=${audit.vfs.question_types}, answers=${audit.vfs.answer_submissions}`);
  addCheck(checks, 'vfs: todo hierarchy hydrated', audit.vfs.todo_lists >= 1 && audit.vfs.todo_parent_edges >= 2 && audit.vfs.todo_cross_list_parents === 0, `lists=${audit.vfs.todo_lists}, edges=${audit.vfs.todo_parent_edges}, cross_list=${audit.vfs.todo_cross_list_parents}`);
  addCheck(checks, 'vfs: learning apps hydrated', audit.vfs.translations >= 1 && audit.vfs.essays >= 1 && audit.vfs.mindmaps >= 1, `translations=${audit.vfs.translations}, essays=${audit.vfs.essays}, mindmaps=${audit.vfs.mindmaps}`);
  addCheck(checks, 'vfs: tombstone final state hydrated', audit.vfs.soft_deleted_rows >= 1, `soft_deleted=${audit.vfs.soft_deleted_rows}`);

  addCheck(checks, 'chat: conversation graph hydrated', audit.chat.sessions >= 2 && audit.chat.messages >= 3 && audit.chat.blocks >= 4 && audit.chat.block_types >= 3, `sessions=${audit.chat.sessions}, messages=${audit.chat.messages}, blocks=${audit.chat.blocks}, types=${audit.chat.block_types}`);
  addCheck(checks, 'chat: rich blocks hydrated', audit.chat.variant_messages >= 1 && audit.chat.error_blocks >= 1, `variants=${audit.chat.variant_messages}, errors=${audit.chat.error_blocks}`);
  addCheck(checks, 'chat: links hydrated', audit.chat.attachments >= 1 && audit.chat.session_mistakes >= 1 && audit.chat.resources >= 1, `attachments=${audit.chat.attachments}, session_mistakes=${audit.chat.session_mistakes}, resources=${audit.chat.resources}`);

  addCheck(checks, 'mistakes: lifecycle hydrated', audit.mistakes.mistakes >= 2 && audit.mistakes.anki_cards >= 2 && audit.mistakes.review_sessions >= 1 && audit.mistakes.review_analyses >= 1, `mistakes=${audit.mistakes.mistakes}, cards=${audit.mistakes.anki_cards}, reviews=${audit.mistakes.review_sessions}`);
  addCheck(checks, 'mistakes: review links hydrated', audit.mistakes.review_session_mistakes >= 1 && audit.mistakes.review_chat_messages >= 1 && audit.mistakes.json_rich_messages >= 1, `review_mistakes=${audit.mistakes.review_session_mistakes}, review_chat=${audit.mistakes.review_chat_messages}, json_messages=${audit.mistakes.json_rich_messages}`);

  addCheck(checks, 'llm: usage breadth hydrated', audit.llm.usage_logs >= 8 && audit.llm.providers >= 2 && audit.llm.models >= 3 && audit.llm.statuses >= 4 && audit.llm.errors >= 1, `logs=${audit.llm.usage_logs}, providers=${audit.llm.providers}, models=${audit.llm.models}, statuses=${audit.llm.statuses}`);
  addCheck(checks, 'llm: token/caller breadth hydrated', audit.llm.token_sources >= 3 && audit.llm.caller_types >= 6, `token_sources=${audit.llm.token_sources}, caller_types=${audit.llm.caller_types}`);

  addCheck(checks, 'workspace db files hydrated', audit.workspaces.files >= 1 && audit.workspaces.bytes > 0, `files=${audit.workspaces.files}, bytes=${audit.workspaces.bytes}, samples=${JSON.stringify(audit.workspaces.samples)}`);

  return {
    ok: checks.every(check => check.ok),
    checks,
  };
}

function evaluate(audit, mode) {
  if (mode === 'seed') return evaluateSeed(audit);
  if (mode === 'hydrated') return evaluateHydrated(audit);
  throw new Error(`Unknown mode: ${mode}`);
}

function formatText(audit, evaluation, mode) {
  const lines = [];
  lines.push(`Wide sync ${mode} audit: ${evaluation.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`Slot root: ${audit.slot_root}`);
  for (const check of evaluation.checks) {
    lines.push(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['seed', 'hydrated'].includes(args.mode)) {
    throw new Error(`Unsupported --mode ${args.mode}. Expected seed or hydrated.`);
  }
  const audit = collectAudit(resolveSlotRoot(args));
  const evaluation = evaluate(audit, args.mode);
  const output = { ok: evaluation.ok, mode: args.mode, audit, checks: evaluation.checks };
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatText(audit, evaluation, args.mode));
  }
  if (args.strict && !evaluation.ok) process.exit(2);
}

main();
