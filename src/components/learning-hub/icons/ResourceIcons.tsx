/**
 * 学习资源管理器自定义 SVG 图标 - Notion 风格优化版 (v4)
 * 
 * 优化重点 (v4):
 * - 文件夹：彻底扁平化，去除所有阴影滤镜，使用纯色块构建，接近 Notion UI 的文件夹质感
 * - 翻译：重新设计为经典的 "文/A" 切换卡片，更清晰的语义
 * - 整体：移除所有 SVG 滤镜（提升性能且更风格化），仅使用透明度表达层次
 */

import React from 'react';
import { cn } from '@/lib/utils';

export interface ResourceIconProps {
  className?: string;
  size?: number;
  primaryColor?: string;
  secondaryColor?: string;
  symbolColor?: string;
}

const defaultSize = 48;

// Notion Color Palette (Matte & Pastel)
// Adjusted for v4: Slightly more vibrant for dark mode visibility, but still matte
const palette = {
  gray:   { bg: '#F1F0EF', fg: '#787774', border: '#E0E0E0' },
  brown:  { bg: '#F4EEEE', fg: '#976D57', border: '#E8DCD5' },
  orange: { bg: '#FBECDD', fg: '#CC782F', border: '#F5CCAA' },
  yellow: { bg: '#FBF3DB', fg: '#CF9232', border: '#F9E2AF' },
  green:  { bg: '#EDF3EC', fg: '#4F9779', border: '#C6E3C6' },
  blue:   { bg: '#E7F3F8', fg: '#2B59C3', border: '#B8D6E8' },
  purple: { bg: '#F6F3F9', fg: '#9A6DD7', border: '#D9CBE4' },
  pink:   { bg: '#FBF2F5', fg: '#D65C9D', border: '#ECD0DE' },
  red:    { bg: '#FDEBEC', fg: '#D44C47', border: '#FFD1CA' },
};

// ============================================================================
// 基础组件：文档形状 (Flat Paper)
// ============================================================================
const DocBase: React.FC<{
  size: number;
  color: keyof typeof palette;
  className?: string;
  children?: React.ReactNode;
}> = ({ size, color, className, children }) => {
  const theme = palette[color];
  
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0', className)}
    >
      {/* 文档主体 - 纯色扁平 */}
      <path
        d="M10 4C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H38C39.1046 44 40 43.1046 40 42V14L30 4H10Z"
        fill={theme.bg}
      />
      
      {/* 边框 - 增加清晰度 */}
      <path
        d="M10 4C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H38C39.1046 44 40 43.1046 40 42V14L30 4H10Z"
        stroke={theme.border}
        strokeWidth="1"
        fill="none"
      />
      
      {/* 折角 - 纯色 */}
      <path
        d="M30 4V13C30 13.5523 30.4477 14 31 14H40"
        fill="#FFFFFF"
        fillOpacity="0.5"
      />
      <path
        d="M30 4L40 14H31C30.4477 14 30 13.5523 30 13V4Z"
        fill="black"
        fillOpacity="0.05"
      />
      
      {/* 内容区域 */}
      <g transform="translate(0, 2)">
        {children}
      </g>
    </svg>
  );
};

// ============================================================================
// 笔记图标 - 绿色 (Lines)
// ============================================================================
export const NoteIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="green" className={className}>
    <rect x="14" y="18" width="16" height="2" rx="1" fill={palette.green.fg} />
    <rect x="14" y="24" width="20" height="2" rx="1" fill={palette.green.fg} opacity="0.6" />
    <rect x="14" y="30" width="18" height="2" rx="1" fill={palette.green.fg} opacity="0.6" />
    <rect x="14" y="36" width="12" height="2" rx="1" fill={palette.green.fg} opacity="0.4" />
  </DocBase>
);

