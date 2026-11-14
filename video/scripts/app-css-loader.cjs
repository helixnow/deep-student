'use strict';
// webpack pre-loader：主应用组件自己 import 的 CSS（如 Badge.css）在交给 css-loader 之前收进 .ds-app 作用域。
const { scopeCss } = require('./app-css-scope.cjs');

module.exports = function appCssLoader(source) {
  return scopeCss(source, this.resourcePath);
};
