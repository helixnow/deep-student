/**
 * 标签输入草稿按逗号（半角 `,` / 全角 `，`）切分。
 *
 * Android 软键盘的 keydown 一律上报 key "Unidentified" / keyCode 229，
 * 「逗号提交标签」只靠 keydown 判断在手机上永远不触发——逗号会作为普通字符
 * 留在草稿里。因此标签输入框还需在 onChange 里按输入值切分：最后一个分隔符
 * 之前的片段视为已提交的标签，之后的部分继续作为草稿。
 *
 * 硬件键盘的 keydown(',') 路径会 preventDefault，逗号不会进入输入值，
 * 两条路径互不重复提交。
 */
const TAG_SEPARATOR_RE = /[,，]/;

export interface TagDraftSplit {
  /** 已由逗号终结的标签（已 trim、去空） */
  tokens: string[];
  /** 最后一个逗号之后的剩余草稿（保持原样，便于继续输入） */
  rest: string;
}

export function splitTagDraft(value: string): TagDraftSplit {
  if (!TAG_SEPARATOR_RE.test(value)) return { tokens: [], rest: value };
  const parts = value.split(TAG_SEPARATOR_RE);
  const rest = parts.pop() ?? '';
  return {
    tokens: parts.map((part) => part.trim()).filter(Boolean),
    rest,
  };
}
