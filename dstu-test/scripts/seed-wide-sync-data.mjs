#!/usr/bin/env node
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TAURI_LAB_HOME = process.env.TAURI_LAB_HOME
  ? path.resolve(process.env.TAURI_LAB_HOME)
  : path.join(os.homedir(), 'Library', 'Application Support', 'tauri-lab');

const APP_SUPPORT_REL = path.join('Library', 'Application Support', 'com.deepstudent.app');
const DEFAULT_PREFIX = 'wide-sync-20260531';
const DEFAULT_SLOT = 'slotA';
const FIXED_ISO = '2026-05-31T10:00:00.000Z';
const FIXED_MS = Date.parse(FIXED_ISO);

function parseArgs(argv) {
  const args = {
    prefix: DEFAULT_PREFIX,
    slot: DEFAULT_SLOT,
    deviceId: 'wide-sync-seed-device',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
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
  node dstu-test/scripts/seed-wide-sync-data.mjs --instance <instance-id> [--slot slotA] [--prefix id] [--json]
  node dstu-test/scripts/seed-wide-sync-data.mjs --image <image-id> [--slot slotA] [--prefix id] [--json]
  node dstu-test/scripts/seed-wide-sync-data.mjs --slot-root <path> [--prefix id] [--json]

The script inserts broad sync coverage data into stopped Deep Student SQLite DBs.
It relies on product triggers to populate __change_log and writes no secrets.`;
}

function sqlite(dbPath, sql, options = {}) {
  const args = [];
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
    if (instance.pid) {
      throw new Error(`Instance ${args.instance} is running; stop it before seeding SQLite data`);
    }
    return path.join(instance.home, APP_SUPPORT_REL, 'slots', args.slot);
  }
  throw new Error(`Missing target.\n${usage()}`);
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
    const stat = fs.statSync(file);
    if (stat.size === 0) throw new Error(`Refusing to seed empty ${name} database: ${file}`);
  }
}

function schema(dbPath) {
  const rows = JSON.parse(sqlite(dbPath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;", { json: true }) || '[]');
  const tables = new Map();
  for (const row of rows) {
    const cols = JSON.parse(sqlite(dbPath, `PRAGMA table_info(${quoteIdent(row.name)});`, { json: true }) || '[]');
    tables.set(row.name, new Set(cols.map(col => col.name)));
  }
  return tables;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function json(value) {
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function numericId(prefix, suffix) {
  return 1000000 + (Number.parseInt(sha256(`${prefix}:${suffix}`).slice(0, 10), 16) % 800000000);
}

function insertOrIgnore(tables, table, row) {
  const cols = tables.get(table);
  if (!cols) return `-- skipped missing table ${table}`;
  const filtered = Object.fromEntries(Object.entries(row).filter(([key]) => cols.has(key)));
  const names = Object.keys(filtered);
  if (names.length === 0) return `-- skipped empty insert ${table}`;
  return [
    `INSERT OR IGNORE INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')})`,
    `VALUES (${names.map(name => lit(filtered[name])).join(', ')});`,
  ].join('\n');
}

function updateIfDifferent(table, sets, where) {
  const assignments = Object.entries(sets)
    .map(([key, value]) => `${quoteIdent(key)} = ${lit(value)}`)
    .join(', ');
  const differs = Object.entries(sets)
    .map(([key, value]) => `(${quoteIdent(key)} IS NOT ${lit(value)})`)
    .join(' OR ');
  return `UPDATE ${quoteIdent(table)} SET ${assignments} WHERE ${where} AND (${differs});`;
}

function countSql(tables) {
  const wanted = [
    'folders',
    'folder_items',
    'resources',
    'notes',
    'files',
    'blobs',
    'exam_sheets',
    'questions',
    'answer_submissions',
    'question_history',
    'review_plans',
    'review_history',
    'todo_lists',
    'todo_items',
    'pomodoro_records',
    'translations',
    'essays',
    'essay_sessions',
    'mindmaps',
    'mindmap_versions',
    'chat_v2_sessions',
    'chat_v2_messages',
    'chat_v2_blocks',
    'chat_v2_attachments',
    'chat_v2_session_groups',
    'chat_v2_session_mistakes',
    'workspace_index',
    'mistakes',
    'anki_cards',
    'chat_messages',
    'document_tasks',
    'review_sessions',
    'review_session_mistakes',
    'review_analyses',
    'review_chat_messages',
    'llm_usage_logs',
    'llm_usage_daily',
    '__change_log',
  ];
  const parts = wanted
    .filter(table => tables.has(table))
    .map(table => `SELECT ${lit(table)} AS table_name, COUNT(*) AS count FROM ${quoteIdent(table)}`);
  return `${parts.join(' UNION ALL ')} ORDER BY table_name;`;
}

function changeLogSql(tables) {
  if (!tables.has('__change_log')) return "SELECT 'missing' AS table_name, 0 AS count;";
  return "SELECT table_name, COUNT(*) AS count FROM __change_log GROUP BY table_name ORDER BY table_name;";
}

