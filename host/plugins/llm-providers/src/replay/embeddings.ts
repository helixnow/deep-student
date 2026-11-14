/**
 * 回放的 `POST …/v1/embeddings`（OpenAI wire 格式）。应答只取决于请求体的 `model`、`input` 和
 * `dimensions`：不读时钟、不用随机数、没有实例状态，所以 A（serde `json!`）与 B（`JSON.stringify`）
 * 对同样的输入得到相同的向量，与键序和空白无关。
 *
 * 一个输入项在维度 D 下的向量：从 D 个 0 开始，对该项的每个特征 f，在 `fnv1a32(utf8(f)) mod D` 处加 1。
 * 特征依次为：
 *   - `w0`（总有；任何项都不会映射到余弦距离无定义的零向量）；
 *   - 文本（字符串项，或对象项的 `text`），码点为 c0…cn-1：每个 i 的 `t1:<ci>`，每对相邻码点的 `t2:<ci><ci+1>`；
 *   - 对象项的 `image` 字符串整体作为一个特征 `img:<image>`；
 *   - 对象项的 `instruction` 同文本，前缀为 `i1:` / `i2:`。
 * 分量是小的非负整数：f32、f64 都精确，序列化为 JSON 整数。共享字符越多的文本余弦相似度越高，
 * 检索表现像一个粗糙的词法模型而不是噪声。
 */

export interface EmbeddingModel { dimension: number }

/**
 * 各嵌入模型的原生维度。G3 语料把这些模型绑定到这些维度（host/plugins/vfs-repos/equivalence:
 * `vfs_create_dimension` + `vfs_set_default_embedding_dimension`）；Rust 拒绝长度与绑定维度不同的向量
 * （unified_retriever.rs `validate_dimension`）。
 */
export const embeddingModels: Readonly<Record<string, EmbeddingModel>> = {
  'w0-text-embedding': { dimension: 768 },
  'w0-vl-embedding': { dimension: 1024 },
};

const OBJECT_ITEM_KEYS = new Set(['text', 'image', 'instruction']);

export type EmbeddingResult =
  | { ok: true; json: unknown }
  | { ok: false; outcome: 'bad-embedding-request' | 'unknown-embedding-model'; status: number; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const encoder = new TextEncoder();

/** `text` 的 UTF-8 字节上的 32 位 FNV-1a（孤立代理编码为 U+FFFD）。 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

function textFeatures(prefix: string, text: string, out: string[]): void {
  const points = Array.from(text);
  for (let i = 0; i < points.length; i++) {
    out.push(`${prefix}1:${points[i]}`);
    if (i + 1 < points.length) out.push(`${prefix}2:${points[i]}${points[i + 1]}`);
  }
}

type Item = string | { text: string | null; image: string | null; instruction: string | null };

function features(item: Item): string[] {
  const out = ['w0'];
  if (typeof item === 'string') { textFeatures('t', item, out); return out; }
  if (item.text !== null) textFeatures('t', item.text, out);
  if (item.image !== null) out.push(`img:${item.image}`);
  if (item.instruction !== null) textFeatures('i', item.instruction, out);
  return out;
}

/** 一个输入项的确定性向量（见文件头）。 */
export function embeddingVector(item: Item, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (const feature of features(item)) vector[fnv1a32(feature) % dimension]! += 1;
  return vector;
}

/** `usage.prompt_tokens`：每段文本与 instruction 的码点数，每张图另加 1。 */
function tokens(item: Item): number {
  if (typeof item === 'string') return Array.from(item).length;
  return Array.from(item.text ?? '').length + Array.from(item.instruction ?? '').length + (item.image === null ? 0 : 1);
}

/** 字符串，或只有 text/image/instruction 键的对象（字符串；null 表示没有）。 */
function decodeItem(value: unknown, index: number): { item: Item } | { error: string } {
  if (typeof value === 'string') return { item: value };
  if (!isObject(value)) return { error: `input[${index}] must be a string or an object with text/image/instruction` };
  const unknown = Object.keys(value).filter(key => !OBJECT_ITEM_KEYS.has(key));
  if (unknown.length) return { error: `input[${index}] has unsupported keys ${unknown.join(', ')}` };
  const field = (key: string): string | null | undefined => {
    const item = value[key];
    return item === undefined || item === null ? null : typeof item === 'string' ? item : undefined;
  };
  const text = field('text'), image = field('image'), instruction = field('instruction');
  if (text === undefined || image === undefined || instruction === undefined) return { error: `input[${index}] text/image/instruction must be strings` };
  return { item: { text, image, instruction } };
}

const bad = (message: string): EmbeddingResult =>
  ({ ok: false, outcome: 'bad-embedding-request', status: 400, message: `x5 llm service: ${message}` });

/** `/embeddings` 请求体（已解析的 JSON）的应答体，或拒绝的原因。 */
export function embeddingResponse(body: unknown, models: Readonly<Record<string, EmbeddingModel>> = embeddingModels): EmbeddingResult {
  if (!isObject(body)) return bad('embeddings request body must be a JSON object');
  const { model, input, dimensions } = body;
  if (typeof model !== 'string' || model === '') return bad('embeddings request needs a model');
  if (!Object.hasOwn(models, model)) {
    return { ok: false, outcome: 'unknown-embedding-model', status: 404,
      message: `x5 llm service: unknown embedding model ${model} (known: ${Object.keys(models).join(', ')})` };
  }
  const native = models[model]!.dimension;
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') return bad(`encoding_format ${JSON.stringify(body.encoding_format)} is not supported (float)`);
  let dimension = native;
  if (dimensions !== undefined) {
    if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > native) {
      return bad(`dimensions must be an integer in 1..${native} for ${model}`);
    }
    dimension = dimensions;
  }
  const raw = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(raw) || raw.length === 0) return bad('embeddings input must be a string or a non-empty array');
  const items: Item[] = [];
  for (const [index, value] of raw.entries()) {
    const decoded = decodeItem(value, index);
    if ('error' in decoded) return bad(decoded.error);
    items.push(decoded.item);
  }
  const promptTokens = items.reduce((sum, item) => sum + tokens(item), 0);
  return { ok: true, json: {
    object: 'list',
    data: items.map((item, index) => ({ object: 'embedding', index, embedding: embeddingVector(item, dimension) })),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  } };
}
