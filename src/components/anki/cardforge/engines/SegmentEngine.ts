/**
 * CardForge 2.0 - 分段估算引擎
 *
 * 将大文档按 token 估算切分为固定大小的分段，纯数学计算，无任何 LLM 调用。
 *
 * 当前唯一消费者是 CardAgent.analyzeContent（估算分段数供预览）。
 * 真正制卡时的 LLM 语义定界发生在后端生成管线内
 * （streaming_anki_service，经 options.enable_llm_boundary_detection 开启），
 * 与本引擎无关。历史上本引擎内置的前端 LLM 定界实现
 * （detectBoundaries/detectSingleBoundary，经 call_llm_for_boundary 命令）
 * 从未被生产路径启用，已删除。
 *
 * 处理流程：
 * - 文档较小（<= chunkSize tokens）：直接返回单个分段
 * - 否则：硬分割（按固定 token 数）→ 构建分段（合并过小分段）
 */

import type {
  SegmentConfig,
  HardSplitPoint,
  DocumentSegment,
} from '../types';

/**
 * 分段选项
 */
export interface SegmentOptions {
  /** 进度回调 */
  onProgress?: (progress: { phase: string; current: number; total: number }) => void;
}

/**
 * 分段估算引擎
 */
export class SegmentEngine {
  private config: SegmentConfig;

  constructor(config?: Partial<SegmentConfig>) {
    // 导入默认配置
    const defaultConfig: SegmentConfig = {
      chunkSize: 50000,
      minSegmentSize: 5000,
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
      total: 2,
    });

    const splitPoints = this.hardSplit(content);
    const boundaries = splitPoints.map((sp) => sp.position);

    // 阶段二：构建分段
    options?.onProgress?.({
      phase: '构建分段',
      current: 1,
      total: 2,
    });

    const segments = this.buildSegments(content, boundaries);

    options?.onProgress?.({
      phase: '完成',
      current: 2,
      total: 2,
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
   * 阶段二：构建最终分段
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

    // 🔧 F22（round2）：ASCII 字母/数字按约 4 字符/token 计（≈0.25）。
    // 旧实现返回 0（理由是 estimateTokens 已按词处理英文），但 hardSplit 逐字符调用本函数
    // 累计 token，字母返回 0 会导致英文长文几乎不产生硬分割点 → analyzeContent 低估分段数。
    // 注：estimateTokens 在调用本函数前已剥离 [a-zA-Z]+ 单词，故该调整不影响其英文词级估算，
    // 仅令 hardSplit 的英文累计与词级估算大致一致（约 5-6 字符/词 × 0.25 ≈ 1.3 token/词）。
    if (
      (code >= 0x0061 && code <= 0x007a) || // a-z
      (code >= 0x0041 && code <= 0x005a) || // A-Z
      (code >= 0x0030 && code <= 0x0039) // 0-9
    ) {
      return 0.25;
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
