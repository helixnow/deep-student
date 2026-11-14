import fs from 'node:fs';
import path from 'node:path';
import { ROOT, files, read } from './common.mjs';
import { sqlTables } from './sql.mjs';
import { rustParser } from '../lib/tree-sitter-rust.mjs';

export async function build(root = ROOT) {
  const parser = await rustParser();
  const literal = n => n.text.replace(/^(?:br|r)?#*"/, '').replace(/"#*$/, '').replaceAll('\\"', '"');
  const schema = new Map(), candidates = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  const rustFiles = files(root, 'src-tauri').filter(f => /\.(rs|sql)$/.test(f) && !f.includes('/target/'));
  const cache = new Map();
  for (const file of rustFiles) {
    const text = read(root, file);
    if (!/CREATE\s+(?:VIRTUAL\s+)?TABLE/i.test(text)) continue;
    if (file.endsWith('.sql')) {
      for (const hit of sqlTables(text, true)) add(schema, hit.table, `${file}:${text.slice(0, hit.offset).split('\n').length}`);
    } else {
      const tree = parser.parse(text);
      const visit = n => {
        if (n.type === 'mod_item' && /^(tests|.*_tests)$/.test(n.childForFieldName('name')?.text ?? '')) return;
        if (n.type === 'string_literal' || n.type === 'raw_string_literal') {
          for (const hit of sqlTables(literal(n), true)) add(schema, hit.table, `${file}:${n.startPosition.row + 1}`);
          return;
        }
        for (const c of n.namedChildren) visit(c);
      };
      visit(tree.rootNode); tree.delete();
    }
  }
  for (const lane of files(root, 'host/plugins').filter(f => f.endsWith('/LANE.md'))) {
    const plugin = lane.split('/')[2];
    const specFile = `host/plugins/${plugin}/SPEC.md`;
    const spec = fs.existsSync(path.join(root, specFile)) ? read(root, specFile) : '';
    for (const m of read(root, lane).matchAll(/`(src-tauri\/[^`]+\.rs)`/g)) {
      const file = m[1];
      if (!/(?:repo|repository)/.test(file) || !fs.existsSync(path.join(root, file))) continue;
      if (!spec.includes(path.basename(file))) continue;
      if (!cache.has(file)) {
        const tree = parser.parse(read(root, file));
        const strings = [];
        const visit = n => {
          if (n.type === 'mod_item' && /^(tests|.*_tests)$/.test(n.childForFieldName('name')?.text ?? '')) return;
          if (n.type === 'string_literal' || n.type === 'raw_string_literal') {
            for (const h of sqlTables(literal(n))) strings.push({ ...h, evidence: `${file}:${n.startPosition.row + 1}` });
            return;
          }
          for (const c of n.namedChildren) visit(c);
        };
        visit(tree.rootNode); tree.delete(); cache.set(file, strings);
      }
      for (const h of cache.get(file)) if (schema.has(h.table)) add(candidates, h.table, { plugin, evidence: h.evidence, spec: specFile });
    }
  }
  // D1 names explicit business owners. No inference from the current TS writers.
  const decisions = {
    notes: ['notes', 'note_links', 'note_document_formats', 'note_document_revisions', 'note_relations', 'note_blocks'],
    'vfs-repos': ['questions', 'question_submissions', 'question_bank_stats'],
    chat: ['chat_v2_sessions', 'chat_v2_messages', 'chat_v2_blocks'],
    memory: ['memory_receipts', 'memory_config'],
  };
  // C2-platform ruling 2026-11-04T11:00Z (L11 owns these VFS tables; L12 schedules only).
  const c2 = ['vfs_index_units', 'vfs_index_segments', 'vfs_embedding_dims', 'vfs_index_profiles', 'resources', 'files', 'exam_sheets', '__lance_orphan_queue'];
  // Coordinator rulings (X6-OWN-C2-20261104 + V2-OWNER-QBANK) are data, applied before any
  // derivation; repository references cannot re-derive a ruled owner.
  const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/electron-migration/gate-checks/owner-rulings.json'), 'utf8'));
  const ruled = new Map();
  for (const r of R.rulings) for (const t of r.tables) ruled.set(t, { owner: r.owner, decision: `${R.source.split(',')[0]}: ${r.evidence}` });
  for (const t of R.unknownOutsideNamespace) ruled.set(t, { owner: null, decision: 'X6-OWN-C2-20261104: owned only inside the listed namespace; elsewhere the database is not identifiable -> unknown' });
  for (const t of R.notProduction.tables) ruled.set(t, { owner: null, decision: `X6-OWN-C2-20261104 not-production: ${R.notProduction.evidence}` });
  const tables = {}, ambiguous = [];
  for (const [table, locations] of [...schema].sort(([a], [b]) => a.localeCompare(b))) {
    const evidence = candidates.get(table) ?? [];
    const owners = [...new Set(evidence.map(e => e.plugin))];
    const d1 = c2.includes(table) ? 'vfs-repos' : Object.entries(decisions).find(([, list]) => list.includes(table))?.[0];
    const ruling = ruled.get(table) ?? (d1 ? { owner: d1, decision: c2.includes(table) ? 'C2-platform ruling 2026-11-04T11:00Z' : 'docs/dev/electron-migration/decisions.md:106-111' } : null);
    const owner = ruling ? ruling.owner : owners.length === 1 ? owners[0] : null;
    tables[table] = { owner, schema: [...new Set(locations)], evidence: [...new Map(evidence.map(e => [`${e.plugin}:${e.evidence}`, e])).values()] };
    if (ruling) tables[table].decision = ruling.decision;
    if (!owner && !ruling) ambiguous.push({ table, candidates: owners, reason: owners.length ? 'multiple Rust repository owners' : 'no unambiguous repository/spec evidence' });
  }
  const rulingsWithoutSchema = [...ruled.keys()].filter(t => !schema.has(t));
  return { version: 2, policy: 'docs/plugins/ARCHITECTURE.md:63; decisions.md D1; owner-rulings.json (C2 X6-OWN-C2-20261104, V2-OWNER-QBANK) take precedence; otherwise Rust schema + LANE-owned repositories corroborated by SPEC. Null owners are unknown, never blocking.',
    namespaces: R.namespaced.map(n => ({ ...n, owner: n.plugin })), tables, ambiguous, rulingsWithoutSchema };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'scripts/electron-migration/gate-checks/build-table-owners.mjs')) {
  fs.writeFileSync(path.join(ROOT, 'scripts/electron-migration/gate-checks/table-owners.json'), JSON.stringify(await build(), null, 2) + '\n');
}
