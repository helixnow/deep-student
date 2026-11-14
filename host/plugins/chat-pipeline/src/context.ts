/**
 * chat_v2/context.rs — injected-context assembly.
 *
 * P1-10 moved everything that changes turn to turn out of the system prompt:
 * the current user message carries `<user_query>` first, followed by
 * `<injected_context>` with runtime facts, resource blocks and the
 * turn-volatile prompt blocks.
 */
import type { ContentBlock__De, SendContextRef } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ContextRef } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { escapeXmlContent } from './prompt-builder.ts';
import { localShellContractForPlatform } from './local-shell-contract.ts';
import { civilTime, chronoStamp, toRfc3339, ymd } from '../../../platform/time/index.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';

export type ContentBlock = ContentBlock__De;

/** Log surface matching context.rs debug sites. */
export interface ContextLog { debug(message: string): void }
let contextLogger: ContextLog = { debug() {} };
export function configureContextLogger(logger: ContextLog): void {
  contextLogger = logger;
}

export function buildUserQueryBlock(userContent: string): string | null {
  if (userContent === '') return null;
  return `<user_query>\n${escapeXmlContent(userContent)}\n</user_query>`;
}

/**
 * `<user_query>` then `<injected_context>`, separated by a blank line. An empty
 * or undefined injected context leaves the wrapper out entirely.
 */
export function wrapUserMessageText(userContent: string, injectedContext?: string | null): string {
  let combinedText = '';
  const userQuery = buildUserQueryBlock(userContent);
  if (userQuery !== null) combinedText = userQuery;

  if (injectedContext !== undefined && injectedContext !== null && injectedContext !== '') {
    if (combinedText !== '') combinedText += '\n\n';
    combinedText += `<injected_context>\n${injectedContext}\n</injected_context>`;
  }
  return combinedText;
}

const TIME_SENSITIVE_EXCLUDED_TERMS = [
  '时间复杂度', '空间复杂度', 'time complexity', 'space complexity',
];

const TIME_SENSITIVE_ZH_KEYWORDS = [
  '当前时间', '现在几点', '现在几号', '现在是', '今天', '明天', '昨天', '后天',
  '今晚', '今早', '日期', '周几', '星期几', '时区', '本周', '下周', '本月',
  '今年', '明年', '截止', '到期', '过期',
];

const TIME_SENSITIVE_EN_KEYWORDS = [
  'current time', 'what time', 'right now', 'current date', 'today', 'tomorrow',
  'yesterday', 'timezone', 'this week', 'next week', 'this month', 'this year',
  'deadline', 'due date', 'expires', 'expiration',
];

/** `to_ascii_lowercase`: only A-Z are lowered, other code points untouched. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, char => char.toLowerCase());
}

export function isTimeSensitiveQuery(userContent: string): boolean {
  const content = rustTrim(userContent);
  if (content === '') return false;

  const lower = asciiLowercase(content);
  if (TIME_SENSITIVE_EXCLUDED_TERMS.some(term => content.includes(term) || lower.includes(term))) {
    return false;
  }
  if (TIME_SENSITIVE_ZH_KEYWORDS.some(keyword => content.includes(keyword))) return true;
  return TIME_SENSITIVE_EN_KEYWORDS.some(keyword => lower.includes(keyword));
}

/** Node platform name → Rust `std::env::consts::OS` name. */
function rustPlatformName(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return platform;
  }
}

const WINDOWS_SHELL_NOTES = '\nshell_notes: PowerShell 7 优先、Windows PowerShell 5.1 回退（不是 bash）；'
  + '为兼容回退环境，避免 `&&`/`||`（改用 `;` 分隔，或用 `if ($?) { ... }` 判断上一条成败）；'
  + '不支持 `export X=Y`（用 `$env:X = "Y"`）；没有 `rm -rf`（用 `Remove-Item -Recurse -Force`）、'
  + '`grep`（用 `Select-String`）、`sed`/`awk`（用 `-replace`）、`touch`（用 `New-Item -Force`）、'
  + '`which`（用 `Get-Command`）；环境变量读取用 `$env:NAME`；路径分隔符用 \\ 或 / 均可；'
  + '命令必须完全非交互（无 stdin，交互式命令会挂起直到超时）。';

export interface RuntimeFactsOptions {
  /** Injectable clock (tests); defaults to now. */
  now?: Date;
  /** Injectable Rust platform name (tests); defaults to the host OS. */
  platform?: string;
}

/**
 * Runtime facts block. Time-sensitive questions get second precision, others
 * only the date; the shell contract tells the model which shell syntax to use.
 */
