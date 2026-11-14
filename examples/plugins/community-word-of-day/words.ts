/** 示例数据：按日期确定性地挑选一个单词（真实插件可以改为调用外部 API）。 */
export interface Word {
  word: string;
  meaning: string;
  example: string;
}

export const WORDS: readonly Word[] = [
  { word: 'serendipity', meaning: '意外发现美好事物的运气', example: 'Finding that book was pure serendipity.' },
  { word: 'resilient', meaning: '有韧性的；能迅速恢复的', example: 'Children are often remarkably resilient.' },
  { word: 'meticulous', meaning: '一丝不苟的', example: 'She keeps meticulous notes for every lecture.' },
  { word: 'ubiquitous', meaning: '无处不在的', example: 'Smartphones have become ubiquitous.' },
];

/** 本地日期 YYYY-MM-DD 对应的单词。 */
export function wordForDate(date: string): Word {
  let h = 0;
  for (const ch of date) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WORDS[h % WORDS.length]!;
}
