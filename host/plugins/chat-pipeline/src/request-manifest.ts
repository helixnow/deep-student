/**
 * D1 request manifest: what chat-pipeline hands to the model layer on every request, as sha256 + UTF-8 byte
 * counts per part (system prompt sections, transient skills, workspace injections, the `<injected_context>`
 * of user messages — resolved references, runtime facts and turn-volatile blocks — tool schemas and other
 * model context). Host log only, never chat_v2; the request itself is untouched and a manifest failure only warns.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LlmModel2Streaming, Model2HistoryMessage, UnifiedModel2StreamInput } from '../../llm/api.ts';
import type { CryptoService } from '../../../platform/crypto/api.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import { TRANSIENT_SKILL_METADATA_KIND } from './microcompact.ts';

export const REQUEST_MANIFEST_TAG = '[ChatV2::request-manifest]';

export interface ManifestDigest { sha256: string; bytes: number }
export type ManifestSection = ManifestDigest & { name: string };
export interface RequestManifest {
  streamEvent: string;
  messageId: string | null;
  taskContext: string | null;
  model: string | null;
  systemPrompt: (ManifestDigest & { sections: ManifestSection[] }) | null;
  skills: (ManifestDigest & { id: string; message: number })[];
  workspace: (ManifestDigest & { message: number })[];
  injectedContext: (ManifestDigest & { message: number; images: number; sections: ManifestSection[] })[];
  tools: (ManifestDigest & { items: ManifestSection[] }) | null;
  context: (ManifestDigest & { key: string })[];
  history: ManifestDigest & { messages: number };
}
export type ManifestHasher = Pick<CryptoService, 'sha256HexSync'>;
type Log = { info(message: string): void; warn(message: string): void };

const UNTAGGED_SECTION = '(untagged)';
const REFS_OPEN = '<injected_context>';
const REFS_CLOSE = '</injected_context>';

/** `ctx.crypto`; a minimal Host without the platform crypto plugin uses the byte-identical Web implementation. */
export function manifestHasherOf(ctx: Context): ManifestHasher {
  return (ctx.get('crypto') as CryptoService | undefined) ?? createWebCrypto();
}

class Digests {
  private readonly hasher: ManifestHasher;
  constructor(hasher: ManifestHasher) { this.hasher = hasher; }
  text(text: string): ManifestDigest { return { sha256: this.hasher.sha256HexSync(text), bytes: utf8ByteLength(text) }; }
  json(value: unknown): ManifestDigest { return this.text(JSON.stringify(value) ?? 'null'); }

  /**
   * PromptBuilder and the injected-context builder join top-level `<tag>…</tag>` parts; text outside any
   * top-level tag is one untagged section.
   */
  sections(text: string): ManifestSection[] {
    const lines = text.split('\n');
    const sections: ManifestSection[] = [];
    const untagged: string[] = [];
    let open: { name: string; start: number } | null = null;
    for (const [index, line] of lines.entries()) {
      if (open !== null) {
        if (line.startsWith(`</${open.name}>`)) {
          sections.push({ name: open.name, ...this.text(lines.slice(open.start, index + 1).join('\n')) });
          open = null;
        }
        continue;
      }
      const tag = /^<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(line)?.[1];
      if (tag === undefined) { untagged.push(line); continue; }
      if (line.endsWith(`</${tag}>`)) sections.push({ name: tag, ...this.text(line) });
      else open = { name: tag, start: index };
    }
    if (open !== null) untagged.push(...lines.slice(open.start));
    const loose = untagged.join('\n');
    return loose.trim() === '' ? sections : [{ name: UNTAGGED_SECTION, ...this.text(loose) }, ...sections];
  }

