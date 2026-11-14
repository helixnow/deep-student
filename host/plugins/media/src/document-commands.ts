/**
 * `src-tauri/src/commands.rs:4093-4148`: `parse_document_from_path` /
 * `parse_document_from_base64` command layer. Errors are plain strings
 * (`Result<String, String>`); the parser runs on the async docs service
 * (Rust moves it into `spawn_blocking`).
 */
import { CommandError } from '../../../kernel/api.ts';
import type { DocsService } from '../api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export interface DocumentCommandLog {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

const utf8Length = (text: string) => utf8ByteLength(text);
const display = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Rust `String::len()` is the UTF-8 byte length, logged as "字符". */
export async function parseDocumentFromPath(
  docs: Pick<DocsService, 'extractTextFromPath'>, filePath: string, log: DocumentCommandLog,
): Promise<string> {
  log.info(`开始解析文档: ${filePath}`);
  let text: string;
  try { text = await docs.extractTextFromPath(filePath); }
  catch (error) {
    const message = `文档解析失败: ${display(error)}`;
    log.error(`${message} (path=${filePath})`);
    throw new CommandError(message);
  }
  log.debug(`文档解析成功，提取文本长度: ${utf8Length(text)} 字符`);
  return text;
}

export async function parseDocumentFromBase64(
  docs: Pick<DocsService, 'extractTextFromBase64'>, fileName: string, base64Content: string,
  log: DocumentCommandLog,
): Promise<string> {
  log.info(`开始解析Base64文档: ${fileName}`);
  let text: string;
  try { text = await docs.extractTextFromBase64(fileName, base64Content); }
  catch (error) {
    const message = `Base64文档解析失败: ${display(error)}`;
    log.error(message);
    throw new CommandError(message);
  }
  log.debug(`Base64文档解析成功，提取文本长度: ${utf8Length(text)} 字符`);
  return text;
}
