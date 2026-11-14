// WP-225 corpus check: v0 validation (scenario-v0.mjs), unique ids, ${n.path}
// references to earlier non-error steps, declared commands exercised, and the
// manifest's 54 target commands each with at least one non-error step.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../../../../scripts/electron-migration/record/scenario-v0.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  'vfs_get_dimension_range', 'vfs_get_embedding_readiness', 'vfs_get_file', 'vfs_get_file_content',
  'vfs_get_lance_stats', 'vfs_get_media_cache_stats', 'vfs_get_mindmap', 'vfs_get_mindmap_content',
  'vfs_get_mindmap_version', 'vfs_get_mindmap_version_content', 'vfs_get_mindmap_versions',
  'vfs_get_pdf_page_image', 'vfs_get_pdf_processing_status', 'vfs_get_preset_dimensions',
  'vfs_get_resource', 'vfs_get_resource_ocr_info', 'vfs_get_resource_path', 'vfs_get_resource_ref_count',
  'vfs_get_resource_refs', 'vfs_get_resource_text_chunks', 'vfs_get_resource_units', 'vfs_increment_ref',
  'vfs_inspect_retrieval_capabilities', 'vfs_list_dimensions', 'vfs_list_embedding_dims', 'vfs_list_files',
  'vfs_list_mindmaps', 'vfs_multimodal_delete', 'vfs_multimodal_index', 'vfs_multimodal_index_resource',
  'vfs_multimodal_search', 'vfs_multimodal_search_detailed', 'vfs_multimodal_stats', 'vfs_optimize_lance',
  'vfs_rag_search', 'vfs_reindex_resource', 'vfs_reindex_unit', 'vfs_reset_all_index_state',
  'vfs_reset_disabled_to_pending', 'vfs_reset_indexed_without_embeddings', 'vfs_resolve_resource_refs',
  'vfs_resource_exists', 'vfs_restore_mindmap_version', 'vfs_retry_pdf_processing',
  'vfs_set_attachment_root_folder', 'vfs_set_default_embedding_dimension', 'vfs_set_mindmap_favorite',
  'vfs_start_pdf_processing', 'vfs_sync_resource_units', 'vfs_unified_batch_index',
  'vfs_unified_index_status', 'vfs_update_mindmap', 'vfs_update_path_cache', 'vfs_upload_attachment',
];
const REF = /^\$\{(0|[1-9][0-9]*)(?:\.([^}]+))?\}$/;

function refs(value, out = []) {
  if (typeof value === 'string') {
    const m = REF.exec(value);
    if (m) out.push(Number(m[1]));
    else if (value.includes('${') && !value.includes('${llm.')) throw new Error(`embedded reference: ${value}`);
  } else if (Array.isArray(value)) value.forEach(v => refs(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => refs(v, out));
  return out;
}

const ids = new Set();
const perCommand = new Map(TARGETS.map(c => [c, { ok: 0, err: 0, scenarios: new Set() }]));
const declared = new Set();
let scenarios = 0, steps = 0;
// `<scenario file>.provider.json` sidecars are provider scripts, not scenario documents.
const files = readdirSync(here).filter(f => f.endsWith('.json') && !f.endsWith('.provider.json')).sort();
for (const file of files) {
  const doc = JSON.parse(readFileSync(join(here, file), 'utf8'));
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'commands,domain,scenarios') throw new Error(`${file}: top-level keys ${keys}`);
  if (doc.domain !== 'vfs') throw new Error(`${file}: domain ${doc.domain}`);
  const used = new Set();
  for (const c of doc.commands) {
    if (!perCommand.has(c)) throw new Error(`${file}: ${c} not in WP-225 manifest`);
    if (declared.has(c)) throw new Error(`${file}: ${c} declared twice`);
    declared.add(c);
  }
  for (const s of doc.scenarios) {
    validateScenario(s);
    if (Object.keys(s).filter(k => k !== 'llm').sort().join(',') !== 'capture,id,normalize,seed,steps') throw new Error(`${s.id}: scenario keys`);
    if (s.llm !== undefined && (typeof s.llm !== 'string' || s.llm === '')) throw new Error(`${s.id}: llm must be a script name`);
    if (ids.has(s.id)) throw new Error(`duplicate id ${s.id}`);
    ids.add(s.id);
    if (s.seed !== 'empty' || !s.capture.events || s.capture.db.join() !== '*' || s.normalize.length) throw new Error(`${s.id}: capture/seed/normalize`);
    scenarios++;
    s.steps.forEach((st, i) => {
      steps++;
      for (const k of Object.keys(st)) if (!['cmd', 'args', 'expect'].includes(k)) throw new Error(`${s.id}[${i}]: key ${k}`);
      for (const n of refs(st.args)) {
        if (n >= i) throw new Error(`${s.id}[${i}]: reference to later step ${n}`);
        if (s.steps[n].expect === 'error') throw new Error(`${s.id}[${i}]: reference to error step ${n}`);
      }
      used.add(st.cmd);
      const c = perCommand.get(st.cmd);
      if (c && doc.commands.includes(st.cmd)) {
        c[st.expect === 'error' ? 'err' : 'ok']++;
        c.scenarios.add(s.id);
      }
    });
  }
  for (const c of doc.commands) if (!used.has(c)) throw new Error(`${file}: declared ${c} never invoked`);
}
const missing = TARGETS.filter(c => !declared.has(c) || perCommand.get(c).ok === 0);
const out = line => process.stdout.write(`${line}\n`);
out(`files=${files.length} scenarios=${scenarios} steps=${steps} commands=${declared.size}/${TARGETS.length}`);
for (const [c, v] of perCommand) out(`${c}\tokSteps=${v.ok}\terrSteps=${v.err}\tscenarios=${v.scenarios.size}`);
if (missing.length) throw new Error(`commands without success step: ${missing.join(', ')}`);
out('OK');
