/**
 * `src-tauri/src/cmd/handout.rs:144-187 notes_export_docx`.
 *
 * The frontend converts note Markdown into a DOCX spec; `image` blocks may carry a
 * `src` (`notes_assets/…` relative path) that is resolved here through
 * `get_image_as_base64` into `data`. Generation itself is Rust
 * `DocumentParser::generate_docx_from_spec`, published by F7 as
 * `nativeOfficeWriter.generateDocx` (D9 `docx@9.15.2`).
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeOfficeWriter } from '../../../platform/native/office/api.ts';
import { ImageBase64Error } from './image-base64.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';

export interface NotesExportDocxDeps {
  /** `state.file_manager.get_image_as_base64(&src)` (restricted to the app data dir). */
  imageAsBase64(src: string): Promise<string>;
  writer(): NativeOfficeWriter;
  warn(message: string): void;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

/** serde_json `Value::get(key)` on objects only (arrays/scalars yield None). */
function field(value: unknown, key: string): unknown {
  const object = asObject(value);
  return object !== null && Object.hasOwn(object, key) ? object[key] : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof ImageBase64Error) return error.appError.message;
  return error instanceof Error ? error.message : String(error);
}

/** handout.rs:151-182: fill `data` for local `src` images; failures only warn. */
export async function resolveNoteImages(
  spec: unknown, deps: Pick<NotesExportDocxDeps, 'imageAsBase64' | 'warn'>,
): Promise<void> {
  const blocks = field(spec, 'blocks');
  if (!Array.isArray(blocks)) return;
  for (const raw of blocks) {
    if (field(raw, 'type') !== 'image') continue;
    const block = raw as JsonObject;
    const data = field(block, 'data');
    if (typeof data === 'string' && data !== '') continue;
    const src = field(block, 'src');
    if (typeof src !== 'string') continue;
    // 不联网取图：退化为占位文字
    if (src.startsWith('http://') || src.startsWith('https://')) continue;
    try {
      block.data = await deps.imageAsBase64(src);
    } catch (error) {
      deps.warn(`[notes_export_docx] image unavailable: ${src} (${errorText(error)})`);
    }
  }
}

/** Returns the DOCX bytes as standard base64. */
export async function notesExportDocx(spec: unknown, deps: NotesExportDocxDeps): Promise<string> {
  // Rust takes `mut spec` by value; never mutate the caller's object.
  const owned: unknown = spec === undefined ? null : structuredClone(spec);
  await resolveNoteImages(owned, deps);
  const writer = deps.writer();
  let bytes: Uint8Array;
  try {
    bytes = await writer.generateDocx(owned);
  } catch (error) {
    // handout.rs:183-187: ParsingError → AppError::internal(e.to_string()).
    throw new CommandError(AppError.internal(error instanceof Error ? error.message : String(error)));
  }
  return toBase64(bytes);
}