// ============================================================================
// 教材图标 - 橙色 (Book) - v5 书本样式
// ============================================================================
export const TextbookIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 书封面 */}
    <rect
      x="8"
      y="6"
      width="28"
      height="36"
      rx="2"
      fill={palette.orange.bg}
      stroke={palette.orange.fg}
      strokeWidth="1.5"
    />
    
    {/* 书脊 */}
    <rect x="8" y="6" width="5" height="36" rx="2" fill={palette.orange.fg} fillOpacity="0.15" />
    <line x1="11" y1="6" x2="11" y2="42" stroke={palette.orange.fg} strokeWidth="1" strokeOpacity="0.25" />
    
    {/* 封面内容 */}
    <path d="M17 20H30" stroke={palette.orange.fg} strokeWidth="2" strokeLinecap="round" />
    <path d="M17 26H26" stroke={palette.orange.fg} strokeWidth="2" strokeLinecap="round" opacity="0.6" />
    
    {/* 书签 */}
    <path d="M27 4V14L29.5 12L32 14V4" fill={palette.orange.fg} />
  </svg>
);

// ============================================================================
// 题目集图标 - 紫色 (Stacked Files) - v7 重设计：四层文件扇形展开，左下角旋转中心
// ============================================================================
export const ExamIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 第4层（底层）- 向右旋转16° */}
    <g style={{ transformOrigin: '8px 44px', transform: 'rotate(16deg)' }}>
      <path
        d="M8 6C6.89543 6 6 6.89543 6 8V40C6 41.1046 6.89543 42 7 42H31C32.1046 42 33 41.1046 33 40V12L25 6H8Z"
        fill={palette.purple.bg}
        stroke={palette.purple.fg}
        strokeWidth="1"
        opacity="0.3"
      />
    </g>
    
    {/* 第3层 - 向右旋转8° */}
    <g style={{ transformOrigin: '8px 44px', transform: 'rotate(8deg)' }}>
      <path
        d="M8 6C6.89543 6 6 6.89543 6 8V40C6 41.1046 6.89543 42 7 42H31C32.1046 42 33 41.1046 33 40V12L25 6H8Z"
        fill={palette.purple.bg}
        stroke={palette.purple.fg}
        strokeWidth="1"
        opacity="0.5"
      />
    </g>
    
    {/* 第2层 - 不旋转 */}
    <g style={{ transformOrigin: '8px 44px', transform: 'rotate(0deg)' }}>
      <path
        d="M8 6C6.89543 6 6 6.89543 6 8V40C6 41.1046 6.89543 42 7 42H31C32.1046 42 33 41.1046 33 40V12L25 6H8Z"
        fill={palette.purple.bg}
        stroke={palette.purple.fg}
        strokeWidth="1"
        opacity="0.7"
      />
    </g>
    
    {/* 第1层（顶层）- 向左旋转8° */}
    <g style={{ transformOrigin: '8px 44px', transform: 'rotate(-8deg)' }}>
      <path
        d="M8 6C6.89543 6 6 6.89543 6 8V40C6 41.1046 6.89543 42 7 42H31C32.1046 42 33 41.1046 33 40V12L25 6H8Z"
        fill="#FFFFFF"
        stroke={palette.purple.fg}
        strokeWidth="1.5"
      />
      {/* 折角 */}
      <path d="M25 6V12H33L25 6Z" fill={palette.purple.bg} stroke={palette.purple.fg} strokeWidth="1.5" strokeLinejoin="round" />
      
      {/* 试卷特征 - 选项列表 */}
      <circle cx="12" cy="20" r="1.5" stroke={palette.purple.fg} strokeWidth="1.2" fill="none" />
      <rect x="16" y="19" width="10" height="2" rx="1" fill={palette.purple.fg} opacity="0.6" />
      
      <circle cx="12" cy="27" r="1.5" fill={palette.purple.fg} />
      <rect x="16" y="26" width="8" height="2" rx="1" fill={palette.purple.fg} opacity="0.8" />
      
      <circle cx="12" cy="34" r="1.5" stroke={palette.purple.fg} strokeWidth="1.2" fill="none" />
      <rect x="16" y="33" width="12" height="2" rx="1" fill={palette.purple.fg} opacity="0.6" />
    </g>
  </svg>
);

// ============================================================================
// 作文图标 - 粉色 (Typography)
// ============================================================================
export const EssayIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="pink" className={className}>
    <text
      x="24"
      y="30"
      fontSize="22"
      fontWeight="bold"
      fontFamily="serif"
      fontStyle="italic"
      fill={palette.pink.fg}
      textAnchor="middle"
    >
      Aa
    </text>
  </DocBase>
);

