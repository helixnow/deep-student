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
import { DEMO_MODEL_PROFILES, DEMO_SESSIONS, type DemoBlocks } from './fixtures';
import { abortScript, playReplyScript } from './scriptPlayer';

const LOG = '[demo-ipc]';

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
            model2_config_id: null,
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

        // ---------- Anki 模板（DialogControlProvider 初始化加载） ----------
        case 'get_all_custom_templates':
        case 'import_builtin_templates':
          return [];
        case 'get_default_template_id':
          return null;

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
          const rec = sessionDb.get(String(args.sessionId ?? ''));
          if (!rec) {
            console.warn(LOG, 'load_session for unknown session:', args.sessionId);
            return null;
          }
          console.info(
            LOG,
            `load_session ${rec.meta.id}: ${rec.messages.length} messages, ${rec.blocks.length} blocks`,
          );
          return {
            session: rec.meta,
            messages: rec.messages,
            blocks: rec.blocks,
          };
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
          const followUp = rec?.followUp?.length
            ? rec.followUp
            : DEMO_SESSIONS[0].followUp;
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
            blocks: rec?.followUp?.length ? rec.followUp : DEMO_SESSIONS[0].followUp,
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
