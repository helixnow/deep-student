/**
 * 放在测试文件的第一个 import：在导入界面模块之前装好 DOM。有的依赖在模块导入时就取全局 `window`，之后不再看：
 * 聊天工具块的滚动区（OverlayScrollbars）导入时没有 DOM 就换成空对象，渲染时报 `getComputedStyle is not a function`。
 */
import { installDom } from './dom';

installDom();
