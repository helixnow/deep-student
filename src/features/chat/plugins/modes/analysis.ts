/**
 * Chat V2 - 题目分析模式插件
 *
 * OCR 串行前置的题目分析模式
 * 自执行注册：import 即注册
 *
 * 流程：
 * 1. 用户上传图片
 * 2. 串行执行 OCR → 生成 ocrMeta
 * 3. OCR 完成后显示输入框
 * 4. 自动发起首轮分析
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { modeRegistry, type ModeConfig, type SystemPromptContext, type ModeInitConfig } from '../../registry';
import { OcrResultHeader } from './components/OcrResultHeader';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatStore } from '../../core/types';
// 🔧 P0-14 修复：导入 VFS 上传和资源 API
import { uploadAttachment, type VfsContextRefData } from '../../context';
import { resourceStoreApi, type ContextRef } from '../../resources';
import { IMAGE_TYPE_ID } from '../../context/definitions/image';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OCR 状态
 */
export type OcrStatus = 'idle' | 'pending' | 'running' | 'success' | 'error';

/**
 * OCR 识别结果元数据
 */
export interface OcrMeta {
  /** 识别出的题目文本 */
  question: string;
  /** 识别出的答案/解析 */
  answer?: string;
  /**
   * ★ 向后兼容：科目（旧数据/旧测试可能包含）
   *
   * 文档28清理后不再作为核心字段，但保留可选以兼容历史数据与测试用例。
   */
  subject?: string;
  /** 题目类型 */
  questionType?: string;
  /** 原始 OCR 文本 */
  rawText: string;
  /** 识别出的标签 */
  tags?: string[];
}

/**
 * 分析模式状态（存储在 store.modeState）
 */
export interface AnalysisModeState {
  /** OCR 状态 */
  ocrStatus: OcrStatus;
  /** OCR 进度 0-100 */
  ocrProgress: number;
  /** OCR 结果 */
  ocrMeta: OcrMeta | null;
  /** OCR 错误信息 */
  ocrError: string | null;
  /** 原始图片（base64 或 URL） */
  images: string[];
  /** 是否已自动发送首条消息 */
  autoMessageSent: boolean;
  /** 学习笔记内容（持久化） */
  note?: string | null;
  /** 笔记保存错误 */
  noteError?: string | null;
}

/**
 * 分析模式初始化配置
 */
// ★ 文档28清理：subject 已从 Chat V2 彻底移除
export interface AnalysisInitConfig {
  /** 图片列表（base64 或文件路径） */
  images: string[];
}

// ============================================================================
// 模式配置
// ============================================================================

/**
 * 分析模式配置
 */
const ANALYSIS_MODE_CONFIG: ModeConfig = {
  requiresOcr: true,
  ocrTiming: 'before', // OCR 串行前置
  autoStartFirstMessage: true, // OCR 完成后自动发起分析
};

// ============================================================================
// 初始化状态工厂
// ============================================================================

/**
 * 创建初始分析模式状态
 */
export function createInitialAnalysisModeState(
  images: string[],
  existingNote?: string | null
): AnalysisModeState {
  return {
    ocrStatus: 'idle',
    ocrProgress: 0,
    ocrMeta: null,
    ocrError: null,
    images,
    autoMessageSent: false,
    note: existingNote ?? null,
    noteError: null,
  };
}

// ============================================================================
// OCR 执行器（TODO: 需要对接实际的 OCR API）
// ============================================================================

/**
 * OCR 进度回调
 */
type OcrProgressCallback = (progress: number) => void;

/**
 * 执行 OCR 识别
 *
 * 调用后端 chat_v2_perform_ocr 命令执行纯 OCR 识别
 * 该命令只做 OCR，不创建会话或保存图片
 */
