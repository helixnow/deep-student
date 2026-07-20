import React from 'react';
import '@/shared/styles/app.css';
import '@/features/workbench/apps/system/SystemWindowShared.css';
import '@/features/workbench/apps/content/ResourceAppWorkspace.css';

/**
 * CT 测试故事：复刻题目集在学习桌面中的真实嵌套链：
 * WindowShell 窗框（定高 flex 列）→ 内容（relative min-h-0 flex-1）
 * → .wb-resource-workspace（absolute inset-0）
 * → .wb-sys-split（flex）→ .wb-sys-aside + .wb-sys-content
 * → main.wb-resource-workspace-main（height:100%）
 * → UnifiedAppPanel（flex flex-col h-full）→ ExamContentView 外壳
 * （Tab 栏 + flex-1 min-h-0 overflow-hidden）。
 */
export const WorkbenchExamShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: 'absolute',
      left: 60,
      top: 30,
      width: 980,
      height: 560,
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid rgba(127,127,127,0.4)',
      borderRadius: 12,
      overflow: 'hidden',
      background: 'hsl(var(--background))',
    }}
  >
    {/* WindowTitleBar 占位（40px） */}
    <div style={{ height: 40, flex: '0 0 auto', borderBottom: '1px solid rgba(127,127,127,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
      题目集
    </div>
    {/* WindowShell 内容区 */}
    <div className="relative min-h-0 flex-1" data-wb-window-content>
      <div className="wb-resource-workspace">
        <div className="wb-sys-split" data-wb-sys-drawer-mode="false">
          <div className="wb-sys-aside">
            <aside className="wb-resource-workspace-sidebar" style={{ padding: 8, fontSize: 13 }}>
              <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 6 }}>题目集</div>
              <div style={{ height: 30, margin: '4px 0', background: 'rgba(127,127,127,0.15)', borderRadius: 6 }} />
              <div style={{ height: 28 }}>全部</div>
              <div style={{ height: 28 }}>最近使用</div>
              <div style={{ height: 28, fontWeight: 600 }}>新题目集</div>
            </aside>
          </div>
          <div className="wb-sys-content">
            <main className="wb-resource-workspace-main">
              {/* UnifiedAppPanel */}
              <div className="flex flex-col h-full min-h-0 overflow-hidden bg-background">
                {/* ExamContentView */}
                <div className="flex flex-col h-full bg-background">
                  {/* Tab 栏 */}
                  <div className="flex-shrink-0 px-3 py-2.5 border-b border-border/40">
                    <div className="flex items-center gap-1 text-sm">
                      <span className="px-2.5 py-1.5 rounded-md bg-accent text-accent-foreground font-medium">题库</span>
                      <span className="px-2.5 py-1.5 text-muted-foreground">做题</span>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  </div>
);

export default WorkbenchExamShell;
