/**
 * CardForge 2.0 - CardAgent 统一入口
 *
 * 制卡系统的唯一入口，提供 MCP 工具兼容的接口。
 * 遵循 LLM-First 设计原则，无状态设计。
 *
 * 注意：ChatAnki 通过 ChatV2AnkiAdapter 使用此引擎的导出/模板/分析/任务控制能力。
 * 独立制卡页面（AnkiCardGeneration）已废弃，但此引擎仍为活跃组件。
 *
 * LLM-First 核心原则：
 * - 所有"理解"和"决策"工作交给 LLM
 * - 多模板自动选择由 LLM 决定
 * - 内容分析由 LLM 执行
 * - 前端只做数据搬运和状态管理
 */

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import i18next from 'i18next';
import { templateManager } from '@/data/ankiTemplates';
import { ankiApiAdapter } from '@/services/ankiApiAdapter';
import { fileManager } from '@/utils/fileManager';
import { SegmentEngine } from './SegmentEngine';
import {
  buildContentAnalysisPrompt,
  buildCardGenerationSystemPrompt,
  buildCardGenerationUserPrompt,
} from '../prompts';
import { normalizeToolExportCards } from './exportNormalize';
import type {
  GenerateCardsInput,
  GenerateCardsOutput,
  ControlTaskInput,
  ControlTaskOutput,
  ExportCardsInput,
  ExportCardsOutput,
  ListTemplatesInput,
  ListTemplatesOutput,
  AnalyzeContentInput,
  AnalyzeContentOutput,
  AnkiCardResult,
  TaskInfo,
  TemplateInfo,
  GenerationStats,
  CardForgeEvent,
  CardForgeEventListener,
  TaskStatus,
} from '../types';

// ============================================================================
// 类型定义 - 后端数据结构
// ============================================================================

interface BackendAnkiCard {
  id: string;
  task_id: string;
  front: string;
  back: string;
  text?: string;
  tags: string[];
  images: string[];
  is_error_card: boolean;
  error_content?: string;
  created_at: string;
  updated_at: string;
  extra_fields?: Record<string, string>;
  template_id?: string;
}

interface BackendDocumentTask {
  id: string;
  document_id: string;
  segment_index: number;
  status: string;
  error_message?: string;
}

interface BackendStreamedCardPayload {
  NewCard?: BackendAnkiCard | { card: BackendAnkiCard; document_id?: string };
  NewErrorCard?: BackendAnkiCard | { card: BackendAnkiCard; document_id?: string };
  TaskStatusUpdate?: {
    task_id: string;
    status: string;
    message?: string;
    segment_index?: number;
    document_id?: string;
  };
  TaskCompleted?: {
    task_id: string;
    final_status: string;
    total_cards_generated: number;
    document_id?: string;
  };
  // ★ 2026-01 修复：添加 TaskProcessingError 类型定义
  TaskProcessingError?: {
    task_id: string;
    error_message: string;
    document_id?: string;
  };
  DocumentProcessingStarted?: {
    document_id: string;
    total_segments: number;
  };
  DocumentProcessingCompleted?: {
    document_id: string;
  };
  DocumentProcessingPaused?: {
    document_id: string;
  };
}

/** 字段提取规则类型 */
interface FieldExtractionRule {
  field_type: string;
  is_required: boolean;
  description?: string;
  default_value?: string;
}

interface BackendGenerationOptions {
  deck_name: string;
  note_type: string;
  enable_images: boolean;
  max_cards_per_mistake: number;
  /** @deprecated 使用 template_ids 替代，支持 LLM 多模板自选 */
  template_id?: string;
  /** LLM-First: 传递所有可用模板，由 LLM 自动选择最合适的模板 */
  template_ids?: string[];
  /** 模板详情，供 LLM 理解各模板用途 */
  template_descriptions?: Array<{ id: string; name: string; description: string; fields: string[]; generation_prompt?: string }>;
  custom_requirements?: string;
  segment_overlap_size: number;
  /** 是否启用 LLM 智能分段边界检测 */
  enable_llm_boundary_detection?: boolean;
  /** 字段提取规则 - 必须传递，用于后端解析AI生成的JSON */
  field_extraction_rules?: Record<string, FieldExtractionRule>;
  /** 多模板：按模板ID分组的字段列表 */
  template_fields_by_id?: Record<string, string[]>;
  /** 多模板：按模板ID分组的字段提取规则 */
  field_extraction_rules_by_id?: Record<string, Record<string, FieldExtractionRule>>;
}

const resolveExportTemplateId = (cards: AnkiCardResult[]): string | undefined => {
  const ids = new Set(
    cards
      .map(card => (typeof card.templateId === 'string' ? card.templateId.trim() : ''))
      .filter(Boolean),
  );
  return ids.size === 1 ? Array.from(ids)[0] : undefined;
};

const buildBackendExportCards = (cards: AnkiCardResult[]): BackendAnkiCard[] => {
  const now = new Date().toISOString();

  return cards.map((card, index) => {
    const rawFields = card.fields ?? {};
    const front = card.front ?? rawFields.Front ?? '';
    const back = card.back ?? rawFields.Back ?? '';
    const text = card.text ?? rawFields.Text;
    const extraFields: Record<string, string> = {
      ...rawFields,
    };

    if (!extraFields.Front) extraFields.Front = front;
    if (!extraFields.Back) extraFields.Back = back;
    if (text && !extraFields.Text) extraFields.Text = text;

    return {
      id: card.id && card.id.trim() ? card.id : `temp-${index}`,
      task_id: card.taskId && card.taskId.trim() ? card.taskId : 'cardforge',
      front,
      back,
      text,
      tags: Array.isArray(card.tags) ? card.tags : [],
      images: Array.isArray(card.images) ? card.images : [],
      is_error_card: card.isErrorCard ?? false,
      error_content: card.errorContent ?? undefined,
      created_at: card.createdAt && card.createdAt.trim() ? card.createdAt : now,
      updated_at: now,
      extra_fields: extraFields,
      template_id: card.templateId ?? undefined,
    };
  });
};

