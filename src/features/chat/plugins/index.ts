/**
 * Chat V2 - 插件导出
 *
 * 导入此文件会自动注册所有内置插件
 */

// 导入即注册（自执行）
import './blocks';
import './modes';
import './events';

// 重导出
export * from './blocks';
export * from './modes';
export * from './events';
