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
import { t } from '@/utils/i18n';
import type { AnkiCard } from '@/types';
import { SegmentEngine } from './SegmentEngine';
import {
  buildContentAnalysisPrompt,
  buildCardGenerationSystemPrompt,
  buildCardGenerationUserPrompt,
} from '../prompts';
import {
  filterExportableCards,
  normalizeToolExportCards,
  validateCardsForExport,
} from './exportNormalize';
import { isTerminalTaskStatus, normalizeTaskStatus } from './taskStatus';
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
} from '../types';

/** anki 命名空间下 engine 子对象的 i18n 快捷函数 */
const tEngine = (key: string, options?: Record<string, unknown>): string =>
  t(`engine.${key}`, options, 'anki');

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

/**
 * 后端 `anki_generation_event` 事件载荷。
 *
 * 与 src-tauri/src/models.rs 的 `StreamedCardPayload` 对齐：serde 外部标签
 * 序列化，即 `{ "NewCard": { "card": {...}, "document_id": "..." } }`。
 * NewCard/NewErrorCard 同时兼容裸卡片对象（旧版桥接可能不带包装层）。
 */
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
  /** 文档处理被用户取消（保留已生成卡片） */
  DocumentProcessingCancelled?: {
    document_id: string;
  };
  /** API 频率限制警告（全局，无 document_id） */
  RateLimitWarning?: {
    message: string;
    retry_after_seconds?: number;
  };
  /** 工作流失败事件（全局，无 document_id） */
  WorkflowFailed?: {
    workflow_type: string;
    error_message: string;
    fallback_used: boolean;
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
  /**
   * @deprecated 使用 template_ids 替代，支持 LLM 多模板自选。
   *
   * 迁移状态（2026-07 核实）：后端 enhanced_anki_service.rs 仍以
   * `options.template_id` 作为模板配置回退（template_ids 缺失/未命中时），
   * 因此前端必须继续填充首个模板 ID；待后端完全切换到 template_ids
   * 后方可移除此字段。
   */
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
        const { cards, paused, timedOut } = await cardCollector.waitForComplete();

        // 计算统计信息
        const stats: GenerationStats = {
          totalCards: cards.length,
          segments: await this.getSegmentCount(documentId),
          templatesUsed: [...new Set(cards.map((c) => c.templateId).filter(Boolean))],
          durationMs: Date.now() - startTime,
          successCount: cards.filter((c) => !c.isErrorCard).length,
          failedCount: cards.filter((c) => c.isErrorCard).length,
        };

        // 🔧 P0：空闲超时必须可区分失败，不能再以 ok:true 伪装成功
        if (timedOut) {
          return {
            ok: false,
            documentId,
            cards,
            stats,
            paused: false,
            timedOut: true,
            error: `生成空闲超时，已收集 ${cards.length} 张卡片`,
          };
        }

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
            message: tEngine('pause_success'),
          };

        case 'resume': {
          await invoke('resume_document_processing', { documentId: input.documentId });
          const tasks = await this.getTaskStatus(input.documentId);
          return {
            ok: true,
            message: tEngine('resume_success'),
            tasks,
          };
        }

        case 'retry':
          if (!input.taskId) {
            return {
              ok: false,
              message: tEngine('retry_requires_task_id'),
            };
          }
          await invoke('trigger_task_processing', {
            taskId: input.taskId,
          });
          return {
            ok: true,
            message: tEngine('retry_triggered'),
          };

        case 'cancel':
          // 非破坏性取消：仅停止生成，保留已生成的任务与卡片
          // （删除会话请走 delete_document_session，属显式删除操作）
          await invoke('cancel_document_processing', { documentId: input.documentId });
          return {
            ok: true,
            message: tEngine('cancel_success'),
          };

        default:
          return {
            ok: false,
            message: tEngine('unknown_action', { action: input.action }),
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
          error: tEngine('export.no_cards'),
        };
      }

      // 导出前校验：识别空卡/错误卡/缺字段，error 级问题卡被排除出导出集合。
      // validation 结果随输出透传，供 UI 内联展示警告明细。
      const validation = validateCardsForExport(input.cards);
      if (!validation.ok) {
        return {
          ok: false,
          error: tEngine('export.no_exportable_cards'),
          validation,
        };
      }
      const exportableCards = filterExportableCards(input.cards, validation);

      switch (input.format) {
        case 'apkg': {
          // 转换卡片格式（AnkiCard 形态：同时携带 fields 与 extra_fields，
          // 分别供新版 batch_export_cards 与旧版降级接口消费）
          const cardsForExport: AnkiCard[] = exportableCards.map((card) => ({
            id: card.id,
            task_id: card.taskId,
            front: card.front,
            back: card.back,
            text: card.text,
            tags: card.tags,
            images: card.images,
            fields: card.fields,
            extra_fields: card.fields,
            is_error_card: card.isErrorCard,
            error_content: card.errorContent ?? undefined,
            created_at: card.createdAt,
            template_id: card.templateId || undefined,
          }));
          const templateId = resolveExportTemplateId(exportableCards);

          const filePath = await ankiApiAdapter.batchExportCards({
            cards: cardsForExport,
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
            exportedCount: exportableCards.length,
            validation,
          };
        }

        case 'anki_connect': {
          // 使用 AnkiConnect API 导入卡片
          // 后端命令: add_cards_to_anki_connect(selected_cards, deck_name, note_type)
          const selectedCards = exportableCards.map((card) => ({
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
            const report = await invoke<{
              noteIds: (number | null)[];
              added: number;
              duplicates: number;
              failed: number;
              createdModels: string[];
            }>('add_cards_to_anki_connect', {
              selected_cards: selectedCards,
              selectedCards,
              deck_name: input.deckName,
              deckName: input.deckName,
              note_type: noteType,
              noteType,
            });

            // 全部已存在（added=0, failed=0, duplicates>0）视为幂等成功
            const allDuplicates =
              report.added === 0 && report.failed === 0 && report.duplicates > 0;
            return {
              ok: report.added > 0 || allDuplicates,
              importedCount: report.added,
              duplicateCount: report.duplicates,
              failedCount: report.failed,
              exportedCount: exportableCards.length,
              validation,
            };
          } catch (importError: unknown) {
            console.warn('[CardAgent] AnkiConnect import failed:', importError);
            return {
              ok: false,
              importedCount: 0,
              validation,
              error: importError instanceof Error
                ? importError.message
                : tEngine('export.anki_connect_failed'),
            };
          }
        }

        case 'json': {
          const exportCards = buildBackendExportCards(exportableCards);
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
              validation,
            };
          }
          return {
            ok: true,
            filePath: saveResult.path,
            exportedCount: exportCards.length,
            validation,
          };
        }

        default:
          return {
            ok: false,
            error: tEngine('export.unsupported_format', { format: input.format }),
            validation,
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
      const templateInfos: TemplateInfo[] = templates.map((template) => {
        const fields = this.normalizeTemplateFields(template.fields);
        // CustomAnkiTemplate 未声明 category，部分旧模板数据可能携带
        const category = (template as Partial<Record<'category', string>>).category;
        return {
          id: template.id,
          name: template.name,
          description: template.description || '',
          category: typeof category === 'string' && category.trim() ? category : 'general',
          fields,
          noteType: template.note_type || 'Basic',
          isActive: template.is_active !== false,
          complexityLevel: this.calculateComplexityLevel(template),
          useCaseDescription: template.description || template.name,
          // 🔧 P0 修复：传递字段提取规则
          field_extraction_rules: this.ensureFieldExtractionRules(fields, template.field_extraction_rules),
          // 🔧 P1 修复：传递生成提示词，指导 LLM 如何构造模板特定字段
          generation_prompt: template.generation_prompt,
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
        // 后端为帕斯卡命名（'Processing' 等），统一归一为小写 TaskStatus
        status: normalizeTaskStatus(update.status),
        progress: 0,
        cardsGenerated: 0,
      }, update.document_id);
    }

    if (payload.TaskCompleted) {
      const completed = payload.TaskCompleted;
      this.emit('task:complete', {
        taskId: completed.task_id,
        status: normalizeTaskStatus(completed.final_status, 'completed'),
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

    // 用户取消：需要让等待中的收集器立即返回，而不是等空闲超时
    if (payload.DocumentProcessingCancelled) {
      this.emit('document:cancelled', {
        documentId: payload.DocumentProcessingCancelled.document_id,
      }, payload.DocumentProcessingCancelled.document_id);
    }

    // ★ 2026-01 修复：处理 TaskProcessingError 事件
    if (payload.TaskProcessingError) {
      const errorEvent = payload.TaskProcessingError;
      this.emit('task:error', {
        taskId: errorEvent.task_id,
        error: errorEvent.error_message || tEngine('task_processing_failed'),
        segmentIndex: 0,
      }, errorEvent.document_id);
    }

    // API 频率限制警告：作为生成活动广播（收集器据此重置空闲计时器）
    if (payload.RateLimitWarning) {
      this.emit('rate:limit', {
        message: payload.RateLimitWarning.message,
        retryAfterSeconds: payload.RateLimitWarning.retry_after_seconds,
      });
    }

    // 工作流失败：以 task:error 形式对外暴露（无 document_id，全局事件）
    if (payload.WorkflowFailed) {
      const failed = payload.WorkflowFailed;
      this.emit('task:error', {
        error: failed.error_message,
        workflowType: failed.workflow_type,
        fallbackUsed: failed.fallback_used,
      });
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
      // Tauri v2：优先 getCurrentWindow().label；兼容旧桥接的 WebviewWindow.getCurrent()
      const windowModule: Record<string, unknown> = await import('@tauri-apps/api/window');
      let labelValue: unknown;

      const getCurrentWindow = windowModule.getCurrentWindow;
      if (typeof getCurrentWindow === 'function') {
        const current = (getCurrentWindow as () => { label?: unknown })();
        labelValue = current?.label;
      }

      if (typeof labelValue !== 'string' || !labelValue.trim()) {
        const webviewWindowClass = windowModule.WebviewWindow as
          | { getCurrent?: () => { label?: unknown } }
          | undefined;
        const webview = webviewWindowClass?.getCurrent?.();
        const rawLabel = webview?.label;
        labelValue = typeof rawLabel === 'function'
          ? await (rawLabel as () => Promise<unknown>).call(webview)
          : rawLabel;
      }

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
    waitForComplete: () => Promise<{ cards: AnkiCardResult[]; paused: boolean; timedOut: boolean }>;
    cancel: () => void;
    setDocumentId: (documentId: string) => void;
  } {
    type CollectorResult = { cards: AnkiCardResult[]; paused: boolean; timedOut: boolean };
    const cards: AnkiCardResult[] = [];
    let completed = false;
    let paused = false;
    let timedOut = false;
    let expectedDocumentId: string | null = null;
    let idleTimerId: ReturnType<typeof setTimeout> | null = null;
    let resolveWithState: ((value: CollectorResult) => void) | null = null;

    // 🔧 F21（round2）：空闲超时替代固定总超时。
    // 旧实现对整个文档用固定 5 分钟总超时，大文档多分段累计耗时极易误触发，
    // 超时后以“部分卡片成功”返回，与后端继续生成后的库内数量不一致。
    // 改为“距上次生成活动”的空闲超时：每收到新卡/错误卡/任务进度/任务完成事件即重置计时器，
    // 仅在长时间无任何活动（疑似卡死）时才返回已收集卡片。
    const IDLE_TIMEOUT_MS = 300000; // 5 分钟无任何生成活动视为卡死
    // 🔧 空闲超时轮询兜底：超时瞬间先查后端任务状态，若任务仍在推进
    // （说明只是事件丢失，不是真的卡死），延长空闲窗口继续等，最多延长次数：
    const MAX_IDLE_EXTENSIONS = 3;
    let idleExtensions = 0;

    // 🔧 早事件缓冲：documentId 由 invoke 返回后才可知（setDocumentId 在
    // invoke 之后调用）。此前 expectedDocumentId 为空时事件被直接丢弃，
    // 极早到达的 NewCard/DocumentProcessingCompleted 会永久丢失。
    // 现在改为缓冲，setDocumentId 后按 documentId 回放匹配。
    type BufferedKind = 'card' | 'errorCard' | 'complete' | 'paused' | 'cancelled' | 'activity';
    const MAX_PENDING_EVENTS = 1024;
    let pendingEvents: Array<{ kind: BufferedKind; event: CardForgeEvent<unknown> }> | null = [];

    const matchesDocument = (event: CardForgeEvent<unknown>): boolean =>
      !event.documentId || event.documentId === expectedDocumentId;

    const cleanup = () => {
      if (idleTimerId) {
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
      pendingEvents = null;
      unsubscribeCard();
      unsubscribeErrorCard();
      unsubscribeComplete();
      unsubscribePaused(); // 🔧 三轮修复 #8: 清理暂停事件监听
      unsubscribeCancelled(); // 取消事件监听
      unsubscribeProgress(); // 🔧 F21: 清理进度事件监听（仅用于重置空闲计时器）
      unsubscribeTaskComplete(); // 🔧 F21: 清理任务完成事件监听
      unsubscribeRateLimit(); // 限流警告也属生成活动
    };

    const finishWith = (state: { paused: boolean }) => {
      if (completed) return;
      completed = true;
      paused = state.paused;
      cleanup();
      if (resolveWithState) {
        resolveWithState({ cards, paused, timedOut: false });
      }
    };

    const finishWithIdleTimeout = async () => {
      if (completed) return;

      // 轮询兜底 #1：事件可能丢失。超时瞬间查询后端任务状态，
      // 若仍有非终态任务在推进，则视为事件通道异常而非卡死，延长等待窗口。
      if (expectedDocumentId && idleExtensions < MAX_IDLE_EXTENSIONS) {
        try {
          const tasks = await invoke<BackendDocumentTask[]>('get_document_tasks', {
            documentId: expectedDocumentId,
          });
          const hasActiveTask = Array.isArray(tasks)
            && tasks.some((task) => !isTerminalTaskStatus(task.status));
          if (!completed && hasActiveTask) {
            idleExtensions += 1;
            console.warn(
              `[CardAgent] 空闲超时但后端任务仍在推进，延长等待（第 ${idleExtensions}/${MAX_IDLE_EXTENSIONS} 次）`
            );
            resetIdleTimer();
            return;
          }
        } catch {
          // 查询失败按普通超时处理
        }
      }

      if (completed) return;
      completed = true;
      timedOut = true;

      // 轮询兜底 #2：超时收尾前从数据库恢复卡片，弥补事件丢失导致的
      // 前端计数与库内数量不一致（get_document_cards 返回 DB 权威数据）。
      let finalCards = cards;
      if (expectedDocumentId) {
        try {
          const dbCards = await invoke<BackendAnkiCard[]>('get_document_cards', {
            documentId: expectedDocumentId,
          });
          if (Array.isArray(dbCards) && dbCards.length > cards.length) {
            const recovered = dbCards
              .filter((card) => this.isValidBackendCard(card))
              .map((card) => this.convertBackendCard(card));
            if (recovered.length > cards.length) {
              console.warn(
                `[CardAgent] 空闲超时兜底：事件收集 ${cards.length} 张，DB 恢复 ${recovered.length} 张`
              );
              finalCards = recovered;
            }
          }
        } catch {
          // 恢复失败则返回事件收集到的卡片
        }
      }

      console.warn(
        `[CardAgent] 文档生成空闲超时（${IDLE_TIMEOUT_MS / 1000}s 无新事件），已收集 ${finalCards.length} 张卡片`
      );
      this.emit('task:error', {
        error: `生成空闲超时，已收集 ${finalCards.length} 张卡片`,
        isTimeout: true,
        partialCards: finalCards.length,
      }, expectedDocumentId ?? undefined);
      cleanup();
      if (resolveWithState) {
        resolveWithState({ cards: finalCards, paused: false, timedOut: true });
      }
    };

    // 重置空闲计时器；仅在已开始等待（waitForComplete 已设置 resolver）后计时，避免无人接收。
    const resetIdleTimer = () => {
      if (completed || !resolveWithState) return;
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        void finishWithIdleTimeout();
      }, IDLE_TIMEOUT_MS);
    };

    // 统一事件分发：documentId 未知期间缓冲；已知后按 documentId 过滤处理。
    const dispatch = (kind: BufferedKind, event: CardForgeEvent<unknown>) => {
      if (completed) return;
      if (!expectedDocumentId) {
        if (pendingEvents && pendingEvents.length < MAX_PENDING_EVENTS) {
          pendingEvents.push({ kind, event });
        }
        return;
      }
      if (!matchesDocument(event)) return;

      switch (kind) {
        case 'card':
        case 'errorCard': {
          const payload = event.payload as { card?: AnkiCardResult } | undefined;
          if (payload?.card) {
            cards.push(payload.card);
          }
          resetIdleTimer(); // 🔧 F21: 有新卡/错误卡，仍属生成活动，重置空闲超时
          break;
        }
        case 'complete':
          finishWith({ paused: false });
          break;
        case 'paused':
          console.log(`[CardAgent] 文档处理已暂停，返回已收集的 ${cards.length} 张卡片`);
          finishWith({ paused: true });
          break;
        case 'cancelled':
          // 非破坏性取消：立即返回已收集卡片，避免等待空闲超时
          console.log(`[CardAgent] 文档处理已取消，返回已收集的 ${cards.length} 张卡片`);
          finishWith({ paused: false });
          break;
        case 'activity':
          resetIdleTimer();
          break;
      }
    };

    // 立即开始监听事件（在调用后端之前）
    const unsubscribeCard = this.on<{ card: AnkiCardResult }>('card:generated', (event) => {
      dispatch('card', event);
    });

    const unsubscribeErrorCard = this.on<{ card: AnkiCardResult }>('card:error', (event) => {
      dispatch('errorCard', event);
    });

    const unsubscribeComplete = this.on('document:complete', (event) => {
      dispatch('complete', event);
    });

    // 🔧 三轮修复 #8: 监听暂停事件，用户暂停时立即返回已收集的卡片
    const unsubscribePaused = this.on('document:paused', (event) => {
      dispatch('paused', event);
    });

    const unsubscribeCancelled = this.on('document:cancelled', (event) => {
      dispatch('cancelled', event);
    });

    // 🔧 F21: 任务进度/完成事件也算“生成活动”，重置空闲超时（不收集卡片，仅防误超时）
    const unsubscribeProgress = this.on('task:progress', (event) => {
      dispatch('activity', event);
    });

    const unsubscribeTaskComplete = this.on('task:complete', (event) => {
      dispatch('activity', event);
    });

    // 限流警告说明后端仍在工作（等待重试），不应触发空闲超时
    const unsubscribeRateLimit = this.on('rate:limit', (event) => {
      dispatch('activity', event);
    });

    return {
      waitForComplete: (): Promise<{ cards: AnkiCardResult[]; paused: boolean; timedOut: boolean }> => {
        // 如果在调用 waitForComplete 之前就已完成，立即返回
        if (completed) {
          return Promise.resolve({ cards, paused, timedOut });
        }

        return new Promise((resolve) => {
          resolveWithState = resolve;
          // 启动空闲计时器；后续每次生成活动都会重置它（见 resetIdleTimer）
          resetIdleTimer();
        });
      },
      setDocumentId: (documentId: string) => {
        expectedDocumentId = documentId;
        // 回放 documentId 未知期间缓冲的事件（按 documentId 过滤）
        const buffered = pendingEvents;
        pendingEvents = null;
        if (buffered && buffered.length > 0) {
          for (const { kind, event } of buffered) {
            dispatch(kind, event);
            if (completed) break;
          }
        }
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
      return tasks.map((task) => ({
        taskId: task.id,
        segmentIndex: task.segment_index,
        // 后端返回帕斯卡命名状态，统一归一为小写 TaskStatus
        status: normalizeTaskStatus(task.status),
        cardsGenerated: 0,
        errorMessage: task.error_message,
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