// ============================================================================
// 翻译图标 - 蓝色 (Translation) - v5 重设计：纯卡片无文件背景
// ============================================================================
export const TranslationIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 卡片 A (背景) - 右上角偏移更多 */}
    <rect
      x="20"
      y="6"
      width="20"
      height="24"
      rx="3"
      fill={palette.blue.bg}
      stroke={palette.blue.fg}
      strokeWidth="1.5"
      strokeOpacity="0.6"
    />
    <text
      x="30"
      y="22"
      fontSize="14"
      fontWeight="600"
      fill={palette.blue.fg}
      textAnchor="middle"
    >
      A
    </text>

    {/* 卡片 文 (前景) - 左下角 */}
    <rect
      x="8"
      y="18"
      width="20"
      height="24"
      rx="3"
      fill="#FFFFFF"
      stroke={palette.blue.fg}
      strokeWidth="1.5"
    />
    <text
      x="18"
      y="34"
      fontSize="14"
      fontWeight="bold"
      fill={palette.blue.fg}
      textAnchor="middle"
    >
      文
    </text>
  </svg>
);

// ============================================================================
// 知识导图图标 - 青色 (Mindmap)
// ============================================================================
export const MindmapIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="green" className={className}>
    <circle cx="18" cy="24" r="3" fill={palette.green.fg} />
    <path d="M21 24C26 24 26 16 31 16" stroke={palette.green.fg} strokeWidth="1.5" fill="none" opacity="0.6" />
    <path d="M21 24C26 24 26 24 31 24" stroke={palette.green.fg} strokeWidth="1.5" fill="none" opacity="0.6" />
    <path d="M21 24C26 24 26 32 31 32" stroke={palette.green.fg} strokeWidth="1.5" fill="none" opacity="0.6" />
    <circle cx="31" cy="16" r="2.5" fill={palette.green.fg} opacity="0.8" />
    <circle cx="31" cy="24" r="2.5" fill={palette.green.fg} opacity="0.8" />
    <circle cx="31" cy="32" r="2.5" fill={palette.green.fg} opacity="0.8" />
  </DocBase>
);

// ============================================================================
// 文件夹图标 - 黄/橙色 (Notion-style Folder) - v5 重设计
// 参考 macOS/Notion 的经典文件夹配色，更饱满的形状
// ============================================================================
export const FolderIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 后层 - 文件夹背板 */}
    <path
      d="M6 10C6 8.89543 6.89543 8 8 8H18L21 11H40C41.1046 11 42 11.8954 42 13V39C42 40.1046 41.1046 41 40 41H8C6.89543 41 6 40.1046 6 39V10Z"
      fill="#E8B849"
    />
    
    {/* 标签页凸起 */}
    <path
      d="M6 10C6 8.89543 6.89543 8 8 8H17C17.5523 8 18 8.44772 18 9V11H6V10Z"
      fill="#D4A53A"
    />

    {/* 前盖 - 主体 */}
    <path
      d="M6 15C6 13.8954 6.89543 13 8 13H40C41.1046 13 42 13.8954 42 15V39C42 40.1046 41.1046 41 40 41H8C6.89543 41 6 40.1046 6 39V15Z"
      fill="#F5C85C"
    />
    
    {/* 顶部高光 - 增加质感 */}
    <path
      d="M7 15C7 14.4477 7.44772 14 8 14H40C40.5523 14 41 14.4477 41 15"
      stroke="white"
      strokeWidth="1"
      strokeOpacity="0.4"
      fill="none"
    />
    
    {/* 底部微暗 - 增加立体感 */}
    <path
      d="M6 37H42V39C42 40.1046 41.1046 41 40 41H8C6.89543 41 6 40.1046 6 39V37Z"
      fill="#E8B849"
      fillOpacity="0.5"
    />
  </svg>
);

