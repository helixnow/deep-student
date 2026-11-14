/**
 * L02 llm 批改适配器：真实读取题目/材料/作答图并驱动 `llmStreaming` 补全。
 *
 * 对应 Rust `qbank_grading/pipeline.rs::grade_practice_snapshot`：
 * 取图 → 构造 prompt → 解析评判配置 → 流式补全 → verdict/score 解析。
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { AppError as AppErrorValue } from '../../../platform/errors/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import type { LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { AnswerSubmission } from '../api.ts';
import { fetchContextImages, fetchImageAnswerContents, guessImageMime,
  type ImageAnswerSourceHost } from './grading-images.ts';
import type { GradingImage } from './grading-context.ts';
import { buildPrompts, parseVerdictAndScore } from './grading-prompts.ts';
import { resolveGradingConfig } from './grading-service.ts';
import { GradingStreamState } from './grading-stream.ts';
import { runSingleShotGrading } from './llm-completion.ts';
import {
  PracticeGradingFailure, type PracticeGradingRequest, type PracticeGradingResponse,
  type PracticeGrader,
} from './practice-grading-queue.ts';

export interface PracticeGraderDeps {
  llm(): LLMManager | undefined;
  streaming(): LlmStreamingService | undefined;
  images(): ImageAnswerSourceHost | undefined;
}

function asAppError(error: unknown): AppErrorValue {
  if (error instanceof CommandError) return error.value as AppErrorValue;
  if (error !== null && typeof error === 'object') {
    if ('appError' in error) return (error as { appError: AppErrorValue }).appError;
    if ('error_type' in error) return error as AppErrorValue;
  }
  return AppError.llm(error instanceof Error ? error.message : String(error));
}

function failure(error: unknown, feedback = ''): PracticeGradingFailure {
  return new PracticeGradingFailure(asAppError(error), feedback, null);
}

export function llmPracticeGrader(deps: PracticeGraderDeps): PracticeGrader {
  return {
    async grade(request: PracticeGradingRequest): Promise<PracticeGradingResponse> {
      const llm = deps.llm();
      if (llm === undefined) throw failure(AppError.configuration('AI 批改服务不可用：llm 服务未提供'));
      const streaming = deps.streaming();
      if (streaming === undefined) {
        throw failure(AppError.configuration('AI 批改服务不可用：L02 llmStreaming 服务未提供'));
      }
      const imagesHost = deps.images();
      const needsImages = request.imageAnswer !== null
        || request.context.materials.some(material => material.images.length > 0)
        || request.context.question_images.length > 0;
      if (needsImages && imagesHost === undefined) {
        throw failure(AppError.configuration('VFS 仓库服务未提供'));
      }

      let contextImages: GradingImage[] = [];
      let answerImages: string[] = [];
      if (imagesHost !== undefined) {
        try {
          contextImages = fetchContextImages(
            imagesHost, request.context.materials, request.context.question_images);
          request.context.images = contextImages;
          answerImages = request.imageAnswer === null
            ? [] : fetchImageAnswerContents(imagesHost, request.imageAnswer);
        } catch (error) {
          throw failure(error);
        }
      }

      const submission: AnswerSubmission = {
        id: request.jobId,
        question_id: request.question.id,
        user_answer: request.answer,
        is_correct: null,
        grading_method: 'ai',
        submitted_at: rfc3339Now(),
      };
      const prompt = buildPrompts(
        request.question, request.context, submission, [], 'grade', request.imageAnswer);
      const images: GradingImage[] = [...contextImages];
      for (const [index, base64] of answerImages.entries()) {
        images.push({
          base64,
          mime: guessImageMime(base64),
          label: `学生作答图 ${index + 1}`,
        });
      }

      let config: Awaited<ReturnType<typeof resolveGradingConfig>>;
      try {
        config = await resolveGradingConfig(llm, null, images.length > 0);
      } catch (error) {
        throw failure(error);
      }
      const stream = new GradingStreamState({
        id: config.id, model: config.model, max_output_tokens: config.maxOutputTokens,
        max_tokens_limit: config.maxTokensLimit,
      });
      const result = await runSingleShotGrading(llm, streaming, {
        config: config.config,
        apiKey: config.apiKey,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        eventName: `practice_${request.jobId}`,
        images,
        stream,
        onChunk: () => undefined,
      });
      if (result.error !== null) {
        throw new PracticeGradingFailure(result.error, result.content, stream.diagnostics);
      }
      const feedback = result.content;
      const { verdict, score } = parseVerdictAndScore(feedback);
      if (verdict === null) {
        const message = 'AI 批改缺少有效判定，已保留反馈草稿，仍待批改';
        throw new PracticeGradingFailure(AppError.llm(message), feedback,
          { ...stream.diagnostics, status: 'invalid_result', error_message: 'AI 批改缺少有效判定' });
      }
      return { verdict, score, feedback, diagnostics: stream.diagnostics };
    },
  };
}
