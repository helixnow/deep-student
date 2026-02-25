/**
 * Chat V2 - 模板工具可视化输出组件
 *
 * 用于渲染 template_preview / template_get / template_update / template_create / template_fork 的工具输出。
 * 使用项目成熟的 renderCardPreview + ShadowDomPreview 做真实 Mustache/Cloze 渲染。
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import { renderCardPreview } from '@/components/SharedPreview';
import type { AnkiCardTemplate } from '@/types';
import {
  Eye,
  FileJson,
  Layers,
  CheckCircle,
  XCircle,
  GitFork,
  Plus,
  Pencil,
} from 'lucide-react';
import { emitTemplateDesignerLifecycle } from '@/chat-v2/debug/templateDesignerDebug';

// ============================================================================
// 类型定义
// ============================================================================

/** before/after 对比中每一侧的原始模板数据 */
interface TemplateSnapshot {
  name?: string;
  frontTemplate?: string;
  backTemplate?: string;
  cssStyle?: string;
  fields?: string[];
  noteType?: string;
  previewDataJson?: string;
  generationPrompt?: string;
  version?: string;
}

interface TemplateVisualData {
  _templateVisual?: boolean;
  _templateDiff?: boolean;
  // 原始模板数据（前端用 renderCardPreview 渲染）
  frontTemplate?: string;
  backTemplate?: string;
  cssStyle?: string;
  previewDataJson?: string;
  generationPrompt?: string;
  // update diff 模式
  before?: TemplateSnapshot;
  after?: TemplateSnapshot;
  // 模板元数据
  id?: string;
  version?: string;
  noteType?: string;
  fields?: string[];
  description?: string;
  isActive?: boolean;
  isBuiltIn?: boolean;
  author?: string;
  // fork 结果
  forked?: boolean;
  sourceTemplateId?: string;
  // create 结果
  created?: boolean;
  // preview 结果
  sampleData?: Record<string, unknown>;
  usedTemplateId?: string;
  // 通用
  warnings?: string[];
  name?: string;
  updated?: boolean;
  templateId?: string;
  [key: string]: unknown;
}

export interface TemplateToolOutputProps {
  output: TemplateVisualData;
  className?: string;
}

// ============================================================================
// 判定函数
// ============================================================================

/**
 * 判断工具输出是否为模板可视化数据
 */
export function isTemplateVisualOutput(output: unknown): output is TemplateVisualData {
  if (!output || typeof output !== 'object') return false;
  const obj = output as Record<string, unknown>;
  return obj._templateVisual === true;
}

// ============================================================================
// 辅助：构建 AnkiCardTemplate 对象供 renderCardPreview 使用
// ============================================================================

function buildAnkiTemplate(data: {
  name?: string;
  frontTemplate?: string;
  backTemplate?: string;
  cssStyle?: string;
  fields?: string[];
  noteType?: string;
  previewDataJson?: string;
  generationPrompt?: string;
  id?: string;
}): AnkiCardTemplate {
  return {
    id: data.id || 'preview',
    name: data.name || '',
    description: '',
    preview_front: '',
    preview_back: '',
    preview_data_json: data.previewDataJson || undefined,
    front_template: data.frontTemplate || '',
    back_template: data.backTemplate || '',
    css_style: data.cssStyle || '',
    note_type: data.noteType || 'Basic',
    generation_prompt: data.generationPrompt || '',
    fields: data.fields || [],
  };
}

/**
 * 使用 renderCardPreview 渲染模板的正面和背面
 */
function renderTemplateSides(
  template: AnkiCardTemplate,
  sampleData?: Record<string, unknown>,
): { front: string; back: string } {
  try {
    const front = renderCardPreview(
      template.front_template,
      template,
      sampleData,
      false,
    );
    const back = renderCardPreview(
      template.back_template,
      template,
      sampleData,
      true,
    );
    return { front, back };
  } catch (err: unknown) {
    return {
      front: `<div style="color:red;padding:8px;">渲染失败: ${err instanceof Error ? err.message : '未知错误'}</div>`,
      back: `<div style="color:red;padding:8px;">渲染失败</div>`,
    };
  }
}

// ============================================================================
// 子组件：单面预览卡片（使用真实渲染）
// ============================================================================

interface CardSideProps {
  label: string;
  htmlContent: string;
  cssContent: string;
}

const CardSide: React.FC<CardSideProps> = ({ label, htmlContent, cssContent }) => {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-xs font-medium text-muted-foreground mb-1.5">{label}</div>
      <div
        className={cn(
          'rounded-lg border border-border/40 overflow-hidden',
          'bg-white dark:bg-zinc-900'
        )}
      >
        <ShadowDomPreview htmlContent={htmlContent} cssContent={cssContent} compact fidelity="anki" />
      </div>
    </div>
  );
};

