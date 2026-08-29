/**
 * 输入栏能力三分离（Wave2-C R3 / P4）
 *
 * 历史上 InputBarUI 用一个 isMobileEnv = matchMedia('(pointer: coarse)')
 * 同时回答三个不同的问题（布局 / 触摸 / 相机），导致「桌面触摸屏出现拍照
 * 入口」「外接键鼠的平板漏判」等混合态。现拆成三个互不兼职的判定：
 *
 * 1. 布局（layout）→ isMobile（MobileLayoutContext，宽度断点驱动）。
 *    内联面板、底部安全区、返回键 handler 等一切布局分支的唯一依据，
 *    继续由 InputBarUI 从 context 取，与本模块无关。
 * 2. 触摸（touch）→ TOUCH_CAPABILITY_MEDIA_QUERY = '(any-pointer: coarse)'。
 *    any-pointer 匹配「任一输入设备是粗指针」（触屏笔记本插着鼠标、
 *    iPad 外接触控板），而 pointer: coarse 只看主指针，混合输入设备会漏判。
 *    JS 侧需要触摸能力布尔时统一用本常量建媒体查询，禁止再拿它兼职判相机。
 * 3. 相机（photo capture）→ canCapturePhoto()。平台/捕获能力判定，见下。
 *    刻意不用 enumerateDevices()（部分平台会触发权限弹窗），也不用指针
 *    媒体查询——触摸 ≠ 有后置摄像头（Surface 台式触摸屏误报、
 *    带摄像头但主指针为鼠标的设备漏报）。
 */
import { isAndroid, isIOS, isMobilePlatform } from '@/utils/platform';

/** 触摸能力媒体查询：JS 侧判「设备可触摸」统一走这里（不要用 pointer: coarse） */
export const TOUCH_CAPABILITY_MEDIA_QUERY = '(any-pointer: coarse)';

/**
 * <input type="file"> 是否支持 HTML Media Capture 的 capture 属性。
 * 纯特性检测（离屏元素 + in 运算符），不触碰相机也不触发权限提示。
 */
export const supportsInputCapture = (): boolean => {
  if (typeof document === 'undefined') return false;
  return 'capture' in document.createElement('input');
};

/**
 * 是否展示「拍照」入口（隐藏的 <input capture="environment"> 能唤起相机）。
 *
 * - Android / iOS：平台即答案，两系统的浏览器/WebView 均实现 Media Capture；
 * - 兜底：其他移动壳（未来新平台 UA）要求 input capture 特性与移动 UA 同时
 *   成立——桌面浏览器即使实现了 capture 属性也只会退化成普通文件选择器，
 *   所以必须叠加 isMobilePlatform() 门控。
 */
export const canCapturePhoto = (): boolean =>
  isAndroid() || isIOS() || (supportsInputCapture() && isMobilePlatform());
