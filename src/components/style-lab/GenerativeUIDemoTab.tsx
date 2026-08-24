import React, { useState } from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import { learningActionHandlers } from '@/features/generative-ui/handlers/learningActionHandlers';
import { useGenerativeUIStream } from '@/features/generative-ui/hooks/useGenerativeUIStream';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';

/**
 * Style Lab — Generative UI 演示页签
 */
export function GenerativeUIDemoTab() {
  const stream = useGenerativeUIStream();
  const [mode, setMode] = useState<'static' | 'stream'>('static');

  const simulateStream = () => {
    stream.reset();
    setMode('stream');
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const chunkSize = Math.max(24, Math.floor(json.length / 8));
    let i = 0;
    const tick = () => {
      if (i >= json.length) {
        stream.finalize();
        return;
      }
      stream.append(json.slice(i, i + chunkSize));
      i += chunkSize;
      window.setTimeout(tick, 80);
    };
    tick();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Generative UI 演示</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            结构化意图 + 组件注册表。模型只输出 JSON，渲染受控 shad 组件。
          </p>
          <div className="flex flex-wrap gap-2">
            <DsButton size="sm" variant={mode === 'static' ? 'default' : 'outline'} onClick={() => setMode('static')}>
              静态示例
            </DsButton>
            <DsButton size="sm" variant="outline" onClick={simulateStream}>
              模拟流式
            </DsButton>
          </div>
        </CardContent>
      </Card>

      {mode === 'static' ? (
        <GenerativeUIRenderer
          intent={LEARNING_DASHBOARD_EXAMPLE}
          actionHandlers={learningActionHandlers}
          onAction={() => {}}
        />
      ) : (
        <GenerativeUIRenderer
          intent={stream.intent ?? LEARNING_DASHBOARD_EXAMPLE}
          isStreaming={stream.isStreaming}
          actionHandlers={learningActionHandlers}
          onAction={() => {}}
        />
      )}
    </div>
  );
}
