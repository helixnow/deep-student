/**
 * `src/chat_v2/tools/{docx,xlsx,pptx}_executor.rs`: tool-name gate, sensitivity and
 * edit-gate wording for the Office read/create/edit tools (executors:
 * `tools/{docx,pptx,xlsx}-executor.ts`).
 */
import { stripToolNamespace } from './document-processing.ts';
import type { EditGateWording } from './office-fidelity.ts';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/** 各编辑路径的保真门禁措辞；写入错误/警告 JSON 中的说明文案。 */
export const DOCX_EDIT_GATE_WORDING: EditGateWording = {
  writePath: 'docx-rs 文本重建',
  officeApps: 'Word/WPS',
  highFeaturesDropped: true,
};

export const XLSX_EDIT_GATE_WORDING: EditGateWording = {
  writePath: 'umya-spreadsheet round-trip 编辑',
  officeApps: 'Excel/WPS',
  highFeaturesDropped: false,
};

export const PPTX_EDIT_GATE_WORDING: EditGateWording = {
  writePath: 'pptx spec 文本重建',
  officeApps: 'PowerPoint/WPS',
  highFeaturesDropped: true,
};

const TOOL_NAMES: Record<OfficeFormat, readonly string[]> = {
  docx: [
    'docx_read_structured', 'docx_extract_tables', 'docx_get_metadata',
    'docx_create', 'docx_to_spec', 'docx_replace_text',
  ],
  xlsx: [
    'xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata',
    'xlsx_create', 'xlsx_to_spec', 'xlsx_edit_cells', 'xlsx_replace_text',
  ],
  pptx: [
    'pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables',
    'pptx_create', 'pptx_to_spec', 'pptx_replace_text',
  ],
};

const WRITE_TOOL_NAMES: Record<OfficeFormat, readonly string[]> = {
  docx: ['docx_create', 'docx_replace_text'],
  xlsx: ['xlsx_create', 'xlsx_edit_cells', 'xlsx_replace_text'],
  pptx: ['pptx_create', 'pptx_replace_text'],
};

export function canHandle(format: OfficeFormat, toolName: string): boolean {
  return TOOL_NAMES[format].includes(stripToolNamespace(toolName));
}

export function sensitivityLevel(format: OfficeFormat, toolName: string): 'medium' | 'low' {
  return WRITE_TOOL_NAMES[format].includes(stripToolNamespace(toolName)) ? 'medium' : 'low';
}