// ============================================================================
// CardAgent 类
// ============================================================================

/**
 * CardAgent - 制卡系统的统一入口
 *
 * 提供 MCP 工具兼容的接口，所有方法都是无状态的。
 * 状态由后端管理，前端只负责调用和监听事件。
 */
// Chat V2 工具调用事件载荷（来自后端 AnkiToolExecutor）
interface ChatV2ToolCallPayload {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  messageId: string;
  blockId: string;
  /** 🆕 2026-01: 会话 ID，用于回调时创建 anki_cards 块 */
  sessionId: string;
}

export class CardAgent {
  private eventListeners: Map<string, Set<CardForgeEventListener>> = new Map();
  private unlistenFn: UnlistenFn | null = null;
  private toolCallUnlistenFn: UnlistenFn | null = null;
  private cachedWindowLabel?: string | null;
  /** 初始化状态 */
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _initError: Error | null = null;

  constructor() {
    // 启动异步初始化（不阻塞构造函数）
    this._initPromise = this.init();
  }

  /**
   * 初始化方法
   * 设置事件监听，错误会被捕获并记录
   */
  private async init(): Promise<void> {
    try {
      await Promise.all([
        this.setupEventListener(),
        this.setupToolCallListener(),
      ]);
      this._initialized = true;
      console.log('[CardAgent] 初始化成功');
    } catch (error: unknown) {
      this._initError = error instanceof Error ? error : new Error(String(error));
      console.error('[CardAgent] 初始化失败:', this._initError);
      // 不抛出错误，让 CardAgent 仍可部分工作
    }
  }

  /**
   * 等待初始化完成
   * 可在关键操作前调用，确保事件监听已设置
   */
  async waitForReady(): Promise<boolean> {
    if (this._initPromise) {
      await this._initPromise;
    }
    return this._initialized && !this._initError;
  }

  /**
   * 检查是否已初始化
   */
  get isReady(): boolean {
    return this._initialized && !this._initError;
  }

  /**
   * 获取初始化错误（如果有）
   */
  get initError(): Error | null {
    return this._initError;
  }

  // ==========================================================================
  // MCP 工具方法
  // ==========================================================================

