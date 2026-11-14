// These imports deliberately target production implementations, never translated test copies.
// Lazy imports let unavailable native engines block their own vectors, not unrelated functions.
import { stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';

export class Unavailable extends Error {}
const plainArgs = value => JSON.parse(stringifyExact(value), (_key, v, context) => {
  if (typeof v === 'number' && /^-?\d+$/.test(context.source) && BigInt(context.source) !== BigInt(v)) {
    throw new Unavailable('adapter requires a published exact-integer production entrypoint');
  }
  return v;
});

export async function dispatch(request) {
  const { fn } = request;
  const a = plainArgs(request.args);
  let invoke;
  if (fn === 'tokens.estimate') {
    const m = await import('../../plugins/llm/src/tokens.ts');
    invoke = () => m.estimateTokens(a.text);
  } else if (fn.startsWith('text.')) {
    const m = await import('../../platform/paths/text.ts');
    invoke = () => m[fn.slice(5)](a.text, a.maxChars);
  } else if (fn === 'wrap.stream') {
    const m = await import('../../platform/util/model-special-tokens.ts');
    invoke = () => {
      const filter = m.create_model_wrap_token_filter(a.providerType, a.providerScope, a.model);
      return [...a.chunks.map(chunk => filter.process(chunk)), filter.flush()];
    };
  } else if (fn.startsWith('embedding.')) {
    const { EmbeddingChunker, EmbeddingTokenLimits } = await import('../../plugins/llm-providers/src/multimodal/embedding-chunker.ts');
    invoke = () => {
      if (fn === 'embedding.estimate') return EmbeddingChunker.estimateTokens(a.text);
      if (fn === 'embedding.limit') return new EmbeddingTokenLimits().getLimit(a.model);
      if (fn === 'embedding.chunk') return new EmbeddingChunker(a.maxTokens).withOverlap(a.overlap).chunkText(a.text);
      throw new Unavailable(fn);
    };
  } else if (fn.startsWith('fsrs.')) {
    const m = await import('../../plugins/review/src/fsrs-scheduler.ts');
    invoke = () => {
      switch (fn) {
        case 'fsrs.sanitize': return m.sanitizeSteps(a.steps);
        case 'fsrs.fuzzFactor': return m.fuzzFactorFor(a.id, a.reps);
        case 'fsrs.fuzz': return m.withReviewFuzz(a.factor, a.interval, a.minimum, a.maximum);
        case 'fsrs.parameters': return m.effectiveParameters(a.parameters);
        case 'fsrs.curve': return m.forgettingCurveConstants(a.parameters);
        case 'fsrs.schedule': return m.schedule(a.card, { ...a.context, fsrs: m.buildFsrs(a.parameters) });
        default: throw new Unavailable(fn);
      }
    };
  } else if (fn === 'crypto.staticKey' || fn === 'crypto.isEncrypted' || fn === 'serde.EncryptedData') {
    const m = await import('../../platform/secrets/crypto-service.ts');
    invoke = () => {
      if (fn === 'crypto.staticKey') return Buffer.from(m.deriveStaticKey(a.seed)).toString('hex');
      if (fn === 'crypto.isEncrypted') return m.isEncryptedFormat(a.json);
      const decoded = m.parseEncryptedData(a.json);
      // This production parser intentionally returns null on failure; compare its public result.
      return decoded === null ? null : JSON.parse(m.serializeEncryptedData(decoded));
    };
  } else if (fn === 'crypto.decryptBackup' || fn === 'crypto.checkVerifier') {
    const { createBackupCrypto } = await import('../../platform/secrets/backup-crypto.ts');
    const crypto = createBackupCrypto();
    invoke = async () => fn === 'crypto.decryptBackup'
      ? Buffer.from(await crypto.decryptBackup(Buffer.from(a.hex, 'hex'), a.password)).toString('hex')
      : crypto.checkPasswordVerifier(a.password, a.verifier);
  } else if (fn === 'serde.PasswordVerifier') {
    const { decodePasswordVerifierBytes, encodePasswordVerifier } = await import('../../plugins/sync-providers/api.ts');
    invoke = () => JSON.parse(Buffer.from(encodePasswordVerifier(
      decodePasswordVerifierBytes(Buffer.from(a.json, 'utf8')),
    )).toString('utf8'));
  } else if (fn === 'serde.AnkiCard') {
    const { decodeAnkiCardInput } = await import('../../plugins/anki/src/anki-cards.ts');
    invoke = () => decodeAnkiCardInput(JSON.parse(a.json), () => { throw new Unavailable('volatile default timestamp requires explicit fixture value'); });
  } else if (fn === 'time.utc') {
    const { parseRfc3339, toRfc3339Opts } = await import('../../platform/time/index.ts');
    invoke = () => {
      const parsed = parseRfc3339(a.text);
      // Preserve the actual Option-style parser result. Rust's chrono Err stays
      // an Err; a result-shape mismatch is not an unavailable production API.
      if (!parsed) return null;
      return toRfc3339Opts(parsed.epochNanos, 'AutoSi', a.useZ);
    };
  } else if (fn === 'cloze.fields') {
    const m = await import('../../plugins/anki/src/image-occlusion.ts');
    invoke = () => {
      const result = m.validateSpec(a.spec);
      return result.ok ? { ok: true, value: m.buildCardFields(result.value, a.imageFileName, a.extraNote) } : result;
    };
  } else if (fn === 'regex.boundedOriginal') {
    const { regex } = await import('../../platform/native/regex/index.ts');
    const { applyTransformOpsAsync, TransformFieldGrowthError } = await import('../../plugins/chatanki/src/transform.ts');
    if (a.replacement.includes('$') && typeof regex.replaceAllProjected !== 'function') {
      throw new Unavailable('F7 projected capture primitive missing for real L24 bounded path');
    }
    invoke = async () => {
      const matcher = await regex.compile(a.pattern);
      try {
        const fields = await applyTransformOpsAsync([{ kind: 'regex_replace', field: 'front', matcher, source: a.pattern, replacement: a.replacement }],
          { front: a.text, back: '', text: null, tags: [] }, regex);
        return { ok: true, value: fields.front };
      } catch (error) {
        if (!(error instanceof TransformFieldGrowthError)) throw error;
        return { ok: false, error: { opIndex: error.opIndex, field: error.field, bytes: error.bytes, detail: error.message } };
      }
    };
  } else if (fn === 'regex.replaceAll' || fn === 'regex.projected') {
    const { regex } = await import('../../platform/native/regex/index.ts');
    if (fn === 'regex.projected' && typeof regex.replaceAllProjected !== 'function') {
      throw new Unavailable('F7 nativeRegex.replaceAllProjected(pattern,text,replacement,limit) is not published');
    }
    invoke = async () => {
      const pattern = await regex.compile(a.pattern);
      return fn === 'regex.replaceAll' ? regex.replaceAll(pattern, a.text, a.replacement)
        : regex.replaceAllProjected(pattern, a.text, a.replacement, a.limit);
    };
  } else {
    throw new Unavailable(`no production adapter: ${fn}`);
  }
  try {
    const value = await invoke();
    if (value === undefined) throw new Unavailable(`undefined adapter result: ${fn}`);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Unavailable) throw error;
    return { ok: false, error: error instanceof Error ? error.message : error };
  }
}
