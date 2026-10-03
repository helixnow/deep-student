/**
 * Web 演示壳 - 学习桌面开场的会话完成态（自动生成，勿手改）
 *
 * 学习桌面不演首答：对话窗口一打开就是「高数错题 → Anki 卡片」播完的样子，
 * 省掉开场跑一遍剧本（打字、流式、渲染五张卡）的一两秒（慢机器上更多）。
 * 内容就是经典布局里这条剧本播完后 chat_v2_load_session 返回的快照，去掉了调试用的 _meta.rawRequest；
 * 时间戳在预置时整体挪到「刚才」（见 mockIpc 的 seedDesktopScene）。
 *
 * 剧本（fixtures.ts 的 ANKI_REPLY / ANKI_CARDS）改了就重新导出：经典布局打开 demo.html?scene=demo-anki-cards，
 * 等五张卡出来、再等几秒快照落盘，在页面里执行
 *   await window.__TAURI_INTERNALS__.invoke('chat_v2_load_session', { sessionId: 'demo-anki-cards' })
 * 取 messages / blocks 写回这里。
 */
import type { PlayedHistory } from './playedHistory';

export const DESKTOP_SCENE_HISTORY: PlayedHistory = {
  "messages": [
    {
      "id": "msg_musdxxht_ccwmmu_0",
      "sessionId": "demo-anki-cards",
      "role": "user",
      "blockIds": [
        "blk_musdxxjd_luc4qd_2"
      ],
      "timestamp": 1791031551241,
      "_meta": {
        "contextSnapshot": {
          "userRefs": [
            {
              "resourceId": "res_demo_img1",
              "hash": "hash_att_demo_img1",
              "typeId": "image",
              "displayName": "错题1·等价无穷小替换.png"
            },
            {
              "resourceId": "res_demo_img2",
              "hash": "hash_att_demo_img2",
              "typeId": "image",
              "displayName": "错题2·换元积分忘换限.png"
            },
            {
              "resourceId": "res_demo_img3",
              "hash": "hash_att_demo_img3",
              "typeId": "image",
              "displayName": "错题3·中值定理辅助函数.png"
            }
          ],
          "retrievalRefs": [],
          "pathMap": {
            "res_demo_img1": "demo-root:attachments/att_demo_img1",
            "res_demo_img2": "demo-root:attachments/att_demo_img2",
            "res_demo_img3": "demo-root:attachments/att_demo_img3",
            "__staged_attachment__:res_demo_img1:att_demo_img1": "{\"rootId\":\"demo-root\",\"relativePath\":\"attachments/att_demo_img1\",\"sourceId\":\"att_demo_img1\",\"sha256\":\"demo\",\"sizeBytes\":0,\"objectHandle\":{\"schemaVersion\":1,\"handleId\":\"demo-obj-att_demo_img1\",\"kind\":\"file\",\"displayName\":\"错题1·等价无穷小替换.png\"}}",
            "__staged_attachment__:res_demo_img2:att_demo_img2": "{\"rootId\":\"demo-root\",\"relativePath\":\"attachments/att_demo_img2\",\"sourceId\":\"att_demo_img2\",\"sha256\":\"demo\",\"sizeBytes\":0,\"objectHandle\":{\"schemaVersion\":1,\"handleId\":\"demo-obj-att_demo_img2\",\"kind\":\"file\",\"displayName\":\"错题2·换元积分忘换限.png\"}}",
            "__staged_attachment__:res_demo_img3:att_demo_img3": "{\"rootId\":\"demo-root\",\"relativePath\":\"attachments/att_demo_img3\",\"sourceId\":\"att_demo_img3\",\"sha256\":\"demo\",\"sizeBytes\":0,\"objectHandle\":{\"schemaVersion\":1,\"handleId\":\"demo-obj-att_demo_img3\",\"kind\":\"file\",\"displayName\":\"错题3·中值定理辅助函数.png\"}}"
          }
        }
      },
      "attachments": []
    },
    {
      "id": "msg_musdxxht_g2ohqk_1",
      "sessionId": "demo-anki-cards",
      "role": "assistant",
      "blockIds": [
        "msg_musdxxht_g2ohqk_1-sb0",
        "msg_musdxxht_g2ohqk_1-sb1",
        "msg_musdxxht_g2ohqk_1-sb2",
        "msg_musdxxht_g2ohqk_1-sb3",
        "msg_musdxxht_g2ohqk_1-sb4"
      ],
      "timestamp": 1791031551241,
      "_meta": {
        "modelId": "deepseek-v4",
        "modelDisplayName": "deepseek-v4",
        "chatParams": {
          "modelId": "",
          "modelDisplayName": "deepseek-v4",
          "modelIdPinnedByUser": false,
          "temperature": 0.7,
          "topP": 0.9,
          "frequencyPenalty": 0,
          "presencePenalty": 0,
          "maxTokens": 32768,
          "enableThinking": true,
          "disableTools": false,
          "model2OverrideId": null,
          "maxToolRecursion": 30
        }
      }
    }
  ],
  "blocks": [
    {
      "id": "blk_musdxxjd_luc4qd_2",
      "messageId": "msg_musdxxht_ccwmmu_0",
      "type": "content",
      "status": "success",
      "content": "这三道高数错题我拍了照片传上来了，帮我整理成 Anki 卡片，重点突出每道题的易错点",
      "startedAt": 1791031551241,
      "endedAt": 1791031551241
    },
    {
      "id": "msg_musdxxht_g2ohqk_1-sb0",
      "messageId": "msg_musdxxht_g2ohqk_1",
      "type": "thinking",
      "status": "success",
      "content": "先从三张照片中提取题目与解题步骤，再对照教材、错题笔记，分别整理极限展开、积分换元和辅助函数构造。\n\n每张问答卡围绕一个知识点提问，背面保留推导要点，标签标明对应章节，方便后续整理。",
      "startedAt": 1791031551482,
      "endedAt": 1791031551582,
      "firstChunkAt": 1791031551582
    },
    {
      "id": "msg_musdxxht_g2ohqk_1-sb1",
      "messageId": "msg_musdxxht_g2ohqk_1",
      "type": "rag",
      "status": "success",
      "toolOutput": {
        "query": "等价无穷小 换元积分 中值定理 错题",
        "totalResults": 3,
        "durationMs": 862,
        "sources": [
          {
            "title": "高等数学（第七版）上册.pdf",
            "url": "/教材/高等数学（第七版）上册.pdf",
            "snippet": "……等价无穷小替换仅适用于乘除因子；对相减的项直接替换会破坏阶的一致性，典型反例即 sin x − x ~ −x³/6……",
            "score": 0.91,
            "metadata": {
              "pageIndex": 58,
              "resourceId": "tb_demo_calculus",
              "resourceType": "textbook"
            }
          },
          {
            "title": "高数错题本（8 月）.md",
            "url": "/笔记/高数错题本（8 月）.md",
            "snippet": "……积分换元需要同步写出变量、上下限与微分的变化；∫₀^π sin²x dx 也可用降幂公式求得 π/2……",
            "score": 0.86,
            "metadata": {
              "resourceId": "note_demo_errorbook",
              "resourceType": "note"
            }
          },
          {
            "title": "中值定理证明套路.md",
            "url": "/笔记/中值定理证明套路.md",
            "snippet": "……结论形如 f′(ξ) = k 时，构造 F(x) = f(x) − k(x−a)，验证端点等值后落罗尔定理……",
            "score": 0.82,
            "metadata": {
              "resourceId": "note_demo_mvt",
              "resourceType": "note"
            }
          }
        ]
      },
      "startedAt": 1791031551706,
      "endedAt": 1791031552721
    },
    {
      "id": "msg_musdxxht_g2ohqk_1-sb2",
      "messageId": "msg_musdxxht_g2ohqk_1",
      "type": "content",
      "status": "success",
      "content": "三道题分别对应**极限的展开阶数、积分换元的完整步骤、中值定理的辅助函数**。我对照了教材与错题笔记，将这三个主题拆成五张问答卡。\n\n### 从解题步骤找到复习重点\n\n- **极限**：展开 sin x 到三阶，保留相减后的首个非零项，再除以 x³ 得到 −1/6。[知识库-1]\n- **定积分**：令 u = cos x，同时写出上下限和 du；也可以用 sin²x = (1 − cos 2x)/2 求得 π/2。[知识库-2]\n- **中值定理**：先把目标整理为 F′(ξ) = 0，再构造 F(x) = f(x) − k(x − a)，核对端点值与可导条件。[知识库-3]\n\n接下来逐张生成卡片。你可以先看正面尝试回忆，再翻面核对推导。",
      "startedAt": 1791031552977,
      "endedAt": 1791031553445,
      "firstChunkAt": 1791031553100
    },
    {
      "id": "msg_musdxxht_g2ohqk_1-sb3",
      "messageId": "msg_musdxxht_g2ohqk_1",
      "type": "anki_cards",
      "status": "success",
      "toolOutput": {
        "cards": [
          {
            "id": "chat-batch-demo-1",
            "front": "求 lim(x→0) (sin x − x) / x³ 时，泰勒展开应保留到哪一阶？",
            "back": "保留到三阶。\n展开 sin x = x − x³/6 + o(x³)，相减后首个非零项是 −x³/6，除以 x³ 得极限 −1/6。",
            "tags": [
              "高数",
              "极限",
              "等价无穷小"
            ],
            "images": [],
            "template_id": "tpl_demo_basic"
          },
          {
            "id": "chat-batch-demo-2",
            "front": "∫₀^π sin²x dx 用换元 u = cos x 时，上下限和微分怎样变化？",
            "back": "x = 0 对应 u = 1，x = π 对应 u = −1，du = −sin x dx。\n在 [0, π] 上 sin x ≥ 0，原式转为 ∫₋₁¹ √(1 − u²) du = π/2。",
            "tags": [
              "高数",
              "定积分",
              "换元法"
            ],
            "images": [],
            "template_id": "tpl_demo_basic"
          },
          {
            "id": "chat-batch-demo-3",
            "front": "什么结构特征的定积分适合用「区间再现」∫ₐᵇ f(x) dx = ∫ₐᵇ f(a+b−x) dx？",
            "back": "被积函数由 sin x、cos x 构成且积分区间为 [0, π] 或 [0, π/2] 时优先考虑。",
            "tags": [
              "高数",
              "定积分",
              "技巧"
            ],
            "images": [],
            "template_id": "tpl_demo_basic"
          },
          {
            "id": "chat-batch-demo-4",
            "front": "证明「存在 ξ 使 f′(ξ) = (f(b) − f(a)) / (b − a)」类命题时，辅助函数怎么构造？",
            "back": "把结论改写为 F′(ξ) = 0 的形式：F(x) = f(x) − [(f(b) − f(a)) / (b − a)]·(x − a)，验证 F(a) = F(b) 后落罗尔定理。",
            "tags": [
              "高数",
              "中值定理",
              "证明"
            ],
            "images": [],
            "template_id": "tpl_demo_basic"
          },
          {
            "id": "chat-batch-demo-5",
            "front": "应用拉格朗日中值定理前，需要逐项核对哪些条件？",
            "back": "核对 f 在闭区间 [a, b] 上连续，并在开区间 (a, b) 内可导。\n满足这两个条件后，可找到 ξ ∈ (a, b)，使 f′(ξ) 等于端点连线的斜率。",
            "tags": [
              "高数",
              "中值定理"
            ],
            "images": [],
            "template_id": "tpl_demo_basic"
          }
        ],
        "templateId": "tpl_demo_basic",
        "syncStatus": "pending",
        "businessSessionId": "demo-anki-cards",
        "messageStableId": "msg_musdxxht_g2ohqk_1",
        "options": {
          "deck_name": "高等数学 · 错题本"
        },
        "documentId": "doc_demo_anki_gaoshu",
        "deliveryStatus": "ready",
        "ankiConnect": {
          "available": false,
          "checkedAt": "2026-10-03T12:45:48.450Z"
        },
        "progress": {
          "stage": "completed",
          "cardsGenerated": 5,
          "completedRatio": 1
        },
        "deletedCardIds": []
      },
      "startedAt": 1791031553847,
      "endedAt": 1791031555989
    },
    {
      "id": "msg_musdxxht_g2ohqk_1-sb4",
      "messageId": "msg_musdxxht_g2ohqk_1",
      "type": "content",
      "status": "success",
      "content": "五张卡片已准备好，牌组名称预填为 **「高等数学 · 错题本」**。\n\n点击卡片可以翻面预览，也可以进入编辑调整题目与答案。检查内容后，点击「加入卡片库」完成收录。桌面版中的复习安排会依据卡片状态与实际作答记录生成。",
      "startedAt": 1791031556296,
      "endedAt": 1791031556448,
      "firstChunkAt": 1791031556425
    }
  ]
};
