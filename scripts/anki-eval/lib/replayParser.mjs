/**
 * 流式制卡解析器的测试侧最小复刻（eval 回放专用，禁止生产代码引用）。
 *
 * ⚠️ DRIFT RISK（漂移风险）：
 * 生产实现是 Rust 私有函数，无法直接从测试调用，此处按行为逐条复刻：
 *   - `StreamingAnkiService::extract_card_from_buffer_impl`
 *     （src-tauri/src/streaming_anki_service.rs，brace-depth 主信号 +
 *       <<<ANKI_CARD_JSON_END>>> 分隔符辅助信号 + 损坏分隔符修复）
 *   - `StreamingAnkiService::clean_json_string`（围栏/BOM/首尾大括号截取）
 *   - 流收尾 E1 残留处理（looks_like_card 判定 → 错误卡或丢弃）
 * 若生产逻辑变更而此文件未同步，eval 基线会静默偏离生产行为。
 * 生产侧已有 Rust 单测覆盖同样场景（streaming_anki_service.rs 测试模块），
 * 两侧共同锚定协议行为；修改任一侧时必须检查另一侧。
 *
 * 实现差异说明：Rust 按 UTF-8 字节扫描，此处按 UTF-16 码元扫描。
 * 所有信号字符（引号、反斜杠、大括号、分隔符）均为 ASCII，
 * 两种扫描方式对信号识别等价。
 */

export const DELIMITER = '<<<ANKI_CARD_JSON_END>>>';
export const BROKEN_DELIMITER_TAIL = 'ANKI_CARD_JSON_END>>>';

/** 对齐 Rust CARD_BUFFER_HARD_LIMIT（字节数近似为码元数，eval 夹具远小于上限）。 */
export const CARD_BUFFER_HARD_LIMIT = 1_000_000;

/**
 * 复刻 extract_card_from_buffer_impl：从缓冲中切出一张卡。
 *
 * @param {{buffer: string}} state 可变缓冲状态
 * @returns {{kind: 'card', content: string}
 *   | {kind: 'consumed_empty'}      // 空段被消费（Rust 返回 None，调用方 while-let 停止）
 *   | {kind: 'wait'}                // 等待更多 chunk（Rust 返回 None）
 *   | {kind: 'truncated', content: string}} // 超硬上限截断（Rust 返回 Some(Err)）
 */
export function extractCardFromBuffer(state) {
  const buf = state.buffer;
  let inString = false;
  let escape = false;
  let depth = 0;
  let objStart = -1;

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    // 辅助信号：字符串外的完整分隔符强制切卡（兜底括号不配平的残片）
    if (c === '<' && buf.startsWith(DELIMITER, i)) {
      const cardContent = buf.slice(0, i).trim();
      state.buffer = buf.slice(i + DELIMITER.length);
      return cardContent ? { kind: 'card', content: cardContent } : { kind: 'consumed_empty' };
    }

    // 损坏分隔符（如 "<<< ANKI_CARD_JSON_END>>>"）自动修复，字符串感知
    if (c === 'A' && buf.startsWith(BROKEN_DELIMITER_TAIL, i)) {
      const start = buf.lastIndexOf('<<<', i);
      if (start !== -1 && start < i) {
        const cardContent = buf.slice(0, start).trim();
        state.buffer = buf.slice(i + BROKEN_DELIMITER_TAIL.length);
        return cardContent ? { kind: 'card', content: cardContent } : { kind: 'consumed_empty' };
      }
    }

    if (c === '"' && depth > 0) {
      // 只在对象内部把引号当作字符串边界（对齐 Rust：b'"' if depth > 0）
      inString = true;
    } else if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const cardContent = buf.slice(objStart, i + 1);
        // 消费卡片本体及紧随其后的分隔符（含损坏变体）；对象前的自然语言前缀一并丢弃
        let restStart = i + 1;
        const rest = buf.slice(restStart);
        const trimmed = rest.replace(/^\s+/, '');
        const wsLen = rest.length - trimmed.length;
        if (trimmed.startsWith(DELIMITER)) {
          restStart += wsLen + DELIMITER.length;
        } else if (trimmed.startsWith('<<<')) {
          const tailPos = trimmed.indexOf(BROKEN_DELIMITER_TAIL);
          if (tailPos !== -1) {
            const between = trimmed.slice(3, tailPos);
            if ([...between].every((ch) => /\s/.test(ch) || ch === '<')) {
              restStart += wsLen + tailPos + BROKEN_DELIMITER_TAIL.length;
            }
          }
        }
        state.buffer = buf.slice(restStart);
        return { kind: 'card', content: cardContent };
      }
    }
  }

  // 既无完整 JSON 也无分隔符：等待后续 chunk，仅做无界增长兜底
  if (state.buffer.length > CARD_BUFFER_HARD_LIMIT) {
    const truncated = state.buffer;
    state.buffer = '';
    return { kind: 'truncated', content: truncated };
  }
  return { kind: 'wait' };
}

