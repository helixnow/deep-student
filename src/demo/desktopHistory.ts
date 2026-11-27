/**
 * Web 演示壳 - 学习桌面开场的会话完成态
 *
 * 学习桌面不演首答：对话窗口一打开就是「高数错题 → Anki 卡片」播完的样子，
 * 省掉开场跑一遍剧本（打字、流式、渲染五张卡）的一两秒（慢机器上更多）。
 * 直接基于 fixtures.ts 与 attachmentAssets.ts 按当前演示语言派生，
 * 保证中英文与剧本单一事实源完全一致；时间戳在预置时由 mockIpc 的 seedDesktopScene
 * 整体挪到「3 分钟前」。
 */
import type { BackendBlock } from '@/features/chat/adapters/types';
import type { PlayedHistory } from './playedHistory';
import { DEMO_IMAGE_ASSETS } from './attachmentAssets';
import { DEMO_SESSIONS } from './fixtures';

const BASE_TS = 1791031551241;
const USER_MSG_ID = 'msg_musdxxht_ccwmmu_0';
const USER_BLK_ID = 'blk_musdxxjd_luc4qd_2';
const ASST_MSG_ID = 'msg_musdxxht_g2ohqk_1';

function buildDesktopSceneHistory(): PlayedHistory {
  const fixture = DEMO_SESSIONS.find((s) => s.meta.id === 'demo-anki-cards') ?? DEMO_SESSIONS[0];
  const userRefs = DEMO_IMAGE_ASSETS.map((img) => ({
    resourceId: img.resourceId,
    hash: `hash_${img.sourceId}`,
    typeId: 'image' as const,
    displayName: img.name,
  }));
  const pathMap: Record<string, string> = {};
  for (const img of DEMO_IMAGE_ASSETS) {
    pathMap[img.resourceId] = `demo-root:attachments/${img.sourceId}`;
    pathMap[`__staged_attachment__:${img.resourceId}:${img.sourceId}`] = JSON.stringify({
      rootId: 'demo-root',
      relativePath: `attachments/${img.sourceId}`,
      sourceId: img.sourceId,
      sha256: 'demo',
      sizeBytes: 0,
      objectHandle: {
        schemaVersion: 1,
        handleId: `demo-obj-${img.sourceId}`,
        kind: 'file',
        displayName: img.name,
      },
    });
  }

  const blockTimings = [
    { start: 241, end: 341, firstChunk: 341 },
    { start: 465, end: 1480 },
    { start: 1736, end: 2204, firstChunk: 1859 },
    { start: 2606, end: 4748 },
    { start: 5055, end: 5207, firstChunk: 5184 },
  ];

  const assistantBlocks: BackendBlock[] = fixture.followUp.map((def, idx) => {
    const timing = blockTimings[idx] ?? { start: 200 * (idx + 1), end: 200 * (idx + 2) };
    const toolOutput = def.type === 'anki_cards'
      ? {
          ...(def.toolOutput as Record<string, unknown>),
          templateId: (def.payload?.templateId as string | undefined) ?? 'tpl_demo_basic',
          businessSessionId: fixture.meta.id,
          messageStableId: ASST_MSG_ID,
          deletedCardIds: [],
        }
      : def.toolOutput;
    return {
      id: `${ASST_MSG_ID}-sb${idx}`,
      messageId: ASST_MSG_ID,
      type: def.type,
      status: 'success',
      ...(def.content !== undefined ? { content: def.content } : {}),
      ...(toolOutput !== undefined ? { toolOutput } : {}),
      startedAt: BASE_TS + timing.start,
      endedAt: BASE_TS + timing.end,
      ...(timing.firstChunk !== undefined ? { firstChunkAt: BASE_TS + timing.firstChunk } : {}),
    };
  });

  return {
    messages: [
      {
        id: USER_MSG_ID,
        sessionId: fixture.meta.id,
        role: 'user',
        blockIds: [USER_BLK_ID],
        timestamp: BASE_TS,
        _meta: {
          contextSnapshot: {
            userRefs,
            retrievalRefs: [],
            pathMap,
          },
        },
        attachments: [],
      },
      {
        id: ASST_MSG_ID,
        sessionId: fixture.meta.id,
        role: 'assistant',
        blockIds: assistantBlocks.map((b) => b.id),
        timestamp: BASE_TS,
        _meta: {
          modelId: 'deepseek-v4',
          modelDisplayName: 'deepseek-v4',
          chatParams: {
            modelId: '',
            modelDisplayName: 'deepseek-v4',
            modelIdPinnedByUser: false,
            temperature: 0.7,
            topP: 0.9,
            frequencyPenalty: 0,
            presencePenalty: 0,
            maxTokens: 32768,
            enableThinking: true,
            disableTools: false,
            model2OverrideId: null,
            maxToolRecursion: 30,
          },
        },
      },
    ],
    blocks: [
      {
        id: USER_BLK_ID,
        messageId: USER_MSG_ID,
        type: 'content',
        status: 'success',
        content: fixture.autoPrompt ?? '',
        startedAt: BASE_TS,
        endedAt: BASE_TS,
      },
      ...assistantBlocks,
    ],
  };
}

export const DESKTOP_SCENE_HISTORY: PlayedHistory = buildDesktopSceneHistory();
