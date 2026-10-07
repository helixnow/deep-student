/**
 * 第 06 章「论文搜索」：论文搜索是对话里的内置技能，没有独立页面——演示一扇对话窗口，
 * 首屏是 arXiv + OpenAlex 两路检索播完、整理成对照表、展开论文来源卡片的样子；追问可以下载入库、生成引用格式。
 * 剧本见 ./paper-search/script.ts，论文元数据见 ./paper-search/papers.ts。
 */
import { CHAT_NAMESPACES, createChatScenePack, expandSources, scrollToConversationEnd } from '../data/chat/scene';
import {
  PAPER_FALLBACK,
  PAPER_FOLLOW_UPS,
  PAPER_PROMPT,
  PAPER_REPLY,
  PAPER_SESSION_ID,
  PAPER_TITLE,
} from './paper-search/script';

export default createChatScenePack({
  title: '论文搜索',
  sessionId: PAPER_SESSION_ID,
  custom: {
    title: PAPER_TITLE,
    description: 'arXiv 预印本 + OpenAlex 高引论文，下载入库与引用格式',
    prompt: PAPER_PROMPT,
    reply: PAPER_REPLY,
  },
  replies: PAPER_FOLLOW_UPS,
  fallback: PAPER_FALLBACK,
  namespaces: CHAT_NAMESPACES,
  // 海报：停在回答末尾——对照表、阅读建议，以及展开的论文来源卡片（往上滚是提问和检索过程）
  async arrange(root) {
    await expandSources(root);
    scrollToConversationEnd(root);
  },
});
