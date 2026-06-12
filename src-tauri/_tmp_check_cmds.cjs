const { execSync } = require('child_process');
const cmds = ['check_anki_connect_availability','check_switch_disk_space','debug_get_raw_mistake','debug_get_raw_mistakes_batch','debug_verify_mistake_integrity','get_slot_size','preheat_mcp_tools','research_delete_report','research_export_all_reports_zip','research_get_report','research_list_reports','resource_get_content_from_vfs','test_rmcp_streamable_http','test_web_search_connectivity','textbooks_adopt','textbooks_delete_permanent','textbooks_list','textbooks_purge_trash','textbooks_recover','textbooks_remove','textbooks_set_favorite','textbooks_update_page_count','textbooks_update_reading_progress','verify_all_slots_integrity','verify_slot_integrity','vfs_delete_resource_index','vfs_get_resource_units','vfs_list_embedding_dims','vfs_reindex_unit','vfs_sync_resource_units','vfs_unified_batch_index','vfs_unified_index_status'];
for (const c of cmds) {
  let out = '';
  try {
    out = execSync(`rg -l "['\\"]${c}['\\"]" ../src -g "*.ts" -g "*.tsx"`, { stdio: ['pipe','pipe','ignore'] }).toString().trim();
  } catch (e) { /* no match */ }
  const files = out ? out.split(/\r?\n/) : [];
  console.log((files.length ? 'FRONTEND-USED ' : 'not-used      ') + c + (files.length ? '  [' + files.join(', ') + ']' : ''));
}
