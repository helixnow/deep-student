/**
 * `StreamingAnkiService` 的迁移：JSON 清理、字段提取、切卡与卡片入库。
 *
 * 纯函数辅助已按职责拆到 `streaming-anki-{protocol,templates,fields,prompt,buffer,errors}.ts`；
 * 本模块只保留与 `this.db` / `this.logger` 绑定的服务状态机。
 * 所有文案、分支、排序与 Rust 源码逐条对应；日志走注入的 {@link AnkiLogger}。
 */
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  AnkiGenerationOptions,
  FieldExtractionRule__De,
  FieldType__De,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { NativeRegex } from '../../../platform/native/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { insertAnkiCard } from '../repository/anki-cards.ts';
import {
  ORIGINAL_GENERATION_FIELD,
  insertOriginalGenerationOnce,
  originalGenerationSnapshotErrorMessage,
} from './anki-gold-set.ts';
import {
  type CardLintInput,
  duplicateKeySource,
  lintCard,
  mergeFlags,
  observeDocumentCard,
} from './anki-qa-lint.ts';
import { defaultLintConfig } from './anki-qa-types.ts';
import { isMultiTemplate, repairJsonDetailed, unwrapCardsArray } from './anki-protocol.ts';
import type { OcclusionCardFields } from './image-occlusion.ts';
import { nowRfc3339 } from './time.ts';
import type { ResidualCardPayload } from './streaming-anki-buffer.ts';
import {
  cancelStreaming,
  clearCancelSender,
  isStreaming,
  registerCancellation,
  type StreamingAnkiDeps,
} from './streaming-anki-cancel.ts';
import { DatabaseError, ValidationError, errorText, occlusionImageRef, trimJsonQuotes } from './streaming-anki-errors.ts';
import {
  deckTag,
  extractReadableText,
  fieldTypeName,
  isPlaceholderCard,
  isRecord,
  jsonFragmentBalanced,
  validateFieldAgainstRule,
  type FieldViolation,
} from './streaming-anki-fields.ts';
import { QA_FLAGS_FIELD, UNREADABLE_FRAGMENT_MSG, stripModelSpecialTokens } from './streaming-anki-protocol.ts';
import {
  eqIgnoreAsciiCase,
  formatTemplateIdentifierHelp,
  resolveTemplateIdCandidate,
} from './streaming-anki-templates.ts';

export class StreamingAnkiService {
  readonly db: DatabaseHandle | SqlExecutor;
  readonly regex: Pick<NativeRegex, 'compile' | 'isMatch'>;
  readonly logger: StreamingAnkiDeps['logger'];

  constructor(deps: StreamingAnkiDeps) {
    this.db = deps.db;
    this.regex = deps.regex;
    this.logger = deps.logger;
  }

