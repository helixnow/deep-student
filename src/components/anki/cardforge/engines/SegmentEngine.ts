/**
 * CardForge 2.0 - 智能分段引擎
 *
 * 负责将大文档分割成适合 LLM 上下文的语义完整片段
 *
 * 设计原则：
 * - 阶段一：硬分割（纯数学计算，按固定 token 数）
 * - 阶段二：LLM 定界（可选，当文档较大时启用，并行执行）
 * - 阶段三：构建最终分段
 *
 * 如果文档较小（< CHUNK_SIZE），直接返回单个分段，不需要 LLM 定界
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  SegmentConfig,
  DEFAULT_SEGMENT_CONFIG,
  HardSplitPoint,
  BoundaryDetectionRequest,
  BoundaryDetectionResult,
  DocumentSegment,
} from '../types';

/**
 * LLM 定界响应格式
 */
interface BoundaryDetectionResponse {
  /** 相对于原始位置的偏移量（正数表示向后，负数表示向前） */
  offset: number;
  /** 选择该边界的原因 */
  reason: string;
  /** 置信度 (0-1) */
  confidence: number;
}

/**
 * Token 估算结果
 */
interface TokenEstimate {
  /** 估算的 token 数 */
  tokens: number;
  /** 字符数 */
  chars: number;
}

/**
 * 分段选项
 */
export interface SegmentOptions {
  /** 是否启用 LLM 定界（默认自动判断） */
  enableLLMBoundary?: boolean;
  /** 进度回调 */
  onProgress?: (progress: { phase: string; current: number; total: number }) => void;
}

/**
 * 智能分段引擎
 */
export class SegmentEngine {
  private config: SegmentConfig;

  constructor(config?: Partial<SegmentConfig>) {
    // 导入默认配置
    const defaultConfig: SegmentConfig = {
      chunkSize: 50000,
      boundaryContext: 1000,
      minSegmentSize: 5000,
      boundaryModel: 'fast',
    };

    this.config = {
      ...defaultConfig,
      ...config,
    };
  }

  /**
   * 主方法：分割文档
   *
   * @param content 原始文档内容
   * @param options 分段选项
   * @returns 文档分段列表
   */
  async segment(content: string, options?: SegmentOptions): Promise<DocumentSegment[]> {
    if (!content || content.trim().length === 0) {
      throw new Error('文档内容不能为空');
    }

    // 估算总 token 数
    const totalTokens = this.estimateTokens(content);

    // 如果文档较小，直接返回单个分段
    if (totalTokens <= this.config.chunkSize) {
      return [
        {
          index: 0,
          startPosition: 0,
          endPosition: content.length,
          content,
          estimatedTokens: totalTokens,
        },
      ];
    }

    // 阶段一：硬分割
    options?.onProgress?.({
      phase: '硬分割',
      current: 0,
      total: 3,
    });

    const splitPoints = this.hardSplit(content);

    // 阶段二：LLM 定界（可选）
    const enableLLMBoundary =
      options?.enableLLMBoundary ?? splitPoints.length > 0;

    let boundaries: number[];

    if (enableLLMBoundary && splitPoints.length > 0) {
      options?.onProgress?.({
        phase: 'LLM 定界',
        current: 1,
        total: 3,
      });

      const detectionResults = await this.detectBoundaries(content, splitPoints);

      // 先按 result.index 排序检测结果，确保与原始 splitPoints 顺序一致
      // 这解决了如果后端返回乱序结果时边界计算错误的问题
      const sortedResults = [...detectionResults].sort((a, b) => a.index - b.index);

      // 将检测结果转换为实际边界位置
      boundaries = sortedResults.map((result) => {
        const splitPoint = splitPoints[result.index];
        if (!splitPoint) {
          console.warn(`[SegmentEngine] 未找到分割点 index=${result.index}，跳过`);
          return -1; // 标记为无效
        }
        return Math.max(
          0,
          Math.min(content.length, splitPoint.position + result.offset)
        );
      }).filter((pos) => pos >= 0); // 过滤无效位置

      // 对边界位置排序并去重
      boundaries = Array.from(new Set(boundaries)).sort((a, b) => a - b);
    } else {
      // 直接使用硬分割点
      boundaries = splitPoints.map((sp) => sp.position);
    }

    // 阶段三：构建分段
    options?.onProgress?.({
      phase: '构建分段',
      current: 2,
      total: 3,
    });

    const segments = this.buildSegments(content, boundaries);

    options?.onProgress?.({
      phase: '完成',
      current: 3,
      total: 3,
    });

    return segments;
  }