// ============================================================================
// 图片图标 - 灰色 (Image)
// ============================================================================
export const ImageFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 图片边框 */}
    <rect
      x="6"
      y="10"
      width="36"
      height="28"
      rx="3"
      fill={palette.gray.bg}
      stroke={palette.gray.fg}
      strokeWidth="1.5"
    />
    {/* 太阳/光源 */}
    <circle cx="14" cy="18" r="3" fill={palette.gray.fg} opacity="0.7" />
    {/* 山峰图形 */}
    <path
      d="M6 32L14 22L22 30L30 20L42 32V35C42 36.6569 40.6569 38 39 38H9C7.34315 38 6 36.6569 6 35V32Z"
      fill={palette.gray.fg}
      opacity="0.5"
    />
  </svg>
);

// ============================================================================
// 通用文件图标
// ============================================================================
export const GenericFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="gray" className={className}>
    <rect x="14" y="18" width="20" height="2" rx="1" fill={palette.gray.fg} fillOpacity="0.3" />
    <rect x="14" y="24" width="16" height="2" rx="1" fill={palette.gray.fg} fillOpacity="0.2" />
    <rect x="14" y="30" width="12" height="2" rx="1" fill={palette.gray.fg} fillOpacity="0.2" />
  </DocBase>
);

// ============================================================================
// PDF 文件图标 - 红色
// ============================================================================
export const PdfFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="red" className={className}>
    {/* PDF 标签 */}
    <rect x="14" y="20" width="20" height="12" rx="2" fill={palette.red.fg} fillOpacity="0.15" />
    <text
      x="24"
      y="29"
      fontSize="8"
      fontWeight="bold"
      fill={palette.red.fg}
      textAnchor="middle"
    >
      PDF
    </text>
    {/* 下方装饰线 */}
    <rect x="14" y="36" width="16" height="2" rx="1" fill={palette.red.fg} opacity="0.4" />
  </DocBase>
);

// ============================================================================
// Word/DOCX 文件图标 - 蓝色
// ============================================================================
export const DocxFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="blue" className={className}>
    {/* W 字母标记 */}
    <text
      x="24"
      y="32"
      fontSize="18"
      fontWeight="bold"
      fill={palette.blue.fg}
      textAnchor="middle"
    >
      W
    </text>
    {/* 下划线装饰 */}
    <rect x="16" y="36" width="16" height="2" rx="1" fill={palette.blue.fg} opacity="0.5" />
  </DocBase>
);

// ============================================================================
// PowerPoint/PPTX 文件图标 - 橙色
// ============================================================================
export const PptxFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="orange" className={className}>
    {/* P 字母标记 */}
    <text
      x="24"
      y="32"
      fontSize="18"
      fontWeight="bold"
      fill={palette.orange.fg}
      textAnchor="middle"
    >
      P
    </text>
    {/* 下划线装饰 */}
    <rect x="16" y="36" width="16" height="2" rx="1" fill={palette.orange.fg} opacity="0.5" />
  </DocBase>
);

// ============================================================================
// Excel/XLSX 文件图标 - 绿色
// ============================================================================
export const XlsxFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <DocBase size={size} color="green" className={className}>
    {/* X 字母标记 */}
    <text
      x="24"
      y="32"
      fontSize="18"
      fontWeight="bold"
      fill={palette.green.fg}
      textAnchor="middle"
    >
      X
    </text>
    {/* 下划线装饰 */}
    <rect x="16" y="36" width="16" height="2" rx="1" fill={palette.green.fg} opacity="0.5" />
  </DocBase>
);

// ============================================================================
// 音频文件图标 - 绿色
// ============================================================================
export const AudioFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 圆形背景 */}
    <circle cx="24" cy="24" r="18" fill={palette.green.bg} stroke={palette.green.fg} strokeWidth="1.5" />
    {/* 音符图标 */}
    <path
      d="M20 32V20L30 18V30"
      stroke={palette.green.fg}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <circle cx="17" cy="32" r="3" fill={palette.green.fg} />
    <circle cx="27" cy="30" r="3" fill={palette.green.fg} />
  </svg>
);

