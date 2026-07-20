import { CustomAnkiTemplate, AnkiCard } from '../types';
import {
  renderAnkiTemplate,
  type AnkiRenderOptions,
  type AnkiSpecialFields,
  type TemplateRenderResult,
} from './ankiTemplateEngine';

/** renderCard 可接受的宽松卡片形态（历史上大量调用方传入非标准卡片对象） */
export type RenderableCard = (AnkiCard | Record<string, unknown>) & {
  fields?: Record<string, unknown>;
  extra_fields?: Record<string, unknown>;
};

/** 单卡渲染的可选项（新增 API，均为可选、不影响既有行为） */
export interface RenderCardOptions {
  /** cloze 多卡序号（c1/c2...）；缺省时正面隐藏全部 cloze */
  clozeOrdinal?: number | null;
  /** {{Deck}} / {{Subdeck}} / {{Card}} / {{Type}} 等特殊字段的来源 */
  special?: Partial<AnkiSpecialFields>;
  /** [sound:...] 处理策略，默认 badge */
  soundStrategy?: AnkiRenderOptions['soundStrategy'];
}

/** 结构化的单卡渲染结果（供 UI 内联展示渲染错误） */
export interface DetailedCardRenderResult {
  front: TemplateRenderResult;
  back: TemplateRenderResult;
}

/**
 * 统一的模板渲染服务
 * 供预览、导出等功能使用
 */
export class TemplateRenderService {
  /**
   * 渲染单张卡片
   */
  static renderCard(
    card: RenderableCard,
    template: CustomAnkiTemplate
  ): { front: string; back: string } {
    const detailed = this.renderCardDetailed(card, template);
    return { front: detailed.front.html, back: detailed.back.html };
  }

  /**
   * 渲染单张卡片并返回结构化结果（含渲染问题列表，永不抛出）。
   * 新增 API：正面结果会自动注入到背面模板的 {{FrontSide}}。
   */
  static renderCardDetailed(
    card: RenderableCard,
    template: CustomAnkiTemplate,
    options: RenderCardOptions = {}
  ): DetailedCardRenderResult {
    try {
      return this.renderCardDetailedUnsafe(card, template, options);
    } catch (error: unknown) {
      // 兜底：数据准备阶段的异常也结构化返回，绝不让白屏异常穿透到 UI
      const message = error instanceof Error ? error.message : String(error);
      const failure: TemplateRenderResult = {
        html: '',
        issues: [{ code: 'render-exception', message: `卡片渲染失败：${message}` }],
        ok: false,
      };
      return { front: failure, back: { ...failure, issues: [...failure.issues] } };
    }
  }

  private static renderCardDetailedUnsafe(
    card: RenderableCard,
    template: CustomAnkiTemplate,
    options: RenderCardOptions = {}
  ): DetailedCardRenderResult {
    // 构建渲染数据
    const renderData = this.prepareRenderData(card);
    const normalizedData = this.applyTemplateFieldAliases(renderData, template);
    this.emitTemplateMismatchDebug(card, template, normalizedData);

    const special: AnkiSpecialFields = {
      tags: this.resolveTags(normalizedData),
      noteTypeName: template.note_type,
      cardName: template.name,
      ...options.special,
    };

    const front = renderAnkiTemplate(template.front_template, normalizedData, {
      side: 'front',
      clozeOrdinal: options.clozeOrdinal ?? null,
      special,
      soundStrategy: options.soundStrategy,
    });

    const back = renderAnkiTemplate(template.back_template, normalizedData, {
      side: 'back',
      frontSide: front.html,
      clozeOrdinal: options.clozeOrdinal ?? null,
      special,
      soundStrategy: options.soundStrategy,
    });

    return { front, back };
  }

