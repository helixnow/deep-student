/** Dependencies and helpers shared by the docx / pptx / xlsx tool executors. */
import type { DocumentParser } from '../document-parser.ts';
import type { OfficeDeliveryDeps } from './office-delivery.ts';
import type { ToolLogger } from './runtime.ts';
import type { VfsFileRepos } from './vfs-source.ts';

/** `chat_v2::tools::OFFICE_DOC_PARSE_MAX_BYTES`. */
export const OFFICE_DOC_PARSE_MAX_BYTES = 50 * 1024 * 1024;

export interface OfficeToolDeps extends OfficeDeliveryDeps {
  repos(): VfsFileRepos;
  parser(): DocumentParser;
  log: ToolLogger;
}

/** `"{LABEL} 文件过大: {}MB (上限 {}MB)"`, checked before structured reads. */
export function checkParseSize(label: 'DOCX' | 'PPTX' | 'XLSX', bytes: Uint8Array): void {
  if (bytes.length > OFFICE_DOC_PARSE_MAX_BYTES) {
    const mb = 1024 * 1024;
    throw new Error(`${label} 文件过大: ${Math.trunc(bytes.length / mb)}MB (上限 ${OFFICE_DOC_PARSE_MAX_BYTES / mb}MB)`);
  }
}

/** `.map_err(|e| format!("{prefix}: {}", e))` around an awaited parser call. */
export async function withPrefix<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`); }
}