// ============================================================================
// 子组件：Before/After 对比（使用真实渲染）
// ============================================================================

interface DiffViewProps {
  before: TemplateSnapshot;
  after: TemplateSnapshot;
  sampleData?: Record<string, unknown>;
}

const DiffView: React.FC<DiffViewProps> = ({ before, after, sampleData }) => {
  const { t } = useTranslation('chatV2');
  const [side, setSide] = useState<'front' | 'back'>('front');

  const beforeTemplate = useMemo(() => buildAnkiTemplate(before), [before]);
  const afterTemplate = useMemo(() => buildAnkiTemplate(after), [after]);

  const beforeRendered = useMemo(
    () => renderTemplateSides(beforeTemplate, sampleData),
    [beforeTemplate, sampleData],
  );
  const afterRendered = useMemo(
    () => renderTemplateSides(afterTemplate, sampleData),
    [afterTemplate, sampleData],
  );

  const beforeHtml = side === 'front' ? beforeRendered.front : beforeRendered.back;
  const afterHtml = side === 'front' ? afterRendered.front : afterRendered.back;

  return (
    <div>
      {/* 正面/背面切换 */}
      <div className="flex gap-1 mb-2">
        <NotionButton variant={side === 'front' ? 'default' : 'ghost'} size="sm" onClick={() => setSide('front')} className={cn(side === 'front' && 'bg-primary/15 text-primary')}>
          {t('templateTool.front')}
        </NotionButton>
        <NotionButton variant={side === 'back' ? 'default' : 'ghost'} size="sm" onClick={() => setSide('back')} className={cn(side === 'back' && 'bg-primary/15 text-primary')}>
          {t('templateTool.back')}
        </NotionButton>
      </div>

      {/* Before / After 并排 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400/70" />
            {t('templateTool.before')}
          </div>
          <div
            className={cn(
              'rounded-lg border border-red-200/50 dark:border-red-900/30 overflow-hidden',
              'bg-white dark:bg-zinc-900'
            )}
          >
            <ShadowDomPreview
              htmlContent={beforeHtml}
              cssContent={before.cssStyle || ''}
              compact
              fidelity="anki"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400/70" />
            {t('templateTool.after')}
          </div>
          <div
            className={cn(
              'rounded-lg border border-green-200/50 dark:border-green-900/30 overflow-hidden',
              'bg-white dark:bg-zinc-900'
            )}
          >
            <ShadowDomPreview
              htmlContent={afterHtml}
              cssContent={after.cssStyle || ''}
              compact
              fidelity="anki"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const TemplateToolOutput: React.FC<TemplateToolOutputProps> = ({
  output,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [showRawJson, setShowRawJson] = useState(false);

  // 数据分析
  const isDiff = output._templateDiff === true && output.before && output.after;
  const hasTemplate = !!(output.frontTemplate || output.backTemplate);
  const warnings = output.warnings || [];

  // 判断输出类型
  const isGetResult = !!(output.id && output.version && output.fields);
  const isForkResult = output.forked === true;
  const isCreateResult = output.created === true;
  const isUpdateResult = output.updated === true;

  // 使用 renderCardPreview 做真实渲染
  const ankiTemplate = useMemo(
    () => (hasTemplate ? buildAnkiTemplate(output) : null),
    [hasTemplate, output],
  );

  const rendered = useMemo(() => {
    if (!ankiTemplate) return null;
    const sampleData = output.sampleData as Record<string, unknown> | undefined;
    return renderTemplateSides(ankiTemplate, sampleData);
  }, [ankiTemplate, output.sampleData]);

  useEffect(() => {
    const templateId =
      (output.templateId as string | undefined) ||
      (output.id as string | undefined) ||
      (output.usedTemplateId as string | undefined);
    emitTemplateDesignerLifecycle({
      level: 'info',
      phase: 'render:template',
      summary: `render template output${templateId ? ` | templateId=${templateId}` : ''}`,
      detail: {
        templateId,
        hasDiff: Boolean(output._templateDiff),
        hasWarnings: Array.isArray(output.warnings) && output.warnings.length > 0,
        warningCount: Array.isArray(output.warnings) ? output.warnings.length : 0,
      },
      templateId,
    });
  }, [output]);

  // 头部图标
  const HeaderIcon = useMemo(() => {
    if (isDiff) return Pencil;
    if (isForkResult) return GitFork;
    if (isCreateResult) return Plus;
    return Eye;
  }, [isDiff, isForkResult, isCreateResult]);

  // 头部标题
  const headerTitle = useMemo(() => {
    if (isDiff) return t('templateTool.diffTitle');
    if (isForkResult) return t('templateTool.forkTitle');
    if (isCreateResult) return t('templateTool.createTitle');
    return t('templateTool.previewTitle');
  }, [isDiff, isForkResult, isCreateResult, t]);

  return (
    <div className={cn('template-tool-output', className)}>
      {/* 头部 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <HeaderIcon className="w-3 h-3" />
          <span>{headerTitle}</span>
          {output.name && (
            <span className="text-foreground font-medium ml-1">{output.name}</span>
          )}
        </div>

        {/* 切换原始 JSON */}
        <NotionButton variant="ghost" size="sm" onClick={() => setShowRawJson(!showRawJson)}>
          <FileJson className="w-3 h-3" />
          {showRawJson
            ? t('templateTool.hideJson')
            : t('templateTool.showJson')}
        </NotionButton>
      </div>

      {/* 模板元数据摘要 */}
      {(isGetResult || isForkResult || isCreateResult || isUpdateResult) && !showRawJson && (
        <div
          className={cn(
            'mb-2 px-3 py-2 rounded-lg text-xs',
            'bg-muted/30 dark:bg-muted/15',
            'border border-border/30',
            'flex flex-wrap items-center gap-x-4 gap-y-1'
          )}
        >
          {output.name && (
            <div className="flex items-center gap-1">
              <Layers className="w-3 h-3 text-muted-foreground" />
              <span className="font-medium text-foreground">{output.name}</span>
            </div>
          )}
          {(output.templateId || output.id) && (
            <div className="text-muted-foreground">
              ID: <code className="text-[10px] bg-muted/50 px-1 rounded">{(output.templateId || output.id || '').slice(0, 8)}…</code>
            </div>
          )}
          {output.version && (
            <div className="text-muted-foreground">v{output.version}</div>
          )}
          {output.noteType && (
            <div className="text-muted-foreground">{output.noteType}</div>
          )}
          {output.fields && output.fields.length > 0 && (
            <div className="text-muted-foreground">
              {t('templateTool.fieldsCount', {
                count: output.fields.length,
              })}：<span className="text-foreground/70">{output.fields.join(', ')}</span>
            </div>
          )}
          {output.isActive !== undefined && (
            <div className="flex items-center gap-0.5">
              {output.isActive ? (
                <CheckCircle className="w-3 h-3 text-green-500" />
              ) : (
                <XCircle className="w-3 h-3 text-muted-foreground" />
              )}
              <span className={output.isActive ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                {output.isActive
                  ? t('templateTool.active')
                  : t('templateTool.inactive')}
              </span>
            </div>
          )}
          {output.isBuiltIn && (
            <div className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px]">
              {t('templateTool.builtin')}
            </div>
          )}
          {isForkResult && output.sourceTemplateId && (
            <div className="text-muted-foreground">
              {t('templateTool.forkedFrom')}：
              <code className="text-[10px] bg-muted/50 px-1 rounded">{output.sourceTemplateId.slice(0, 8)}…</code>
            </div>
          )}
        </div>
      )}

      {/* 警告 */}
      {warnings.length > 0 && (
        <div className="mb-2 px-2 py-1.5 rounded bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-800/30">
          {warnings.map((w, i) => (
            <div key={i} className="text-xs text-yellow-700 dark:text-yellow-400">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      {/* 内容区 */}
      <div
        className={cn(
          'rounded-lg',
          'bg-muted/20 dark:bg-muted/10',
          'border border-border/30',
          'p-3'
        )}
      >
        {showRawJson ? (
          <pre className="text-xs whitespace-pre-wrap break-words font-mono text-muted-foreground max-h-60 overflow-auto">
            {JSON.stringify(output, null, 2)}
          </pre>
        ) : isDiff ? (
          <DiffView
            before={output.before!}
            after={output.after!}
            sampleData={output.sampleData as Record<string, unknown> | undefined}
          />
        ) : rendered ? (
          <div className="flex gap-3">
            <CardSide
              label={t('templateTool.front')}
              htmlContent={rendered.front}
              cssContent={output.cssStyle || ''}
            />
            <CardSide
              label={t('templateTool.back')}
              htmlContent={rendered.back}
              cssContent={output.cssStyle || ''}
            />
          </div>
        ) : (
          <pre className="text-xs whitespace-pre-wrap break-words font-mono text-muted-foreground max-h-60 overflow-auto">
            {JSON.stringify(output, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
};

export default TemplateToolOutput;
