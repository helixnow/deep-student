import React from 'react';

/**
 * CT 测试故事：模拟 ExamContentView 外壳。
 * Tab 栏（固定高）+ flex-1 overflow-hidden 有界内容区，
 * 与 src/features/learning-hub/apps/views/ExamContentView.tsx 的真实结构一致。
 */
export const ExamShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex h-screen w-screen flex-col bg-background text-foreground">
    <div className="flex-shrink-0 px-3 py-2.5 border-b border-border/40">
      <div className="flex items-center gap-1 text-sm">
        <span className="px-2.5 py-1.5 rounded-md bg-accent text-accent-foreground font-medium">题库</span>
        <span className="px-2.5 py-1.5 text-muted-foreground">做题</span>
      </div>
    </div>
    <div className="flex-1 overflow-hidden">{children}</div>
  </div>
);

export default ExamShell;
