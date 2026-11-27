/** 演示界面与内容语言：官网英文页给 iframe 带 ?lang=en，其余一律中文 */
export const demoLang: 'zh-CN' | 'en-US' =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('lang') === 'en'
    ? 'en-US'
    : 'zh-CN';

export const isDemoEn = demoLang === 'en-US';

/** 根据当前演示语言选择中文或英文文案 */
export const tr = (zh: string, en: string): string => (isDemoEn ? en : zh);

/** 根据当前演示语言选择任意中文或英文结构化数据 */
export const pick = <T,>(zh: T, en: T): T => (isDemoEn ? en : zh);
