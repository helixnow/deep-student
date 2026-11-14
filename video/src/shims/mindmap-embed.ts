/**
 * 主应用的 src/features/mindmap/components/mindmap/MindMapEmbed.tsx 在宣传片里换成这个文件（webpack-override.mjs），
 * 所以这里不能有相对导入。原文件会带进整个思维导图编辑器（约 2300 个模块），而且要向后端取导图数据；
 * 生成式界面的「导图嵌入」块在片子里不渲染内容。
 */
export const MindMapEmbed = (_props: unknown) => null;
export default MindMapEmbed;
