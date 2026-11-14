'use strict';
// webpack pre-loader：主应用源码读到的时钟换成片中的时钟（src/app-ui/clock.ts）——日期固定在片中的「今天」，
// 一秒及以上的定时器不再触发。只给用到的名字加模块级绑定；接在首行之前、不换行，行号不变。
const path = require('node:path');

const clock = JSON.stringify(path.resolve(__dirname, '../src/app-ui/clock.ts'));
const BINDINGS = { Date: 'FilmDate', setTimeout: 'filmSetTimeout', setInterval: 'filmSetInterval' };

module.exports = function appClockLoader(source) {
  // window.setTimeout(...) 绕过模块级绑定，先去掉前缀
  const code = source.replace(/\bwindow\.(setTimeout|setInterval)\b/g, '$1');
  const used = Object.keys(BINDINGS).filter((name) => new RegExp(`\\b${name}\\b`).test(code));
  if (used.length === 0) return code;
  return `import { ${used.map((name) => `${BINDINGS[name]} as ${name}`).join(', ')} } from ${clock};${code}`;
};
