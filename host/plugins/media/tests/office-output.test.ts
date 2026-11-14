import { expect, it } from 'vitest';
import {
  OFFICE_FIDELITY_CONTRACT, fidelityManifest, parseOutputOptions, vfsTaskObject,
} from '../src/office-output.ts';

it('vfs_defaults_preserve_legacy_target', () => {
  const options = parseOutputOptions({}, 'report.docx');
  expect(options.target).toBe('vfs');
});

it('workspace_replace_requires_hash_bound_policy', () => {
  expect(() => parseOutputOptions(
    { output_target: 'workspace', relative_path: 'report.docx', overwrite_policy: 'replace_if_match' },
    'report.docx',
  )).toThrow();
  expect(() => parseOutputOptions(
    { output_target: 'workspace', relative_path: 'report.docx', expected_sha256: 'a' },
    'report.docx',
  )).toThrow();
});

it('fidelity_manifest_is_explicit_about_macro_policy', () => {
  const manifest = fidelityManifest('xlsx', 'replace_text') as {
    contract: string;
    macros: Record<string, unknown>;
    source_preflight: Record<string, unknown>;
  };
  expect(manifest.contract).toBe(OFFICE_FIDELITY_CONTRACT);
  expect(manifest.macros.execution_policy).toBe('never_execute');
  expect(manifest.macros.preservation).toBe('not_supported');
  expect(manifest.macros.default_source_action).toBe('refuse');
  expect(manifest.source_preflight.tool).toBe('builtin-office_fidelity_inspect');
  expect(manifest.source_preflight.inspection_result_consumed_by_current_resource_id_editors).toBe(true);
});

it('edit_cells_operation_uses_edit_semantics_not_create', () => {
  const manifest = fidelityManifest('xlsx', 'edit_cells');
  // 非 Create：preserved 走"受支持内容"语义，不承诺完整 round-trip
  expect(manifest.preserved).toEqual(['supported_text_content', 'supported_structural_content']);
  expect(manifest.operation).toBe('edit_cells');
});

it('docx_pptx_delivery_handles_carry_lineage_and_capabilities', () => {
  const cases = [
    [
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx.replace_text',
    ],
    [
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx.replace_text',
    ],
  ] as const;
  for (const [format, mime, transform] of cases) {
    const handle = vfsTaskObject(
      'file-1', 'edited.out', mime, Buffer.from('payload'), format, 'replace_text', 'src-res-1');
    expect(handle.handleId, format).toBe('vfs-file:file-1');
    // 血缘：derivedFrom 指回源资源，transformId 与操作对应
    const edges = handle.provenance.derivedFrom;
    expect(edges, format).toHaveLength(1);
    expect(edges[0]!.sourceHandleId, format).toBe('vfs:src-res-1');
    expect(edges[0]!.transformId, format).toBe(transform);
    expect(edges[0]!.transformParamsHash, format).not.toBeNull();
    // VFS 交付：providerRef + 能力位
    const provider = handle.providerRef!;
    expect(provider.provider, format).toBe('deep-student-vfs');
    expect(provider.externalId, format).toBe('file-1');
    expect(handle.capabilities.readable && handle.capabilities.writable, format).toBe(true);
    expect(() => handle.validate(), format).not.toThrow();
  }
});
