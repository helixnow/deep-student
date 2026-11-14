/**
 * `src/chat_v2/tools/xlsx_executor.rs`: read-only detection of formula cells
 * that an edit is about to overwrite. umya-spreadsheet's `set_value` silently
 * replaces formulas, so the result must list them in the fidelity warning.
 *
 * This scans the OOXML package directly (workbook → rels → worksheet), which is
 * enough for the warning path and needs no native writer. Actual cell editing
 * still requires umya-spreadsheet and stays blocked (see `DocumentParser`).
 */
import { decodeXmlEntities, xmlTokens } from './document-xml.ts';
import { readZipEntries } from './zip.ts';

function packageFiles(bytes: Uint8Array): Map<string, Uint8Array> | null {
  let entries;
  try { entries = readZipEntries(bytes); }
  catch { return null; }
  if (entries === null) return null;
  return new Map(entries.map(entry => [entry.name, entry.bytes]));
}

/** `xl/workbook.xml` → 工作表名 → rel id。 */
function sheetRelationships(workbook: Uint8Array): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const token of xmlTokens(new TextDecoder().decode(workbook))) {
    if (token.kind !== 'start' || token.local !== 'sheet') continue;
    const name = token.attrs.name;
    const id = token.attrs.id;
    if (name !== undefined && id !== undefined) relationships.set(name, id);
  }
  return relationships;
}

/** `xl/_rels/workbook.xml.rels` → rel id → 包内路径。 */
function relationshipTargets(rels: Uint8Array): Map<string, string> {
  const targets = new Map<string, string>();
  for (const token of xmlTokens(new TextDecoder().decode(rels))) {
    if (token.kind !== 'start' || token.local !== 'Relationship') continue;
    const id = token.attrs.Id;
    const target = token.attrs.Target;
    if (id === undefined || target === undefined) continue;
    const normalized = target.startsWith('/') ? target.slice(1)
      : target.startsWith('xl/') ? target : `xl/${target}`;
    targets.set(id, normalized);
  }
  return targets;
}

/** 工作表 XML 中带 `<f>` 的单元格地址（大写）。 */
function formulaCells(sheetXml: string): Set<string> {
  const formulas = new Set<string>();
  let current: string | null = null;
  for (const token of xmlTokens(sheetXml)) {
    if (token.kind === 'start') {
      if (token.local === 'c') {
        const reference = token.attrs.r;
        current = reference === undefined ? null
          : decodeXmlEntities(reference).toUpperCase();
      } else if (token.local === 'f' && current !== null) {
        formulas.add(current);
      }
    } else if (token.kind === 'end' && token.local === 'c') {
      current = null;
    }
  }
  return formulas;
}

/**
 * 收集编辑目标中原为公式的单元格地址（`Sheet!Cell`）。读取失败返回空表，
 * 与 Rust 一致——真正的解析错误由后续 `edit_xlsx_cells` 统一报告。
 */
export function collectOverwrittenFormulaCells(
  bytes: Uint8Array,
  edits: ReadonlyArray<readonly [string, string, string]>,
): string[] {
  const files = packageFiles(bytes);
  if (files === null) return [];
  const workbook = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (workbook === undefined || rels === undefined) return [];
  const sheetIds = sheetRelationships(workbook);
  const targets = relationshipTargets(rels);
  const sheetCells = new Map<string, Set<string>>();
  const overwritten: string[] = [];
  for (const [sheetName, cellRef] of edits) {
    let cells = sheetCells.get(sheetName);
    if (cells === undefined) {
      const relationship = sheetIds.get(sheetName);
      const path = relationship === undefined ? undefined : targets.get(relationship);
      const sheet = path === undefined ? undefined : files.get(path);
      cells = sheet === undefined ? new Set() : formulaCells(new TextDecoder().decode(sheet));
      sheetCells.set(sheetName, cells);
    }
    if (!cells.has(cellRef.toUpperCase())) continue;
    const address = `${sheetName}!${cellRef}`;
    if (!overwritten.includes(address)) overwritten.push(address);
  }
  return overwritten;
}