  /**
   * 阶段一：硬分割
   *
   * 按固定 token 数进行机械分割，纯数学计算，无 LLM 调用
   *
   * @param content 原始文档
   * @returns 硬分割点列表
   */
  private hardSplit(content: string): HardSplitPoint[] {
    const splitPoints: HardSplitPoint[] = [];
    const chunkSize = this.config.chunkSize;

    let currentPosition = 0;
    let currentTokens = 0;
    let splitIndex = 0;

    // 逐字符扫描，累计 token 数
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const charTokens = this.estimateCharTokens(char);

      currentTokens += charTokens;

      // 达到分段大小，记录分割点
      if (currentTokens >= chunkSize) {
        splitPoints.push({
          position: i,
          index: splitIndex,
        });

        currentTokens = 0;
        splitIndex++;
      }
    }

    return splitPoints;
  }

  /**
   * 阶段二：LLM 定界
   *
   * 在每个硬分割点附近，让 LLM 找到最佳语义边界
   * 所有定界任务并行执行
   *
   * @param content 原始文档
   * @param splitPoints 硬分割点列表
   * @returns 边界检测结果列表
   */
  private async detectBoundaries(
    content: string,
    splitPoints: HardSplitPoint[]
  ): Promise<BoundaryDetectionResult[]> {
    // 构建所有定界请求
    const requests: BoundaryDetectionRequest[] = splitPoints.map((sp) => {
      const contextSize = this.config.boundaryContext;

      // 提取前后上下文
      const beforeStart = Math.max(0, sp.position - contextSize);
      const afterEnd = Math.min(content.length, sp.position + contextSize);

      const beforeContext = content.slice(beforeStart, sp.position);
      const afterContext = content.slice(sp.position, afterEnd);

      return {
        beforeContext,
        afterContext,
        originalPosition: sp.position,
        index: sp.index,
      };
    });

    // 并行执行所有定界任务
    const results = await Promise.all(
      requests.map((req) => this.detectSingleBoundary(req))
    );

    return results;
  }

  /**
   * 执行单个定界任务
   *
   * @param request 定界请求
   * @returns 定界结果
   */
  private async detectSingleBoundary(
    request: BoundaryDetectionRequest
  ): Promise<BoundaryDetectionResult> {
    // 构建定界 prompt
    const prompt = this.buildBoundaryPrompt(request);

    try {
      // 调用后端 LLM（使用 call_model2_raw_prompt）
      const response = await invoke<{
        assistant_message: string;
        input_tokens: number;
        output_tokens: number;
      }>('call_llm_for_boundary', {
        prompt,
      });

      // 解析 LLM 响应
      const result = this.parseBoundaryResponse(response.assistant_message);

      return {
        index: request.index,
        offset: result.offset,
        reason: result.reason,
        confidence: result.confidence,
      };
    } catch (error: unknown) {
      // LLM 调用失败，fallback 到硬分割点（偏移量为 0）
      console.error(`LLM 定界失败（索引 ${request.index}）:`, error);

      return {
        index: request.index,
        offset: 0,
        reason: 'LLM 调用失败，使用硬分割点',
        confidence: 0.5,
      };
    }
  }

  /**
   * 构建定界 prompt
   *
   * @param request 定界请求
   * @returns prompt 字符串
   */
  private buildBoundaryPrompt(request: BoundaryDetectionRequest): string {
    return `你是文档分段专家。你的任务是在给定的文本分割点附近找到最佳的语义边界。

【当前分割点上下文】

==== 分割点之前的内容 ====
${request.beforeContext}
==== [分割点] ====
${request.afterContext}
==== 分割点之后的内容 ====

【任务】
分析上述文本，在分割点附近找到最佳的语义边界。

【优先级】
1. 章节/标题边界（如 "## 章节标题"、"第一章"等）
2. 段落边界（空行分隔）
3. 句子边界（句号、问号、感叹号）
4. 词边界（空格、标点）

【输出格式】
请以 JSON 格式输出，包含以下字段：
{
  "offset": <数字，相对于原始分割点的偏移量，正数表示向后移动，负数表示向前移动，范围 -${this.config.boundaryContext} 到 +${this.config.boundaryContext}>,
  "reason": "<字符串，说明为什么选择这个位置>",
  "confidence": <数字，0-1 之间，表示你对这个边界选择的信心程度>
}

【示例】
如果在分割点之前 50 个字符处有一个章节标题，应该输出：
{
  "offset": -50,
  "reason": "章节标题边界：'## 第二章'",
  "confidence": 0.95
}

如果分割点正好在段落边界，应该输出：
{
  "offset": 0,
  "reason": "段落边界（空行）",
  "confidence": 0.9
}

请直接输出 JSON，不要包含任何其他文字。`;
  }

  /**
   * 解析 LLM 定界响应
   *
   * @param response LLM 返回的字符串
   * @returns 解析后的定界响应
   */
  private parseBoundaryResponse(response: string): BoundaryDetectionResponse {
    try {
      // 尝试提取 JSON（可能包含在 markdown 代码块中）
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('未找到 JSON 内容');
      }

      const parsed = JSON.parse(jsonMatch[0]) as BoundaryDetectionResponse;

      // 验证字段
      if (
        typeof parsed.offset !== 'number' ||
        typeof parsed.reason !== 'string' ||
        typeof parsed.confidence !== 'number'
      ) {
        throw new Error('JSON 格式不正确');
      }

      // 限制偏移量范围
      const maxOffset = this.config.boundaryContext;
      parsed.offset = Math.max(
        -maxOffset,
        Math.min(maxOffset, parsed.offset)
      );

      // 限制置信度范围
      parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));

      return parsed;
    } catch (error: unknown) {
      // 解析失败，返回默认值（不偏移）
      console.error('解析 LLM 定界响应失败:', error, '原始响应:', response);

      return {
        offset: 0,
        reason: '解析失败，使用原始分割点',
        confidence: 0.5,
      };
    }
  }

  /**
   * 阶段三：构建最终分段
   *
   * @param content 原始文档
   * @param boundaries 边界位置列表
   * @returns 文档分段列表
   */
  private buildSegments(content: string, boundaries: number[]): DocumentSegment[] {
    const segments: DocumentSegment[] = [];

    // 确保边界列表包含起点和终点
    const allBoundaries = [0, ...boundaries, content.length];

    // 去重并排序
    const uniqueBoundaries = Array.from(new Set(allBoundaries)).sort(
      (a, b) => a - b
    );

    // 构建分段
    for (let i = 0; i < uniqueBoundaries.length - 1; i++) {
      const startPosition = uniqueBoundaries[i];
      const endPosition = uniqueBoundaries[i + 1];
      const segmentContent = content.slice(startPosition, endPosition);

      // 过滤掉过小的分段
      const estimatedTokens = this.estimateTokens(segmentContent);
      if (estimatedTokens < this.config.minSegmentSize && i > 0) {
        // 合并到上一个分段
        const lastSegment = segments[segments.length - 1];
        if (lastSegment) {
          lastSegment.endPosition = endPosition;
          lastSegment.content = content.slice(
            lastSegment.startPosition,
            endPosition
          );
          lastSegment.estimatedTokens = this.estimateTokens(lastSegment.content);
        }
        continue;
      }

      segments.push({
        index: segments.length,
        startPosition,
        endPosition,
        content: segmentContent,
        estimatedTokens,
      });
    }

    return segments;
  }

  /**
   * Token 估算（复用后端逻辑）
   *
   * 规则：
   * - 中文：1 token/字符
   * - 英文：约 1.3 tokens/词
   * - 其他：0.2 tokens/字符
   *
   * @param text 文本内容
   * @returns 估算的 token 数
   */
  private estimateTokens(text: string): number {
    let totalTokens = 0;

    // 正则：匹配英文单词
    const wordRegex = /[a-zA-Z]+/g;
    const words = text.match(wordRegex) || [];
    totalTokens += words.length * 1.3;

    // 移除英文单词后，剩余的字符
    const remainingText = text.replace(wordRegex, '');

    for (const char of remainingText) {
      totalTokens += this.estimateCharTokens(char);
    }

    return Math.ceil(totalTokens);
  }

  /**
   * 估算单个字符的 token 数
   *
   * @param char 单个字符
   * @returns token 数
   */
  private estimateCharTokens(char: string): number {
    const code = char.charCodeAt(0);

    // 中文字符（CJK Unified Ideographs）
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0x20000 && code <= 0x2a6df) || // 扩展 B
      (code >= 0x2a700 && code <= 0x2b73f) || // 扩展 C
      (code >= 0x2b740 && code <= 0x2b81f) || // 扩展 D
      (code >= 0x2b820 && code <= 0x2ceaf) // 扩展 E/F
    ) {
      return 1.0;
    }

    // 英文字母和数字（在 estimateTokens 中已按词处理）
    if (
      (code >= 0x0061 && code <= 0x007a) || // a-z
      (code >= 0x0041 && code <= 0x005a) || // A-Z
      (code >= 0x0030 && code <= 0x0039) // 0-9
    ) {
      return 0; // 已在 estimateTokens 中按词计算
    }

    // 其他字符（标点、空格等）
    return 0.2;
  }

  /**
   * 获取当前配置
   */
  getConfig(): Readonly<SegmentConfig> {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SegmentConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
}
