import React, { useMemo } from 'react';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from './registry';
import { parseGenerativeUIIntent, validateBlockProps } from './schema';
import { GenerativeUIChrome } from './GenerativeUIChrome';
import type { GenerativeUIIntent, GenerativeUIRendererProps } from './types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { ActionBarBlock } from './components/ActionBarBlock';

// 确保内置块已注册
import './blocks';

function normalizeIntent(input: string | GenerativeUIIntent): GenerativeUIIntent | null {
  if (typeof input === 'string') {
    const result = parseGenerativeUIIntent(input);
    return result.ok ? result.intent : null;
  }
  return input;
}

export function GenerativeUIRenderer({
  intent: intentInput,
  isStreaming = false,
  showChrome = true,
  onAction,
  actionHandlers,
  className,
}: GenerativeUIRendererProps) {
  const intent = useMemo(() => normalizeIntent(intentInput), [intentInput]);
  const parseError = useMemo(() => {
    if (typeof intentInput !== 'string') return null;
    const result = parseGenerativeUIIntent(intentInput);
    return result.ok ? null : result.errors;
  }, [intentInput]);

  if (!intent) {
    return (
      <Alert variant="destructive" className={className}>
        <AlertTitle>无法解析 AI 界面意图</AlertTitle>
        <AlertDescription>
          {parseError?.join('; ') ?? '格式无效'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      className={cn('generative-ui-root space-y-3 min-w-0', className)}
      data-generative-ui
      data-streaming={isStreaming || undefined}
    >
      {showChrome ? (
        <GenerativeUIChrome isStreaming={isStreaming} onAction={onAction} />
      ) : null}

      {intent.meta?.title ? (
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">{intent.meta.title}</h3>
          {intent.meta.description ? (
            <p className="text-sm text-muted-foreground">{intent.meta.description}</p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3">
        {intent.blocks.map((block, index) => {
          const config = generativeUIRegistry.get(block.type);
          if (!config) {
            return (
              <Alert key={block.id ?? index} variant="warning">
                <AlertTitle>未知组件：{block.type}</AlertTitle>
                <AlertDescription>已跳过，请检查组件注册表</AlertDescription>
              </Alert>
            );
          }

          const validation = validateBlockProps(config.propsSchema, block.props ?? {});
          if (!validation.ok) {
            return (
              <Alert key={block.id ?? index} variant="destructive">
                <AlertTitle>{block.type} 参数校验失败</AlertTitle>
                <AlertDescription>{validation.errors.join('; ')}</AlertDescription>
              </Alert>
            );
          }

          const Component = config.component;
          if (block.type === 'action-bar') {
            return (
              <ActionBarBlock
                key={block.id ?? index}
                {...validation.props}
                actionHandlers={actionHandlers}
                onAction={onAction}
              />
            );
          }

          return <Component key={block.id ?? index} {...validation.props} />;
        })}
      </div>
    </div>
  );
}