// ============================================================================
// 视频文件图标 - 紫色
// ============================================================================
export const VideoFileIcon: React.FC<ResourceIconProps> = ({
  className,
  size = defaultSize,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn('shrink-0', className)}
  >
    {/* 视频播放器外框 */}
    <rect
      x="6"
      y="10"
      width="36"
      height="28"
      rx="4"
      fill={palette.purple.bg}
      stroke={palette.purple.fg}
      strokeWidth="1.5"
    />
    {/* 播放按钮 */}
    <path
      d="M20 17L32 24L20 31V17Z"
      fill={palette.purple.fg}
    />
  </svg>
);

// ============================================================================
// 侧边栏图标 (Simple geometric)
// ============================================================================

export const MemoryIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.purple.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 背景圆 */}
    <circle cx="12" cy="12" r="10" fill={palette.purple.bg} stroke={palette.purple.border} strokeWidth="1.2"/>
    {/* 连接线 */}
    <path d="M7 7L17 9" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    <path d="M7 7L17 17" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    <path d="M7 12L17 9" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    <path d="M7 12L17 17" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    <path d="M7 17L17 9" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    <path d="M7 17L17 17" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.3"/>
    {/* 左侧节点 */}
    <circle cx="7" cy="7" r="2.2" fill={symbolColor} stroke={palette.purple.border} strokeWidth="0.6"/>
    <circle cx="7" cy="12" r="2.2" fill={symbolColor} stroke={palette.purple.border} strokeWidth="0.6"/>
    <circle cx="7" cy="17" r="2.2" fill={symbolColor} stroke={palette.purple.border} strokeWidth="0.6"/>
    {/* 右侧节点 */}
    <circle cx="17" cy="9" r="1.8" fill={symbolColor} fillOpacity="0.65" stroke={palette.purple.border} strokeWidth="0.6"/>
    <circle cx="17" cy="17" r="1.8" fill={symbolColor} fillOpacity="0.65" stroke={palette.purple.border} strokeWidth="0.6"/>
  </svg>
);

export const FavoriteIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.yellow.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 书签底座 */}
    <rect x="4" y="2" width="16" height="20" rx="2" fill={palette.yellow.bg} stroke={palette.yellow.border} strokeWidth="1.2"/>
    {/* 书签丝带 */}
    <path d="M9 2V7.5L12 5.8L15 7.5V2" fill={symbolColor} fillOpacity="0.8" stroke={symbolColor} strokeWidth="0.5" strokeOpacity="0.3" strokeLinejoin="round"/>
    {/* 五角星 */}
    <path d="M12 9L13.76 12.53L17.66 13.1L14.83 15.87L15.52 19.76L12 17.9L8.48 19.76L9.17 15.87L6.34 13.1L10.24 12.53Z" fill={symbolColor} fillOpacity="0.8" stroke={symbolColor} strokeWidth="0.5" strokeOpacity="0.4" strokeLinejoin="round"/>
  </svg>
);

export const RecentIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.blue.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 时钟外圈 */}
    <circle cx="12" cy="12" r="10" fill={palette.blue.bg} stroke={palette.blue.border} strokeWidth="1.2"/>
    {/* 表盘刻度 */}
    <circle cx="12" cy="3.5" r="0.8" fill={symbolColor} fillOpacity="0.4"/>
    <circle cx="20.5" cy="12" r="0.8" fill={symbolColor} fillOpacity="0.4"/>
    <circle cx="12" cy="20.5" r="0.8" fill={symbolColor} fillOpacity="0.4"/>
    <circle cx="3.5" cy="12" r="0.8" fill={symbolColor} fillOpacity="0.4"/>
    {/* 时钟内圈 */}
    <circle cx="12" cy="12" r="7" fill="white" fillOpacity="0.35" stroke={symbolColor} strokeWidth="0.8" strokeOpacity="0.25"/>
    {/* 时针 */}
    <path d="M12 12V8" stroke={symbolColor} strokeWidth="1.8" strokeLinecap="round"/>
    {/* 分针 */}
    <path d="M12 12L15.5 14" stroke={symbolColor} strokeWidth="1.4" strokeLinecap="round"/>
    {/* 中心点 */}
    <circle cx="12" cy="12" r="1.2" fill={symbolColor}/>
  </svg>
);

