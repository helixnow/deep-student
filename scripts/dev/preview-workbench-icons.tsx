/**
 * 临时预览脚本：把 WorkbenchAppIcon 全部图标渲染成静态 HTML，便于视觉核对。
 * 运行：npx vite-node scripts/dev/preview-workbench-icons.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { WorkbenchAppIcon } from '../../src/features/workbench/components/WorkbenchAppIcon';

const TYPE_IDS = [
  'notes', 'todo', 'chat', 'pomodoro', 'translation', 'skills',
  'textbook', 'browser', 'templates', 'sandbox', 'flashcards', 'settings',
  'exam', 'image', 'file', 'file-preview', 'taskDashboard', 'files', 'essay',
];

const NAMES: Record<string, string> = {
  notes: '笔记', todo: '待办', chat: '对话', pomodoro: '番茄钟', translation: '翻译',
  skills: '技能管理', textbook: '教材', browser: '浏览器', templates: '模板管理',
  sandbox: '沙箱工作台', flashcards: '闪卡', settings: '设置', exam: '题目集',
  image: '图片', file: '文件', 'file-preview': '文件预览', taskDashboard: '制卡任务',
  files: '资源库', essay: '作文批改',
};

const cells = TYPE_IDS.map((id) => {
  const svg = renderToStaticMarkup(<WorkbenchAppIcon typeId={id} />);
  return `<div class="cell"><div class="tile">${svg}</div><span>${NAMES[id] ?? id}</span></div>`;
}).join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 40px; background: #f2f4f7; font: 12px/1.4 -apple-system, "PingFang SC", sans-serif; }
.grid { display: grid; grid-template-columns: repeat(6, 110px); gap: 26px 18px; }
.cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.tile { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; }
.tile svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 2px 4px rgba(33,43,54,.22)); }
.dark { background: #22262c; margin-top: 40px; padding: 30px; border-radius: 12px; }
.dark span { color: #cbd2da; }
</style></head><body>
<div class="grid">${cells}</div>
<div class="dark"><div class="grid">${cells}</div></div>
</body></html>`;

fs.writeFileSync('/tmp/wb-icons-preview.html', html);
console.log('written /tmp/wb-icons-preview.html');
