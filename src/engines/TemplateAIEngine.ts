/**
 * 模板 AI 事件引擎
 * 
 * 监听模板 AI 流式事件并更新状态
 */

import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useTemplateAIStore } from '../stores/templateAiStore';
import { CreateTemplateRequest } from '../types';
import { getErrorMessage } from '../utils/errorUtils';
import i18n from '../i18n';

export class TemplateAIEngine {
  private sessionId: string;
  private unlisteners: UnlistenFn[] = [];
  private started = false;
  private lastAssistantSignature: string | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * 开始监听事件
   */
  async start(): Promise<void> {
    if (this.started) return; // 防止重复启动导致重复监听
    this.started = true;
    const eventBase = `template_ai_stream_${this.sessionId}`;

    // 开始事件：重置并标记流式中
    const startListener = await listen<{ id: string }>(
      `${eventBase}_start`,
      () => {
        const s = useTemplateAIStore.getState();
        // 清空上一轮的流式内容，但不要动 messages
        s.resetStreamState();
        s.setStreamState({ isStreaming: true, error: undefined, tokensUsed: undefined });
      }
    );
    this.unlisteners.push(startListener);
    
    // 监听内容流
    const contentListener = await listen<{ content: string; is_complete?: boolean }>(
      eventBase,
      (event) => {
        const store = useTemplateAIStore.getState();
        
        // 🔥 关键修复：检测 is_complete 标志，避免重复拼接完整内容
        if (event.payload.is_complete) {
          // 最后一块是完整内容，直接覆盖而不是累加
          store.setStreamState({
            currentContent: event.payload.content,
            isStreaming: true,
          });
        } else {
          // 增量块，累加到当前内容
          const currentContent = store.streamState.currentContent + event.payload.content;
          store.setStreamState({
            currentContent,
            isStreaming: true,
          });
        }
      }
    );
    this.unlisteners.push(contentListener);

    // 监听思维链
    const reasoningListener = await listen<{ content: string; is_complete?: boolean }>(
      `${eventBase}_reasoning`,
      (event) => {
        const store = useTemplateAIStore.getState();
        
        // 🔥 关键修复：字段名改为 content（与后端 StreamChunk 结构一致），并支持 is_complete
        if (event.payload.is_complete) {
          // 最后一块是完整内容，直接覆盖
          store.setStreamState({
            thinkingContent: event.payload.content,
          });
        } else {
          // 增量块，累加
          const thinkingContent = store.streamState.thinkingContent + event.payload.content;
          store.setStreamState({
            thinkingContent,
          });
        }
      }
    );
    this.unlisteners.push(reasoningListener);

    // 监听 JSON 结果
    const jsonListener = await listen<{
      template: CreateTemplateRequest;
      warnings: string[];
      summary?: Record<string, any>;
      changes?: Record<string, any>;
    }>(`${eventBase}_json`, (event) => {
      const store = useTemplateAIStore.getState();
      const assistantContentRaw = store.streamState.currentContent;
      const assistantContent = assistantContentRaw.trim();

      if (assistantContent.length > 0) {
        const sig = `${assistantContent.length}:${assistantContent.slice(0, 64)}`;
        if (this.lastAssistantSignature === sig) {
          return; // 去重：避免重复助手消息
        }
        store.addMessage({
          id: Date.now().toString(),
          session_id: this.sessionId,
          role: 'assistant',
          content: assistantContentRaw,
          created_at: new Date().toISOString(),
        });
        this.lastAssistantSignature = sig;
      } else {
        // 后端未提供内容流时，生成一条精简的可读消息，确保对话区有记录
        try {
          const tpl = event.payload?.template as CreateTemplateRequest | undefined;
          const name = tpl?.name || 'Template';
          const noteType = tpl?.note_type || 'Unknown';
          const fieldCount = Array.isArray(tpl?.fields) ? tpl!.fields.length : undefined;
          const summary = fieldCount != null
            ? i18n.t('anki:template_ai.assistant_generated_summary_with_count', { name, count: fieldCount, noteType })
            : i18n.t('anki:template_ai.assistant_generated_summary', { name, noteType });
          const sig = `${summary.length}:${summary.slice(0, 64)}`;
          if (this.lastAssistantSignature === sig) {
            // 已记录
          } else {
            store.addMessage({
              id: Date.now().toString(),
              session_id: this.sessionId,
              role: 'assistant',
              content: summary,
              created_at: new Date().toISOString(),
            });
            this.lastAssistantSignature = sig;
          }
        } catch {}
      }

      store.resetStreamState();
      store.setLatestCandidate(event.payload.template);
      store.setValidationWarnings(event.payload.warnings || []);
      store.setLatestSummary(event.payload.summary ?? null);
      store.setRecentChanges(event.payload.changes ?? null);
      
      console.log('✅ 模板生成完成:', event.payload.template);
    });
    this.unlisteners.push(jsonListener);

    // 监听用量
    const usageListener = await listen<any>(
      `${eventBase}_usage`,
      (event) => {
        try {
          const store = useTemplateAIStore.getState();
          const tokens =
            (event?.payload?.total_tokens ?? event?.payload?.input_tokens ?? event?.payload?.output_tokens)
            ?? undefined;
          if (typeof tokens === 'number' && Number.isFinite(tokens)) {
            if (store.streamState.tokensUsed !== tokens) {
              store.setStreamState({ tokensUsed: tokens });
            }
          }
          console.log('📊 用量统计:', event.payload);
        } catch (e) {
          console.warn('用量事件处理失败', e);
        }
      }
    );
    this.unlisteners.push(usageListener);

    // 监听错误
    const errorListener = await listen<{ error: string }>(
      `${eventBase}_error`,
      (event) => {
        const store = useTemplateAIStore.getState();

        // 在解析 JSON 失败等错误场景下，仍将已累积的 AI 流式内容作为助手消息显示出来
        const assistantContentRaw = store.streamState.currentContent;
        if (assistantContentRaw && assistantContentRaw.trim().length > 0) {
          store.addMessage({
            id: Date.now().toString(),
            session_id: this.sessionId,
            role: 'assistant',
            content: assistantContentRaw,
            created_at: new Date().toISOString(),
          });
        }

        // 重置流状态后，再写入“可读的详细错误”
        const friendly = (() => {
          try {
            // 动态导入，避免打包时循环依赖
            return import('../utils/templateErrorAnalyzer').then((mod) => {
              const raw = store.streamState.currentContent || '';
              const backend = typeof event.payload.error === 'string' ? event.payload.error : '';
              return (mod.analyzeTemplateError?.(raw, backend)) || backend || i18n.t('analysis:input_bar.attachments.parse_failed', { defaultValue: '解析失败' });
            }).catch(() => event.payload.error);
          } catch {
            return event.payload.error;
          }
        })();

        store.resetStreamState();
        if (friendly && typeof (friendly as any).then === 'function') {
          (friendly as Promise<string>).then((msg) => {
            useTemplateAIStore.getState().setStreamState({ isStreaming: false, error: msg });
          });
        } else {
          store.setStreamState({ isStreaming: false, error: friendly as string });
        }
        console.error('❌ 模板生成错误:', event.payload.error);
      }
    );
    this.unlisteners.push(errorListener);

    // 取消事件
    const cancelledListener = await listen<{ reason: string }>(
      `${eventBase}_cancelled`,
      () => {
        const s = useTemplateAIStore.getState();
        s.setStreamState({ isStreaming: false });
      }
    );
    this.unlisteners.push(cancelledListener);

    // 结束事件（无论成功或取消都会发送end）
    const endListener = await listen<any>(
      `${eventBase}_end`,
      () => {
        const s = useTemplateAIStore.getState();
        s.setStreamState({ isStreaming: false });
      }
    );
    this.unlisteners.push(endListener);
  }

  /**
   * 停止监听
   */
  stop(): void {
    this.unlisteners.forEach((fn) => fn());
    this.unlisteners = [];
  }
}
