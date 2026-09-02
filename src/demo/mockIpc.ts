/**
 * Web 演示壳 - IPC Mock 层（真链路方案）
 *
 * - mockIPC(handler, { shouldMockEvents: true })：invoke 拦截 + listen/emit 内存闭环
 * - mockWindows('main')：让 @tauri-apps/api/window 的 getCurrentWindow() 可用
 * - 内存会话库：fixture 会话 + 运行时创建的 draft 会话
 * - chat_v2_send_message：立即返回 assistantMessageId（与真实后端一致），
 *   并异步启动 scriptPlayer 往真实 adapter 的 channel 推流式事件
 *
 * 安装时机：必须在任何 app 模块 import 之前（模块级 isTauriRuntime 常量）。
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type {
  BackendBlock,
  BackendMessage,
  SessionInfo,
} from '@/features/chat/adapters/types';
import { DEMO_MODEL_PROFILES, DEFAULT_FOLLOW_UP, DEMO_SESSIONS, type DemoBlocks } from './fixtures';
import {
  DEMO_ANKI_TEMPLATES,
  DEMO_MINDMAP_CONTENT,
  DEMO_MINDMAP_ID,
  DEMO_MINDMAP_META,
} from './fixtures';
import { abortScript, playReplyScript } from './scriptPlayer';
import { getPlayedHistory } from './playedHistory';

const LOG = '[demo-ipc]';

/**
 * 每个会话的专属剧本只首播一次；之后（含自由输入）走 DEFAULT_FOLLOW_UP 兜底。
 * 播放完成的历史由 playedHistory 快照承载——重进会话直接恢复完成态，
 * 不再重置 playedOnce、不重播第一答（页面刷新才全部重来）。
 */
const playedOnce = new Set<string>();

// ============================================================================
// 内存会话库
// ============================================================================

interface DemoSessionRecord {
  meta: SessionInfo & { groupId?: string | null };
  messages: BackendMessage[];
  blocks: BackendBlock[];
  followUp: DemoBlocks;
}

const sessionDb = new Map<string, DemoSessionRecord>(
  DEMO_SESSIONS.map((f) => [
    f.meta.id,
    { meta: f.meta, messages: f.messages, blocks: f.blocks, followUp: f.followUp },
  ]),
);

let createSeq = 0;

function touch(meta: SessionInfo & { groupId?: string | null }): void {
  meta.updatedAt = new Date().toISOString();
}

// ============================================================================
// Settings KV
// ============================================================================

const SETTINGS_SEED: Record<string, unknown> = {
  // 跳过首次启动引导
  app_initialized: 'true',
  // 已同意用户协议（UserAgreementDialog: 值须等于 USER_AGREEMENT_VERSION '1.0.0'）
  user_agreement_accepted: '1.0.0',
  // 固定经典桌面壳（学习桌面是另一套 UI，demo 演示经典布局）
  'desktop.workbenchMode': 'false',
};

const settingsKV = new Map<string, unknown>(Object.entries(SETTINGS_SEED));