export function buildRuntimeFactsBlock(userContent: string, options: RuntimeFactsOptions = {}): string {
  const now = options.now ?? new Date();
  const epochNanos = BigInt(now.getTime()) * 1_000_000n;
  const local = civilTime(epochNanos, true);
  const platform = options.platform ?? rustPlatformName((globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux');
  const shell = localShellContractForPlatform(platform);
  const temporalFact = isTimeSensitiveQuery(userContent)
    ? `当前时间: ${chronoStamp(local, ':', false).replace('T', ' ')}`
    : `当前日期: ${ymd(local)}`;
  const shellNotes = shell.shell_kind === 'windows_powershell' ? WINDOWS_SHELL_NOTES : '';

  return '<runtime_facts>\n'
    + `${temporalFact}\n`
    + `时区: ${toRfc3339(epochNanos, { local: true }).slice(-6)}\n`
    + `os: ${shell.os}\n`
    + `platform: ${platform}\n`
    + `local_shell: ${shell.invocation ?? 'none'}\n`
    + `shell_path: ${shell.shell_path ?? 'none'}\n`
    + `sandbox_backend: ${shell.sandbox_backend}\n`
    + `shell_kind: ${shell.shell_kind}\n`
    + `output_encoding: ${shell.output_encoding ?? 'none'}\n`
    + `execution_supported: ${shell.execution_supported}\n`
    + 'non_interactive: true\n'
    + 'pty_available: false\n'
    + 'persistent_shell_session: false\n'
    + `network_default: deny${shellNotes}\n`
    + '</runtime_facts>';
}

/**
 * Block order: runtime facts → resource `formattedBlocks` (reference order) →
 * turn-volatile text. Volatile blocks are pre-escaped XML fragments and are
 * appended verbatim, exactly like runtime facts.
 */
export function buildInjectedContextBlocks(runtimeFacts: string,
  refs: readonly SendContextRef[], turnVolatile?: string | null): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: runtimeFacts }];
  for (const ref of refs) {
    for (const block of ref.formattedBlocks) {
      blocks.push(block.type === 'image'
        ? { type: 'image', mediaType: block.mediaType, base64: block.base64 }
        : { type: 'text', text: block.text });
    }
  }
  if (turnVolatile !== undefined && turnVolatile !== null && turnVolatile !== '') {
    blocks.push({ type: 'text', text: turnVolatile });
  }
  return blocks;
}

/** Text blocks joined by a blank line; image blocks yield their base64 payload. */
export function collectInjectedContextTextAndImages(blocks: readonly ContentBlock[]):
  { text: string; images: string[] } {  let text = '';
  const images: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (text !== '') text += '\n\n';
      text += block.text;
    } else {
      images.push(block.base64);
    }
  }
  return { text, images };
}

/** Full pipeline composition for the current user message. */
export function combineUserContent(userContent: string, runtimeFacts: string,
  refs: readonly SendContextRef[], turnVolatile?: string | null):
  { text: string; images: string[] } {
  const blocks = buildInjectedContextBlocks(runtimeFacts, refs, turnVolatile);
  const { text, images } = collectInjectedContextTextAndImages(blocks);
  return { text: wrapUserMessageText(userContent, text), images };
}

/** `PipelineContext::build_user_content_from_context_refs` — flatten in order. */
export function buildUserContentFromContextRefs(
  refs: readonly SendContextRef[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const ref of refs) blocks.push(...ref.formattedBlocks);
  return blocks;
}

/** `SendContextRef::to_context_ref` — drops the transient formatted blocks. */
export function sendContextRefToContextRef(ref: SendContextRef): ContextRef {
  return {
    resourceId: ref.resourceId,
    hash: ref.hash,
    typeId: ref.typeId,
    ...(ref.displayName === undefined || ref.displayName === null
      ? {}
      : { displayName: ref.displayName }),
    ...(ref.injectModes === undefined || ref.injectModes === null
      ? {}
      : {
        // The `__De` split only changes the TS enum arrays; JSON is identical.
        injectModes: ref.injectModes as unknown as ContextRef['injectModes'],
      }),
  };
}

/** `PipelineContext::convert_to_context_refs`. */
export function convertToContextRefs(refs: readonly SendContextRef[]): ContextRef[] {
  return refs.map(sendContextRefToContextRef);
}

/**
 * `PipelineContext::get_combined_user_content`: runtime facts + resource blocks
 * inside `<injected_context>`, after the `<user_query>` wrapper.
 */
export function combinedUserContent(userContent: string, refs: readonly SendContextRef[],
  options: RuntimeFactsOptions & { turnVolatile?: string | null } = {}):
  { text: string; images: string[] } {
  const runtimeFacts = buildRuntimeFactsBlock(userContent, options);
  const blocks = buildInjectedContextBlocks(runtimeFacts, refs, options.turnVolatile);
  const { text, images } = collectInjectedContextTextAndImages(blocks);
  const combined = wrapUserMessageText(userContent, text);
  // Rust `String::len()` counts UTF-8 bytes, not UTF-16 code units.
  contextLogger.debug(`[ChatV2::pipeline] Combined user content: context_refs=${refs.length}`
    + `, context_images=${images.length}, total_len=${utf8ByteLength(combined)}`);
  return { text: combined, images };
}

/**
 * `PipelineContext::get_content_blocks_ordered`: keeps image/text interleaving
 * for multimodal requests. Wrapper blocks contain no extra newlines.
 */
export function contentBlocksOrdered(userContent: string, refs: readonly SendContextRef[],
  options: RuntimeFactsOptions & { turnVolatile?: string | null } = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const userQuery = buildUserQueryBlock(userContent);
  if (userQuery !== null) blocks.push({ type: 'text', text: userQuery });

  const runtimeFacts = buildRuntimeFactsBlock(userContent, options);
  const injected = buildInjectedContextBlocks(runtimeFacts, refs, options.turnVolatile);
  if (injected.length > 0) {
    blocks.push({ type: 'text', text: '<injected_context>' });
    blocks.push(...injected);
    blocks.push({ type: 'text', text: '</injected_context>' });
  }
  contextLogger.debug(`[ChatV2::pipeline] get_content_blocks_ordered: total_blocks=${blocks.length}`);
  return blocks;
}