// ★ 文档28清理：subject 已从 Chat V2 彻底移除
async function performOcr(
  images: string[],
  onProgress?: OcrProgressCallback
): Promise<OcrMeta> {
  try {
    // 通知开始
    onProgress?.(10);

    // 准备请求参数
    // 确保图片是 base64 格式（支持 data:image/... 和纯 base64）
    const normalizedImages = images.map((img) => {
      if (img.startsWith('data:')) {
        return img; // 已经是 data URL
      }
      // 假设是纯 base64，添加前缀
      return `data:image/jpeg;base64,${img}`;
    });

    onProgress?.(30);

    // 调用新的 Chat V2 OCR 命令
    const response = await invoke<{
      ocr_text: string;
      tags: string[];
      mistake_type: string;
    }>('chat_v2_perform_ocr', {
      request: {
        images: normalizedImages,
      },
    });

    onProgress?.(90);
    onProgress?.(100);

    return {
      question: response.ocr_text || '',
      answer: undefined,
      questionType: response.mistake_type || undefined,
      rawText: response.ocr_text || '',
      tags: response.tags,
    };
  } catch (error: unknown) {
    console.error('[Analysis Mode] OCR failed:', getErrorMessage(error));
    throw error;
  }
}

// ============================================================================
// 模式插件注册
// ============================================================================

/**
 * 题目分析模式插件
 *
 * 特点：
 * - OCR 串行前置：必须先完成 OCR 才能发送消息
 * - 自动首轮分析：OCR 完成后自动发起分析请求
 * - 支持 OCR 重试
 * - renderHeader 显示 OCR 结果
 */
modeRegistry.register('analysis', {
  name: 'analysis',
  extends: 'chat', // 继承 chat 的所有面板能力
  config: ANALYSIS_MODE_CONFIG,

  /**
   * 模式初始化
   *
   * @param store - ChatStore 实例
   * @param initConfig - 初始化配置（可选，包含 images 等）
   */
  onInit: async (store: ChatStore, initConfig?: ModeInitConfig) => {
    // 🔧 P0修复：优先从 initConfig 获取 images，回退到 modeState
    const existingState = store.modeState as unknown as Partial<AnalysisModeState> | null;
    const images = initConfig?.images || existingState?.images || [];
    // ★ 文档28清理：subject 已从 Chat V2 彻底移除
    // 🔧 保留已有笔记内容
    const existingNote = existingState?.note;

    // 如果没有图片，只设置初始状态（保留已有笔记）
    if (images.length === 0) {
      store.setModeState(createInitialAnalysisModeState([], existingNote) as unknown as Record<string, unknown>);
      return;
    }

    // 设置初始状态（保留已有笔记）
    store.setModeState({
      ocrStatus: 'pending',
      ocrProgress: 0,
      ocrMeta: null,
      ocrError: null,
      images,
      autoMessageSent: false,
      note: existingNote ?? null,
      noteError: null,
    } as unknown as Record<string, unknown>);

    // 执行 OCR
    try {
      // 更新为 running 状态
      store.updateModeState({ ocrStatus: 'running' });

      // 执行 OCR 并更新进度
      // ★ 文档28清理：subject 已从 Chat V2 彻底移除
      const ocrResult = await performOcr(
        images,
        (progress) => {
          store.updateModeState({ ocrProgress: progress });
        }
      );

      // OCR 成功
      store.updateModeState({
        ocrStatus: 'success',
        ocrMeta: ocrResult,
        ocrProgress: 100,
      });

      // 自动发起首轮分析
      if (ANALYSIS_MODE_CONFIG.autoStartFirstMessage) {
        await autoSendFirstMessage(store, images);
      }
    } catch (error: unknown) {
      // OCR 失败
      store.updateModeState({
        ocrStatus: 'error',
        ocrError: getErrorMessage(error),
      });
    }
  },

  /**
   * 发送消息时的回调
   * 可用于注入 OCR 结果到消息上下文
   */
  onSendMessage: (store: ChatStore, _content: string) => {
    const modeState = store.modeState as unknown as AnalysisModeState | null;

    // 如果 OCR 正在进行中，阻止发送
    if (
      modeState &&
      (modeState.ocrStatus === 'pending' || modeState.ocrStatus === 'running')
    ) {
      // ★ 测试/极端场景兜底：i18n 未初始化时不要抛空消息
      const translated = i18n.t('chatV2:mode.analysis.ocrInProgress');
      throw new Error(translated && translated.trim() ? translated : 'OCR 正在进行中');
    }
  },

  /**
   * 构建系统提示
   * 注入 OCR 识别结果到系统提示中
   */
  buildSystemPrompt: (context: SystemPromptContext): string => {
    const modeState = context.modeState as unknown as AnalysisModeState | null;
    const ocrMeta = modeState?.ocrMeta;

    let systemPrompt = `你是一个专业的题目分析助手。请根据用户提供的题目图片和识别结果，进行详细的解题分析。

分析要求：
1. 仔细阅读题目内容，理解题意
2. 分析解题思路和方法
3. 给出详细的解答步骤
4. 如果有多种解法，请一并说明
5. 指出常见的错误和注意事项`;

    // 注入 OCR 识别结果
    if (ocrMeta) {
      systemPrompt += `\n\n【识别到的题目内容】\n${ocrMeta.question}`;
      if (ocrMeta.answer) {
        systemPrompt += `\n\n【参考答案/解析】\n${ocrMeta.answer}`;
      }
      if (ocrMeta.subject) {
        systemPrompt += `\n【科目】${ocrMeta.subject}`;
      }
      if (ocrMeta.questionType) {
        systemPrompt += `\n【题型】${ocrMeta.questionType}`;
      }
    }

    return systemPrompt;
  },

  /**
   * 获取启用的工具列表
   * 分析模式启用知识库检索
   */
  getEnabledTools: (_store: ChatStore): string[] => {
    return ['rag'];
  },

  /**
   * 自定义 Header 组件
   * 显示 OCR 结果
   */
  renderHeader: OcrResultHeader,
});

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 自动发送首条分析消息
 *
 * 🔧 P0-14 修复：将图片上传到 VFS 并创建 ContextRef
 * 原问题：后端已移除 attachments 字段，图片无法传递给模型
 * 解决方案：使用 VFS 引用模式，先上传图片再发送消息
 */
