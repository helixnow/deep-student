import React, { useState } from 'react';
import { AlertTriangle, FileText, Trash2, Settings, Info } from 'lucide-react';
import { NotionButton } from './NotionButton';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
  NotionAlertDialog,
} from './NotionDialog';

/**
 * NotionDialog / NotionAlertDialog 组件预览面板
 */
export const NotionDialogDemo: React.FC = () => {
  const [generalOpen, setGeneralOpen] = useState(false);
  const [scrollOpen, setScrollOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [loadingOpen, setLoadingOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleFakeLoading = () => {
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      setLoadingOpen(false);
    }, 1500);
  };

  return (
    <div className="p-6 space-y-8">
      {/* 通用模态框 Demo */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-1">NotionDialog — 通用模态框</h4>
        <p className="text-xs text-muted-foreground mb-3">
          默认使用 NotionButton 按钮 + 自研滚动条，支持 Header / Body / Footer 组合
        </p>
        <div className="flex flex-wrap gap-2">
          <NotionButton variant="primary" size="sm" onClick={() => setGeneralOpen(true)}>
            <FileText className="h-3.5 w-3.5" />
            基本弹窗
          </NotionButton>
          <NotionButton variant="default" size="sm" onClick={() => setScrollOpen(true)}>
            <Settings className="h-3.5 w-3.5" />
            长内容滚动
          </NotionButton>
        </div>
      </div>

      {/* 确认模态框 Demo */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-1">NotionAlertDialog — 确认模态框</h4>
        <p className="text-xs text-muted-foreground mb-3">
          紧凑设计，支持 icon / loading / 多种变体色
        </p>
        <div className="flex flex-wrap gap-2">
          <NotionButton variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            删除确认
          </NotionButton>
          <NotionButton variant="warning" size="sm" onClick={() => setDangerOpen(true)}>
            <AlertTriangle className="h-3.5 w-3.5" />
            危险操作
          </NotionButton>
          <NotionButton variant="success" size="sm" onClick={() => setSuccessOpen(true)}>
            <Info className="h-3.5 w-3.5" />
            成功变体
          </NotionButton>
          <NotionButton variant="primary" size="sm" onClick={() => setLoadingOpen(true)}>
            Loading 状态
          </NotionButton>
        </div>
      </div>

      {/* ---- 弹窗实例 ---- */}

      {/* 基本通用弹窗 */}
      <NotionDialog open={generalOpen} onOpenChange={setGeneralOpen}>
        <NotionDialogHeader>
          <NotionDialogTitle>通用模态框标题</NotionDialogTitle>
          <NotionDialogDescription>
            这是一个 Notion 风格的通用模态框，按钮使用 NotionButton，滚动条使用项目自研 CustomScrollArea。
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody>
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-sm text-foreground/80">
                内容区域可放置任意组件：表单、列表、预览等。Body 自带自研滚动条，内容超出时自动出现。
              </p>
            </div>
            <div className="rounded-lg border border-border/50 p-3">
              <p className="text-xs text-muted-foreground">
                支持 closeOnOverlay / showClose / maxWidth 等配置项。
              </p>
            </div>
          </div>
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => setGeneralOpen(false)}>
            取消
          </NotionButton>
          <NotionButton variant="primary" size="sm" onClick={() => setGeneralOpen(false)}>
            确定
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>

      {/* 长内容滚动弹窗 */}
      <NotionDialog open={scrollOpen} onOpenChange={setScrollOpen} maxWidth="max-w-md">
        <NotionDialogHeader>
          <NotionDialogTitle>自研滚动条演示</NotionDialogTitle>
          <NotionDialogDescription>
            下方内容超出可视区域时，会出现项目自研的 CustomScrollArea 滚动条。
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody>
          <div className="space-y-3 py-2">
            {Array.from({ length: 20 }, (_, i) => (
              <div key={i} className="rounded-lg bg-muted/30 p-3 border border-border/30">
                <p className="text-sm text-foreground/70">
                  第 {i + 1} 项 — 这是一段演示文本，用于测试滚动条在长内容场景下的表现效果。
                </p>
              </div>
            ))}
          </div>
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => setScrollOpen(false)}>
            关闭
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>

      {/* 删除确认 */}
      <NotionAlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        icon={<Trash2 className="h-5 w-5 text-red-500" />}
        title="确认删除？"
        description="此操作将永久删除该项目，无法撤销。请确认是否继续。"
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => setDeleteOpen(false)}
      />

      {/* 危险操作 */}
      <NotionAlertDialog
        open={dangerOpen}
        onOpenChange={setDangerOpen}
        icon={<AlertTriangle className="h-5 w-5 text-orange-500" />}
        title="清空所有数据"
        description="这将永久清除所有学习记录和配置，此操作不可撤销。"
        confirmText="确认清空"
        cancelText="再想想"
        confirmVariant="warning"
        onConfirm={() => setDangerOpen(false)}
      >
        <div className="rounded-lg bg-orange-500/5 border border-orange-500/20 p-3">
          <p className="text-xs text-orange-600 dark:text-orange-400">
            提示：可在确认框内嵌入额外内容，如此警告提示。
          </p>
        </div>
      </NotionAlertDialog>

      {/* 成功变体 */}
      <NotionAlertDialog
        open={successOpen}
        onOpenChange={setSuccessOpen}
        title="确认提交？"
        description="您的修改将立即生效。"
        confirmText="提交"
        cancelText="返回"
        confirmVariant="success"
        onConfirm={() => setSuccessOpen(false)}
      />

      {/* Loading 状态 */}
      <NotionAlertDialog
        open={loadingOpen}
        onOpenChange={setLoadingOpen}
        title="正在保存..."
        description="点击确认后将模拟 1.5 秒的加载状态。"
        confirmText="确认保存"
        cancelText="取消"
        confirmVariant="primary"
        loading={isLoading}
        onConfirm={handleFakeLoading}
      />
    </div>
  );
};
