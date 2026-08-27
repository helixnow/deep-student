/**
 * ACR Agent 结合能力表 — Wave2-B R5（Agent 结合-1）
 *
 * 声明式登记「Agent 跨应用结合点」的唯一合法入口，解决两类漂移：
 *
 * 1. 防自造（52-wave2 §B 边界）：
 *    - 制卡唯一合法入口 = `cardAgent.startGeneration`（后端
 *      `start_enhanced_document_processing`，与 chatanki 共用），本表只经
 *      E 域现成包装 `selectionStudyActions.makeCardsFromSelection` 懒加载透传，
 *      不新增 tauri command、不碰判分/管线/CriticSummary。
 *    - 出题唯一合法通道 = 聊天 Agent 的 qbank-tools 技能（经
 *      PREFILL_CHAT_INPUT 预填、autoSend=false）；`import_question_bank_stream`
 *      是「解析已有题目」的抽取流，对散文材料得空结果，禁止拿来出题。
 *    - streaming_anki / qbank 服务层：本文件零 import（一致性测试钉住）。
 * 2. 防漂移（notes-gap C4 同型问题）：导航结合点（打开笔记锚点 / 打开
 *    PDF 页）以 workbenchBus 薄封装为入口，复用既有 activation 通道
 *    （scrollToHeading / gotoPage → pdfFocusAck），不开第二套事件协议；
 *    本表与 workbenchBus 的 typeId 白名单同源（直接 import 常量）。
 *
 * 消费方：StageManager app_command / 领域 driver 后续轮次按 id 查表取入口；
 * 本轮只登记 + 透传，不改 stageManager / tool_loop / pipeline。
 * GenUI 仍为只读冻结，不在本表（notes-gap §1.6 A2）。
 *
 * 对照调研：wave2-B-r1-notes-gap §1.6/§3、wave2-B-r1-pdf-gap §五、
 * 台账 4.6-2（孤儿库函数裁决：复用，见各 entry 的 source 列）。
 */
import {
  PDF_PAGE_ACTIVATION_TYPE_IDS,
  workbenchBus,
  type ActivationDispatchResult,
  type OpenNoteAnchorRequest,
  type OpenPdfPageRequest,
} from '../core/workbenchBus';
// 仅类型导入（编译期擦除）：值导入必须走下方懒加载包装，
// 避免把 cardforge / 聊天服务打进 workbench agent 常驻 chunk。
import type {
  SelectionCardInput,
  SelectionQuestionResult,
  SelectionSourceInfo,
} from '@/features/pdf/selectionStudyActions';

export type AgentIntegrationId =
  | 'open_note_anchor'
  | 'open_pdf_page'
  | 'generate_cards_from_excerpt'
  | 'generate_questions_from_excerpt';

export interface AgentIntegrationEntry {
  id: AgentIntegrationId;
  /** 结合点归属域；anki/qbank 侧只登记入口不实现（E 域禁改） */
  domain: 'notes' | 'pdf' | 'anki' | 'qbank';
  /**
   * navigation = 开窗/定位（可幂等重试）；
   * pipeline = 后台任务入口（启动即返回，任务台跟踪）；
   * chat-prefill = 预填聊天输入、不自动发送（用户最后把关）。
   */
  kind: 'navigation' | 'pipeline' | 'chat-prefill';
  /** 唯一合法入口（符号路径描述，供一致性测试与人工审计） */
  entry: string;
  /** 经由的既有 activation 通道（仅导航类） */
  activation?: {
    typeIds: readonly string[];
    action: string;
    payloadShape: string;
  };
  risk: 'read' | 'low';
  /** 回执 / 确认语义（Agent 侧判断成败的依据） */
  ack: string;
  /** 调研文档锚（能力来源与裁决记录） */
  source: string;
}

