/**
 * Chat V2 - 引用来源解析 Context
 *
 * 正文引用徽章的 hover 即时预览（CitationPopover）需要来源数据
 * （标题/snippet/score/url）。数据在 content.tsx（块层，可访问 store）
 * 中 resolve，消费方是 MarkdownRenderer 深处的徽章组件。
 *
 * 中间隔着 StreamingBlockRenderer 等不属于 citation 分区的组件，
 * 为避免层层透传 props，这里用 React Context 直接桥接。
 *
 * ★ 契约：index 为"类型内 1-based 序号"（[知识库-N] 的 N），不可变。
 */

import { createContext } from 'react';
import type { RetrievalSource, RetrievalSourceType } from '../plugins/blocks/components/types';

/**
 * 引用来源解析器
 *
 * @param type - 来源类型（rag/memory/web_search/multimodal）
 * @param index - 类型内 1-based 序号
 * @returns 来源数据；找不到时返回 null/undefined（徽章不出预览浮层）
 */
export type CitationSourceResolver = (
  type: RetrievalSourceType,
  index: number,
) => RetrievalSource | null | undefined;

/**
 * 引用来源解析 Context
 * Provider 在 content.tsx（有 store 的分支）挂载；无 Provider 时预览浮层静默禁用。
 */
export const CitationSourceContext = createContext<CitationSourceResolver | null>(null);