function seedVfsSql(tables, prefix, deviceId, blob) {
  const s = [];
  const memoryAuditId = numericId(prefix, 'memory-audit');
  const blobHash = blob.hash;
  const blobRelativePath = blob.relativePath;
  const blobSize = blob.size;
  const folder = `${prefix}-folder-root`;
  const nested = `${prefix}-folder-nested`;
  const nestedDeep = `${prefix}-folder-deep-child`;
  const deletedFolder = `${prefix}-folder-deleted`;
  const noteRes = `${prefix}-res-note-active`;
  const note = `${prefix}-note-active`;
  const noteMut = `${prefix}-note-mutated`;
  const noteMutRes = `${prefix}-res-note-mutated`;
  const noteDel = `${prefix}-note-deleted`;
  const noteDelRes = `${prefix}-res-note-deleted`;
  const fileRes = `${prefix}-res-file-active`;
  const file = `${prefix}-file-active`;
  const imageFileRes = `${prefix}-res-file-image`;
  const imageFile = `${prefix}-file-image`;
  const examRes = `${prefix}-res-exam-rich`;
  const exam = `${prefix}-exam-rich`;
  const deletedExamRes = `${prefix}-res-exam-soft-deleted-parent`;
  const deletedExam = `${prefix}-exam-soft-deleted-parent`;
  const deletedExamQuestion = `${prefix}-q-soft-deleted-parent-child`;
  const essayRes = `${prefix}-res-essay`;
  const essaySession = `${prefix}-essay-session`;
  const essay = `${prefix}-essay-round-2`;
  const mindmapRes = `${prefix}-res-mindmap`;
  const mindmap = `${prefix}-mindmap`;
  const translationRes = `${prefix}-res-translation`;
  const translation = `${prefix}-translation`;
  const todoList = `${prefix}-todo-list`;
  const todoListArchived = `${prefix}-todo-list-archived`;

  s.push(insertOrIgnore(tables, 'folders', {
    id: folder,
    parent_id: null,
    title: 'Wide sync coverage',
    icon: 'layers',
    color: '#2563eb',
    is_expanded: 1,
    sort_order: 53100,
    created_at: FIXED_MS,
    updated_at: FIXED_MS,
    is_favorite: 1,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'folders', {
    id: nested,
    parent_id: folder,
    title: 'Nested references',
    icon: 'folder-tree',
    color: '#059669',
    is_expanded: 0,
    sort_order: 53101,
    created_at: FIXED_MS + 1,
    updated_at: FIXED_MS + 1,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'folders', {
    id: nestedDeep,
    parent_id: nested,
    title: 'Deep child references',
    icon: 'folder-cog',
    color: '#0f766e',
    is_expanded: 1,
    sort_order: 53103,
    created_at: FIXED_MS + 3,
    updated_at: FIXED_MS + 3,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'folders', {
    id: deletedFolder,
    parent_id: folder,
    title: 'Soft deleted folder',
    icon: 'trash',
    color: '#64748b',
    is_expanded: 0,
    sort_order: 53102,
    created_at: FIXED_MS + 2,
    updated_at: FIXED_MS + 2,
    deleted_at: FIXED_ISO,
    device_id: deviceId,
  }));

  for (const row of [
    [noteRes, 'note', note, 'notes', 'Inline markdown note used by wide sync coverage.'],
    [noteMutRes, 'note', noteMut, 'notes', 'This note is inserted and then updated to exercise UPDATE replay.'],
    [noteDelRes, 'note', noteDel, 'notes', 'This note is soft-deleted before image capture.'],
    [fileRes, 'file', file, 'files', 'Synthetic local document with a matching blob row.'],
    [imageFileRes, 'file', imageFile, 'files', 'Synthetic image file with a second blob row.'],
    [examRes, 'exam', exam, 'exam_sheets', 'Rich exam sheet seed with mixed question types.'],
    [deletedExamRes, 'exam', deletedExam, 'exam_sheets', 'Soft-deleted exam parent with child question/submission rows.'],
    [essayRes, 'essay', essay, 'essays', 'Essay grading seed.'],
    [mindmapRes, 'mindmap', mindmap, 'mindmaps', 'Mindmap JSON seed.'],
    [translationRes, 'translation', translation, 'translations', 'Translation result seed.'],
  ]) {
    s.push(insertOrIgnore(tables, 'resources', {
      id: row[0],
      hash: sha256(row.join(':')),
      type: row[1],
      source_id: row[2],
      source_table: row[3],
      storage_mode: 'inline',
      data: row[4],
      metadata_json: json({
        seed: prefix,
        source: 'wide-sync',
        syncCoverage: {
          duplicateHashProbe: row[1] === 'file',
          nestedJson: { labels: ['wide', row[1]], weights: { local: 0.7, remote: 0.3 } },
        },
      }),
      ref_count: 1,
      created_at: FIXED_MS,
      updated_at: FIXED_MS,
      device_id: deviceId,
    }));
  }
  s.push(insertOrIgnore(tables, 'blobs', {
    hash: blobHash,
    relative_path: blobRelativePath,
    size: blobSize,
    mime_type: 'text/markdown',
    ref_count: 1,
    created_at: FIXED_MS,
  }));
  for (const extraBlob of [blob.compressed, blob.image]) {
    s.push(insertOrIgnore(tables, 'blobs', {
      hash: extraBlob.hash,
      relative_path: extraBlob.relativePath,
      size: extraBlob.size,
      mime_type: extraBlob.mimeType,
      ref_count: 1,
      created_at: FIXED_MS + 1,
    }));
  }
  s.push(insertOrIgnore(tables, 'notes', {
    id: note,
    resource_id: noteRes,
    title: 'Wide sync active note',
    tags: json(['sync', 'wide', 'active']),
    is_favorite: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'notes', {
    id: noteMut,
    resource_id: noteMutRes,
    title: 'Wide sync mutable note',
    tags: json(['sync', 'update-before-upload']),
    is_favorite: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(updateIfDifferent('notes', { title: 'Wide sync mutable note updated', is_favorite: 1, updated_at: '2026-05-31T10:05:00.000Z' }, `id = ${lit(noteMut)}`));
  s.push(updateIfDifferent('resources', {
    metadata_json: json({ seed: prefix, source: 'wide-sync', updateChain: ['insert', 'metadata-rewrite'], nested: { pinned: true, counters: [1, 2, 3] } }),
    updated_at: FIXED_MS + 5000,
  }, `id = ${lit(noteMutRes)}`));
  s.push(insertOrIgnore(tables, 'notes', {
    id: noteDel,
    resource_id: noteDelRes,
    title: 'Wide sync soft deleted note',
    tags: json(['sync', 'deleted']),
    is_favorite: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    deleted_at: '2026-05-31T10:06:00.000Z',
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'files', {
    id: file,
    resource_id: fileRes,
    blob_hash: blobHash,
    sha256: blobHash,
    file_name: 'wide-sync-coverage.md',
    original_path: '/synthetic/wide-sync-coverage.md',
    size: blobSize,
    compressed_blob_hash: blob.compressed.hash,
    page_count: 1,
    tags_json: json(['sync', 'blob', 'markdown']),
    is_favorite: 1,
    bookmarks_json: json([{ page: 1, label: 'seed' }]),
    status: 'active',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    type: 'document',
    name: 'wide-sync-coverage.md',
    content_hash: blobHash,
    description: 'Small markdown file for wide sync coverage',
    mime_type: 'text/markdown',
    preview_json: json({ pages: 1, kind: 'markdown' }),
    extracted_text: 'Wide sync coverage markdown content.',
    ocr_pages_json: json([{ page: 1, text: 'Wide sync coverage markdown content.' }]),
    mm_indexed_pages_json: json([1]),
    mm_index_state: 'completed',
    processing_status: 'completed',
    processing_progress: json({ percent: 100 }),
    processing_completed_at: FIXED_MS,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'files', {
    id: imageFile,
    resource_id: imageFileRes,
    blob_hash: blob.image.hash,
    sha256: blob.image.hash,
    file_name: 'wide-sync-diagram.png',
    original_path: '/synthetic/wide-sync-diagram.png',
    size: blob.image.size,
    page_count: 1,
    tags_json: json(['sync', 'blob', 'image']),
    is_favorite: 0,
    bookmarks_json: json([]),
    cover_key: blob.image.hash,
    status: 'active',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    type: 'image',
    name: 'wide-sync-diagram.png',
    content_hash: blob.image.hash,
    description: 'Small PNG-like seed blob for image/file sync coverage',
    mime_type: 'image/png',
    preview_json: json({ pages: 1, kind: 'image', width: 1, height: 1 }),
    extracted_text: '',
    processing_status: 'completed',
    processing_progress: json({ percent: 100 }),
    processing_completed_at: FIXED_MS,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'exam_sheets', {
    id: exam,
    resource_id: examRes,
    exam_name: 'Wide Sync Mixed Question Set',
    status: 'ready',
    temp_id: `${prefix}-temp-exam`,
    metadata_json: json({ source_type: 'seed', subject: 'mixed', coverage: ['choice', 'multi', 'fill', 'essay', 'image'] }),
    preview_json: json({ pages: [{ page: 1, question_count: 5 }] }),
    linked_mistake_ids: json([`${prefix}-mistake-active`]),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    is_favorite: 1,
    sync_enabled: 1,
    remote_exam_id: `${prefix}-remote-exam`,
    sync_config: json({ provider: 'seed', mode: 'wide' }),
    device_id: deviceId,
  }));
  const questions = [
    ['q1', 'A', 'single_choice', 'medium', json(['A', 'B', 'C', 'D']), 'B', 'B', 1],
    ['q2', 'A,C', 'multiple_choice', 'hard', json(['A', 'B', 'C', 'D']), 'A,C', 'A,D', 0],
    ['q3', 'magnetic flux', 'fill_blank', 'easy', null, 'magnetic flux', 'magnetic flux', 1],
    ['q4', 'Use Faraday law and explain signs.', 'short_answer', 'hard', null, 'Faraday law', 'partial Faraday law', 0],
    ['q5', 'See attached diagram.', 'image_reasoning', 'medium', null, 'clockwise', null, null],
  ];
  for (const [suffix, answer, type, difficulty, options, userAnswer, submission, correct] of questions) {
    const qid = `${prefix}-${suffix}`;
    s.push(insertOrIgnore(tables, 'questions', {
      id: qid,
      exam_id: exam,
      question_label: suffix.toUpperCase(),
      content: `Wide sync ${type} question ${suffix}`,
      options_json: options,
      answer,
      explanation: `Seed explanation for ${suffix}.`,
      question_type: type,
      difficulty,
      tags: json(['wide-sync', type]),
      status: submission ? 'answered' : 'new',
      user_answer: submission,
      is_correct: correct,
      attempt_count: submission ? 1 : 0,
      correct_count: correct ? 1 : 0,
      last_attempt_at: submission ? FIXED_ISO : null,
      user_note: suffix === 'q2' ? 'Needs review' : null,
      is_favorite: suffix === 'q4' ? 1 : 0,
      is_bookmarked: suffix === 'q2' ? 1 : 0,
      source_type: 'seed',
      source_ref: exam,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      sync_status: 'local_only',
      content_hash: sha256(`${qid}:${type}:${answer}`),
      device_id: deviceId,
      images_json: suffix === 'q5' ? json([{ name: 'diagram.png', mime_type: 'image/png', size: 1200 }]) : json([]),
      ai_feedback: submission ? `AI feedback for ${suffix}` : null,
      ai_score: correct === null ? null : correct ? 95 : 48,
      ai_graded_at: submission ? FIXED_ISO : null,
    }));
    if (submission) {
      s.push(insertOrIgnore(tables, 'answer_submissions', {
        id: `${qid}-submission-1`,
        question_id: qid,
        user_answer: submission,
        is_correct: correct,
        grading_method: suffix === 'q4' ? 'ai' : 'auto',
        submitted_at: FIXED_ISO,
        client_request_id: `${qid}-request-1`,
        device_id: deviceId,
        updated_at: FIXED_ISO,
      }));
      if (suffix === 'q2') {
        s.push(insertOrIgnore(tables, 'answer_submissions', {
          id: `${qid}-submission-retry`,
          question_id: qid,
          user_answer: 'A,C',
          is_correct: 1,
          grading_method: 'manual',
          submitted_at: '2026-05-31T10:04:30.000Z',
          client_request_id: `${qid}-request-retry`,
          device_id: deviceId,
          updated_at: '2026-05-31T10:04:30.000Z',
        }));
      }
    }
    s.push(insertOrIgnore(tables, 'question_history', {
      id: `${qid}-history-1`,
      question_id: qid,
      field_name: 'status',
      old_value: 'new',
      new_value: submission ? 'answered' : 'new',
      operator: 'seed',
      reason: 'wide sync coverage',
      created_at: FIXED_ISO,
    }));
    s.push(insertOrIgnore(tables, 'review_plans', {
      id: `${qid}-review-plan`,
      question_id: qid,
      exam_id: exam,
      ease_factor: correct ? 2.6 : 2.1,
      interval_days: correct ? 3 : 1,
      repetitions: submission ? 1 : 0,
      next_review_date: '2026-06-01',
      last_review_date: submission ? '2026-05-31' : null,
      status: correct ? 'learning' : 'due',
      total_reviews: submission ? 1 : 0,
      total_correct: correct ? 1 : 0,
      consecutive_failures: correct === 0 ? 1 : 0,
      is_difficult: correct === 0 ? 1 : 0,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      device_id: deviceId,
    }));
    s.push(insertOrIgnore(tables, 'review_history', {
      id: `${qid}-review-history-1`,
      plan_id: `${qid}-review-plan`,
      question_id: qid,
      quality: correct ? 5 : 2,
      passed: correct ? 1 : 0,
      ease_factor_before: 2.5,
      ease_factor_after: correct ? 2.6 : 2.1,
      interval_before: 0,
      interval_after: correct ? 3 : 1,
      repetitions_before: 0,
      repetitions_after: 1,
      reviewed_at: FIXED_ISO,
      user_answer: submission,
      time_spent_seconds: 45,
    }));
  }
  s.push(updateIfDifferent('questions', {
    tags: json(['wide-sync', 'multiple_choice', 'retry', 'json-update-chain']),
    images_json: json([{ name: 'q2-local-annotation.png', mime_type: 'image/png', size: 2048, regions: [{ x: 12, y: 20, w: 80, h: 44 }] }]),
    user_note: 'Updated after retry; tests JSON merge and update replay.',
    updated_at: '2026-05-31T10:04:31.000Z',
    sync_status: 'modified',
  }, `id = ${lit(`${prefix}-q2`)}`));
  s.push(insertOrIgnore(tables, 'exam_sheets', {
    id: deletedExam,
    resource_id: deletedExamRes,
    exam_name: 'Wide Sync Soft Deleted Parent Sheet',
    status: 'archived',
    temp_id: `${prefix}-temp-deleted-exam`,
    metadata_json: json({ source_type: 'seed', boundary: 'parent-with-children-tombstone' }),
    preview_json: json({ pages: [{ page: 1, question_count: 1 }] }),
    linked_mistake_ids: json([`${prefix}-mistake-deleted`]),
    created_at: FIXED_ISO,
    updated_at: '2026-05-31T10:04:40.000Z',
    deleted_at: '2026-05-31T10:04:41.000Z',
    sync_enabled: 1,
    remote_exam_id: `${prefix}-remote-deleted-exam`,
    sync_config: json({ provider: 'seed', mode: 'tombstone-parent' }),
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'questions', {
    id: deletedExamQuestion,
    exam_id: deletedExam,
    question_label: 'TOMBSTONE-1',
    content: 'Question under a soft-deleted exam parent.',
    options_json: json(['True', 'False']),
    answer: 'True',
    explanation: 'The parent tombstone should not break child replay ordering.',
    question_type: 'single_choice',
    difficulty: 'easy',
    tags: json(['wide-sync', 'soft-deleted-parent']),
    status: 'answered',
    user_answer: 'False',
    is_correct: 0,
    attempt_count: 1,
    correct_count: 0,
    last_attempt_at: FIXED_ISO,
    user_note: 'Child row kept to test parent tombstone ordering.',
    source_type: 'seed',
    source_ref: deletedExam,
    created_at: FIXED_ISO,
    updated_at: '2026-05-31T10:04:42.000Z',
    deleted_at: '2026-05-31T10:04:43.000Z',
    sync_status: 'modified',
    content_hash: sha256(`${deletedExamQuestion}:deleted-parent-child`),
    device_id: deviceId,
    images_json: json([]),
    ai_feedback: 'Synthetic feedback on tombstoned child.',
    ai_score: 12,
    ai_graded_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'answer_submissions', {
    id: `${deletedExamQuestion}-submission-1`,
    question_id: deletedExamQuestion,
    user_answer: 'False',
    is_correct: 0,
    grading_method: 'auto',
    submitted_at: FIXED_ISO,
    client_request_id: `${deletedExamQuestion}-request-1`,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'review_plans', {
    id: `${deletedExamQuestion}-review-plan`,
    question_id: deletedExamQuestion,
    exam_id: deletedExam,
    ease_factor: 1.9,
    interval_days: 1,
    repetitions: 1,
    next_review_date: '2026-06-01',
    last_review_date: '2026-05-31',
    status: 'suspended',
    total_reviews: 1,
    total_correct: 0,
    consecutive_failures: 1,
    is_difficult: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'todo_lists', {
    id: todoList,
    title: 'Wide sync checklist',
    description: 'Todo list with nested, due, completed, and deleted items.',
    icon: 'check-square',
    color: '#f59e0b',
    sort_order: 53100,
    is_default: 0,
    is_favorite: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'todo_lists', {
    id: todoListArchived,
    title: 'Wide sync archived checklist',
    description: 'Soft deleted list for tombstone coverage.',
    icon: 'archive',
    color: '#94a3b8',
    sort_order: 53101,
    is_default: 0,
    is_favorite: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    deleted_at: '2026-05-31T10:10:00.000Z',
    device_id: deviceId,
  }));
  const todoRows = [
    ['todo-parent', 'Review synced question set', 'pending', 'high', null, null, 4, 1],
    ['todo-child', 'Fix weak electromagnetic induction step', 'pending', 'medium', 'todo-parent', '2026-06-01', 2, 0],
    ['todo-grandchild', 'Attach the corrected diagram to the explanation', 'pending', 'high', 'todo-child', '2026-06-02', 1, 0],
    ['todo-done', 'Export initial notes', 'completed', 'low', null, null, 1, 1],
    ['todo-deleted', 'Obsolete local task', 'pending', 'none', null, null, 0, 0],
  ];
  for (const [suffix, title, status, priority, parentSuffix, dueDate, estimated, completed] of todoRows) {
    const id = `${prefix}-${suffix}`;
    s.push(insertOrIgnore(tables, 'todo_items', {
      id,
      todo_list_id: todoList,
      title,
      description: `Seed ${status} todo for wide sync coverage.`,
      status,
      priority,
      due_date: dueDate,
      due_time: dueDate ? '20:30' : null,
      reminder: dueDate ? '2026-06-01T19:30:00.000Z' : null,
      tags_json: json(['wide-sync', status]),
      sort_order: todoRows.findIndex(row => row[0] === suffix),
      parent_id: parentSuffix ? `${prefix}-${parentSuffix}` : null,
      completed_at: status === 'completed' ? FIXED_ISO : null,
      repeat_json: suffix === 'todo-child' ? json({ type: 'weekly', interval: 1 }) : null,
      attachments_json: suffix === 'todo-parent' ? json([{ type: 'question', id: `${prefix}-q2` }]) : json([]),
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      deleted_at: suffix === 'todo-deleted' ? '2026-05-31T10:11:00.000Z' : null,
      estimated_pomodoros: estimated,
      completed_pomodoros: completed,
      device_id: deviceId,
    }));
  }
  s.push(insertOrIgnore(tables, 'pomodoro_records', {
    id: `${prefix}-pomodoro-work`,
    todo_item_id: `${prefix}-todo-parent`,
    start_time: '2026-05-31T09:25:00.000Z',
    end_time: '2026-05-31T09:50:00.000Z',
    duration: 1500,
    actual_duration: 1480,
    type: 'work',
    status: 'completed',
    created_at: FIXED_ISO,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'essay_sessions', {
    id: essaySession,
    title: 'Wide sync essay session',
    essay_type: 'argument',
    grade_level: 'high-school',
    custom_prompt: 'Grade structure and evidence.',
    subject: 'writing',
    total_rounds: 2,
    latest_score: 86,
    is_favorite: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'essays', {
    id: essay,
    resource_id: essayRes,
    title: 'Wide sync graded essay',
    essay_type: 'argument',
    grading_result_json: json({ summary: 'Clear structure, needs stronger evidence.', dimensions: ['structure', 'language', 'logic'] }),
    score: 86,
    session_id: essaySession,
    round_number: 2,
    grade_level: 'high-school',
    custom_prompt: 'Grade structure and evidence.',
    dimension_scores_json: json({ structure: 30, language: 28, logic: 28 }),
    is_favorite: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'mindmaps', {
    id: mindmap,
    resource_id: mindmapRes,
    title: 'Wide sync concept map',
    description: 'Mindmap with settings and version history.',
    is_favorite: 1,
    default_view: 'mindmap',
    theme: 'academic',
    settings: json({ layout: 'tree', showTags: true }),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'mindmap_versions', {
    version_id: `${prefix}-mindmap-version-1`,
    mindmap_id: mindmap,
    resource_id: mindmapRes,
    title: 'Wide sync concept map v1',
    label: 'seed baseline',
    source: 'manual',
    created_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'translations', {
    id: translation,
    resource_id: translationRes,
    src_lang: 'en',
    tgt_lang: 'zh',
    engine: 'seed',
    model: 'wide-sync-translator',
    is_favorite: 1,
    quality_rating: 4,
    created_at: FIXED_ISO,
    metadata_json: json({ source_text: 'Cloud sync should preserve structured learning data.' }),
    title: 'Wide sync translation',
    subject: 'sync',
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  const folderLinks = [
    ['note', note],
    ['note', noteMut],
    ['image', file],
    ['image', imageFile],
    ['exam', exam],
    ['essay', essaySession],
    ['mindmap', mindmap],
    ['translation', translation],
  ];
  folderLinks.forEach(([type, id], index) => {
    s.push(insertOrIgnore(tables, 'folder_items', {
      id: `${prefix}-fi-${index + 1}`,
      folder_id: index < 2 ? nestedDeep : index === 2 ? nested : folder,
      item_type: type,
      item_id: id,
      sort_order: index,
      created_at: FIXED_MS + index,
      updated_at: FIXED_MS + index,
      cached_path: `/Wide sync coverage/${type}/${id}`,
      device_id: deviceId,
    }));
  });
  s.push(insertOrIgnore(tables, 'question_sync_conflicts', {
    id: `${prefix}-qsync-conflict-local-only`,
    question_id: `${prefix}-q2`,
    exam_id: exam,
    conflict_type: 'modify_modify',
    local_snapshot: json({ answer: 'A,D', tags: ['local'] }),
    remote_snapshot: json({ answer: 'A,C', tags: ['remote'] }),
    local_hash: sha256(`${prefix}:local-q2`),
    remote_hash: sha256(`${prefix}:remote-q2`),
    local_updated_at: FIXED_ISO,
    remote_updated_at: '2026-05-31T10:07:00.000Z',
    status: 'pending',
    created_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'question_sync_logs', {
    id: `${prefix}-qsync-log-local-only`,
    exam_id: exam,
    direction: 'pull',
    sync_type: 'incremental',
    result: 'partial',
    synced_count: 4,
    conflict_count: 1,
    error_count: 0,
    details_json: json({ boundary: 'local-runtime-not-row-sync' }),
    started_at: FIXED_ISO,
    completed_at: '2026-05-31T10:08:00.000Z',
  }));
  s.push(insertOrIgnore(tables, 'memory_config', {
    key: `${prefix}:memory-config`,
    value: json({ mode: 'backup-only', seed: prefix }),
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'vfs_indexing_config', {
    key: `${prefix}:indexing-config`,
    value: json({ chunkSize: 384, multimodal: true }),
    updated_at: FIXED_MS,
  }));
  s.push(insertOrIgnore(tables, 'memory_audit_log', {
    id: memoryAuditId,
    timestamp: FIXED_ISO,
    source: 'manual',
    operation: 'write',
    success: 1,
    note_id: note,
    title: 'Wide sync memory audit boundary',
    content_preview: 'Local runtime audit row should stay local.',
    folder: '/Wide sync coverage',
    event: 'ADD',
    confidence: 0.98,
    reason: 'seed boundary coverage',
    session_id: `${prefix}-chat-session`,
    duration_ms: 42,
    extra_json: json({ seed: prefix }),
  }));
  s.push(insertOrIgnore(tables, 'memory_write_idempotency', {
    idempotency_key: `${prefix}:memory-write`,
    note_id: note,
    event: 'ADD',
    is_new: 1,
    confidence: 0.98,
    reason: 'seed boundary coverage',
    resource_id: noteRes,
    downgraded: 0,
    created_at: FIXED_MS,
  }));
  s.push(insertOrIgnore(tables, 'resources', {
    id: `${prefix}-res-hard-delete-probe`,
    hash: sha256(`${prefix}:hard-delete`),
    type: 'note',
    source_id: `${prefix}-hard-delete-probe`,
    source_table: 'notes',
    storage_mode: 'inline',
    data: 'Inserted then hard-deleted to exercise DELETE change-log replay.',
    ref_count: 0,
    created_at: FIXED_MS,
    updated_at: FIXED_MS,
    device_id: deviceId,
  }));
  s.push(`DELETE FROM resources WHERE id = ${lit(`${prefix}-res-hard-delete-probe`)};`);
  s.push(insertOrIgnore(tables, 'resources', {
    id: `${prefix}-res-unique-hash-first`,
    hash: sha256(`${prefix}:unique-hash-reuse`),
    type: 'note',
    source_id: `${prefix}-unique-hash-first`,
    source_table: 'notes',
    storage_mode: 'inline',
    data: 'First owner of a reused business-unique resource hash.',
    metadata_json: json({ seed: prefix, uniqueProbe: 'first' }),
    ref_count: 0,
    created_at: FIXED_MS,
    updated_at: FIXED_MS,
    device_id: deviceId,
  }));
  s.push(`DELETE FROM resources WHERE id = ${lit(`${prefix}-res-unique-hash-first`)};`);
  s.push(insertOrIgnore(tables, 'resources', {
    id: `${prefix}-res-unique-hash-second`,
    hash: sha256(`${prefix}:unique-hash-reuse`),
    type: 'note',
    source_id: `${prefix}-unique-hash-second`,
    source_table: 'notes',
    storage_mode: 'inline',
    data: 'Second owner of the same resource hash after a hard delete.',
    metadata_json: json({ seed: prefix, uniqueProbe: 'second-after-delete' }),
    ref_count: 1,
    created_at: FIXED_MS + 1,
    updated_at: FIXED_MS + 1,
    device_id: deviceId,
  }));
  return s.join('\n');
}

function seedChatSql(tables, prefix, deviceId) {
  const s = [];
  const workspace = `${prefix}-workspace`;
  const group = `${prefix}-session-group`;
  const session = `${prefix}-chat-session`;
  const deletedSession = `${prefix}-chat-session-deleted`;
  const userMessage = `${prefix}-msg-user`;
  const assistantMessage = `${prefix}-msg-assistant`;
  const assistantVariantMessage = `${prefix}-msg-assistant-variant`;
  const toolMessage = `${prefix}-msg-tool`;
  const deletedMessage = `${prefix}-msg-deleted`;
  const deletedSessionMessage = `${prefix}-msg-deleted-session-child`;
  const userBlock = `${prefix}-block-user`;
  const thinkingBlock = `${prefix}-block-thinking`;
  const answerBlock = `${prefix}-block-answer`;
  const variantBlock = `${prefix}-block-variant-answer`;
  const errorBlock = `${prefix}-block-error-tool`;
  const toolBlock = `${prefix}-block-tool`;
  const deletedSessionBlock = `${prefix}-block-deleted-session-child`;
  s.push(insertOrIgnore(tables, 'workspace_index', {
    workspace_id: workspace,
    name: 'Wide sync workspace',
    status: 'active',
    creator_session_id: session,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_session_groups', {
    id: group,
    name: 'Wide sync group',
    description: 'Session group seed',
    icon: 'messages-square',
    color: '#7c3aed',
    system_prompt: 'Preserve structured learning context across devices.',
    default_skill_ids_json: json(['resource-manager', 'question-bank']),
    workspace_id: workspace,
    sort_order: 531,
    persist_status: 'active',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pinned_resource_ids_json: json([`${prefix}-res-note-active`, `${prefix}-exam-rich`]),
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_sessions', {
    id: session,
    mode: 'chat',
    title: 'Wide sync multi-block chat',
    persist_status: 'active',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    metadata_json: json({ seed: prefix, linked_exam_id: `${prefix}-exam-rich` }),
    description: 'Conversation with attachments, resources, thinking, and tool blocks.',
    summary_hash: sha256(`${prefix}:summary`),
    workspace_id: workspace,
    device_id: deviceId,
    group_id: group,
    tags_hash: sha256('wide-sync,question-bank'),
    title_locked: 1,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_sessions', {
    id: deletedSession,
    mode: 'chat',
    title: 'Wide sync deleted session',
    persist_status: 'deleted',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    deleted_at: '2026-05-31T10:20:00.000Z',
    device_id: deviceId,
  }));
  s.push(updateIfDifferent('chat_v2_session_groups', {
    default_skill_ids_json: json(['resource-manager', 'question-bank', 'sync-auditor']),
    pinned_resource_ids_json: json([`${prefix}-res-note-active`, `${prefix}-exam-rich`, `${prefix}-file-image`]),
    updated_at: '2026-05-31T10:19:30.000Z',
  }, `id = ${lit(group)}`));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: userMessage,
    session_id: session,
    role: 'user',
    block_ids_json: json([userBlock]),
    timestamp: FIXED_MS,
    persistent_stable_id: `${prefix}-stable-user`,
    meta_json: json({ source: 'seed' }),
    attachments_json: json([`${prefix}-attachment-image`]),
    shared_context_json: json({ resourceIds: [`${prefix}-note-active`] }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: assistantMessage,
    session_id: session,
    role: 'assistant',
    block_ids_json: json([thinkingBlock, answerBlock]),
    timestamp: FIXED_MS + 1000,
    persistent_stable_id: `${prefix}-stable-assistant`,
    parent_id: userMessage,
    active_variant_id: `${prefix}-variant-main`,
    variants_json: json([
      { id: `${prefix}-variant-main`, message_id: assistantMessage, label: 'main' },
      { id: `${prefix}-variant-alt`, message_id: assistantVariantMessage, label: 'alternate' },
    ]),
    meta_json: json({ model: 'deepseek-v4pro', provider: 'deepseek' }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: assistantVariantMessage,
    session_id: session,
    role: 'assistant',
    block_ids_json: json([variantBlock, errorBlock]),
    timestamp: FIXED_MS + 1500,
    persistent_stable_id: `${prefix}-stable-assistant-alt`,
    parent_id: userMessage,
    supersedes: assistantMessage,
    meta_json: json({ model: 'deepseek-v4pro', provider: 'deepseek', variant: 'alternate' }),
    active_variant_id: `${prefix}-variant-alt`,
    shared_context_json: json({ resourceIds: [`${prefix}-file-image`, `${prefix}-exam-rich`] }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: toolMessage,
    session_id: session,
    role: 'assistant',
    block_ids_json: json([toolBlock]),
    timestamp: FIXED_MS + 2000,
    persistent_stable_id: `${prefix}-stable-tool`,
    parent_id: assistantMessage,
    meta_json: json({ tool: 'learning_resource_lookup' }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: deletedMessage,
    session_id: session,
    role: 'user',
    block_ids_json: json([]),
    timestamp: FIXED_MS + 2500,
    persistent_stable_id: `${prefix}-stable-deleted`,
    parent_id: userMessage,
    meta_json: json({ source: 'seed', tombstone: true }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
    deleted_at: '2026-05-31T10:21:00.000Z',
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_messages', {
    id: deletedSessionMessage,
    session_id: deletedSession,
    role: 'assistant',
    block_ids_json: json([deletedSessionBlock]),
    timestamp: FIXED_MS + 2600,
    persistent_stable_id: `${prefix}-stable-deleted-session-child`,
    meta_json: json({ source: 'seed', parentSessionDeleted: true }),
    device_id: deviceId,
    updated_at: '2026-05-31T10:21:30.000Z',
    deleted_at: '2026-05-31T10:22:00.000Z',
  }));
  const blocks = [
    [userBlock, userMessage, 'content', 'success', 0, 'Please connect this chat with the wide sync question set.', null, null, null, null],
    [thinkingBlock, assistantMessage, 'thinking', 'success', 0, 'Need to inspect linked notes, todos, and mixed question state.', null, null, null, null],
    [answerBlock, assistantMessage, 'content', 'success', 1, 'Linked resources are ready. The weak point is question q2 and todo-child.', null, null, null, null],
    [variantBlock, assistantVariantMessage, 'content', 'success', 0, 'Alternate answer links the diagram file and the question set.', null, null, null, `${prefix}-variant-alt`],
    [errorBlock, assistantVariantMessage, 'mcp_tool', 'error', 1, null, 'learning_resource_lookup', json({ query: 'missing seed resource' }), json({ error: 'not_found' }), `${prefix}-variant-alt`],
    [toolBlock, toolMessage, 'mcp_tool', 'success', 0, null, 'learning_resource_lookup', json({ query: 'wide sync question set' }), json({ resultCount: 5 }), null],
    [deletedSessionBlock, deletedSessionMessage, 'content', 'success', 0, 'Child block under a deleted session tombstone.', null, null, null, null],
  ];
  for (const [id, messageId, type, status, index, content, toolName, toolInput, toolOutput, variantId] of blocks) {
    s.push(insertOrIgnore(tables, 'chat_v2_blocks', {
      id,
      message_id: messageId,
      block_type: type,
      status,
      block_index: index,
      content,
      tool_name: toolName,
      tool_input_json: toolInput,
      tool_output_json: toolOutput,
      citations_json: json([{ type: 'resource', id: `${prefix}-note-active` }]),
      error: status === 'error' ? 'Synthetic tool failure for block error sync coverage' : null,
      variant_id: variantId,
      started_at: FIXED_MS,
      ended_at: FIXED_MS + 300,
      first_chunk_at: status === 'success' ? FIXED_MS + 30 : null,
      compacted_at: id === thinkingBlock ? FIXED_MS + 5000 : null,
      device_id: deviceId,
      updated_at: FIXED_ISO,
    }));
  }
  s.push(insertOrIgnore(tables, 'chat_v2_attachments', {
    id: `${prefix}-attachment-image`,
    message_id: userMessage,
    name: 'wide-sync-diagram.png',
    type: 'image',
    mime_type: 'image/png',
    size: 1200,
    status: 'ready',
    preview_url: 'seed://wide-sync-diagram',
    storage_path: 'attachments/wide-sync-diagram.png',
    content_hash: sha256('wide-sync-diagram'),
    created_at: FIXED_ISO,
    block_id: userBlock,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'resources', {
    id: `${prefix}-chat-resource`,
    hash: sha256(`${prefix}:chat-resource`),
    type: 'retrieval',
    source_id: session,
    data: 'Chat-side resource that should move with chat_v2 sync.',
    metadata_json: json({ session_id: session, seed: prefix }),
    ref_count: 1,
    created_at: FIXED_MS,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_session_mistakes', {
    session_id: session,
    mistake_id: `${prefix}-mistake-active`,
    relation_type: 'primary',
    created_at: FIXED_ISO,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(updateIfDifferent('chat_v2_session_mistakes', {
    relation_type: 'bridge',
    updated_at: '2026-05-31T10:22:00.000Z',
  }, `session_id = ${lit(session)} AND mistake_id = ${lit(`${prefix}-mistake-active`)}`));
  s.push(insertOrIgnore(tables, 'chat_v2_session_mistakes', {
    session_id: deletedSession,
    mistake_id: `${prefix}-mistake-deleted`,
    relation_type: 'archived',
    created_at: FIXED_ISO,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(`DELETE FROM chat_v2_session_mistakes WHERE session_id = ${lit(deletedSession)} AND mistake_id = ${lit(`${prefix}-mistake-deleted`)};`);
  s.push(insertOrIgnore(tables, 'chat_v2_session_state', {
    session_id: session,
    chat_params_json: json({ model_id: 'deepseek-v4pro', temperature: 0.2 }),
    features_json: json({ webSearch: true, memory: true, rag: true }),
    mode_state_json: json({ mode: 'study', resourceManagerOpen: true }),
    input_value: 'Draft input that should stay local runtime state',
    panel_states_json: json({ resources: 'open', conflicts: 'closed' }),
    updated_at: FIXED_ISO,
    model_id: 'deepseek-v4pro',
    temperature: 0.2,
    context_limit: 128000,
    max_tokens: 4096,
    enable_thinking: 1,
    disable_tools: 0,
    attachments_json: json([{ id: `${prefix}-attachment-image` }]),
    rag_enabled: 1,
    rag_library_ids_json: json([`${prefix}-exam-rich`]),
    pending_context_refs_json: json([{ type: 'question', id: `${prefix}-q2` }]),
    loaded_skill_ids_json: json(['resource-manager', 'question-bank']),
    active_skill_id: 'question-bank',
    active_skill_ids_json: json(['question-bank']),
    skill_state_json: json({ selectedQuestion: `${prefix}-q2` }),
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_todo_lists', {
    session_id: session,
    message_id: assistantMessage,
    variant_id: `${prefix}-variant-main`,
    todo_list_id: `${prefix}-chat-todo-list`,
    title: 'Wide sync chat todo boundary',
    steps_json: json([{ id: 'step-1', text: 'Review q2', done: false }]),
    is_all_done: 0,
    created_at: FIXED_MS,
    updated_at: FIXED_MS,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_session_tags', {
    session_id: session,
    tag: 'wide-sync-boundary',
    tag_type: 'manual',
    created_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'sleep_block', {
    id: `${prefix}-sleep-block`,
    workspace_id: workspace,
    coordinator_session_id: session,
    awaiting_agents: json([`${prefix}-agent-session`]),
    wake_condition: json({ type: 'result_message', source: 'wide-sync' }),
    status: 'sleeping',
    timeout_at: '2026-06-01T00:00:00.000Z',
    created_at: FIXED_ISO,
    message_id: assistantMessage,
    block_id: answerBlock,
  }));
  s.push(insertOrIgnore(tables, 'subagent_task', {
    id: `${prefix}-subagent-task`,
    workspace_id: workspace,
    agent_session_id: `${prefix}-agent-session`,
    skill_id: 'question-bank',
    status: 'running',
    task_content: 'Synthetic subagent task boundary row',
    last_active_at: FIXED_ISO,
    needs_recovery: 0,
    created_at: FIXED_ISO,
    initial_task: 'Review wide sync q2',
    started_at: FIXED_ISO,
    result_summary: null,
  }));
  s.push(insertOrIgnore(tables, 'chat_v2_compactions', {
    id: `${prefix}-compaction`,
    session_id: session,
    summary_message_id: assistantMessage,
    tail_start_message_id: toolMessage,
    tail_start_time_created: FIXED_MS + 2000,
    reason: 'manual',
    is_auto: 0,
    is_overflow: 1,
    tokens_before: 64000,
    tokens_after: 3200,
    model_id: 'deepseek-v4pro',
    created_at: FIXED_MS + 3000,
  }));
  s.push(insertOrIgnore(tables, 'resources', {
    id: `${prefix}-chat-hard-delete-resource`,
    hash: sha256(`${prefix}:chat-hard-delete`),
    type: 'retrieval',
    source_id: `${prefix}-chat-hard-delete`,
    data: 'Inserted then hard-deleted to exercise chat_v2 DELETE replay.',
    metadata_json: json({ seed: prefix, hardDelete: true }),
    ref_count: 0,
    created_at: FIXED_MS,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(`DELETE FROM resources WHERE id = ${lit(`${prefix}-chat-hard-delete-resource`)};`);
  return s.join('\n');
}

function seedMistakesSql(tables, prefix, deviceId) {
  const s = [];
  const chatUserId = numericId(prefix, 'mistake-chat-user');
  const chatAssistantId = numericId(prefix, 'mistake-chat-assistant');
  const reviewChatId = numericId(prefix, 'review-chat-assistant');
  const mistake = `${prefix}-mistake-active`;
  const deletedMistake = `${prefix}-mistake-deleted`;
  const secondMistake = `${prefix}-mistake-second`;
  const reviewSession = `${prefix}-review-session`;
  const reviewAnalysis = `${prefix}-review-analysis`;
  const docTask = `${prefix}-document-task`;
  const hardDeleteDocTask = `${prefix}-document-task-hard-delete`;
  s.push(insertOrIgnore(tables, 'mistakes', {
    id: mistake,
    created_at: FIXED_ISO,
    question_images: json([{ path: 'seed://question.png', width: 640, height: 480 }]),
    analysis_images: json([{ path: 'seed://analysis.png', width: 640, height: 480 }]),
    user_question: 'Why did I choose the wrong induced current direction?',
    ocr_text: 'A loop enters a magnetic field. Determine induced current direction.',
    ocr_note: 'Seed OCR note',
    tags: json(['wide-sync', 'physics', 'mistake']),
    mistake_type: 'conceptual',
    status: 'active',
    chat_category: 'analysis',
    updated_at: FIXED_ISO,
    last_accessed_at: FIXED_ISO,
    chat_metadata: json({ linked_chat_session: `${prefix}-chat-session` }),
    exam_sheet: `${prefix}-exam-rich`,
    autosave_signature: sha256(`${prefix}:mistake`),
    mistake_summary: 'Confused Lenz law direction.',
    user_error_analysis: 'Forgot to oppose magnetic flux change.',
    irec_card_id: `${prefix}-anki-card-1`,
    irec_status: 1,
    device_id: deviceId,
  }));
  s.push(updateIfDifferent('mistakes', {
    tags: json(['wide-sync', 'physics', 'mistake', 'json-update-chain']),
    chat_metadata: json({ linked_chat_session: `${prefix}-chat-session`, toolState: { lastTool: 'learning_resource_lookup', attempts: [1, 2] } }),
    user_error_analysis: 'Updated chain: forgot that induced current opposes flux change, then corrected with right-hand rule.',
    updated_at: '2026-05-31T10:26:00.000Z',
  }, `id = ${lit(mistake)}`));
  s.push(insertOrIgnore(tables, 'mistakes', {
    id: deletedMistake,
    created_at: FIXED_ISO,
    question_images: json([]),
    analysis_images: json([]),
    user_question: 'Soft-deleted seed mistake',
    ocr_text: 'Deleted seed',
    tags: json(['wide-sync', 'deleted']),
    mistake_type: 'calculation',
    status: 'archived',
    chat_category: 'analysis',
    updated_at: FIXED_ISO,
    last_accessed_at: FIXED_ISO,
    deleted_at: '2026-05-31T10:25:00.000Z',
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'mistakes', {
    id: secondMistake,
    created_at: FIXED_ISO,
    question_images: json([]),
    analysis_images: json([]),
    user_question: 'A second related mistake for composite review keys.',
    ocr_text: 'Determine sign of flux change before choosing current.',
    tags: json(['wide-sync', 'physics', 'related']),
    mistake_type: 'procedure',
    status: 'active',
    chat_category: 'review',
    updated_at: FIXED_ISO,
    last_accessed_at: FIXED_ISO,
    chat_metadata: json({ linked_chat_session: `${prefix}-chat-session`, sibling: mistake }),
    exam_sheet: `${prefix}-exam-rich`,
    autosave_signature: sha256(`${prefix}:mistake-second`),
    mistake_summary: 'Chose current direction before defining positive normal.',
    user_error_analysis: 'Procedure order was unstable.',
    irec_card_id: `${prefix}-anki-card-2`,
    irec_status: 0,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'temp_sessions', {
    temp_id: `${prefix}-temp-session-streaming`,
    session_data: json({ prompt: 'streamed mistake analysis', chunks: ['first', 'second'], linkedMistake: mistake }),
    stream_state: 'paused',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    last_error: 'synthetic pause boundary',
  }));
  s.push(insertOrIgnore(tables, 'settings', {
    key: `${prefix}:mistake-settings`,
    value: json({ reviewMode: 'mixed', enabledPanels: ['anki', 'rag', 'history'] }),
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'rag_configurations', {
    id: `${prefix}-rag-config`,
    chunk_size: 384,
    chunk_overlap: 64,
    chunking_strategy: 'semantic',
    min_chunk_size: 32,
    default_top_k: 8,
    default_rerank_enabled: 1,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'custom_anki_templates', {
    id: `${prefix}-anki-template`,
    name: `Wide Sync Template ${prefix}`,
    description: 'Synthetic template boundary row for sync coverage.',
    author: 'dstu-test',
    version: '1.0.0',
    preview_front: '{{Question}}',
    preview_back: '{{Answer}}',
    note_type: 'Basic',
    fields_json: json(['Question', 'Answer', 'MistakePattern']),
    generation_prompt: 'Generate compact mistake cards.',
    front_template: '{{Question}}',
    back_template: '{{Answer}}<br>{{MistakePattern}}',
    css_style: '.card { font-family: sans-serif; }',
    field_extraction_rules_json: json({ Question: '$.question', Answer: '$.answer' }),
    preview_data_json: json({ Question: 'What changes?', Answer: 'Flux', MistakePattern: 'Direction' }),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    is_active: 1,
    is_built_in: 0,
  }));
  s.push(insertOrIgnore(tables, 'rag_sub_libraries', {
    id: `${prefix}-rag-sub-library`,
    name: `Wide Sync RAG ${prefix}`,
    description: 'Boundary row for non-row-sync RAG library metadata.',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'document_control_states', {
    document_id: `${prefix}-doc`,
    state: 'mixed',
    pending_tasks_json: json([`${prefix}-pending-task`]),
    running_tasks_json: json({ [docTask]: { startedAt: FIXED_ISO } }),
    completed_tasks_json: json([docTask]),
    failed_tasks_json: json({ [`${prefix}-failed-task`]: 'synthetic failure' }),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'search_logs', {
    id: `${prefix}-search-log`,
    search_type: 'hybrid',
    query: 'Lenz law direction mistake',
    result_count: 2,
    execution_time_ms: 37,
    mistake_ids_json: json([mistake, secondMistake]),
    error_message: null,
    user_feedback: 'useful',
    created_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'exam_sheet_sessions', {
    id: `${prefix}-exam-sheet-session`,
    exam_name: 'Wide Sync Mixed Question Set',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    temp_id: `${prefix}-exam-temp-session`,
    status: 'ready',
    metadata_json: json({ linkedMistakes: [mistake, secondMistake] }),
    preview_json: json({ questionCount: 5, pages: [1] }),
    linked_mistake_ids: json([mistake, secondMistake]),
  }));
  s.push(insertOrIgnore(tables, 'document_tasks', {
    id: docTask,
    document_id: `${prefix}-doc`,
    original_document_name: 'wide-sync-source.pdf',
    segment_index: 1,
    content_segment: 'Segment used to generate wide sync Anki cards.',
    status: 'Completed',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    anki_generation_options_json: json({ language: 'en', count: 2 }),
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'document_tasks', {
    id: hardDeleteDocTask,
    document_id: `${prefix}-doc-hard-delete`,
    original_document_name: 'wide-sync-delete-probe.pdf',
    segment_index: 99,
    content_segment: 'Hard delete probe for document task replay.',
    status: 'Cancelled',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    error_message: 'synthetic cancellation before sync',
    anki_generation_options_json: json({ language: 'en', count: 0 }),
    device_id: deviceId,
  }));
  s.push(`DELETE FROM document_tasks WHERE id = ${lit(hardDeleteDocTask)};`);
  for (const index of [1, 2]) {
    s.push(insertOrIgnore(tables, 'anki_cards', {
      id: `${prefix}-anki-card-${index}`,
      task_id: docTask,
      front: index === 1 ? 'What does Lenz law oppose?' : 'How to check induced current direction?',
      back: index === 1 ? 'The change in magnetic flux.' : 'Use right-hand rule after deciding opposing field direction.',
      tags_json: json(['wide-sync', 'physics', index === 1 ? 'error-card' : 'procedure']),
      images_json: index === 1 ? json([{ name: 'lenz-law.png', blob: `${prefix}-file-image` }]) : json([]),
      is_error_card: index === 1 ? 1 : 0,
      error_content: index === 1 ? 'Wrong current direction' : null,
      card_order_in_task: index,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      extra_fields_json: json({ MistakePattern: index === 1 ? 'conceptual' : 'procedure', LinkedQuestion: `${prefix}-q${index}` }),
      template_id: `${prefix}-anki-template`,
      source_type: 'mistake',
      source_id: mistake,
      text: 'Wide sync card text',
      device_id: deviceId,
    }));
  }
  s.push(updateIfDifferent('anki_cards', {
    tags_json: json(['wide-sync', 'physics', 'procedure', 'json-update-chain']),
    extra_fields_json: json({ MistakePattern: 'procedure', LinkedQuestion: `${prefix}-q2`, ReviewHint: { steps: ['define normal', 'oppose flux', 'right-hand rule'] } }),
    updated_at: '2026-05-31T10:26:30.000Z',
  }, `id = ${lit(`${prefix}-anki-card-2`)}`));
  s.push(insertOrIgnore(tables, 'anki_cards', {
    id: `${prefix}-anki-card-duplicate-error-allowed`,
    task_id: docTask,
    front: 'How to check induced current direction?',
    back: 'Use right-hand rule after deciding opposing field direction.',
    tags_json: json(['wide-sync', 'physics', 'duplicate-dedup-error-card']),
    images_json: json([]),
    is_error_card: 1,
    error_content: 'Duplicate business dedup key allowed because this is an error card.',
    card_order_in_task: 3,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    extra_fields_json: json({ MistakePattern: 'procedure', DuplicateProbe: true }),
    template_id: `${prefix}-anki-template`,
    source_type: 'mistake',
    source_id: mistake,
    text: 'Wide sync card text',
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'review_sessions', {
    id: reviewSession,
    title: 'Wide sync mistake review',
    start_date: '2026-05-31',
    end_date: '2026-06-07',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'review_session_mistakes', {
    session_id: reviewSession,
    mistake_id: mistake,
    added_at: FIXED_ISO,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(updateIfDifferent('review_session_mistakes', {
    added_at: '2026-05-31T10:27:00.000Z',
    updated_at: '2026-05-31T10:27:00.000Z',
  }, `session_id = ${lit(reviewSession)} AND mistake_id = ${lit(mistake)}`));
  s.push(insertOrIgnore(tables, 'review_session_mistakes', {
    session_id: reviewSession,
    mistake_id: secondMistake,
    added_at: FIXED_ISO,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(`DELETE FROM review_session_mistakes WHERE session_id = ${lit(reviewSession)} AND mistake_id = ${lit(secondMistake)};`);
  s.push(insertOrIgnore(tables, 'review_analyses', {
    id: reviewAnalysis,
    name: 'Wide sync consolidated review',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    mistake_ids: json([mistake]),
    consolidated_input: 'Review Lenz law error and todo q2.',
    user_question: 'What pattern caused this mistake?',
    status: 'completed',
    tags: json(['wide-sync', 'review']),
    analysis_type: 'consolidated_review',
    temp_session_data: json({ summary: 'Stable seed analysis' }),
    session_sequence: 1,
    device_id: deviceId,
  }));
  s.push(insertOrIgnore(tables, 'review_chat_messages', {
    id: reviewChatId,
    review_analysis_id: reviewAnalysis,
    role: 'assistant',
    content: 'The recurring pattern is deciding the field direction before applying Lenz law.',
    timestamp: FIXED_ISO,
    thinking_content: 'Seed reasoning',
    rag_sources: json([{ doc: `${prefix}-doc`, chunk: 1, score: 0.91 }]),
    memory_sources: json([{ note_id: `${prefix}-note-active`, score: 0.82 }]),
    web_search_sources: json([{ title: 'Synthetic source', url: 'seed://source' }]),
    image_paths: json(['seed://analysis.png']),
    image_base64: json(['data:image/png;base64,iVBORw0KGgo=']),
    doc_attachments: json([{ id: `${prefix}-doc`, name: 'wide-sync-source.pdf' }]),
    tool_call: json({ name: 'mistake_pattern_lookup', args: { topic: 'Lenz law' } }),
    tool_result: json({ matches: [mistake, secondMistake] }),
    overrides: json({ model: 'deepseek-v4pro' }),
    relations: json([{ type: 'mistake', id: mistake }]),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_messages', {
    id: chatUserId,
    mistake_id: mistake,
    role: 'user',
    content: 'Explain my Lenz law mistake.',
    timestamp: FIXED_ISO,
    stable_id: `${prefix}-mistake-chat-user`,
    turn_id: `${prefix}-turn-1`,
    turn_seq: 1,
    message_kind: 'chat',
    lifecycle: 'completed',
    graph_sources: json([{ node: 'lenz-law', relation: 'opposes-flux-change' }]),
    web_search_sources: json([{ title: 'Synthetic search result', url: 'seed://search' }]),
    image_paths: json(['seed://question.png']),
    image_base64: json(['data:image/png;base64,iVBORw0KGgo=']),
    doc_attachments: json([{ id: `${prefix}-doc`, page: 1 }]),
    metadata: json({ seed: prefix, uiRoute: 'mistake-chat' }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(insertOrIgnore(tables, 'chat_messages', {
    id: chatAssistantId,
    mistake_id: mistake,
    role: 'assistant',
    content: 'You treated the induced field as reinforcing the change instead of opposing it.',
    timestamp: FIXED_ISO,
    thinking_content: 'Seed answer reasoning',
    stable_id: `${prefix}-mistake-chat-assistant`,
    turn_id: `${prefix}-turn-1`,
    turn_seq: 2,
    rag_sources: json([{ doc: `${prefix}-doc`, chunk: 1, score: 0.94 }]),
    memory_sources: json([{ note_id: `${prefix}-note-active`, reason: 'same concept' }]),
    graph_sources: json([{ node: 'right-hand-rule', relation: 'after-field-direction' }]),
    tool_call: json({ name: 'learning_resource_lookup', args: { resource: `${prefix}-exam-rich` } }),
    tool_result: json({ resultCount: 5, weakQuestion: `${prefix}-q2` }),
    relations: json([{ type: 'reply_to', id: chatUserId }, { type: 'resource', id: `${prefix}-exam-rich` }]),
    reply_to_msg_id: chatUserId,
    message_kind: 'chat',
    lifecycle: 'completed',
    metadata: json({ seed: prefix, model: 'deepseek-v4pro', answerShape: { bullets: 3, hasDiagram: true } }),
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(updateIfDifferent('chat_messages', {
    metadata: json({ seed: prefix, model: 'deepseek-v4pro', answerShape: { bullets: 4, hasDiagram: true }, jsonUpdateChain: ['insert', 'metadata-expand'] }),
    relations: json([{ type: 'reply_to', id: chatUserId }, { type: 'resource', id: `${prefix}-exam-rich` }, { type: 'anki_card', id: `${prefix}-anki-card-2` }]),
    updated_at: '2026-05-31T10:29:00.000Z',
  }, `id = ${chatAssistantId}`));
  return s.join('\n');
}

function seedLlmSql(tables, prefix, deviceId) {
  const s = [];
  const rows = [
    ['chat-success', 'deepseek', 'deepseek-v4pro', 'chat_v2', 'success', null, 1200, 640, 1840, 2200],
    ['exam-success', 'siliconflow', 'deepseek-v4pro', 'exam_sheet', 'success', null, 800, 420, 1220, 1800],
    ['embedding-success', 'siliconflow', 'bge-m3', 'embedding', 'success', null, 160, 0, 160, 320],
    ['rerank-error', 'siliconflow', 'bge-reranker-v2', 'reranker', 'error', 'Synthetic seed retryable error', 300, 0, 300, 1500],
    ['chat-timeout', 'deepseek', 'deepseek-v4pro', 'chat_v2', 'timeout', 'Synthetic timeout for sync coverage', 900, 0, 900, 30000],
    ['memory-cancelled', 'deepseek', 'deepseek-v4pro', 'memory', 'cancelled', 'Synthetic user cancellation', 240, 0, 240, 410],
    ['anki-estimated', 'siliconflow', 'deepseek-v4pro', 'anki', 'success', null, 500, 220, 720, 900],
    ['other-tiktoken', 'deepseek', 'deepseek-v4pro', 'other:chaos_seed', 'success', null, 333, 111, 444, 780],
  ];
  for (const [suffix, provider, model, callerType, status, error, prompt, completion, total, duration] of rows) {
    s.push(insertOrIgnore(tables, 'llm_usage_logs', {
      id: `${prefix}-usage-${suffix}`,
      timestamp: FIXED_ISO,
      provider,
      model,
      adapter: 'seed',
      api_config_id: `${provider}-seed-config`,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      reasoning_tokens: status === 'success' ? 32 : 0,
      cached_tokens: suffix === 'chat-success' ? 128 : 0,
      token_source: suffix === 'anki-estimated' ? 'estimated' : suffix === 'other-tiktoken' ? 'tiktoken' : 'api',
      duration_ms: duration,
      request_bytes: prompt * 4,
      response_bytes: completion * 4,
      first_token_ms: status === 'success' ? 380 : null,
      caller_type: callerType,
      session_id: `${prefix}-chat-session`,
      status,
      error_message: error,
      cost_estimate: total * 0.000001,
      device_id: deviceId,
      updated_at: FIXED_ISO,
    }));
  }
  s.push(updateIfDifferent('llm_usage_logs', {
    cost_estimate: 0.003531,
    updated_at: '2026-05-31T10:31:00.000Z',
  }, `id = ${lit(`${prefix}-usage-chat-success`)}`));
  s.push(insertOrIgnore(tables, 'llm_usage_logs', {
    id: `${prefix}-usage-hard-delete`,
    timestamp: FIXED_ISO,
    provider: 'deepseek',
    model: 'deepseek-v4pro',
    adapter: 'seed',
    api_config_id: 'deepseek-seed-config',
    prompt_tokens: 1,
    completion_tokens: 0,
    total_tokens: 1,
    token_source: 'api',
    duration_ms: 1,
    caller_type: 'other:delete_probe',
    session_id: `${prefix}-chat-session`,
    status: 'cancelled',
    error_message: 'Synthetic hard delete probe',
    cost_estimate: 0,
    device_id: deviceId,
    updated_at: FIXED_ISO,
  }));
  s.push(`DELETE FROM llm_usage_logs WHERE id = ${lit(`${prefix}-usage-hard-delete`)};`);
  s.push(insertOrIgnore(tables, 'llm_usage_daily', {
    date: '2026-05-31',
    caller_type: 'chat_v2',
    model: 'deepseek-v4pro',
    provider: 'deepseek',
    request_count: 3,
    success_count: 1,
    error_count: 2,
    total_prompt_tokens: 2340,
    total_completion_tokens: 640,
    total_tokens: 2980,
    total_reasoning_tokens: 32,
    total_cached_tokens: 128,
    total_cost_estimate: 0.003531,
    avg_duration_ms: 10873,
    total_duration_ms: 32620,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    device_id: deviceId,
  }));
  return s.join('\n');
}

async function writeBlob(slotRoot, prefix) {
  const content = [
    '# Wide Sync Coverage',
    '',
    'This synthetic file is part of a broad cloud-sync seed image.',
    'It is intentionally small so the image remains portable.',
    `Seed prefix: ${prefix}`,
    '',
  ].join('\n');
  const hash = sha256(content);
  const relativePath = path.posix.join('wide-sync', `${hash}.md`);
  const absolute = path.join(slotRoot, 'vfs_blobs', 'wide-sync', `${hash}.md`);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');

  const compressedContent = Buffer.from(`compressed:${content}`, 'utf8');
  const compressedHash = sha256(compressedContent);
  const compressedRelativePath = path.posix.join('wide-sync', `${compressedHash}.txt`);
  const compressedAbsolute = path.join(slotRoot, 'vfs_blobs', 'wide-sync', `${compressedHash}.txt`);
  await fsp.writeFile(compressedAbsolute, compressedContent);

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const imageHash = sha256(pngBytes);
  const imageRelativePath = path.posix.join('wide-sync', `${imageHash}.png`);
  const imageAbsolute = path.join(slotRoot, 'vfs_blobs', 'wide-sync', `${imageHash}.png`);
  await fsp.writeFile(imageAbsolute, pngBytes);

  return {
    hash,
    relativePath,
    size: Buffer.byteLength(content),
    mimeType: 'text/markdown',
    compressed: {
      hash: compressedHash,
      relativePath: compressedRelativePath,
      size: compressedContent.length,
      mimeType: 'text/plain',
    },
    image: {
      hash: imageHash,
      relativePath: imageRelativePath,
      size: pngBytes.length,
      mimeType: 'image/png',
    },
  };
}

function runSeed(dbPath, tables, sql) {
  if (!sql.trim()) return;
  sqlite(dbPath, [
    'PRAGMA foreign_keys = OFF;',
    'PRAGMA busy_timeout = 5000;',
    'BEGIN IMMEDIATE;',
    sql,
    'COMMIT;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
  ].join('\n'));
}

function assertForeignKeys(dbPath) {
  const rows = JSON.parse(sqlite(dbPath, 'PRAGMA foreign_key_check;', { json: true }) || '[]');
  if (rows.length > 0) {
    throw new Error(`Foreign key check failed for ${dbPath}: ${JSON.stringify(rows.slice(0, 20), null, 2)}`);
  }
}

function queryCounts(dbPath, tables) {
  return JSON.parse(sqlite(dbPath, countSql(tables), { json: true }) || '[]');
}

function queryChangeLog(dbPath, tables) {
  return JSON.parse(sqlite(dbPath, changeLogSql(tables), { json: true }) || '[]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slotRoot = resolveSlotRoot(args);
  const paths = dbPaths(slotRoot);
  requireDbFiles(paths);

  const blob = await writeBlob(slotRoot, args.prefix);
  const schemas = {
    vfs: schema(paths.vfs),
    chat: schema(paths.chat),
    mistakes: schema(paths.mistakes),
    llm: schema(paths.llm),
  };
  const before = Object.fromEntries(Object.entries(paths).map(([name, dbPath]) => [name, {
    counts: queryCounts(dbPath, schemas[name]),
    change_log: queryChangeLog(dbPath, schemas[name]),
  }]));

  runSeed(paths.vfs, schemas.vfs, seedVfsSql(schemas.vfs, args.prefix, args.deviceId, blob));
  runSeed(paths.chat, schemas.chat, seedChatSql(schemas.chat, args.prefix, args.deviceId));
  runSeed(paths.mistakes, schemas.mistakes, seedMistakesSql(schemas.mistakes, args.prefix, args.deviceId));
  runSeed(paths.llm, schemas.llm, seedLlmSql(schemas.llm, args.prefix, args.deviceId));

  for (const dbPath of Object.values(paths)) {
    assertForeignKeys(dbPath);
  }

  const after = Object.fromEntries(Object.entries(paths).map(([name, dbPath]) => [name, {
    counts: queryCounts(dbPath, schemas[name]),
    change_log: queryChangeLog(dbPath, schemas[name]),
  }]));
  const output = {
    ok: true,
    slot_root: slotRoot,
    prefix: args.prefix,
    device_id: args.deviceId,
    blob,
    before,
    after,
    notes: [
      'Rows are inserted through normal SQLite tables; product triggers generate __change_log.',
      'Tables without __change_log triggers are intentionally populated too, so post-sync assertions can reveal coverage gaps.',
    ],
  };
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Seeded ${slotRoot}`);
    console.log(`Prefix: ${args.prefix}`);
    console.log(`Blob: ${blob.relativePath} (${blob.size} bytes)`);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  console.error('');
  console.error(usage());
  process.exit(1);
});