/**
 * 复刻 clean_json_string：剥 markdown 围栏与 BOM，截取首个 { 到最后一个 }。
 */
export function cleanJsonString(raw) {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.replace(/^\uFEFF+/, '');
  const trimmed = s.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function tryParseObject(text) {
  try {
    const value = JSON.parse(text);
    // 生产侧字段提取要求顶层为 JSON 对象；字符串/数组等一律走失败路径
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * 对一个已切出的片段做解析分类（对齐生产 parse_and_save_card 的成败语义）。
 *
 * 生产侧不区分 parse_ok / repair_ok（总是先 clean 再 parse）；
 * eval 侧区分二者以便度量"模型原始输出合规率"与"修复层挽救率"。
 *
 * @returns {{outcome: 'parse_ok'|'repair_ok'|'error_card', card?: object}}
 */
export function classifySegment(rawSegment) {
  const direct = tryParseObject(rawSegment.trim());
  if (direct.ok) {
    return { outcome: 'parse_ok', card: direct.value };
  }
  const cleaned = tryParseObject(cleanJsonString(rawSegment));
  if (cleaned.ok) {
    return { outcome: 'repair_ok', card: cleaned.value };
  }
  return { outcome: 'error_card' };
}

/**
 * 按 chunkSize 回放一段模型原始输出（复刻流式消费循环 + E1 收尾）。
 *
 * @param {string} rawStream 模型输出全文
 * @param {number} chunkSize 每个 chunk 的码元数；0 表示整段一次送入
 * @returns {{cards: Array<{outcome: string, card?: object, stage: string}>, droppedProse: number}}
 */
export function replayStream(rawStream, chunkSize) {
  const state = { buffer: '' };
  const cards = [];
  let droppedProse = 0;

  const size = chunkSize > 0 ? chunkSize : rawStream.length || 1;
  for (let offset = 0; offset < rawStream.length; offset += size) {
    state.buffer += rawStream.slice(offset, offset + size);
    // 对齐 Rust `while let Some(...)`：wait 与 consumed_empty（均为 None）都终止内循环
    for (;;) {
      const result = extractCardFromBuffer(state);
      if (result.kind === 'card') {
        cards.push({ ...classifySegment(result.content), stage: 'stream' });
      } else if (result.kind === 'truncated') {
        cards.push({ outcome: 'error_card', stage: 'truncated' });
        break;
      } else {
        break;
      }
    }
  }

  // E1 收尾：残留大概率是漏分隔符的最后一张卡
  const residual = state.buffer.trim();
  if (residual) {
    const looksLikeCard = residual.includes('{');
    if (looksLikeCard) {
      const cls = classifySegment(residual);
      cards.push({ ...cls, stage: 'finalize' });
    } else {
      // 纯自然语言收尾：丢弃，不生成错误卡
      droppedProse++;
    }
  }

  return { cards, droppedProse };
}

/**
 * direct 入口：整段内容直接走 parse_and_save 路径。
 * 对应生产的两个真实入口：错误卡聚合修复管线（FIX 段响应）与收尾残留解析。
 */
export function replayDirect(rawContent) {
  return { cards: [{ ...classifySegment(rawContent), stage: 'direct' }], droppedProse: 0 };
}
