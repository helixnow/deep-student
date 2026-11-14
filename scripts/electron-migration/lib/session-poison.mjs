// 会话中毒判定：上游内容过滤（provider.content-filter / invalid_prompt）是确定性的，同一会话续作必然再被拦，必须换新会话。
// 2026-11-06 05:00Z：U2 在"不计重试"的恢复里空转 11 次，C1 每次被唤醒都回到被拦的会话。
// 原因一：被拦的那一步自己也写一条 step_finish（reason=content-filter），旧判定把它当成"有进展"，连续计数每次被重置为 1。
// 原因二：协调者唤醒路径只按上下文大小换会话，不看内容过滤。

const filteredError = (e) => e?.type === 'provider.content-filter' || /invalid_prompt|flagged as potentially violating/i.test(String(e?.message ?? ''));

/** 最近一轮是否以内容过滤结束：从尾部找最近的 error（遇到 step_start 说明之后又开始了新一步，不算）。 */
export function poisoned(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === 'error') return filteredError(events[i].error);
    if (t === 'step_start') return false;
  }
  return false;
}

/** 自 since 以来是否有过正常完成的步骤。被内容过滤拦下的 step_finish 不算进展。 */
export function progressedSince(events, since) {
  const t0 = Date.parse(since ?? '') || 0;
  return events.some((e) => e.type === 'step_finish' && (e.timestamp ?? 0) > t0 && e.part?.reason !== 'content-filter');
}

/**
 * 协调者被拦后换新会话时要重新送达的指令：上一轮唤醒（lastResumeAt）时送出、被拦轮次消费掉的消息。
 * sentAt 在 lastResumeAt 之前几毫秒写入，留 60 秒余量。lastWakeAt 不能用：立即送达会把它改成一小时前。
 * 每条只补送一次（redelivered 标记），避免同一条消息本身触发过滤时无限补送。
 */
export function redeliverable(sentQueue, lastResumeAt) {
  const t0 = (Date.parse(lastResumeAt ?? '') || 0) - 60_000;
  return (sentQueue ?? []).filter((q) => !q.redelivered && (Date.parse(q.sentAt ?? '') || 0) >= t0);
}
