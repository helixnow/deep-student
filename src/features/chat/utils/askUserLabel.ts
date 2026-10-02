/**
 * 提问选项标签清洗。
 *
 * 首项在界面上已经带「推荐」徽标；模型常把 "(Recommended)" / "（推荐）" 也写进标签，
 * 结果显示成「20 张 · 基础问答卡（Recommended）（推荐）」。这里剥掉标签尾部的推荐标记。
 */
const RECOMMENDED_SUFFIX_RE =
  /[\s·\-—–]*(?:[(（[【]\s*(?:recommended|推荐|建议)\s*[)）\]】]|[-—–]\s*(?:recommended|推荐))\s*$/i;

export function stripRecommendedMarker(label: string): string {
  const stripped = label.replace(RECOMMENDED_SUFFIX_RE, '').trim();
  return stripped || label;
}