export const AGENT_INTEGRATIONS: readonly AgentIntegrationEntry[] = [
  {
    id: 'open_note_anchor',
    domain: 'notes',
    kind: 'navigation',
    entry: 'workbenchBus.openNoteAnchor',
    activation: {
      typeIds: ['note'],
      action: 'scrollToHeading',
      payloadShape: '{ heading: string, level?: 1-6 }',
    },
    risk: 'read',
    ack: 'workspaceRegistry.activateWorkspaceResource → editor.scrollToHeading；'
      + '编辑器受理即 handled+acknowledged，未挂载回 ACTIVATION_NOT_READY',
    source: 'wave2-B-r1-notes-gap §1.6 A3 / §3（workbenchBus 结合点：新动作走既有 activation，不开新全局事件）',
  },
  {
    id: 'open_pdf_page',
    domain: 'pdf',
    kind: 'navigation',
    entry: 'workbenchBus.openPdfPage',
    activation: {
      typeIds: PDF_PAGE_ACTIVATION_TYPE_IDS,
      action: 'gotoPage',
      payloadShape: '{ page: integer >= 1 }',
    },
    risk: 'read',
    ack: 'pdfFocusAck.requestPdfPageFocus：pdf-ref:focus + viewer ack + 超时 + stale 防双跳'
      + '（回执失败则不会再发生迟到跳页，LLM 可安全重试）',
    source: 'wave2-B-r1-pdf-gap §5.1（已有能力不重建，只补登记与薄封装）',
  },
  {
    id: 'generate_cards_from_excerpt',
    domain: 'anki',
    kind: 'pipeline',
    entry: 'cardAgent.startGeneration（经 selectionStudyActions.makeCardsFromSelection 懒加载包装）',
    risk: 'low',
    ack: '启动即返回 documentId；进度与结果由任务台（anki-tasks）跟踪，前端不阻塞等待',
    source: 'wave2-B-r1-pdf-gap §5.2-3（唯一合法入口）/ notes-gap §1.6 A6 / 台账 4.6-2 裁决：复用',
  },
  {
    id: 'generate_questions_from_excerpt',
    domain: 'qbank',
    kind: 'chat-prefill',
    entry: 'selectionStudyActions.sendSelectionToQuestionGeneration（PREFILL_CHAT_INPUT → 聊天 Agent qbank-tools）',
    risk: 'low',
    ack: 'autoSend=false，题量/题型由用户把关；来源（文件名/页码）已并入 prompt 文本',
    source: 'wave2-B-r1-pdf-gap §5.2-3（不走 import_question_bank_stream）/ 台账 4.6-2 裁决：复用',
  },
] as const;

export function getAgentIntegration(id: AgentIntegrationId): AgentIntegrationEntry {
  const entry = AGENT_INTEGRATIONS.find((item) => item.id === id);
  if (!entry) throw new Error(`[ACR] unknown agent integration: ${id}`);
  return entry;
}

// ============================================================================
// 薄执行器：每个 entry 一个透传函数，签名即契约；不含任何业务逻辑。
// ============================================================================

/** open_note_anchor：打开指定笔记并滚动到标题锚点（委托 workbenchBus 薄封装）。 */
export function openNoteAnchor(req: OpenNoteAnchorRequest): Promise<ActivationDispatchResult> {
  return workbenchBus.openNoteAnchor(req);
}

/** open_pdf_page：打开 PDF 类资源并跳到指定页（委托 workbenchBus 薄封装）。 */
export function openPdfPage(req: OpenPdfPageRequest): Promise<ActivationDispatchResult> {
  return workbenchBus.openPdfPage(req);
}

/**
 * generate_cards_from_excerpt：从资源摘录发起制卡。
 * 懒加载透传到 E 域包装（内部 = cardAgent.startGeneration），保持
 * cardforge 不进本 chunk；校验（最小长度等）由服务内部完成。
 */
export async function startCardsFromExcerpt(input: SelectionCardInput): Promise<void> {
  const { makeCardsFromSelection } = await import('@/features/pdf/selectionStudyActions');
  return makeCardsFromSelection(input);
}

/**
 * generate_questions_from_excerpt：从资源摘录预填出题指令到聊天。
 * 懒加载透传；autoSend=false，由用户调整题量/题型后发送。
 */
export async function prefillQuestionsFromExcerpt(
  input: SelectionSourceInfo,
): Promise<SelectionQuestionResult> {
  const [{ sendSelectionToQuestionGeneration }, { default: i18n }] = await Promise.all([
    import('@/features/pdf/selectionStudyActions'),
    import('@/i18n'),
  ]);
  return sendSelectionToQuestionGeneration(input, i18n.t);
}