async function autoSendFirstMessage(
  store: ChatStore,
  images: string[]
): Promise<void> {
  const modeState = store.modeState as unknown as AnalysisModeState | null;

  // 防止重复发送
  if (modeState?.autoMessageSent) {
    return;
  }

  // 标记已发送
  store.updateModeState({ autoMessageSent: true });

  // 🔧 P0-14 修复：上传图片到 VFS 并创建 ContextRef
  try {
    for (let index = 0; index < images.length; index++) {
      const image = images[index];

      // 从 data URL 中提取 MIME 类型和 base64 内容
      let mimeType = 'image/png';
      let base64Content = image;

      if (image.startsWith('data:')) {
        const match = image.match(/^data:([^;,]+)[;,]/);
        if (match) {
          mimeType = match[1];
        }
        // 提取 base64 内容
        const base64Match = image.match(/base64,(.+)$/);
        if (base64Match) {
          base64Content = base64Match[1];
        }
      }

      const fileName = i18n.t('chatV2:mode.analysis.ocrImageName', {
        index: index + 1,
        defaultValue: 'OCR 图片 {{index}}',
      }) || `OCR 图片 ${index + 1}`;

      // 1. 上传到 VFS attachments 表
      const uploadResult = await uploadAttachment({
        name: fileName,
        mimeType,
        base64Content,
        type: 'image',
      });

      console.log('[Analysis Mode] Uploaded image to VFS:', uploadResult.sourceId);

      // 2. 构造 VfsContextRefData
      const refData: VfsContextRefData = {
        refs: [
          {
            sourceId: uploadResult.sourceId,
            resourceHash: uploadResult.resourceHash,
            type: 'image',
            name: fileName,
          },
        ],
        totalCount: 1,
        truncated: false,
      };

      // 3. 存储到 resources 表
      const resourceResult = await resourceStoreApi.createOrReuse({
        type: 'image' as import('../../resources').ResourceType,
        data: JSON.stringify(refData),
        sourceId: uploadResult.sourceId,
        metadata: {
          name: fileName,
          mimeType,
          size: uploadResult.attachment.size,
          vfsRefMode: true,
        },
      });

      console.log('[Analysis Mode] Created resource:', resourceResult.resourceId);

      // 4. 构建 ContextRef 并添加到 store
      const contextRef: ContextRef = {
        resourceId: resourceResult.resourceId,
        hash: resourceResult.hash,
        typeId: IMAGE_TYPE_ID,
      };

      store.addContextRef(contextRef);
      console.log('[Analysis Mode] Added context ref:', resourceResult.resourceId);
    }

    // 发送分析请求（不再需要 attachments 参数）
    await store.sendMessage(
      i18n.t('chatV2:mode.analysis.autoPrompt', { defaultValue: '请分析这道题目' }) || '请分析这道题目',
    );
  } catch (error: unknown) {
    // 如果发送失败，重置标记以允许重试
    store.updateModeState({ autoMessageSent: false });
    console.error('[Analysis Mode] Auto send failed:', error);
  }
}

