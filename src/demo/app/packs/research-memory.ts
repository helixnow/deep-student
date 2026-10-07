/**
 * 第 03 章「深度调研与智能记忆」：一扇对话窗口，调研模式跑完的一次调研——
 * 用户记忆块、任务清单（5/5 完成）、网络 / 学术 / 本地知识库检索块、报告写入笔记，正文带来源徽章。
 * 访客可以继续追问（「记住……」会演示写入记忆）。剧本见 ./research-memory/script.ts。
 */
import { CHAT_NAMESPACES, createChatScenePack, scrollToConversationTop } from '../data/chat/scene';
import {
  RESEARCH_FALLBACK,
  RESEARCH_FOLLOW_UPS,
  RESEARCH_PROMPT,
  RESEARCH_REPLY,
  RESEARCH_SESSION_ID,
  RESEARCH_TITLE,
} from './research-memory/script';

export default createChatScenePack({
  title: '深度调研与智能记忆',
  sessionId: RESEARCH_SESSION_ID,
  custom: {
    title: RESEARCH_TITLE,
    description: '用户记忆 + 网络 / 学术 / 知识库检索，调研报告写入笔记',
    prompt: RESEARCH_PROMPT,
    reply: RESEARCH_REPLY,
  },
  replies: RESEARCH_FOLLOW_UPS,
  fallback: RESEARCH_FALLBACK,
  namespaces: CHAT_NAMESPACES,
  // 海报：展开「已调用 N 个工具」（网络 / 学术 / 知识库三个检索块）和完成的任务清单
  async arrange(root) {
    const buttons = () => [...root.querySelectorAll<HTMLElement>('button, [role="button"]')];
    buttons().find((b) => /已调用 \d+ 个工具|^Used \d+ tools/.test(b.textContent ?? ''))?.click();
    buttons().filter((b) => /5\s*\/\s*5/.test(b.textContent ?? '')).pop()?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    scrollToConversationTop(root);
  },
});
