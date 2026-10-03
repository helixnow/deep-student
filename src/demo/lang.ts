/** 演示界面语言：官网英文页给 iframe 带 ?lang=en，其余一律中文 */
export const demoLang: 'zh-CN' | 'en-US' =
  new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en-US' : 'zh-CN';

/** 演示自己写死的界面文字（说明卡、拦截提示等）跟着演示语言走；剧本内容不在此列 */
export const tr = (zh: string, en: string): string => (demoLang === 'en-US' ? en : zh);