  /**
   * 批量渲染卡片
   */
  static batchRender(
    cards: AnkiCard[],
    template: CustomAnkiTemplate
  ): AnkiCard[] {
    return cards.map(card => {
      const { front, back } = this.renderCard(card, template);
      return {
        ...card,
        front: front || card.front, // 保护：如果渲染失败，保留原值
        back: back || card.back,     // 保护：如果渲染失败，保留原值
        // 保留原始的 extra_fields，后端导出时需要这些数据
        extra_fields: card.extra_fields
      };
    });
  }

  private static resolveTags(renderData: Record<string, unknown>): string[] | string | undefined {
    const raw = renderData.Tags ?? renderData.tags;
    if (raw === undefined || raw === null) return undefined;
    if (Array.isArray(raw)) return raw.map(item => String(item));
    return String(raw);
  }

  /**
   * 准备渲染数据
   * 将 extra_fields 中的 JSON 字符串解析为对象
   */
  private static prepareRenderData(card: RenderableCard): Record<string, any> {
    const source = card as Record<string, any>;
    const renderData: Record<string, any> = {
      ...source,
      // 保留基础字段
      Front: source.front || '',
      Back: source.back || '',
      Tags: source.tags || [],
      Text: source.text || ''
    };

    // 字段名转换逻辑：确保所有蛇形命名(snake_case)都能正确转换为大驼峰(PascalCase)
    const toPascalCase = (str: string) => {
        const normalized = str.trim();
        const optionMatch = normalized.match(/^option([a-z])$/i);
        if (optionMatch) {
          return `Option${optionMatch[1].toUpperCase()}`;
        }
        return normalized.replace(/(^|_|\s)([a-z])/g, (_match, _separator, char) => char.toUpperCase());
    };

    // 处理 extra_fields（独立 Anki 模块使用）
    if (source.extra_fields) {
        Object.entries(source.extra_fields).forEach(([key, value]) => {
            const pascalKey = toPascalCase(key);
            try {
                // 尝试解析 JSON
                if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
                    const parsed = JSON.parse(value);
                    // 保留原始键名（例如 optiona），兼容模板里的小写占位符
                    renderData[key] = parsed;
                    renderData[pascalKey] = parsed;
                } else {
                    // 保留原始键名（例如 optiona），兼容模板里的小写占位符
                    renderData[key] = value;
                    renderData[pascalKey] = value;
                }
            } catch {
                // 解析失败，保持原值
                renderData[key] = value;
                renderData[pascalKey] = value;
            }
        });
    }