// ============================================================================
// 辅助 Hook：检查是否可以发送消息
// ============================================================================

/**
 * 检查 analysis 模式是否允许发送消息
 *
 * @param store - ChatStore 实例
 * @returns 是否允许发送
 */
export function canSendInAnalysisMode(store: ChatStore): boolean {
  if (store.mode !== 'analysis') {
    return true;
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;
  if (!modeState) {
    return true;
  }

  // OCR 进行中时不允许发送
  if (modeState.ocrStatus === 'pending' || modeState.ocrStatus === 'running') {
    return false;
  }

  // 其他情况允许发送
  return true;
}

/**
 * 获取 analysis 模式的 OCR 状态
 *
 * @param store - ChatStore 实例
 * @returns OCR 状态或 null
 */
export function getAnalysisOcrStatus(store: ChatStore): OcrStatus | null {
  if (store.mode !== 'analysis') {
    return null;
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;
  return modeState?.ocrStatus || null;
}

/**
 * 手动触发 OCR 重试
 *
 * @param store - ChatStore 实例
 * @param images - 可选的新图片列表
 */
export async function retryOcr(
  store: ChatStore,
  images?: string[]
): Promise<void> {
  if (store.mode !== 'analysis') {
    throw new Error(i18n.t('chatV2:mode.analysis.retryOnlyInAnalysis'));
  }

  const modeState = store.modeState as unknown as AnalysisModeState | null;

  // 🔧 P2修复：检查 OCR 是否正在进行，防止并发请求
  if (modeState?.ocrStatus === 'pending' || modeState?.ocrStatus === 'running') {
    console.warn('[Analysis Mode] OCR already in progress, ignoring retry request');
    return;
  }

  const targetImages = images || modeState?.images || [];

  if (targetImages.length === 0) {
    throw new Error(i18n.t('chatV2:mode.analysis.noImagesToOcr'));
  }

  // 重置状态并重新执行 OCR
  store.updateModeState({
    ocrStatus: 'pending',
    ocrProgress: 0,
    ocrError: null,
    autoMessageSent: false,
    images: targetImages,
  });

  // 重新触发初始化（会执行 OCR）
  const modePlugin = modeRegistry.getResolved('analysis');
  if (modePlugin?.onInit) {
    await modePlugin.onInit(store);
  }
}

// ============================================================================
// 导出
// ============================================================================

export const ANALYSIS_MODE = 'analysis';
