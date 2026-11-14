'use strict';
// webpack pre-loader：主应用里有 `(import.meta as any)?.env?.DEV` 这类写法。esbuild 降级可选链后会留下一个裸的
// import.meta（`(_a = import.meta) == null ? …`），而 Remotion 的产物不是模块脚本，裸 import.meta 是语法错误。
// 这里先改写成只带 env 的对象；env 再由 webpack-override.mjs 里的 DefinePlugin 替换，hot 等其余属性为 undefined。
module.exports = function appImportMetaLoader(source) {
  return source.replace(/\(import\.meta as any\)/g, '({ env: import.meta.env } as any)');
};