    // 🔧 处理 fields（chat-anki 管线使用）
    if (source.fields && typeof source.fields === 'object') {
        Object.entries(source.fields).forEach(([key, value]) => {
            const pascalKey = toPascalCase(key);
            // 先写入原始键名，保证模板 {{optiona}} / {{question}} 能命中
            if (!(key in renderData) || !renderData[key]) {
                renderData[key] = value;
            }
            // 只有当字段还未被设置时才添加（避免覆盖已有数据）
            if (!(pascalKey in renderData) || !renderData[pascalKey]) {
                try {
                    // 尝试解析 JSON
                    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
                        const parsed = JSON.parse(value);
                        renderData[pascalKey] = parsed;
                    } else {
                        renderData[pascalKey] = value;
                    }
                } catch {
                    // 解析失败，保持原值
                    renderData[pascalKey] = value;
                }
            }
        });
    }

    // 处理其他可能的字段格式
    Object.keys(source).forEach(key => {
        if (!['id', 'created_at', 'updated_at', 'extra_fields'].includes(key)) {
            const pascalKey = toPascalCase(key);
            // 如果字段还没有被处理，添加到渲染数据中
            if (!(pascalKey in renderData)) {
                renderData[pascalKey] = source[key];
            }
        }
    });

    // 确保大写字段名存在（模板中使用的是大写）
    if (!renderData.Tips && renderData.tips) {
      renderData.Tips = renderData.tips;
    }
    if (!renderData.CommonMistakes && renderData.commonmistakes) {
      renderData.CommonMistakes = renderData.commonmistakes;
    }

    return renderData;
  }

  private static applyTemplateFieldAliases(
    renderData: Record<string, any>,
    template: CustomAnkiTemplate,
  ): Record<string, any> {
    const next = { ...renderData };
    const templateFields = Array.isArray(template.fields) ? template.fields : [];
    const normalizedKeyMap = new Map<string, string>();
    const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

    Object.keys(next).forEach((key) => {
      const normalized = normalizeKey(key);
      if (!normalizedKeyMap.has(normalized)) {
        normalizedKeyMap.set(normalized, key);
      }
    });

    const frontValue = next.front ?? next.Front;
    const backValue = next.back ?? next.Back;

    for (const field of templateFields) {
      if (!field) continue;
      const lower = field.toLowerCase();
      const normalizedField = normalizeKey(field);
      const canonical = next[field];
      const lowerValue = next[lower];
      const hasCanonical =
        canonical !== undefined && canonical !== null && String(canonical).trim() !== '';
      const hasLower =
        lowerValue !== undefined && lowerValue !== null && String(lowerValue).trim() !== '';
      if (!hasCanonical && hasLower) {
        // Mustache placeholders are case-sensitive; copy lowercase key to canonical field key.
        next[field] = lowerValue;
        continue;
      }
      if (!hasCanonical) {
        const sourceKey = normalizedKeyMap.get(normalizedField);
        if (sourceKey && sourceKey in next) {
          next[field] = next[sourceKey];
          next[lower] = next[sourceKey];
          continue;
        }
      }
      if (hasCanonical) continue;

      if ((lower === 'question' || lower === 'word' || lower === 'name') && frontValue) {
        next[field] = frontValue;
        next[lower] = frontValue;
      } else if (
        ['back', 'explanation', 'definition', 'desc', 'expl', 'backdetail', 'answer'].includes(lower) &&
        backValue
      ) {
        next[field] = backValue;
        next[lower] = backValue;
      }
    }

    return next;
  }

  private static emitTemplateMismatchDebug(
    card: RenderableCard,
    template: CustomAnkiTemplate,
    renderData: Record<string, any>,
  ): void {
    const requiredFields = Object.entries(template.field_extraction_rules ?? {})
      .filter(([, rule]) => Boolean(rule?.is_required))
      .map(([key]) => key);

    if (requiredFields.length === 0) return;

    const missing = requiredFields.filter((field) => {
      const lower = field.toLowerCase();
      const value = renderData[field] ?? renderData[lower];
      if (value === undefined || value === null) return true;
      if (typeof value === 'string') return value.trim().length === 0;
      if (Array.isArray(value)) return value.length === 0;
      return false;
    });

    if (missing.length === 0) return;

    try {
      const cardId = typeof (card as Record<string, unknown>).id === 'string'
        ? (card as Record<string, string>).id
        : '?';
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
        detail: {
          level: 'warn',
          phase: 'render:stack',
          summary: `template data missing required=${missing.join(',')} card=${cardId.slice(0, 8)} template=${template.id}`,
          detail: {
            cardId: cardId === '?' ? null : cardId,
            templateId: template.id,
            templateName: template.name,
            missingRequiredFields: missing,
            availableKeys: Object.keys(renderData).slice(0, 40),
          },
        },
      }));
    } catch {
      // debug only
    }
  }

  /**
   * 预渲染卡片用于导出
   * 返回渲染后的卡片，保留原始数据用于调试
   */
  static prerenderForExport(
    card: AnkiCard,
    _template: CustomAnkiTemplate
  ): AnkiCard {
    // 统一策略：导出阶段不做整卡HTML预渲染，避免与后端模板二次套壳
    // 保持 card.fields / extra_fields 以供后端按模板字段渲染
    return card;
  }

  /**
   * 检查卡片是否需要预渲染
   * 如果卡片有 extra_fields 且使用了复杂模板，则需要预渲染
   */
  static needsPrerender(_card: AnkiCard, _template?: CustomAnkiTemplate): boolean {
    // 统一策略：导出阶段一律不做前端预渲染
    return false;
  }
}