  /** context.ts wrapUserMessageText (text) and context-compiler buildCurrentUserMessage (multimodal parts). */
  injectedContext(message: Model2HistoryMessage, index: number): RequestManifest['injectedContext'][number] | null {
    const parts = message.multimodal_content;
    if (parts != null) {
      const start = parts.findIndex(part => part.type === 'text' && part.text === REFS_OPEN);
      const end = parts.findIndex((part, at) => at > start && part.type === 'text' && part.text === REFS_CLOSE);
      if (start >= 0 && end > start) {
        const block = parts.slice(start, end + 1);
        const inner = block.slice(1, -1);
        const text = inner.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');
        return { message: index, images: inner.length - inner.filter(part => part.type === 'text').length,
          ...this.json(block), sections: this.sections(text) };
      }
    }
    const start = message.content.indexOf(`${REFS_OPEN}\n`);
    const end = start < 0 ? -1 : message.content.indexOf(`\n${REFS_CLOSE}`, start);
    if (end < 0) return null;
    return { message: index, images: message.image_base64?.length ?? 0,
      ...this.text(message.content.slice(start, end + REFS_CLOSE.length + 1)),
      sections: this.sections(message.content.slice(start + REFS_OPEN.length + 1, end)) };
  }
}

export function topLevelSections(text: string, hasher: ManifestHasher): ManifestSection[] {
  return new Digests(hasher).sections(text);
}

export function buildRequestManifest(input: UnifiedModel2StreamInput, hasher: ManifestHasher): RequestManifest {
  const digests = new Digests(hasher);
  const skills: RequestManifest['skills'] = [];
  const workspace: RequestManifest['workspace'] = [];
  const injectedContext: RequestManifest['injectedContext'] = [];
  for (const [index, message] of input.chatHistory.entries()) {
    const metadata = message.metadata ?? null;
    if (metadata?.kind === TRANSIENT_SKILL_METADATA_KIND) {
      skills.push({ id: typeof metadata.skillId === 'string' ? metadata.skillId : '', message: index, ...digests.text(message.content) });
    } else if (metadata?.workspace_injection === true) {
      workspace.push({ message: index, ...digests.text(message.content) });
    } else if (message.role === 'user') {
      const injected = digests.injectedContext(message, index);
      if (injected !== null) injectedContext.push(injected);
    }
  }
  const { custom_tools: customTools, ...rest } = input.context;
  const tools = Array.isArray(customTools) ? {
    ...digests.json(customTools),
    items: customTools.map(tool => {
      const record = tool !== null && typeof tool === 'object' && !Array.isArray(tool) ? tool : {};
      const fn = record.function;
      const name = fn !== null && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string' ? fn.name
        : typeof record.name === 'string' ? record.name : '';
      return { name, ...digests.json(tool) };
    }),
  } : null;
  const prompt = input.systemPromptOverride ?? null;
  return {
    streamEvent: input.streamEvent, messageId: input.messageId ?? null, taskContext: input.taskContext,
    model: input.modelOverrideId ?? null,
    systemPrompt: prompt === null ? null : { ...digests.text(prompt), sections: digests.sections(prompt) },
    skills, workspace, injectedContext, tools,
    context: Object.keys(rest).sort().map(key => ({ key, ...digests.json(rest[key]) })),
    history: { messages: input.chatHistory.length, ...digests.json(input.chatHistory) },
  };
}

/** Every chat-pipeline model request (single turn, variants, unified text streams) goes through this port. */
export function withRequestManifest(service: LlmModel2Streaming, log: Log, hasher: ManifestHasher): LlmModel2Streaming {
  const record = (input: UnifiedModel2StreamInput) => {
    try {
      log.info(`${REQUEST_MANIFEST_TAG} ${JSON.stringify(buildRequestManifest(input, hasher))}`);
    } catch (error) {
      log.warn(`${REQUEST_MANIFEST_TAG} skipped (stream_event=${input.streamEvent}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    callUnifiedModel2Stream(input) {
      record(input);
      return service.callUnifiedModel2Stream(input);
    },
    callUnifiedModel2StreamWithConfig(config, establishRetries, input) {
      record(input);
      return service.callUnifiedModel2StreamWithConfig(config, establishRetries, input);
    },
  };
}