export const TrashIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.red.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 桶身 */}
    <path d="M6 7H18V20C18 21.1046 17.1046 22 16 22H8C6.89543 22 6 21.1046 6 20V7Z" fill={palette.red.bg} stroke={palette.red.border} strokeWidth="1.2"/>
    {/* 桶盖 */}
    <rect x="4" y="5" width="16" height="2.5" rx="1.25" fill={symbolColor} fillOpacity="0.7" stroke={symbolColor} strokeWidth="0.5" strokeOpacity="0.3"/>
    {/* 提手 */}
    <path d="M9 5V3.5C9 2.67 9.67 2 10.5 2H13.5C14.33 2 15 2.67 15 3.5V5" stroke={symbolColor} strokeWidth="1.2" strokeLinecap="round"/>
    {/* 删除线条 */}
    <line x1="10" y1="10.5" x2="10" y2="18" stroke={symbolColor} strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
    <line x1="14" y1="10.5" x2="14" y2="18" stroke={symbolColor} strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
  </svg>
);

export const IndexStatusIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.green.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 数据库桶身 */}
    <path d="M4 7V17C4 19.2 7.58 21 12 21C16.42 21 20 19.2 20 17V7" fill={palette.green.bg}/>
    <path d="M4 7V17C4 19.2 7.58 21 12 21C16.42 21 20 19.2 20 17V7" stroke={palette.green.border} strokeWidth="1.2"/>
    {/* 顶部椭圆 */}
    <ellipse cx="12" cy="7" rx="8" ry="3.5" fill={palette.green.bg} stroke={palette.green.border} strokeWidth="1.2"/>
    <ellipse cx="12" cy="7" rx="8" ry="3.5" fill={symbolColor} fillOpacity="0.15"/>
    {/* 中间分隔线 */}
    <path d="M4 12C4 14.2 7.58 15.5 12 15.5C16.42 15.5 20 14.2 20 12" stroke={symbolColor} strokeWidth="1" strokeOpacity="0.35"/>
    {/* 向量化箭头 */}
    <path d="M10 11L12 9L14 11" stroke={symbolColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.6"/>
    <line x1="12" y1="9" x2="12" y2="14" stroke={symbolColor} strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.6"/>
  </svg>
);

export const AllFilesIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.green.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 后层文件夹 */}
    <rect x="3" y="6" width="18" height="15" rx="2" fill={palette.green.bg} stroke={palette.green.border} strokeWidth="1.2" opacity="0.5"/>
    {/* 前层文件夹 */}
    <path d="M3 7C3 5.89543 3.89543 5 5 5H9.5L11.5 7.5H19C20.1046 7.5 21 8.39543 21 9.5V19C21 20.1046 20.1046 21 19 21H5C3.89543 21 3 20.1046 3 19V7Z" fill={palette.green.bg} stroke={palette.green.border} strokeWidth="1.2"/>
    {/* 文件夹标签 */}
    <path d="M3 7C3 5.89543 3.89543 5 5 5H9.5L11.5 7.5H3V7Z" fill={symbolColor} fillOpacity="0.15"/>
    {/* 文件缩略线 */}
    <rect x="7" y="11" width="7" height="1.2" rx="0.6" fill={symbolColor} fillOpacity="0.5"/>
    <rect x="7" y="14" width="10" height="1.2" rx="0.6" fill={symbolColor} fillOpacity="0.35"/>
    <rect x="7" y="17" width="5" height="1.2" rx="0.6" fill={symbolColor} fillOpacity="0.2"/>
  </svg>
);

