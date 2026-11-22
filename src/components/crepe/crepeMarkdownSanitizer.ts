/**
 * Crepe Markdown 纯函数清洗工具
 *
 * 负责：
 * 1. IME 空段落零宽占位符（U+200B）的剔除，避免序列化或隐藏保存时污染笔记；
 * 2. 初始化前规范化历史遗留的 asset:// URL（双重编码、双斜杠、绝对 notes_assets 路径还原为相对路径）。
 */

/**
 * IME 空段落占位（见 CrepeEditor handleCompositionStart）：
 * 桌面 WebView 下空 textblock + IME 合成会走慢路径，合成开始时插入零宽空格占位、合成结束再清理。
 * Android 不启用：软键盘几乎每个词都会开合成，compositionstart 时改文档会与 ProseMirror 的
 * DOM 观察/输入法合成区打架（重复字、丢字、光标跳），且占位清理在选区移走时会漏删。
 */
export const IME_PLACEHOLDER_ZWS = '\u200b';

/**
 * 剔除 Markdown 中残留的 IME 零宽占位字符。
 */
export function stripImePlaceholder(markdown: string): string {
  if (!markdown || !markdown.includes(IME_PLACEHOLDER_ZWS)) return markdown;
  return markdown.split(IME_PLACEHOLDER_ZWS).join('');
}

/**
 * 预处理传给 Crepe 的 Markdown 中的 `asset://` URL：
 * - 保持 `notes_assets/...` 相对路径原样，交由 ImageBlock.proxyDomURL 在渲染期转换；
 * - 修复历史双重编码（`%2F` / `%5C`）；
 * - 修复 `asset://localhost//...` 多余斜杠；
 * - 将历史绝对 `asset://localhost/.../notes_assets/...` 还原为相对 `notes_assets/...` 路径，
 *   避免数据空间目录差异导致后端安全校验拒绝访问。
 */
export function sanitizeAssetUrlsForCrepe(markdown: string): string {
  if (!markdown || !markdown.includes('asset://')) {
    return markdown;
  }

  return markdown.replace(/(asset:\/\/[^)\s]+)/g, (match) => {
    let fixed = match;

    // 1. 修复双重编码问题
    if (/%2f|%5c/i.test(fixed)) {
      fixed = fixed
        .replace(/%2F/gi, '/')
        .replace(/%5C/gi, '/');
    }

    // 2. 修复双斜杠问题（asset://localhost//Users -> asset://localhost/Users）
    fixed = fixed.replace(/^(asset:\/\/localhost)\/+/, '$1/');

    // 3. 历史兼容：将绝对 asset://.../notes_assets/... 还原成相对路径
    const notesAssetsMatch = fixed.match(
      /^(?:asset|tauri):\/\/localhost\/.*?(notes_assets\/[^)\s"']+)$/i,
    );
    if (notesAssetsMatch?.[1]) {
      fixed = notesAssetsMatch[1];
    }

    return fixed;
  });
}
