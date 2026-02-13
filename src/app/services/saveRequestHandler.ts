import type React from 'react';
import { TauriAPI } from '@/utils/tauriApi';
import type { MistakeItem } from '@/types';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ChatMessage } from './types';
import { getStableMessageId } from './types';

// ★ Bridge 完成原因集合已废弃（2026-01 清理）

/**
 * 依赖接口 - 从 App.tsx 传入
 */
export interface SaveRequestHandlerDeps {
  analysisResult: any;
  analysisBusinessSessionId: string | null;
  t: (key: string, options?: any) => string;
  setAnalysisBusinessSessionId: (id: string) => void;
  setAnalysisHostKeepAlive: (value: boolean) => void;
  setCurrentView: (view: any) => void;
  handleViewChange: (view: any) => void;
  latestGenerationBySessionRef: React.MutableRefObject<Map<string, number>>;
}

/**
 * 创建保存请求处理函数
 */
export function createSaveRequestHandler(deps: SaveRequestHandlerDeps) {
  const {
    analysisResult,
    analysisBusinessSessionId,
    t,
    setAnalysisBusinessSessionId,
    setAnalysisHostKeepAlive,
    setCurrentView,
    handleViewChange,
    latestGenerationBySessionRef,
  } = deps;

  return async (data: any) => {
    // 实现原App.tsx中的保存逻辑
    // 在自动保存场景下，对部分“防御性错误”降级为内部告警，避免打扰用户
    let isAutoSave = false;
    try {
      console.log('🔍 App.tsx保存请求:', data);
      console.log('📊 analysisResult:', analysisResult);
      const saveSource: 'auto' | 'manual' | string = typeof data?.saveSource === 'string' ? data.saveSource : 'manual';
      isAutoSave = saveSource === 'auto';
      const autosaveSignature = typeof data?.autosaveSignature === 'string' && data.autosaveSignature.trim().length > 0
        ? data.autosaveSignature.trim()
        : null;
      const saveReason = data?.saveReason || data?.persistenceMeta?.reason || (isAutoSave ? 'auto-save' : 'manual-save');
      const payloadGenerationId = typeof data?.generationId === 'number' ? data.generationId : null;

      const normalizedChatHistory: ChatMessage[] = Array.isArray(data.normalizedChatHistory)
        ? data.normalizedChatHistory
        : Array.isArray(data.chatHistory)
          ? data.chatHistory
          : [];

      // 持久化元信息（签名、原因等）
      if (data.persistenceMeta) {
        console.log('🧾 [PersistenceMeta]', data.persistenceMeta);
      }

      const effectiveBusinessId = [
        data.businessSessionId,
        data.originalBusinessSessionId,
        analysisBusinessSessionId,
        // 🎯 统一架构：移除 selectedMistake?.id，会话 ID 由 Store 管理
      ]
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .find((id) => id.length > 0) || '';

      const requestedChatCategory: 'analysis' | 'general_chat' =
        data.chatCategory === 'general_chat' ? 'general_chat' : 'analysis';
      const chatMetadataProvided = data && Object.prototype.hasOwnProperty.call(data, 'chatMetadata');
      const incomingChatMetadata = chatMetadataProvided ? (data.chatMetadata ?? null) : undefined;

      const runtimeSnapshot = data.runtimeSnapshot;
      const normalizedHistoryBase = Array.isArray(data.normalizedChatHistory) && data.normalizedChatHistory.length > 0
        ? data.normalizedChatHistory
        : normalizedChatHistory;
      const normalizedHistoryForSave: ChatMessage[] = Array.isArray(runtimeSnapshot?.normalizedMessages)
        && runtimeSnapshot.normalizedMessages.length > 0
        ? runtimeSnapshot.normalizedMessages
        : normalizedHistoryBase;
      const snapshotHistory: ChatMessage[] = Array.isArray(runtimeSnapshot?.messagesWithThinking)
        && runtimeSnapshot.messagesWithThinking.length > 0
        ? runtimeSnapshot.messagesWithThinking
        : Array.isArray(data.chatHistory) && data.chatHistory.length > 0
          ? data.chatHistory
          : normalizedHistoryForSave;
      const snapshotStableIds: string[] | undefined = Array.isArray(runtimeSnapshot?.stableIds)
        ? runtimeSnapshot.stableIds
        : Array.isArray(data.persistenceMeta?.stableIds)
          ? data.persistenceMeta?.stableIds
          : undefined;
      const rawSignaturePayload = typeof data.signaturePayload === 'string' && data.signaturePayload.trim().length > 0
        ? data.signaturePayload.trim()
        : typeof runtimeSnapshot?.signaturePayload === 'string' && runtimeSnapshot.signaturePayload.length > 0
          ? runtimeSnapshot.signaturePayload
          : JSON.stringify(normalizedHistoryForSave);
      const summaryFromSnapshot = typeof runtimeSnapshot?.summaryText === 'string' ? runtimeSnapshot.summaryText : null;
      const summaryFromData = typeof data.summaryContent === 'string' && data.summaryContent.trim().length > 0
        ? data.summaryContent.trim()
        : null;
      const resolvedSummaryContent = summaryFromData ?? summaryFromSnapshot ?? null;
      const summaryCompleteFlag = summaryFromData
        ? true
        : Boolean(runtimeSnapshot?.summaryIncluded && summaryFromSnapshot && summaryFromSnapshot.trim().length > 0);
      const thinkingRecord = (() => {
        const source = data.thinkingContent;
        if (source instanceof Map) {
          const out: Record<string, string> = {};
          source.forEach((value, key) => {
            if (typeof key === 'string' && typeof value === 'string' && value.trim().length > 0) {
              out[key] = value;
            }
          });
          return Object.keys(out).length > 0 ? out : undefined;
        }
        if (source && typeof source === 'object') {
          const out: Record<string, string> = {};
          Object.entries(source as Record<string, unknown>).forEach(([key, value]) => {
            if (typeof value === 'string' && value.trim().length > 0) {
              out[key] = value;
            }
          });
          return Object.keys(out).length > 0 ? out : undefined;
        }
        return undefined;
      })();

      const rebuildThinkingContentMap = (mistake: MistakeItem) => {
        const map = new Map<string, string>();
        (mistake.chat_history || []).forEach((message: any, index: number) => {
          if (message.role === 'assistant' && message.thinking_content) {
            const stableId = getStableMessageId(message, index);
            map.set(stableId, message.thinking_content);
          }
        });
        return map;
      };

      const generationKeys = [
        data.businessSessionId,
        data.originalBusinessSessionId,
        analysisBusinessSessionId,
        effectiveBusinessId,
      ]
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id, index, arr) => id.length > 0 && arr.indexOf(id) === index);

      const targetMistakeId = generationKeys[0] ?? null;

      // 首轮即正式架构：所有ID都是正式mistake_id，只需检查是否为空
      if (!targetMistakeId) {
        console.warn('[App.handleSaveRequest] 缺少正式错题 ID，无法执行保存', {
          data,
          effectiveBusinessId,
        });
        return { success: false, reason: 'missing-business-session-id' };
      }

      if (payloadGenerationId !== null && generationKeys.length > 0) {
        let isStale = false;
        let latestKnown = Number.NEGATIVE_INFINITY;
        for (const key of generationKeys) {
          const last = latestGenerationBySessionRef.current.get(key);
          if (typeof last === 'number') {
            if (payloadGenerationId < last) {
              isStale = true;
            }
            if (last > latestKnown) latestKnown = last;
          }
        }
        if (isStale) {
          console.warn('[App.handleSaveRequest] 检测到过期保存请求，已丢弃', {
            payloadGenerationId,
            latestKnown: latestKnown === Number.NEGATIVE_INFINITY ? null : latestKnown,
            keys: generationKeys,
          });
          return { success: false, reason: 'stale-generation', latestGenerationId: latestKnown };
        }
        for (const key of generationKeys) {
          latestGenerationBySessionRef.current.set(key, payloadGenerationId);
        }
      }

      const runtimeResponse = await TauriAPI.runtimeAutosaveCommit({
        businessSessionId: targetMistakeId,
        snapshot: {
          history: snapshotHistory,
          normalizedHistory: normalizedHistoryForSave,
          thinkingContent: thinkingRecord,
          summaryContent: resolvedSummaryContent ?? undefined,
          summaryComplete: summaryCompleteFlag,
          signaturePayload: rawSignaturePayload,
          stableIds: snapshotStableIds,
        },
        saveSource,
        saveReason,
        reason: data.persistenceMeta?.reason,
        chatCategory: requestedChatCategory,
        chatMetadata: chatMetadataProvided ? (incomingChatMetadata ?? null) : undefined,
        autosaveSignature: autosaveSignature ?? undefined,
        generationId: payloadGenerationId ?? undefined,
      });

      if (!runtimeResponse?.success || !runtimeResponse.finalMistakeItem) {
        const runtimeReason = runtimeResponse?.reason || 'runtime_autosave_error';
        throw new Error(`persist_failed:${runtimeReason}`);
      }

      const finalMistakeItem = runtimeResponse.finalMistakeItem;
      if (runtimeResponse.success) {
        let resolvedMistake: MistakeItem | null = finalMistakeItem;

        if (resolvedMistake && (chatMetadataProvided || requestedChatCategory === 'general_chat')) {
          try {
            const patched: MistakeItem = {
              ...resolvedMistake,
              chat_category: requestedChatCategory,
              ...(chatMetadataProvided ? { chat_metadata: incomingChatMetadata ?? null } : {}),
            };
            resolvedMistake = await TauriAPI.updateMistake(patched);
          } catch (patchError) {
            console.warn('⚠️ [App.handleSaveRequest] 更新聊天元数据失败:', patchError);
          }
        }
        
        if (!resolvedMistake) {
          throw new Error('runtime_autosave_commit_missing_result');
        }

        // 🎯 通用态改造：入库后会话提升 - 更新 analysisBusinessSessionId
        const savedMistakeId = resolvedMistake.id;
        if (savedMistakeId) {
          setAnalysisBusinessSessionId(savedMistakeId);
        }
        if (!isAutoSave) {
          showGlobalNotification('success', t('common:messages.success.mistake_saved_to_library'));
        }
        try {
          const sessionId = data.originalInputs?.examSheet?.session_id
            || resolvedMistake.exam_sheet?.session_id
            || (resolvedMistake.exam_sheet as any)?.sessionId
            || (resolvedMistake.exam_sheet as any)?.sessionID;
          if (sessionId) {
            window.dispatchEvent(
              new CustomEvent('examSheetSessionLinked', {
                detail: {
                  sessionId,
                  mistakeId: resolvedMistake.id,
                },
              }),
            );
          }
        } catch (eventError) {
          console.warn('触发 examSheetSessionLinked 事件失败:', eventError);
        }
        if (!isAutoSave) {
          setAnalysisHostKeepAlive(false);
          try { setCurrentView('learning-hub'); } catch {}
        }
        
        // ★ Bridge 流程已废弃（2026-01 清理）：link_finish 调用已移除
        
        // 🎯 优先处理前端传递的总结内容
        if (data.summaryContent && resolvedMistake) {
          try {
            console.log('[App] Saving frontend-generated summary content to database...');

            // 改进解析逻辑，保持原始格式
            const parseSummaryContent = (content: string) => {
              console.log('[App] Summary parse - content length:', content.length);
              console.log('[App] Summary parse - content preview:', content.substring(0, 200) + '...');

              // 策略1：如果内容较短或者没有明显的分段标识，保存到第一个字段
              const lines = content.split('\n');
              const hasNumberedSections = lines.some(line => /^\s*\d+\.\s*(核心知识点|错误分析|学习建议)/.test(line));
              const hasMarkdownSections = lines.some(line => /^#+\s*(核心知识点|错误分析|学习建议)/.test(line));

              if (!hasNumberedSections && !hasMarkdownSections) {
                console.log('[App] Summary parse - no clear sections, saving to mistake_summary');
                return {
                  mistakeSummary: content.trim(),
                  userErrorAnalysis: null,
                };
              }
              
              // 🎯 策略2：尝试分段，但保持更完整的内容
              let mistakeSummary = '';
              let userErrorAnalysis = '';
              let currentSection = '';
              let includeCurrentLine = false;

              for (const line of lines) {
                const trimmedLine = line.trim();
                
                // 检测章节标题
                if (/^\s*\d+\.\s*核心知识点|^#+\s*核心知识点|题目解析|正确解法/.test(trimmedLine)) {
                  currentSection = 'mistake_summary';
                  includeCurrentLine = true;
                } else if (/^\s*\d+\.\s*错误分析|^#+\s*错误分析|^\s*\d+\.\s*学习建议|^#+\s*学习建议|薄弱环节/.test(trimmedLine)) {
                  currentSection = 'user_error_analysis';
                  includeCurrentLine = true;
                } else {
                  includeCurrentLine = true;
                }
                
                if (includeCurrentLine) {
                  if (currentSection === 'mistake_summary') {
                    mistakeSummary += line + '\n';
                  } else if (currentSection === 'user_error_analysis') {
                    userErrorAnalysis += line + '\n';
                  } else if (!currentSection) {
                    // 如果还没有检测到分段，先放到第一个字段
                    mistakeSummary += line + '\n';
                  }
                }
              }

              // 🎯 策略3：如果分段后某个字段为空，将所有内容保存到第一个字段
              if (!mistakeSummary.trim() && !userErrorAnalysis.trim()) {
                console.log('📄 [总结解析] 分段失败，保存完整内容到mistake_summary');
                return {
                  mistakeSummary: content.trim(),
                  userErrorAnalysis: null,
                };
              }
              
              console.log('📄 [总结解析] 分段结果:', {
                mistakeSummaryLength: mistakeSummary.trim().length,
                userErrorAnalysisLength: userErrorAnalysis.trim().length
              });

              return {
                mistakeSummary: mistakeSummary.trim() || null,
                userErrorAnalysis: userErrorAnalysis.trim() || null,
              };
            };
            
            const { mistakeSummary, userErrorAnalysis } = parseSummaryContent(data.summaryContent);
            
            // 更新错题记录，添加总结字段
            const updatedMistake = {
              ...resolvedMistake,
              mistake_summary: mistakeSummary,
              user_error_analysis: userErrorAnalysis,
              status: "completed", // 🎯 修复：设置状态为已完成
              updated_at: new Date().toISOString(),
            };
            
            await TauriAPI.updateMistake(updatedMistake);
            console.log('✅ 前端总结内容已成功保存到数据库');
            
          } catch (error) {
            console.error('保存前端总结内容失败:', error);
            showGlobalNotification('error', t('common:messages.error.summary_save_failed') + ': ' + getErrorMessage(error));
          }

          // ★ 错题记忆通过 UserMemory 系统和记忆内化→知识图谱实现
        }

        // 成功保存后：手动保存仍然跳转回错题库；自动保存保持在当前分析/详情视图
        if (!isAutoSave) {
          try {
            handleViewChange('library');
          } catch {}
        }

        return { success: true, final_mistake_item: resolvedMistake };
      } else {
        showGlobalNotification('error', t('common:messages.error.save_failed_retry'));
      }
    } catch (error) {
      const friendly = getErrorMessage(error);
      // 非致命：自动保存场景下，TempSession 尚未就绪或已被清理，后续强提交仍会完成入库
      if (isAutoSave && typeof friendly === 'string' && friendly.includes('临时会话不存在')) {
        console.warn('[App.handleSaveRequest] 非致命自动保存错误：临时会话不存在', {
          error: friendly,
          data,
        });
        return { success: false, reason: 'temp-session-not-found', error: friendly };
      }

      console.error('保存失败:', error);
      // ★ Bridge 回滚已废弃（2026-01 清理）
      showGlobalNotification('error', t('common:messages.error.save_failed_with_details') + ': ' + friendly);
      throw error;
    }
  };
}