export const DesktopIcon: React.FC<ResourceIconProps> = ({ className, size = 24, symbolColor = palette.blue.fg }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    {/* 桌面板 */}
    <rect x="2" y="3" width="20" height="14" rx="2.5" fill={palette.blue.bg} stroke={palette.blue.border} strokeWidth="1.2"/>
    {/* 屏幕顶部装饰条 */}
    <rect x="2" y="3" width="20" height="3.5" rx="2.5" fill={symbolColor} fillOpacity="0.12"/>
    {/* 文件图标 - 小文档 */}
    <rect x="6" y="8" width="4" height="5" rx="0.8" fill={symbolColor} fillOpacity="0.25" stroke={symbolColor} strokeWidth="0.6" strokeOpacity="0.4"/>
    <rect x="7" y="10" width="2" height="0.6" rx="0.3" fill={symbolColor} fillOpacity="0.5"/>
    <rect x="7" y="11.2" width="1.5" height="0.6" rx="0.3" fill={symbolColor} fillOpacity="0.35"/>
    {/* 文件图标 - 小图片 */}
    <rect x="14" y="8" width="4" height="5" rx="0.8" fill={symbolColor} fillOpacity="0.25" stroke={symbolColor} strokeWidth="0.6" strokeOpacity="0.4"/>
    <circle cx="15.5" cy="10" r="0.7" fill={symbolColor} fillOpacity="0.5"/>
    <path d="M14.5 12.5L15.8 11L17 12L17.5 11.5" stroke={symbolColor} strokeWidth="0.5" strokeLinecap="round" strokeOpacity="0.5"/>
    {/* 底座 - 使用 currentColor 适配暗色模式 */}
    <path d="M10 17V19.5" stroke="currentColor" strokeWidth="1.3" opacity="0.5"/>
    <path d="M14 17V19.5" stroke="currentColor" strokeWidth="1.3" opacity="0.5"/>
    <path d="M8 19.5H16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.5"/>
  </svg>
);

// ============================================================================
// 图标类型映射
// ============================================================================
export type ResourceIconType = 
  | 'note' 
  | 'textbook' 
  | 'exam' 
  | 'essay' 
  | 'translation' 
  | 'mindmap' 
  | 'folder' 
  | 'image' 
  | 'file'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'audio'
  | 'video'
  | 'memory'
  | 'favorite'
  | 'recent'
  | 'trash'
  | 'indexStatus'
  | 'allFiles'
  | 'desktop';

export const ResourceIconMap: Record<ResourceIconType, React.FC<ResourceIconProps>> = {
  note: NoteIcon,
  textbook: TextbookIcon,
  exam: ExamIcon,
  essay: EssayIcon,
  translation: TranslationIcon,
  mindmap: MindmapIcon,
  folder: FolderIcon,
  image: ImageFileIcon,
  file: GenericFileIcon,
  pdf: PdfFileIcon,
  docx: DocxFileIcon,
  pptx: PptxFileIcon,
  xlsx: XlsxFileIcon,
  audio: AudioFileIcon,
  video: VideoFileIcon,
  memory: MemoryIcon,
  favorite: FavoriteIcon,
  recent: RecentIcon,
  trash: TrashIcon,
  indexStatus: IndexStatusIcon,
  allFiles: AllFilesIcon,
  desktop: DesktopIcon,
};

/**
 * 根据类型获取对应的图标组件
 */
export function getResourceIcon(type: ResourceIconType): React.FC<ResourceIconProps> {
  return ResourceIconMap[type] || GenericFileIcon;
}

/**
 * 根据 MIME 类型获取对应的文件图标组件
 * 用于聊天附件、文件预览等场景
 */
export function getFileTypeIconByMime(mimeType: string): React.FC<ResourceIconProps> {
  // PDF 文件
  if (mimeType.includes('pdf')) {
    return PdfFileIcon;
  }
  
  // Word 文档
  if (mimeType.includes('word') || mimeType.includes('msword') || mimeType.includes('wordprocessingml')) {
    return DocxFileIcon;
  }
  
  // PowerPoint 演示文稿
  if (mimeType.includes('presentationml') || mimeType.includes('powerpoint')) {
    return PptxFileIcon;
  }
  
  // Excel 电子表格
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return XlsxFileIcon;
  }
  
  // 音频文件
  if (mimeType.includes('audio')) {
    return AudioFileIcon;
  }
  
  // 视频文件
  if (mimeType.includes('video')) {
    return VideoFileIcon;
  }
  
  // 图片文件
  if (mimeType.includes('image')) {
    return ImageFileIcon;
  }
  
  // 默认通用文件图标
  return GenericFileIcon;
}