  cleanJsonString(jsonStr: string): string {
    let s = rustTrim(jsonStr);
    if (s.startsWith('```json')) s = s.slice(7);
    if (s.startsWith('```')) s = s.slice(3);
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.replace(/^\uFEFF+/u, '');

    const trimmed = rustTrim(s);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      if (jsonFragmentBalanced(candidate)) return candidate;
    }
    return trimmed;
  }

  cleanTemplatePlaceholders(content: string): string {
    let cleaned = content;
    cleaned = cleaned.split('{{.}}').join('');
    cleaned = cleaned.split('{{/}}').join('');
    cleaned = cleaned.split('{{#}}').join('');
    cleaned = cleaned.split('{{}}').join('');
    while (cleaned.includes('{{}}')) cleaned = cleaned.split('{{}}').join('');
    cleaned = cleaned.split('{{  }}').join('');
    cleaned = cleaned.split('{{ }}').join('');
    return rustTrim(cleaned);
  }

  extractTemplateId(jsonValue: unknown): string | null {
    for (const key of ['template_id', 'templateId']) {
      const value = this.extractFieldValue(jsonValue, key);
      if (value === undefined) continue;
      if (typeof value === 'string') {
        const trimmed = rustTrim(value);
        if (trimmed !== '') return trimmed;
      } else if (typeof value === 'number') {
        return JSON.stringify(value);
      }
    }
    return null;
  }

  extractFieldValue(jsonValue: unknown, fieldName: string): unknown {
    if (!isRecord(jsonValue)) return undefined;
    const fieldLower = fieldName.toLowerCase();

    if (Object.hasOwn(jsonValue, fieldName)) return jsonValue[fieldName];
    for (const [key, value] of Object.entries(jsonValue)) {
      if (key.toLowerCase() === fieldLower) return value;
    }

    const fieldsObj = jsonValue['fields'];
    if (isRecord(fieldsObj)) {
      if (Object.hasOwn(fieldsObj, fieldName)) return fieldsObj[fieldName];
      for (const [key, value] of Object.entries(fieldsObj)) {
        if (key.toLowerCase() === fieldLower) return value;
      }
    }
    return undefined;
  }

  processFieldValue(value: unknown, fieldType: FieldType__De): string {
    const typeName = fieldTypeName(fieldType);
    const asStringOrSerialized = (): string => {
      if (typeof value === 'string') return value;
      return trimJsonQuotes(JSON.stringify(value));
    };

    switch (typeName) {
      case 'Array': {
        if (Array.isArray(value)) {
          if (value.every((item) => typeof item === 'string')) {
            return JSON.stringify(value);
          }
          let formatted = '';
          value.forEach((item, idx) => {
            if (isRecord(item)) {
              const order = typeof item['order'] === 'number' ? Math.trunc(item['order']) : idx + 1;
              const action = typeof item['action'] === 'string' ? item['action'] : '';
              formatted += `${order}. ${action}\n`;
              if (typeof item['details'] === 'string') formatted += `    - ${item['details']}\n`;
              if (typeof item['code'] === 'string') formatted += `\`\`\`\n${item['code']}\n\`\`\`\n`;
              if (typeof item['warning'] === 'string') formatted += `❗ ${item['warning']}\n`;
            } else {
              formatted += trimJsonQuotes(JSON.stringify(item));
            }
          });
          return rustTrim(formatted);
        }
        return JSON.stringify(value);
      }
      case 'Number': {
        if (typeof value === 'number') return String(value);
        if (typeof value === 'string') return value;
        return trimJsonQuotes(JSON.stringify(value));
      }
      case 'Boolean': {
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'string') return value;
        return trimJsonQuotes(JSON.stringify(value));
      }
      case 'RichText': {
        if (typeof value === 'string') return value;
        if (isRecord(value)) return JSON.stringify(value);
        return trimJsonQuotes(JSON.stringify(value));
      }
      case 'Date':
      case 'Formula':
      case 'Text':
      default:
        return asStringOrSerialized();
    }
  }

  processTagsField(value: unknown, fieldType: FieldType__De): string[] {
    const typeName = fieldTypeName(fieldType);
    if (typeName === 'Array') {
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string');
      }
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((tag) => rustTrim(tag))
          .filter((tag) => tag !== '');
      }
      return [];
    }
    if (typeName === 'Text') {
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((tag) => rustTrim(tag))
          .filter((tag) => tag !== '');
      }
      return [];
    }
    return [];
  }

  async extractFieldsWithRules(
    jsonValue: unknown,
    rules: Readonly<Record<string, FieldExtractionRule__De>>,
    templateFields: readonly string[] | null,
  ): Promise<{ front: string; back: string; tags: string[]; extra_fields: Record<string, string> }> {
    let front = '';
    let back = '';
    let tags: string[] = [];
    const extraFields: Record<string, string> = {};
    const qaFlags: FieldViolation[] = [];

    const priority = (name: string): number => {
      const lower = name.toLowerCase();
      if (lower === 'text') return 0;
      if (lower === 'front') return 1;
      if (lower === 'back') return 2;
      if (lower === 'tags') return 3;
      return 4;
    };

    const orderedRules = Object.entries(rules).sort(([a], [b]) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const byPriority = priority(a) - priority(b);
      if (byPriority !== 0) return byPriority;
      if (aLower === bLower) return 0;
      return aLower < bLower ? -1 : 1;
    });

    const applyDefault = (fieldNameLower: string, defaultValue: string): void => {
      switch (fieldNameLower) {
        case 'front':
          if (front === '') front = defaultValue;
          break;
        case 'back':
          if (back === '') back = defaultValue;
          break;
        case 'tags':
          try {
            const parsed = JSON.parse(defaultValue) as unknown;
            tags = Array.isArray(parsed)
              ? parsed.filter((item): item is string => typeof item === 'string')
              : [];
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            tags = [];
          }
          break;
        default:
          extraFields[fieldNameLower] = defaultValue;
      }
    };

    for (const [fieldName, rule] of orderedRules) {
      const fieldValue = this.extractFieldValue(jsonValue, fieldName);
      const fieldNameLower = fieldName.toLowerCase();

      if (fieldValue !== undefined) {
        switch (fieldNameLower) {
          case 'front': {
            const processed = this.processFieldValue(fieldValue, rule.field_type);
            qaFlags.push(...(await validateFieldAgainstRule(fieldName, processed, rule, this.regex, this.logger)));
            front = processed;
            extraFields['front'] = processed;
            break;
          }
          case 'back': {
            const processed = this.processFieldValue(fieldValue, rule.field_type);
            qaFlags.push(...(await validateFieldAgainstRule(fieldName, processed, rule, this.regex, this.logger)));
            back = processed;
            break;
          }
          case 'tags': {
            tags = this.processTagsField(fieldValue, rule.field_type);
            for (const tag of tags) {
              qaFlags.push(...(await validateFieldAgainstRule(fieldName, tag, rule, this.regex, this.logger)));
            }
            break;
          }
          case 'explanation': {
            const processed = this.processFieldValue(fieldValue, rule.field_type);
            qaFlags.push(...(await validateFieldAgainstRule(fieldName, processed, rule, this.regex, this.logger)));
            extraFields['explanation'] = processed;
            break;
          }
          case 'text': {
            const processed = this.processFieldValue(fieldValue, rule.field_type);
            qaFlags.push(...(await validateFieldAgainstRule(fieldName, processed, rule, this.regex, this.logger)));
            extraFields['text'] = processed;
            if (front === '') front = processed;
            if (back === '') back = `填空题：${processed}`;
            break;
          }
          default: {
            const processed = this.processFieldValue(fieldValue, rule.field_type);
            qaFlags.push(...(await validateFieldAgainstRule(fieldName, processed, rule, this.regex, this.logger)));
            extraFields[fieldNameLower] = processed;
          }
        }
        continue;
      }

      if (rule.is_required) {
        const defaultValue = rule.default_value ?? null;
        if (defaultValue !== null) {
          applyDefault(fieldNameLower, defaultValue);
        } else {
          throw new ValidationError(`缺少必需字段: ${fieldName}`);
        }
      } else {
        const defaultValue = rule.default_value ?? null;
        if (defaultValue !== null) applyDefault(fieldNameLower, defaultValue);
      }
    }

    if (Object.hasOwn(extraFields, 'optiona')) {
      let choiceBack = '';
      const optionA = extraFields['optiona'];
      if (optionA !== undefined) choiceBack += `A. ${optionA}\n`;
      const optionB = extraFields['optionb'];
      if (optionB !== undefined) choiceBack += `B. ${optionB}\n`;
      const optionC = extraFields['optionc'];
      if (optionC !== undefined) choiceBack += `C. ${optionC}\n`;
      const optionD = extraFields['optiond'];
      if (optionD !== undefined) choiceBack += `D. ${optionD}\n`;
      const correct = extraFields['correct'];
      if (correct !== undefined) choiceBack += `\n正确答案：${correct}\n`;
      const explanation = extraFields['explanation'];
      if (explanation !== undefined) choiceBack += `\n解析：${explanation}`;
      back = choiceBack;
    }

    if (front === '') {
      const title = isRecord(jsonValue) ? jsonValue['Title'] : undefined;
      const question = isRecord(jsonValue) ? jsonValue['question'] : undefined;
      if (typeof title === 'string') front = title;
      else if (typeof question === 'string') front = question;
    }

    if (back === '') {
      if (isRecord(jsonValue)) {
        const overview = jsonValue['Overview'];
        const interpretation = jsonValue['Interpretation'];
        const contentValue = jsonValue['Content'];
        const law = jsonValue['Law'];
        if (typeof overview === 'string') back = overview;
        else if (typeof interpretation === 'string') back = interpretation;
        else if (typeof contentValue === 'string') back = contentValue;
        else if (typeof law === 'string') back = law;
      }
    }

    const SEMANTIC_FRONT_KEYS = ['question', 'term', 'word', 'name', 'symbol', 'title', 'text'];
    const SEMANTIC_BACK_KEYS = ['answer', 'definition', 'explanation', 'expl', 'detail', 'backdetail', 'meaning'];
    if (front === '') {
      const found = SEMANTIC_FRONT_KEYS.map((key) => extraFields[key]).find(
        (value) => value !== undefined && rustTrim(value) !== '',
      );
      if (found !== undefined) front = found;
    }
    if (back === '') {
      const found = SEMANTIC_BACK_KEYS.map((key) => extraFields[key]).find(
        (value) => value !== undefined && rustTrim(value) !== '' && value !== front,
      );
      if (found !== undefined) back = found;
    }

    if (front === '' && templateFields !== null) {
      const first = templateFields[0];
      if (first !== undefined) {
        const value = extraFields[first.toLowerCase()];
        if (value !== undefined) front = value;
      }
    }
    if (back === '' && templateFields !== null) {
      const second = templateFields[1];
      if (second !== undefined) {
        const value = extraFields[second.toLowerCase()];
        if (value !== undefined) back = value;
      }
    }

    if (front === '') {
      const readable = extractReadableText(jsonValue);
      if (readable !== null) {
        this.logger.warn(`[ANKI_PARSE_WARN] front 字段缺失，回退为首个可读文本（${[...readable].length} 字符）`);
        front = readable;
      } else {
        throw new ValidationError(`${UNREADABLE_FRAGMENT_MSG}: 残片不含任何可读文本字段，已丢弃`);
      }
    }

    if (back === '') {
      const fieldsObj = isRecord(jsonValue) && isRecord(jsonValue['fields']) ? jsonValue['fields'] : null;
      const getField = (key: string): string | undefined => {
        if (!isRecord(jsonValue)) return undefined;
        const top = jsonValue[key];
        if (typeof top === 'string') return top;
        const nested = fieldsObj !== null ? fieldsObj[key] : undefined;
        return typeof nested === 'string' ? nested : undefined;
      };

      if (getField('optiona') !== undefined) {
        let choiceBack = '';
        const optionA = getField('optiona');
        if (optionA !== undefined) {
          choiceBack += `A. ${optionA}\n`;
          extraFields['optiona'] = optionA;
        }
        const optionB = getField('optionb');
        if (optionB !== undefined) {
          choiceBack += `B. ${optionB}\n`;
          extraFields['optionb'] = optionB;
        }
        const optionC = getField('optionc');
        if (optionC !== undefined) {
          choiceBack += `C. ${optionC}\n`;
          extraFields['optionc'] = optionC;
        }
        const optionD = getField('optiond');
        if (optionD !== undefined) {
          choiceBack += `D. ${optionD}\n`;
          extraFields['optiond'] = optionD;
        }
        const correct = getField('correct');
        if (correct !== undefined) {
          choiceBack += `\n正确答案：${correct}\n`;
          extraFields['correct'] = correct;
        }
        const explanation = getField('explanation');
        if (explanation !== undefined) {
          choiceBack += `\n解析：${explanation}`;
          extraFields['explanation'] = explanation;
        }
        back = choiceBack;
      } else {
        const skipKeys = new Set(['front', 'tags', 'template_id', 'templateid', 'text', QA_FLAGS_FIELD]);
        let fallbackBack = '';
        for (const [key, value] of Object.entries(extraFields)) {
          if (skipKeys.has(key) || rustTrim(value) === '' || value === front) continue;
          if (fallbackBack !== '') fallbackBack += '\n\n';
          fallbackBack += value;
        }
        if (fallbackBack === '') {
          if (isRecord(jsonValue)) {
            for (const [key, value] of Object.entries(jsonValue)) {
              const keyLower = key.toLowerCase();
              if (['front', 'tags', 'template_id', 'templateid', 'fields'].includes(keyLower)) continue;
              if (typeof value === 'string') {
                if (rustTrim(value) !== '' && value !== front) {
                  if (fallbackBack !== '') fallbackBack += '\n\n';
                  fallbackBack += value;
                }
              }
            }
          }
        }
        if (fallbackBack === '') throw new ValidationError('back字段不能为空');
        back = fallbackBack;
      }
    }

    if (qaFlags.length > 0) {
      this.logger.warn(
        `[QA_FLAGS] 卡片字段校验发现 ${qaFlags.length} 项违规（仅标记，不丢弃）: ${JSON.stringify(qaFlags)}`,
      );
      extraFields[QA_FLAGS_FIELD] = JSON.stringify(qaFlags);
    }

    return { front, back, tags, extra_fields: extraFields };
  }

  expandWrapperPayloads(raw: string): ResidualCardPayload[] {
    const intact = (json: string): ResidualCardPayload => ({ json, truncated: false });
    if (!raw.includes('{')) return [intact(raw)];
    const cleaned = this.cleanJsonString(raw);
    let parsed: unknown;
    let lossy = false;
    try {
      parsed = JSON.parse(cleaned) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const repair = repairJsonDetailed(cleaned);
      if (repair === null) {
        parsed = undefined;
      } else {
        try {
          parsed = JSON.parse(repair.text) as unknown;
          lossy = repair.truncated_string;
        } catch (inner) {
          if (!(inner instanceof SyntaxError)) throw inner;
          parsed = undefined;
        }
      }
    }
    if (parsed !== undefined) {
      const cards = unwrapCardsArray(parsed);
      if (cards !== null) {
        this.logger.info(
          `[ANKI_PROTOCOL] 收尾残留为结构化 wrapper，展开为 ${cards.length} 个卡片 payload${lossy ? '（最后一张受字符串截断影响，将落错误卡）' : ''}`,
        );
        const lastIndex = cards.length - 1;
        return cards.map((card, index) => ({
          json: JSON.stringify(card),
          truncated: lossy && index === lastIndex,
        }));
      }
    }
    return [intact(raw)];
  }

  async parseAndSaveCard(
    cardJson: string,
    taskId: string,
    documentId: string,
    options: AnkiGenerationOptions,
    qaPassEnabled: boolean,
    occlusionFields: OcclusionCardFields | null,
  ): Promise<AnkiCard | null> {
    const stripped = stripModelSpecialTokens(cardJson);
    if (rustTrim(stripped) === '') {
      throw new ValidationError(`${UNREADABLE_FRAGMENT_MSG}: 残片仅含模型特殊token，已丢弃`);
    }

    const cleanedJson = this.cleanJsonString(stripped);
    let jsonValue: unknown;
    try {
      jsonValue = JSON.parse(cleanedJson) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const repair = repairJsonDetailed(cleanedJson);
      if (repair !== null && repair.truncated_string) {
        this.logger.error('[ANKI_PARSE_ERROR] JSON在字符串中途截断，拒绝有损修复入库');
        this.logger.error(`[ANKI_PARSE_ERROR] 错误信息: ${error.message}`);
        this.logger.error(`[ANKI_PARSE_ERROR] 原始内容: ${cardJson}`);
        throw new ValidationError(`JSON在字符串中途截断（${error.message}），残缺内容: ${cleanedJson}`);
      }
      if (repair !== null) {
        try {
          jsonValue = JSON.parse(repair.text) as unknown;
          this.logger.warn(`[ANKI_JSON_REPAIR] 解析失败（${error.message}），无损修复后成功解析`);
        } catch (inner) {
          if (!(inner instanceof SyntaxError)) throw inner;
          this.logger.error('[ANKI_PARSE_ERROR] JSON解析失败（修复产物不可解析）');
          this.logger.error(`[ANKI_PARSE_ERROR] 错误信息: ${error.message}`);
          this.logger.error(`[ANKI_PARSE_ERROR] 原始内容: ${cardJson}`);
          this.logger.error(`[ANKI_PARSE_ERROR] 清理后内容: ${cleanedJson}`);
          throw new ValidationError(`JSON解析失败: ${error.message}`);
        }
      } else {
        this.logger.error('[ANKI_PARSE_ERROR] JSON解析失败');
        this.logger.error(`[ANKI_PARSE_ERROR] 错误信息: ${error.message}`);
        this.logger.error(`[ANKI_PARSE_ERROR] 原始内容: ${cardJson}`);
        this.logger.error(`[ANKI_PARSE_ERROR] 清理后内容: ${cleanedJson}`);
        throw new ValidationError(`JSON解析失败: ${error.message}`);
      }
    }

    if (isPlaceholderCard(jsonValue)) {
      throw new ValidationError(`${UNREADABLE_FRAGMENT_MSG}: 卡片字段全为占位符，已丢弃`);
    }

    const multiTemplate = isMultiTemplate(options);
    const rawTemplateId = this.extractTemplateId(jsonValue);
    const templateIdFromCard = resolveTemplateIdCandidate(
      rawTemplateId,
      options.template_descriptions,
      options.template_ids,
      options.template_fields_by_id,
    );
    if (rawTemplateId !== null) {
      if (templateIdFromCard !== null && templateIdFromCard !== rawTemplateId) {
        this.logger.info(`[ANKI_TEMPLATE_RESOLVE] template_id normalized: raw='${rawTemplateId}' -> resolved='${templateIdFromCard}'`);
      } else if (templateIdFromCard === null) {
        this.logger.warn(
          `[ANKI_TEMPLATE_RESOLVE] Unknown template_id from model: '${rawTemplateId}' (${formatTemplateIdentifierHelp(options)})`,
        );
      }
    }

    let resolvedTemplateId: string | null;
    if (multiTemplate) {
      resolvedTemplateId = templateIdFromCard;
    } else {
      resolvedTemplateId =
        templateIdFromCard ??
        options.template_id ??
        (options.template_ids !== null &&
        options.template_ids !== undefined &&
        options.template_ids.length === 1
          ? options.template_ids[0]!
          : null);
    }

    if (multiTemplate && resolvedTemplateId === null) {
      throw new ValidationError(
        `卡片缺少或无法识别 template_id，无法在多模板场景解析字段。请确保每个卡片JSON包含 template_id 且值为模板ID（不是名称）。${formatTemplateIdentifierHelp(options)}`,
      );
    }
    if (multiTemplate && (options.field_extraction_rules_by_id === null || options.field_extraction_rules_by_id === undefined)) {
      throw new ValidationError('多模板解析失败：缺少按模板分组的 field_extraction_rules_by_id。');
    }
    if (multiTemplate && (options.template_fields_by_id === null || options.template_fields_by_id === undefined)) {
      throw new ValidationError('多模板解析失败：缺少按模板分组的 template_fields_by_id。');
    }

    let resolvedTemplateFields: string[] | null;
    if (options.template_fields_by_id !== null && options.template_fields_by_id !== undefined) {
      if (resolvedTemplateId === null) {
        throw new ValidationError('多模板解析失败：缺少 template_id');
      }
      const fields = options.template_fields_by_id[resolvedTemplateId];
      if (fields === undefined) {
        throw new ValidationError(
          `模板字段缺失：未找到模板 ${resolvedTemplateId} 的 template_fields。${formatTemplateIdentifierHelp(options)}`,
        );
      }
      resolvedTemplateFields = fields;
    } else {
      resolvedTemplateFields = options.template_fields ?? null;
    }

    let resolvedRules: Readonly<Record<string, FieldExtractionRule__De>>;
    if (options.field_extraction_rules_by_id !== null && options.field_extraction_rules_by_id !== undefined) {
      if (resolvedTemplateId === null) {
        throw new ValidationError('多模板解析失败：缺少 template_id');
      }
      const rules = options.field_extraction_rules_by_id[resolvedTemplateId];
      if (rules === undefined) {
        throw new ValidationError(
          `字段提取规则缺失：未找到模板 ${resolvedTemplateId} 的 field_extraction_rules。${formatTemplateIdentifierHelp(options)}`,
        );
      }
      resolvedRules = rules;
    } else if (options.field_extraction_rules !== null && options.field_extraction_rules !== undefined) {
      resolvedRules = options.field_extraction_rules;
    } else {
      throw new ValidationError(
        '字段提取规则缺失：前端未传递 field_extraction_rules，无法解析AI生成的卡片JSON。请确保模板配置正确且前端已传递字段提取规则。',
      );
    }

    const extracted = await this.extractFieldsWithRules(jsonValue, resolvedRules, resolvedTemplateFields);
    const cleanedFront = this.cleanTemplatePlaceholders(extracted.front);
    const cleanedBack = this.cleanTemplatePlaceholders(extracted.back);
    const cleanedTags = extracted.tags
      .map((tag) => this.cleanTemplatePlaceholders(tag))
      .filter((tag) => tag !== '');
    if (cleanedTags.length === 0) {
      const tag = deckTag(options.deck_name);
      if (tag !== null) cleanedTags.push(tag);
    }

    const cleanedExtraFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(extracted.extra_fields)) {
      cleanedExtraFields[key] = this.cleanTemplatePlaceholders(value);
    }

    const needsTextField =
      resolvedTemplateFields !== null &&
      resolvedTemplateFields.some((field) => eqIgnoreAsciiCase(field, 'text'));
    if (needsTextField && !Object.hasOwn(cleanedExtraFields, 'text')) {
      let rawText: string | undefined;
      if (isRecord(jsonValue)) {
        const direct = jsonValue['text'] ?? jsonValue['Text'];
        if (typeof direct === 'string') rawText = direct;
      }
      if (rawText !== undefined) {
        cleanedExtraFields['text'] = this.cleanTemplatePlaceholders(rawText);
      } else if (cleanedFront.includes('{{c')) {
        cleanedExtraFields['text'] = cleanedFront;
      } else if (cleanedBack.includes('{{c')) {
        cleanedExtraFields['text'] = cleanedBack;
      }
    }

    if (occlusionFields !== null) {
      for (const [key, value] of Object.entries(occlusionFields.extraFields)) {
        if (!Object.hasOwn(cleanedExtraFields, key)) cleanedExtraFields[key] = value;
      }
      for (const tag of occlusionFields.tags) {
        if (!cleanedTags.includes(tag)) cleanedTags.push(tag);
      }
      const currentText = cleanedExtraFields['text'];
      const hasModelText = currentText !== undefined && rustTrim(currentText) !== '';
      if (!hasModelText && rustTrim(occlusionFields.text) !== '') {
        cleanedExtraFields['text'] = occlusionFields.text;
      }
    }

    const lintInput: CardLintInput = {
      front: cleanedFront,
      back: cleanedBack,
      text: cleanedExtraFields['text'] ?? null,
      tags: cleanedTags,
      extra_fields: cleanedExtraFields,
    };
    const lintIssues = lintCard(lintInput, defaultLintConfig());
    lintIssues.push(...observeDocumentCard(documentId, duplicateKeySource(lintInput)));
    mergeFlags(cleanedExtraFields, lintIssues);

    if (!qaPassEnabled) delete cleanedExtraFields[QA_FLAGS_FIELD];

    const originalText = cleanedExtraFields['text'] ?? null;
    const snapshot = insertOriginalGenerationOnce(cleanedExtraFields, cleanedFront, cleanedBack, originalText);
    if (!snapshot.ok) {
      this.logger.warn(
        `[ANKI_ORIGINAL_GENERATION] 跳过任务 ${taskId} 的原始快照，不影响卡片入库: ${originalGenerationSnapshotErrorMessage(snapshot.error)}`,
      );
    }

    const images: string[] = [];
    if (images.length === 0) {
      const imageRef = occlusionImageRef(cleanedExtraFields);
      if (imageRef !== null) images.push(imageRef);
    }

    const now = nowRfc3339();
    const card: AnkiCard = {
      id: globalThis.crypto.randomUUID(),
      task_id: taskId,
      front: cleanedFront,
      back: cleanedBack,
      text: cleanedExtraFields['text'] ?? null,
      tags: cleanedTags,
      images,
      is_error_card: false,
      error_content: null,
      created_at: now,
      updated_at: now,
      extra_fields: cleanedExtraFields,
      template_id: resolvedTemplateId,
    };

    let inserted: boolean;
    try {
      inserted = insertAnkiCard(this.db, card);
    } catch (error) {
      throw new DatabaseError(`保存卡片失败: ${errorText(error)}`);
    }
    if (!inserted) {
      const preview = [...(card.text ?? card.front)].slice(0, 80).join('');
      this.logger.warn(`[DOC-LEVEL] 发现重复卡片，跳过保存: ${preview}`);
      return null;
    }
    return card;
  }

  async cancelStreaming(taskId: string): Promise<void> {
    await cancelStreaming(taskId);
  }

  async clearCancelSender(taskId: string): Promise<void> {
    await clearCancelSender(taskId);
  }

  async isStreaming(taskId: string): Promise<boolean> {
    return isStreaming(taskId);
  }

  registerCancellation(taskId: string, runSignal?: AbortSignal): AbortSignal {
    return registerCancellation(taskId, runSignal);
  }

  async createErrorCard(errorContent: string, taskId: string): Promise<AnkiCard> {
    const now = nowRfc3339();
    const card: AnkiCard = {
      id: globalThis.crypto.randomUUID(),
      task_id: taskId,
      front: '内容可能被截断或AI输出不完整',
      back: '请检查以下原始片段并手动创建或编辑卡片。',
      text: null,
      tags: ['错误', '截断'],
      images: [],
      is_error_card: true,
      error_content: errorContent,
      created_at: now,
      updated_at: now,
      extra_fields: {},
      template_id: null,
    };
    let inserted: boolean;
    try {
      inserted = insertAnkiCard(this.db, card);
    } catch (error) {
      throw new DatabaseError(`保存错误卡片失败: ${errorText(error)}`);
    }
    if (!inserted) this.logger.warn(`错误卡片已存在，跳过保存: ${card.id}`);
    return card;
  }
}