  /**
   * generate_cards - 核心制卡工具
   *
   * 根据学习材料自动生成 Anki 记忆卡片。
   * 支持超大文档（自动分段），支持多模板自动选择。
   */
  async generateCards(input: GenerateCardsInput): Promise<GenerateCardsOutput> {
    const startTime = Date.now();

    try {
      // 🔧 P0 修复 #1: 初始化失败时必须阻止继续执行
      // 原问题：初始化失败后仍继续执行，可能导致事件监听器未注册，卡片数据丢失
      const isReady = await this.waitForReady();
      if (!isReady || this._initError) {
        console.error('[CardAgent] 初始化失败，无法执行生成任务:', this._initError?.message);
        return {
          ok: false,
          error: `CardAgent 初始化失败: ${this._initError?.message || '事件监听器未就绪'}`,
        };
      }

      // 验证输入
      if (!input.content || input.content.trim().length === 0) {
        return {
          ok: false,
          error: '内容不能为空',
        };
      }

      // 获取可用模板
      const templates = (await this.getAvailableTemplates(input.templates)).map((t) => {
        const fields = this.normalizeTemplateFields(t.fields);
        return {
          ...t,
          fields,
          field_extraction_rules: this.ensureFieldExtractionRules(fields, t.field_extraction_rules),
        };
      });
      if (templates.length === 0) {
        return {
          ok: false,
          error: '没有可用的模板',
        };
      }

      // LLM-First: 准备模板详情，供后端 LLM 智能选择
      const templateDescriptions = templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description || t.useCaseDescription || '',
        fields: t.fields || [],
        // 🔧 修复：传递 generation_prompt，确保 LLM 知道如何构造模板特定字段
        generation_prompt: t.generation_prompt || undefined,
      }));

      // G4: 使用 PromptKit 构建系统 prompt 和用户 prompt
      // 注意：userPrompt 使用占位符标记内容位置，实际内容由后端填充
      const systemPrompt = buildCardGenerationSystemPrompt();
      const userPrompt = buildCardGenerationUserPrompt(
        '{{DOCUMENT_CONTENT}}', // 占位符，后端会用实际内容替换
        templates,
        undefined, // 分段信息由后端管理
        {
          maxCards: input.maxCards,
          customRequirements: input.options?.customRequirements,
          preferredTemplates: input.templates,
        }
      );

      // 构建后端生成选项 - 传递所有模板让 LLM 自选
      const templateFieldMap = templates.reduce((acc, t) => {
        acc[t.id] = this.normalizeTemplateFields(t.fields);
        return acc;
      }, {} as Record<string, string[]>);

      const templateRulesMap = templates.reduce((acc, t) => {
        acc[t.id] = this.ensureFieldExtractionRules(
          templateFieldMap[t.id] ?? this.normalizeTemplateFields(t.fields),
          t.field_extraction_rules
        );
        return acc;
      }, {} as Record<string, Record<string, FieldExtractionRule>>);

      const isMultiTemplate = templates.length > 1;
      const defaultTemplateId = templates[0]?.id;
      const backendOptions: BackendGenerationOptions & {
        system_prompt?: string;
        custom_anki_prompt?: string;
        template_fields?: string[];
      } = {
        deck_name: input.options?.deckName || 'Default',
        note_type: 'Basic',
        enable_images: true,
        max_cards_per_mistake: input.maxCards || 50,
        // LLM-First: 传递所有模板 ID，由后端 LLM 自动选择最合适的
        template_ids: templates.map((t) => t.id),
        template_descriptions: templateDescriptions,
        // 保留 template_id 作为回退（兼容性）
        template_id: templates[0]?.id,
        custom_requirements: input.options?.customRequirements,
        segment_overlap_size: 200,
        // 启用 LLM 智能分段边界检测
        enable_llm_boundary_detection: true,
        // G4: 使用 PromptKit 制卡模板
        system_prompt: systemPrompt,
        custom_anki_prompt: userPrompt,
        // 单模板时传递字段定义（多模板时使用按模板分组的映射）
        template_fields: !isMultiTemplate && defaultTemplateId
          ? templateFieldMap[defaultTemplateId]
          : undefined,
        // 单模板时传递字段提取规则（多模板时使用按模板分组的映射）
        field_extraction_rules: !isMultiTemplate && defaultTemplateId
          ? templateRulesMap[defaultTemplateId]
          : undefined,
        // 多模板：按模板ID分组的字段与规则
        template_fields_by_id: templateFieldMap,
        field_extraction_rules_by_id: templateRulesMap,
      };

      // 🔧 P0 修复：先设置事件监听，再调用后端，防止竞态条件丢失事件
      // 创建卡片收集器，在调用后端之前就开始监听
      const cardCollector = this.createCardCollector();

      try {
        // 🔧 CardForge 2.0 修复：使用流式命令 start_enhanced_document_processing
        // 旧版 generate_anki_cards_from_document 是同步 API，不发射事件，导致前端永久等待
        // 新版使用 EnhancedAnkiService，支持流式事件发射
        // 注意：Tauri 默认使用 camelCase 参数名
        const documentId = await invoke<string>('start_enhanced_document_processing', {
          documentContent: input.content,
          originalDocumentName: input.options?.deckName || 'Default',
          options: backendOptions,
        });
        cardCollector.setDocumentId(documentId);

        // 等待生成完成并收集卡片（使用已经在监听的收集器）
        const { cards, paused } = await cardCollector.waitForComplete();

        // 计算统计信息
        const stats: GenerationStats = {
          totalCards: cards.length,
          segments: await this.getSegmentCount(documentId),
          templatesUsed: [...new Set(cards.map((c) => c.templateId).filter(Boolean))],
          durationMs: Date.now() - startTime,
          successCount: cards.filter((c) => !c.isErrorCard).length,
          failedCount: cards.filter((c) => c.isErrorCard).length,
        };

        return {
          ok: true,
          documentId,
          cards,
          stats,
          paused,
        };
      } catch (innerError: unknown) {
        // 🔧 二轮修复 #7: 确保 cardCollector 在错误时被清理，防止资源泄漏
        cardCollector.cancel();
        throw innerError;
      }
    } catch (error: unknown) {
      console.error('[CardAgent] generateCards error:', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * control_task - 任务控制工具
   *
   * 控制 Anki 卡片生成任务的执行。
   * 支持暂停、恢复、重试和取消操作。
   */
  async controlTask(input: ControlTaskInput): Promise<ControlTaskOutput> {
    try {
      switch (input.action) {
        case 'pause':
          await invoke('pause_document_processing', { documentId: input.documentId });
          return {
            ok: true,
            message: '已暂停文档处理',
          };

        case 'resume':
          await invoke('resume_document_processing', { documentId: input.documentId });
          const tasks = await this.getTaskStatus(input.documentId);
          return {
            ok: true,
            message: '已恢复文档处理',
            tasks,
          };

        case 'retry':
          if (!input.taskId) {
            return {
              ok: false,
              message: '重试操作需要提供 taskId',
            };
          }
          await invoke('trigger_task_processing', {
            taskId: input.taskId,
          });
          return {
            ok: true,
            message: '已触发任务重试',
          };

        case 'cancel':
          await invoke('delete_document_session', { documentId: input.documentId });
          return {
            ok: true,
            message: '已取消文档处理',
          };

        default:
          return {
            ok: false,
            message: `未知操作: ${input.action}`,
          };
      }
    } catch (error: unknown) {
      console.error('[CardAgent] controlTask error:', error);
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * export_cards - 导出卡片工具
   *
   * 将卡片导出为指定格式。
   * 支持 APKG 文件、AnkiConnect 同步、JSON 导出。
   */
  async exportCards(input: ExportCardsInput): Promise<ExportCardsOutput> {
    try {
      if (!input.cards || input.cards.length === 0) {
        return {
          ok: false,
          error: '没有可导出的卡片',
        };
      }

      switch (input.format) {
        case 'apkg': {
          // 转换卡片格式
          const cardsForExport = input.cards.map((card) => ({
            id: card.id,
            front: card.front,
            back: card.back,
            text: card.text,
            tags: card.tags,
            images: card.images,
            fields: card.fields,
            extra_fields: card.fields,
          }));
          const templateId = resolveExportTemplateId(input.cards);

          const filePath = await ankiApiAdapter.batchExportCards({
            cards: cardsForExport as any,
            format: 'apkg',
            options: {
              deckName: input.deckName,
              noteType: input.noteType || 'Basic',
              templateId,
            },
          });

          return {
            ok: true,
            filePath,
          };
        }

        case 'anki_connect': {
          // 使用 AnkiConnect API 导入卡片
          // 后端命令: add_cards_to_anki_connect(selected_cards, deck_name, note_type)
          const selectedCards = input.cards.map((card) => ({
            id: card.id ?? '',
            task_id: card.taskId ?? '',
            front: card.front ?? card.fields?.Front ?? '',
            back: card.back ?? card.fields?.Back ?? '',
            text: card.text ?? null,
            tags: card.tags ?? [],
            images: card.images ?? [],
            is_error_card: card.isErrorCard ?? false,
            error_content: card.errorContent ?? null,
            created_at: card.createdAt ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
            extra_fields: card.fields ?? {},
            template_id: card.templateId ?? null,
          }));

          try {
            const noteType = input.noteType || 'Basic';
            const noteIds = await invoke<(number | null)[]>('add_cards_to_anki_connect', {
              selected_cards: selectedCards,
              selectedCards,
              deck_name: input.deckName,
              deckName: input.deckName,
              note_type: noteType,
              noteType,
            });

            const importedCount = noteIds.filter(id => id !== null).length;
            return {
              ok: importedCount > 0,
              importedCount,
            };
          } catch (importError: unknown) {
            console.warn('[CardAgent] AnkiConnect import failed:', importError);
            return {
              ok: false,
              importedCount: 0,
              error: importError instanceof Error ? importError.message : 'AnkiConnect导入失败',
            };
          }
        }

        case 'json': {
          const exportCards = buildBackendExportCards(input.cards);
          const jsonData = JSON.stringify(exportCards, null, 2);
          const suggestedName = `anki_cards_${Date.now()}.json`;
          const saveResult = await fileManager.saveTextFile({
            content: jsonData,
            defaultFileName: suggestedName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
          if (saveResult.canceled) {
            return {
              ok: false,
              error: i18next.t('anki:operation_cancelled'),
            };
          }
          return {
            ok: true,
            filePath: saveResult.path,
          };
        }

        default:
          return {
            ok: false,
            error: `不支持的导出格式: ${input.format}`,
          };
      }
    } catch (error: unknown) {
      console.error('[CardAgent] exportCards error:', error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * list_templates - 获取可用模板
   *
   * 获取可用的 Anki 卡片模板列表。
   * 可按类别筛选。
   */
  async listTemplates(input: ListTemplatesInput = {}): Promise<ListTemplatesOutput> {
    try {
      await templateManager.loadTemplates();

      let templates = input.activeOnly !== false
        ? templateManager.getActiveTemplates()
        : templateManager.getAllTemplates();

      // 按类别筛选（CustomAnkiTemplate 可能没有 category 字段）
      const query = input.category?.trim().toLowerCase();
      if (query) {
        templates = templates.filter((t) => {
          const hay = `${t.id} ${t.name}\n${t.description || ''}`.toLowerCase();
          return hay.includes(query) || (t.note_type || '').toLowerCase().includes(query);
        });
      }

      // 转换为 TemplateInfo 格式
      // 🔧 P0 修复：必须包含 field_extraction_rules，用于后端解析AI生成的JSON
      const templateInfos: TemplateInfo[] = templates.map((t) => {
        const fields = this.normalizeTemplateFields(t.fields);
        return {
        id: t.id,
        name: t.name,
        description: t.description || '',
        category: (t as any).category || 'general',
          fields,
        noteType: t.note_type || 'Basic',
        isActive: t.is_active !== false,
        complexityLevel: this.calculateComplexityLevel(t),
        useCaseDescription: t.description || t.name,
        // 🔧 P0 修复：传递字段提取规则
          field_extraction_rules: this.ensureFieldExtractionRules(fields, t.field_extraction_rules),
        // 🔧 P1 修复：传递生成提示词，指导 LLM 如何构造模板特定字段
        generation_prompt: t.generation_prompt,
        };
      });

      return {
        templates: templateInfos,
      };
    } catch (error: unknown) {
      console.error('[CardAgent] listTemplates error:', error);
      return {
        templates: [],
      };
    }
  }

  /**
   * analyze_content - 内容预分析 (LLM-First)
   *
   * 预分析学习材料，估算可生成的卡片数量，推荐合适的模板。
   * 不实际生成卡片，用于用户确认前的预览。
   *
   * LLM-First: 使用 LLM 进行内容分析和模板推荐，而不是规则匹配。
   * 集成 SegmentEngine 进行准确的分段估算。
   */
  async analyzeContent(input: AnalyzeContentInput): Promise<AnalyzeContentOutput> {
    try {
      const content = input.content;

      // 获取可用模板
      const { templates } = await this.listTemplates({ activeOnly: true });

      // 使用 SegmentEngine 进行准确的分段估算
      let estimatedSegments: number;
      try {
        const segmentEngine = new SegmentEngine();
        // 快速估算分段（不启用 LLM 定界，仅硬分割）
        const segments = await segmentEngine.segment(content, {
          enableLLMBoundary: false,
        });
        estimatedSegments = segments.length;
      } catch (segmentError: unknown) {
        console.warn('[CardAgent] SegmentEngine failed, falling back to estimation:', segmentError);
        // Fallback: 简单估算
        const estimatedTokens = this.estimateTokens(content);
        const CHUNK_SIZE = 50000;
        estimatedSegments = Math.max(1, Math.ceil(estimatedTokens / CHUNK_SIZE));
      }

      // LLM-First: 使用 LLM 进行智能内容分析
      try {
        const analysisPrompt = buildContentAnalysisPrompt(content, templates);

        // 调用后端 LLM（复用 call_llm_for_boundary 作为通用 LLM 接口）
        const llmResult = await invoke<{
          assistant_message: string;
          input_tokens: number;
          output_tokens: number;
        }>('call_llm_for_boundary', { prompt: analysisPrompt });

        // 解析 LLM 返回的 JSON
        interface LLMAnalysisResult {
          estimated_cards?: number;
          suggested_templates?: Array<{
            template_id: string;
            reason: string;
            estimated_usage: number;
          }>;
          content_types?: string[];
        }

        const analysisJson = this.extractJsonFromLLMResponse(llmResult.assistant_message) as LLMAnalysisResult | null;
        if (analysisJson) {
          console.log('[CardAgent] LLM content analysis success:', analysisJson);

          return {
            estimatedSegments,
            estimatedCards: analysisJson.estimated_cards ?? estimatedSegments * 4,
            suggestedTemplates: (analysisJson.suggested_templates ?? []).map((t) => ({
              templateId: t.template_id,
              reason: t.reason,
              estimatedUsage: t.estimated_usage,
            })),
            contentTypes: analysisJson.content_types ?? ['text'],
          };
        }
      } catch (llmError: unknown) {
        console.warn('[CardAgent] LLM analysis failed, falling back to rule-based:', llmError);
      }

      // LLM-First Fallback: 当 LLM 不可用时，返回保守的默认结果
      // 注意：不使用规则匹配，因为这违反 LLM-First 原则
      // 用户应该知道这是一个估算值，而不是智能分析结果
      const cardsPerSegment = 4;
      const estimatedCards = estimatedSegments * cardsPerSegment;

      // 返回所有模板作为建议，不做预判（交给用户或后端 LLM 决定）
      const defaultSuggestions = templates.slice(0, 5).map((t) => ({
        templateId: t.id,
        reason: 'LLM 分析不可用，建议根据内容手动选择',
        estimatedUsage: 20, // 均匀分布
      }));

      return {
        estimatedSegments,
        estimatedCards,
        suggestedTemplates: defaultSuggestions,
        contentTypes: ['unknown'], // 明确标识未能分析
      };
    } catch (error: unknown) {
      console.error('[CardAgent] analyzeContent error:', error);
      return {
        estimatedSegments: 1,
        estimatedCards: 5,
        suggestedTemplates: [],
        contentTypes: ['text'],
      };
    }
  }

  /**
   * 从 LLM 响应中提取 JSON
   */
  private extractJsonFromLLMResponse(response: string): Record<string, unknown> | null {
    try {
      // 尝试直接解析
      return JSON.parse(response.trim());
    } catch {
      // 尝试从 markdown 代码块中提取
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1].trim());
        } catch {
          // 继续尝试其他方式
        }
      }

      // 尝试找到 JSON 对象
      const jsonObjectMatch = response.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        try {
          return JSON.parse(jsonObjectMatch[0]);
        } catch {
          return null;
        }
      }

      return null;
    }
  }

  // ==========================================================================
  // 事件系统
  // ==========================================================================

  /**
   * 订阅事件
   */
  on<T = unknown>(eventType: string, listener: CardForgeEventListener<T>): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType)!.add(listener as CardForgeEventListener);

    // 返回取消订阅函数
    return () => {
      this.eventListeners.get(eventType)?.delete(listener as CardForgeEventListener);
    };
  }

  /**
   * 设置后端事件监听
   * 🔧 P0 修复 #3: 失败时必须抛出错误，让 init() 捕获
   */
  private async setupEventListener(): Promise<void> {
    if (this.unlistenFn) return;

    try {
      this.unlistenFn = await listen<BackendStreamedCardPayload>(
        'anki_generation_event',
        (event) => {
          this.handleBackendEvent(event.payload);
        }
      );
      console.log('[CardAgent] anki_generation_event 事件监听器设置成功');
    } catch (error: unknown) {
      console.error('[CardAgent] Failed to setup event listener:', error);
      // 🔧 P0 修复: 必须重新抛出错误，否则 init() 无法捕获，_initError 不会被设置
      throw error;
    }
  }

  /**
   * 设置 Chat V2 工具调用监听（CardForge 2.0）
   *
   * 监听后端 AnkiToolExecutor 发出的 `anki_tool_call` 事件，
   * 将工具调用路由到相应的 CardAgent 方法执行。
   * 🔧 P0 修复 #3: 失败时必须抛出错误
   */
  private async setupToolCallListener(): Promise<void> {
    if (this.toolCallUnlistenFn) return;

    try {
      this.toolCallUnlistenFn = await listen<ChatV2ToolCallPayload>(
        'anki_tool_call',
        async (event) => {
          await this.handleToolCall(event.payload);
        }
      );
      console.log('[CardAgent] Chat V2 tool call listener setup complete');
    } catch (error: unknown) {
      console.error('[CardAgent] Failed to setup tool call listener:', error);
      // 🔧 P0 修复: 必须重新抛出错误
      throw error;
    }
  }

  /**
   * 处理 Chat V2 工具调用
   *
   * 将后端桥接过来的工具调用路由到对应方法。
   * 🔧 P2 增强：添加输入验证，防止类型不匹配导致的运行时错误
   */
  private async handleToolCall(payload: ChatV2ToolCallPayload): Promise<void> {
    const { toolCallId, toolName, arguments: args, messageId, blockId, sessionId } = payload;

    console.log(`[CardAgent] Handling tool call: ${toolName} (id: ${toolCallId}, session: ${sessionId})`);

    try {
      let result: unknown;

      // 工具名标准化：builtin-anki_generate_cards -> anki_generate_cards
      const normalizedName = toolName.startsWith('builtin-')
        ? toolName.replace('builtin-', '')
        : toolName;

      switch (normalizedName) {
        case 'anki_generate_cards': {
          // 验证必需参数
          if (typeof args.content !== 'string' || !args.content.trim()) {
            result = { ok: false, error: 'content 参数是必需的且不能为空' };
            break;
          }
          const generateResult = await this.generateCards({
            content: args.content,
            templates: Array.isArray(args.templates) ? args.templates : undefined,
            maxCards: typeof args.maxCards === 'number' ? args.maxCards : undefined,
            options: {
              deckName: typeof args.deckName === 'string' ? args.deckName : undefined,
              customRequirements: typeof args.customRequirements === 'string' ? args.customRequirements : undefined,
            },
          });
          result = generateResult;

          // 🆕 2026-01: 将卡片结果回调到后端，创建 anki_cards 块显示在聊天中
          if (sessionId && messageId) {
            try {
              const cards = generateResult.cards || [];
              await invoke('chat_v2_anki_cards_result', {
                request: {
                  sessionId,
                  messageId,
                  toolBlockId: blockId,
                  cards: cards.map(card => ({
                    id: card.id,
                    front: card.front,
                    back: card.back,
                    text: card.text,
                    tags: card.tags,
                    templateId: card.templateId,
                    isErrorCard: card.isErrorCard,
                    createdAt: card.createdAt,
                  })),
                  documentId: generateResult.documentId,
                  templateId: cards[0]?.templateId,
                  success: generateResult.ok,
                  error: generateResult.error,
                },
              });
              console.log(`[CardAgent] Anki cards result sent to backend: ${cards.length} cards`);
            } catch (callbackError: unknown) {
              console.error('[CardAgent] Failed to send anki cards result to backend:', callbackError);
              // 不影响主流程，继续执行
            }
          }
          break;
        }

        case 'anki_control_task': {
          // 验证必需参数
          const validActions = ['pause', 'resume', 'retry', 'cancel'];
          if (typeof args.action !== 'string' || !validActions.includes(args.action)) {
            result = { ok: false, error: `action 必须是 ${validActions.join('/')} 之一` };
            break;
          }
          if (typeof args.documentId !== 'string' || !args.documentId.trim()) {
            result = { ok: false, error: 'documentId 参数是必需的' };
            break;
          }
          result = await this.controlTask({
            action: args.action as 'pause' | 'resume' | 'retry' | 'cancel',
            documentId: args.documentId,
            taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          });
          break;
        }

        case 'anki_export_cards': {
          // 验证必需参数
          const hasDocumentId =
            typeof args.documentId === 'string' && args.documentId.trim().length > 0;
          if (!Array.isArray(args.cards) || args.cards.length === 0) {
            result = hasDocumentId
              ? {
                  ok: false,
                  error:
                    'anki_export_cards 需要 cards 列表；检测到 documentId，请改用 chatanki_export。',
                }
              : { ok: false, error: 'cards 必须是非空数组' };
            break;
          }
          const validFormats = ['apkg', 'anki_connect', 'json'];
          if (typeof args.format !== 'string' || !validFormats.includes(args.format)) {
            result = { ok: false, error: `format 必须是 ${validFormats.join('/')} 之一` };
            break;
          }
          if (typeof args.deckName !== 'string' || !args.deckName.trim()) {
            result = { ok: false, error: 'deckName 参数是必需的' };
            break;
          }
          // Normalize legacy minimal cards while preserving full CardForge payload when present.
          result = await this.exportCards({
            cards: normalizeToolExportCards(args.cards),
            format: args.format as 'apkg' | 'anki_connect' | 'json',
            deckName: args.deckName,
            noteType: typeof args.noteType === 'string' ? args.noteType : undefined,
          });
          break;
        }

        case 'anki_list_templates':
          result = await this.listTemplates({
            category: typeof args.category === 'string' ? args.category : undefined,
            activeOnly: typeof args.activeOnly === 'boolean' ? args.activeOnly : undefined,
          });
          break;

        case 'anki_analyze_content': {
          // 验证必需参数
          if (typeof args.content !== 'string' || !args.content.trim()) {
            result = { ok: false, error: 'content 参数是必需的且不能为空' };
            break;
          }
          result = await this.analyzeContent({
            content: args.content,
          });
          break;
        }

        default:
          console.warn(`[CardAgent] Unknown Anki tool: ${toolName}`);
          result = { ok: false, error: `Unknown tool: ${toolName}` };
      }

      // 发送工具执行结果事件到后端（可选：用于 UI 更新）
      this.emit('tool:result', {
        toolCallId,
        toolName,
        messageId,
        blockId,
        result,
      });

      const normalizedOk = !(
        result &&
        typeof result === 'object' &&
        (('ok' in result && (result as { ok?: boolean }).ok === false) ||
          ('success' in result && (result as { success?: boolean }).success === false) ||
          ('status' in result &&
            typeof (result as { status?: string }).status === 'string' &&
            ['error', 'failed'].includes((result as { status?: string }).status!)))
      );
      const normalizedError = !normalizedOk &&
        result &&
        typeof result === 'object' &&
        'error' in result &&
        typeof (result as { error?: string }).error === 'string'
        ? (result as { error?: string }).error
        : undefined;
      const windowLabel = await this.getWindowLabel();

      // 回传执行结果给后端（用于工具调用真实完成确认）
      void emit(`anki_tool_result:${toolCallId}`, {
        toolCallId,
        toolName,
        messageId,
        blockId,
        ok: normalizedOk,
        result,
        error: normalizedError,
        windowLabel: windowLabel ?? undefined,
      });

      console.log(`[CardAgent] Tool ${toolName} completed`, result);
    } catch (error: unknown) {
      console.error(`[CardAgent] Tool ${toolName} failed:`, error);

      this.emit('tool:error', {
        toolCallId,
        toolName,
        messageId,
        blockId,
        error: error instanceof Error ? error.message : String(error),
      });

      const windowLabel = await this.getWindowLabel();
      void emit(`anki_tool_result:${toolCallId}`, {
        toolCallId,
        toolName,
        messageId,
        blockId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        windowLabel: windowLabel ?? undefined,
      });
    }
  }

  /**
   * 处理后端事件
   * 🔧 P1 修复 #6: 添加事件有效性验证
   */
  private handleBackendEvent(payload: BackendStreamedCardPayload): void {
    if (payload.NewCard) {
      // 🔧 P1 修复: 验证卡片数据有效性
      const newCardPayload = payload.NewCard;
      const resolved = newCardPayload &&
        typeof newCardPayload === 'object' &&
        'card' in newCardPayload
        ? {
            card: (newCardPayload as { card: BackendAnkiCard; document_id?: string }).card,
            documentId: (newCardPayload as { document_id?: string }).document_id,
          }
        : {
            card: newCardPayload as BackendAnkiCard,
            documentId: undefined,
          };
      if (!this.isValidBackendCard(resolved.card)) {
        console.error('[CardAgent] 收到无效的 NewCard 数据:', newCardPayload);
        return;
      }
      const card = this.convertBackendCard(resolved.card);
      this.emit('card:generated', {
        card,
        taskId: card.taskId,
        segmentIndex: 0,
      }, resolved.documentId);
    }

    if (payload.NewErrorCard) {
      // 🔧 P1 修复: 验证错误卡片数据
      const errorCardPayload = payload.NewErrorCard;
      const resolved = errorCardPayload &&
        typeof errorCardPayload === 'object' &&
        'card' in errorCardPayload
        ? {
            card: (errorCardPayload as { card: BackendAnkiCard; document_id?: string }).card,
            documentId: (errorCardPayload as { document_id?: string }).document_id,
          }
        : {
            card: errorCardPayload as BackendAnkiCard,
            documentId: undefined,
          };
      if (!this.isValidBackendCard(resolved.card)) {
        console.error('[CardAgent] 收到无效的 NewErrorCard 数据:', errorCardPayload);
        return;
      }
      const card = this.convertBackendCard(resolved.card);
      this.emit('card:error', {
        card,
        taskId: card.taskId,
        segmentIndex: 0,
      }, resolved.documentId);
    }

    if (payload.TaskStatusUpdate) {
      const update = payload.TaskStatusUpdate;
      // 🔧 P1 修复: 验证任务状态更新
      if (!update.task_id || typeof update.task_id !== 'string') {
        console.error('[CardAgent] 收到无效的 TaskStatusUpdate:', update);
        return;
      }
      this.emit('task:progress', {
        taskId: update.task_id,
        segmentIndex: update.segment_index || 0,
        status: update.status as TaskStatus,
        progress: 0,
        cardsGenerated: 0,
      }, update.document_id);
    }

    if (payload.TaskCompleted) {
      const completed = payload.TaskCompleted;
      this.emit('task:complete', {
        taskId: completed.task_id,
        status: completed.final_status as TaskStatus,
        totalCards: completed.total_cards_generated,
      }, completed.document_id);
    }

    if (payload.DocumentProcessingStarted) {
      this.emit('document:start', {
        documentId: payload.DocumentProcessingStarted.document_id,
        totalSegments: payload.DocumentProcessingStarted.total_segments,
      }, payload.DocumentProcessingStarted.document_id);
    }

    if (payload.DocumentProcessingCompleted) {
      this.emit('document:complete', {
        documentId: payload.DocumentProcessingCompleted.document_id,
      }, payload.DocumentProcessingCompleted.document_id);
    }

    if (payload.DocumentProcessingPaused) {
      this.emit('document:paused', {
        documentId: payload.DocumentProcessingPaused.document_id,
      }, payload.DocumentProcessingPaused.document_id);
    }

    // ★ 2026-01 修复：处理 TaskProcessingError 事件
    if (payload.TaskProcessingError) {
      const errorEvent = payload.TaskProcessingError;
      this.emit('task:error', {
        taskId: errorEvent.task_id,
        error: errorEvent.error_message || '任务处理失败',
        segmentIndex: 0,
      }, errorEvent.document_id);
    }
  }

  /**
   * 验证后端卡片数据有效性
   * 🔧 P1 修复 #6: 防止 XSS 和无效数据注入
   */
  private isValidBackendCard(card: BackendAnkiCard): boolean {
    return !!(
      card &&
      typeof card.id === 'string' &&
      card.id.length > 0 &&
      typeof card.task_id === 'string' &&
      typeof card.front === 'string' &&
      typeof card.back === 'string' &&
      Array.isArray(card.tags) &&
      Array.isArray(card.images)
    );
  }

  /**
   * 发射事件
   */
  private emit<T>(eventType: string, payload: T, documentId?: string): void {
    const event: CardForgeEvent<T> = {
      type: eventType as CardForgeEvent['type'],
      documentId: documentId ?? '',
      timestamp: new Date().toISOString(),
      payload,
    };

    const listeners = this.eventListeners.get(eventType);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error: unknown) {
          console.error('[CardAgent] Event listener error:', error);
        }
      });
    }
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /**
   * 获取当前窗口 label（用于跨窗口事件校验）
   */
  private async getWindowLabel(): Promise<string | null> {
    if (this.cachedWindowLabel !== undefined) {
      return this.cachedWindowLabel ?? null;
    }

    try {
      const { WebviewWindow } = await import('@tauri-apps/api/window');
      const webview: any = WebviewWindow.getCurrent();
      const labelValue = typeof webview?.label === 'string'
        ? webview.label
        : await webview?.label?.();
      const normalized = typeof labelValue === 'string' && labelValue.trim()
        ? labelValue
        : null;
      this.cachedWindowLabel = normalized;
      return normalized;
    } catch {
      this.cachedWindowLabel = null;
      return null;
    }
  }

  /**
   * 获取可用模板
   */
  private async getAvailableTemplates(templateIds?: string[]): Promise<TemplateInfo[]> {
    const { templates } = await this.listTemplates({ activeOnly: true });

    if (templateIds && templateIds.length > 0) {
      return templates.filter((t) => templateIds.includes(t.id));
    }

    return templates;
  }

  private normalizeTemplateFields(fields?: string[]): string[] {
    return fields && fields.length > 0 ? fields : ['front', 'back', 'tags'];
  }

  private buildDefaultFieldRule(field: string): FieldExtractionRule {
    const lower = field.toLowerCase();
    return {
      field_type: lower === 'tags' ? 'Array' : 'Text',
      is_required: lower === 'front' || lower === 'back',
      description: `${field} 字段的内容`,
      default_value: lower === 'tags' ? '[]' : '',
    };
  }

  private ensureFieldExtractionRules(
    fields: string[],
    rules?: Record<string, FieldExtractionRule>
  ): Record<string, FieldExtractionRule> {
    const normalizedFields = this.normalizeTemplateFields(fields);
    const filled: Record<string, FieldExtractionRule> = {
      ...(rules || {}),
    };
    normalizedFields.forEach((field) => {
      if (!filled[field]) {
        filled[field] = this.buildDefaultFieldRule(field);
      }
    });
    return filled;
  }

  /**
   * 🔧 P0 修复：创建卡片收集器
   *
   * 必须在调用后端之前创建，防止竞态条件丢失早期事件。
   * 返回的收集器会立即开始监听事件。
   */
  private createCardCollector(): {
    waitForComplete: () => Promise<{ cards: AnkiCardResult[]; paused: boolean }>;
    cancel: () => void;
    setDocumentId: (documentId: string) => void;
  } {
    const cards: AnkiCardResult[] = [];
    let completed = false;
    let paused = false;
    let expectedDocumentId: string | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let resolveWithState: ((value: { cards: AnkiCardResult[]; paused: boolean }) => void) | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      unsubscribeCard();
      unsubscribeErrorCard();
      unsubscribeComplete();
      unsubscribePaused(); // 🔧 三轮修复 #8: 清理暂停事件监听
    };

    // 立即开始监听事件（在调用后端之前）
    const unsubscribeCard = this.on<{ card: AnkiCardResult }>('card:generated', (event) => {
      if (!expectedDocumentId) {
        return;
      }
      if (event.documentId && event.documentId !== expectedDocumentId) {
        return;
      }
      cards.push(event.payload.card);
    });

    const unsubscribeErrorCard = this.on<{ card: AnkiCardResult }>('card:error', (event) => {
      if (!expectedDocumentId) {
        return;
      }
      if (event.documentId && event.documentId !== expectedDocumentId) {
        return;
      }
      cards.push(event.payload.card);
    });

    const unsubscribeComplete = this.on('document:complete', (event) => {
      if (!expectedDocumentId) {
        return;
      }
      if (event.documentId && event.documentId !== expectedDocumentId) {
        return;
      }
      if (!completed) {
        completed = true;
        cleanup();
        if (resolveWithState) {
          resolveWithState({ cards, paused: false });
        }
      }
    });

    // 🔧 三轮修复 #8: 监听暂停事件，用户暂停时立即返回已收集的卡片
    const unsubscribePaused = this.on('document:paused', (event) => {
      if (!expectedDocumentId) {
        return;
      }
      if (event.documentId && event.documentId !== expectedDocumentId) {
        return;
      }
      if (!completed) {
        completed = true;
        paused = true;
        console.log(`[CardAgent] 文档处理已暂停，返回已收集的 ${cards.length} 张卡片`);
        cleanup();
        if (resolveWithState) {
          resolveWithState({ cards, paused });
        }
      }
    });

    return {
      waitForComplete: (): Promise<{ cards: AnkiCardResult[]; paused: boolean }> => {
        // 如果在调用 waitForComplete 之前就已完成，立即返回
        if (completed) {
          return Promise.resolve({ cards, paused });
        }

        return new Promise((resolve) => {
          resolveWithState = resolve;

          // 超时保护 (5分钟)
          timeoutId = setTimeout(() => {
            if (!completed) {
              completed = true;
              console.warn(`[CardAgent] 文档生成超时 (5分钟)，已收集 ${cards.length} 张卡片`);

              this.emit('task:error', {
                error: `生成超时，已收集 ${cards.length} 张卡片`,
                isTimeout: true,
                partialCards: cards.length,
              }, expectedDocumentId ?? undefined);

              cleanup();
              resolve({ cards, paused: false });
            }
          }, 300000);
        });
      },
      setDocumentId: (documentId: string) => {
        expectedDocumentId = documentId;
      },
      cancel: () => {
        if (!completed) {
          completed = true;
          paused = false;
          cleanup();
        }
      },
    };
  }

  /**
   * 获取分段数量
   */
  private async getSegmentCount(documentId: string): Promise<number> {
    try {
      const tasks = await invoke<BackendDocumentTask[]>('get_document_tasks', { documentId });
      return tasks.length;
    } catch {
      return 1;
    }
  }

  /**
   * 获取任务状态
   */
  private async getTaskStatus(documentId: string): Promise<TaskInfo[]> {
    try {
      const tasks = await invoke<BackendDocumentTask[]>('get_document_tasks', { documentId });
      return tasks.map((t) => ({
        taskId: t.id,
        segmentIndex: t.segment_index,
        status: t.status as TaskStatus,
        cardsGenerated: 0,
        errorMessage: t.error_message,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 转换后端卡片格式
   */
  private convertBackendCard(backendCard: BackendAnkiCard): AnkiCardResult {
    return {
      id: backendCard.id,
      taskId: backendCard.task_id,
      templateId: backendCard.template_id || '',
      front: backendCard.front,
      back: backendCard.back,
      text: backendCard.text,
      tags: backendCard.tags || [],
      fields: backendCard.extra_fields || {},
      images: backendCard.images || [],
      isErrorCard: backendCard.is_error_card,
      errorContent: backendCard.error_content,
      createdAt: backendCard.created_at,
    };
  }

  /**
   * 估算 token 数
   */
  private estimateTokens(text: string): number {
    // 安全检查：防止 text 为 undefined 或 null
    if (!text) {
      return 0;
    }
    let tokens = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) {
        // 中文字符
        tokens += 1;
      } else if (code >= 0x0020 && code <= 0x007f) {
        // ASCII 字符
        tokens += 0.25; // 约 4 个字符一个 token
      } else {
        tokens += 0.5;
      }
    }
    return Math.ceil(tokens);
  }

  // =========================================================================
  // 已删除的规则匹配方法 (LLM-First 原则)
  // =========================================================================
  // detectContentTypes 和 suggestTemplates 已删除
  // 原因：设计文档明确禁止使用规则匹配进行内容分析和模板推荐
  // 替代：所有"理解"和"决策"工作由 LLM 在 analyzeContent 中完成
  // =========================================================================

  /**
   * 计算模板复杂度
   */
  private calculateComplexityLevel(
    template: { fields?: string[]; note_type?: string }
  ): TemplateInfo['complexityLevel'] {
    const fieldCount = template.fields?.length || 0;
    const isCloze = template.note_type === 'Cloze';

    if (fieldCount <= 2 && !isCloze) return 'simple';
    if (fieldCount <= 4) return 'moderate';
    if (fieldCount <= 6) return 'complex';
    return 'very_complex';
  }

  /**
   * 清理资源
   *
   * 释放所有事件监听器，防止内存泄漏
   */
  dispose(): void {
    // 清理后端事件监听器
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
    // 清理 Chat V2 工具调用监听器
    if (this.toolCallUnlistenFn) {
      this.toolCallUnlistenFn();
      this.toolCallUnlistenFn = null;
    }
    // 清理本地事件监听器
    this.eventListeners.clear();
  }
}

// ============================================================================
// 导出单例实例
// ============================================================================

export const cardAgent = new CardAgent();

// 导出便捷方法
export const generateCards = (input: GenerateCardsInput) => cardAgent.generateCards(input);
export const controlTask = (input: ControlTaskInput) => cardAgent.controlTask(input);
export const exportCards = (input: ExportCardsInput) => cardAgent.exportCards(input);
export const listTemplates = (input?: ListTemplatesInput) => cardAgent.listTemplates(input);
export const analyzeContent = (input: AnalyzeContentInput) => cardAgent.analyzeContent(input);