/** 模拟真实 IPC 往返延迟（过快会导致列表挂载前 restore 完成，跳过吸底滚动） */
function withLatency<T>(value: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ============================================================================
// 安装
// ============================================================================

export function installDemoIpcMocks(): void {
  mockWindows('main');

  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;

      switch (cmd) {
        // ---------- settings KV ----------
        case 'get_setting': {
          const key = String(args.key ?? '');
          return settingsKV.has(key) ? settingsKV.get(key) : null;
        }
        case 'save_setting':
          settingsKV.set(String(args.key ?? ''), args.value);
          return null;

        // ---------- 模型 ----------
        case 'get_model_profiles':
          return DEMO_MODEL_PROFILES;
        case 'get_model_assignments':
          return {
            // 预分配 demo 配置：readinessGate 见 model2 已分配即放行；
            // 为 null 会触发 autoAssignAllModels 并弹"已自动分配N个模型"气泡
            model2_config_id: 'demo-config-deepseek',
            anki_card_model_config_id: null,
            qbank_ai_grading_model_config_id: null,
            embedding_model_config_id: null,
            reranker_model_config_id: null,
            chat_title_model_config_id: null,
            exam_sheet_ocr_model_config_id: null,
            translation_model_config_id: null,
            vl_embedding_model_config_id: null,
            vl_reranker_model_config_id: null,
            memory_decision_model_config_id: null,
            review_analysis_model_config_id: null,
            voice_input_asr_model_config_id: null,
          };

        // ---------- Anki 模板（DialogControlProvider 初始化加载；
        // 演示模板让 anki_cards 块走 ShadowDOM 模板渲染 + 翻面，与桌面版一致） ----------
        case 'get_all_custom_templates':
        case 'import_builtin_templates':
          return DEMO_ANKI_TEMPLATES;
        case 'get_default_template_id':
          return DEMO_ANKI_TEMPLATES[0]?.id ?? null;

        // ---------- Anki 卡片写库 / 导出 / 同步（anki_cards 块的操作按钮；
        // 返回诚实语义成功，观众点按钮能看到真实成功反馈而非报错） ----------
        case 'save_anki_cards': {
          const request = (args.request ?? {}) as { cards?: Array<{ id?: string | null }> };
          const cards = Array.isArray(request.cards) ? request.cards : [];
          const persistedIds = cards.map(
            (_, i) => `demo-saved-${Date.now().toString(36)}-${i}`,
          );
          return {
            savedIds: persistedIds,
            taskId: `demo-task-${Date.now().toString(36)}`,
            cardIdMappings: cards.map((card, i) => ({
              inputIndex: i,
              inputId: card?.id ?? null,
              persistedId: persistedIds[i],
            })),
            skippedIds: [],
            duplicatedIds: [],
            failed: [],
          };
        }
        case 'export_multi_template_apkg':
          return `/tmp/deep-student-demo/${String(args.deckName ?? 'demo-cards')}.apkg`;
        case 'add_cards_to_anki_connect': {
          const syncCards = (args.selectedCards as unknown[] | undefined) ?? [];
          return {
            noteIds: syncCards.map((_, i) => 1700000000000 + i),
            added: syncCards.length,
            duplicates: 0,
            failed: 0,
            createdModels: [],
          };
        }

        // ---------- 思维导图（正文 [思维导图:mm_demo_...] 内嵌预览） ----------
        case 'vfs_get_mindmap': {
          const mindmapId = String(args.mindmapId ?? '');
          return mindmapId === DEMO_MINDMAP_ID ? DEMO_MINDMAP_META : null;
        }
        case 'vfs_get_mindmap_content': {
          const mindmapId = String(args.mindmapId ?? '');
          return mindmapId === DEMO_MINDMAP_ID ? DEMO_MINDMAP_CONTENT : null;
        }

        // ---------- App 启动链路的安全默认值 ----------
        // 维护模式闸门（返回 null 会触发 status.is_in_maintenance_mode 解包异常）
        case 'data_governance_get_maintenance_status':
          return {
            is_in_maintenance_mode: false,
            blocked_components: [],
            component_health: { components: [] },
            component_issues: [],
          };
        // 迁移状态（useMigrationStatusListener 读 has_pending_migrations）
        case 'data_governance_get_migration_status':
          return { has_pending_migrations: false, migrations: [] };
        // 待办（reminderScheduler 对返回值做数组迭代）
        case 'todo_list_today':
        case 'todo_list_reminders':
          return [];
        // 窗口外观同步（桌面原生效果，浏览器下静默成功）
        case 'set_window_appearance':
        case 'sync_titlebar_sidebar_material':
        case 'set_sidebar_vibrancy':
        case 'save_webview_settings':
          return null;
        // 路径插件（resolve_directory 用于定位 skills 等目录）
        case 'plugin:path|resolve_directory':
          return '/tmp/deep-student-demo';
        // 技能目录扫描 / dstu 文件监听 / 窗口枚举：演示环境恒为空，静默
        case 'skill_list_directories':
          return [];
        case 'dstu_watch':
        case 'dstu_unwatch':
        case 'plugin:window|get_all_windows':
          return null;
        // 更新检查（useAppUpdater: check() 返回 falsy → 视为已是最新）
        case 'plugin:updater|check':
          return null;

        // ---------- 文档任务/卡片（adapter 副加载） ----------
        case 'get_document_tasks':
        case 'get_document_cards':
          return [];
        // 工作区恢复（useWorkspaceRestore 对返回值读 .length）
        case 'workspace_list_all':
          return [];
        // 会话 token 用量角标
        case 'llm_usage_session_summary':
          return { total_tokens: 0, total_requests: 0 };

        // ---------- 设置页预热的列表型命令（真实桌面版启动时同样预热） ----------
        case 'get_api_configurations':
          // 一条演示配置：避免"未配置 AI 服务"banner；名称明确标注演示
          return [
            {
              id: 'demo-config-deepseek',
              name: '演示模型服务',
              vendorId: 'deepseek',
              vendorName: 'DeepSeek',
              providerType: 'openai',
              apiKey: 'demo-key-not-real',
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-v4',
              isMultimodal: false,
              isReasoning: true,
              isEmbedding: false,
              isReranker: false,
              enabled: true,
              modelAdapter: 'openai',
            },
          ];
        case 'get_available_ocr_models':
        case 'get_ocr_engines':
          return [];
        case 'get_ocr_thinking_enabled':
          return false;
        case 'save_model_assignments':
        case 'add_ocr_engine':
        case 'remove_ocr_engine':
        case 'update_ocr_engine_priority':
          return null;

        // ---------- 会话列表 / 计数 / 详情 ----------
        case 'chat_v2_list_sessions': {
          const status = String(args.status ?? 'active');
          const groupId = args.groupId as string | undefined;
          const all = [...sessionDb.values()].map((r) => r.meta);
          let list = all.filter((s) => s.persistStatus === status);
          if (groupId === '*') {
            // demo 会话均不分组
            list = list.filter((s) => Boolean(s.groupId));
          } else if (groupId === '') {
            list = list.filter((s) => !s.groupId);
          }
          list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const offset = Number(args.offset ?? 0);
          const limit = Number(args.limit ?? list.length);
          return list.slice(offset, offset + limit);
        }
        case 'chat_v2_count_sessions': {
          const status = String(args.status ?? 'active');
          const groupId = args.groupId as string | undefined;
          let list = [...sessionDb.values()]
            .map((r) => r.meta)
            .filter((s) => s.persistStatus === status);
          if (groupId === '*') list = list.filter((s) => Boolean(s.groupId));
          if (groupId === '') list = list.filter((s) => !s.groupId);
          return list.length;
        }
        case 'chat_v2_get_session': {
          const rec = sessionDb.get(String(args.sessionId ?? ''));
          return rec ? rec.meta : null;
        }
        case 'chat_v2_create_session': {
          const now = new Date();
          const meta: DemoSessionRecord['meta'] = {
            id: `demo-draft-${Date.now().toString(36)}-${createSeq++}`,
            mode: String(args.mode ?? 'default'),
            persistStatus: 'active',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            groupId: (args.groupId as string | null | undefined) ?? null,
            metadata: (args.metadata as Record<string, unknown> | undefined) ?? undefined,
          };
          sessionDb.set(meta.id, { meta, messages: [], blocks: [], followUp: [] });
          console.info(LOG, 'session created:', meta.id);
          return meta;
        }
        case 'chat_v2_delete_session': {
          sessionDb.delete(String(args.sessionId ?? ''));
          return null;
        }
        case 'chat_v2_archive_session': {
          const rec = sessionDb.get(String(args.sessionId ?? ''));
          if (rec) rec.meta.persistStatus = 'archived';
          return null;
        }

        // ---------- 会话加载 ----------
        case 'chat_v2_load_session': {
          const sessionId = String(args.sessionId ?? '');
          const rec = sessionDb.get(sessionId);
          if (!rec) {
            console.warn(LOG, 'load_session for unknown session:', args.sessionId);
            return null;
          }
          // 已播放完成的会话：返回播放结果快照（本次访问内不重播）
          const played = getPlayedHistory(sessionId);
          const messages = played?.messages ?? rec.messages;
          const blocks = played?.blocks ?? rec.blocks;
          console.info(
            LOG,
            `load_session ${rec.meta.id}: ${messages.length} messages, ${blocks.length} blocks${played ? ' (played snapshot)' : ''}`,
          );
          return withLatency({
            session: rec.meta,
            messages,
            blocks,
          });
        }
        case 'chat_v2_load_messages_page':
          // 尾部分块之外没有更多历史
          return { messages: [], blocks: [] };

        // ---------- 发送 / 中止（剧本播放入口） ----------
        case 'chat_v2_send_message': {
          const request = args.request as {
            sessionId: string;
            content: string;
            userMessageId: string;
            assistantMessageId: string;
          };
          const rec = sessionDb.get(request.sessionId);
          touch(rec?.meta ?? ({} as SessionInfo));
          // 首轮播放专属剧本（自动播放的第一答）；之后自由输入走兜底罐头回复
          const firstPlay = !playedOnce.has(request.sessionId);
          playedOnce.add(request.sessionId);
          const followUp = firstPlay && rec?.followUp?.length
            ? rec.followUp
            : DEFAULT_FOLLOW_UP;
          // 异步播放，立即返回 assistantMessageId（与真实后端一致）
          void playReplyScript({
            sessionId: request.sessionId,
            assistantMessageId: request.assistantMessageId,
            blocks: followUp,
          });
          return request.assistantMessageId;
        }
        case 'chat_v2_cancel_stream': {
          const sessionId = String(args.sessionId ?? '');
          const wasPlaying = abortScript(sessionId);
          if (wasPlaying) {
            void emit(`chat_v2_session_${sessionId}`, {
              sessionId,
              eventType: 'stream_cancelled',
              timestamp: Date.now(),
            });
          }
          return null;
        }
        case 'chat_v2_wake_session':
        case 'chat_v2_continue_message': {
          const sessionId = String(args.sessionId ?? '');
          const assistantMessageId = String(args.assistantMessageId ?? '');
          const rec = sessionDb.get(sessionId);
          void playReplyScript({
            sessionId,
            assistantMessageId,
            blocks: DEFAULT_FOLLOW_UP,
          });
          return assistantMessageId;
        }

        // ---------- 持久化 / 其他会话写操作：静默成功 ----------
        case 'chat_v2_save_session':
        case 'chat_v2_update_session_settings':
        case 'chat_v2_upsert_streaming_block':
        case 'chat_v2_update_block_content':
        case 'chat_v2_delete_message':
        case 'chat_v2_switch_variant':
        case 'chat_v2_retry_variants':
        case 'chat_v2_retry_variant':
        case 'chat_v2_cancel_variant':
        case 'chat_v2_branch_session':
        case 'chat_v2_compact_session':
        case 'chat_v2_reorder_groups':
          return null;

        // ---------- 分组 ----------
        case 'chat_v2_list_groups':
          return [];
        case 'chat_v2_create_group':
          return {
            id: `demo-group-${Date.now().toString(36)}`,
            name: String(args.name ?? '新建分组'),
            icon: args.icon ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        case 'chat_v2_update_group':
          return null;

        default:
          console.warn(`${LOG} unmocked cmd:`, cmd, args);
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  console.info(
    `${LOG} mocks installed: ${DEMO_SESSIONS.length} scripted sessions, events bridged in-memory.`,
  );
}
