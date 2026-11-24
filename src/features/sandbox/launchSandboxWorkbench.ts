import {
  usePinnedArtifactStore,
  type PinnedArtifactKind,
  type PinnedArtifactRecord,
} from '@/stores/pinnedArtifactStore';
import {
  resolveTargetSandboxOwnerKey,
  useSandboxWorkbenchStore,
} from './store/useSandboxWorkbenchStore';
import type { SandboxOwnerKey, SandboxSessionInput } from './types';

export interface PinArtifactToCanvasInput {
  kind?: PinnedArtifactKind;
  artifactKind?: PinnedArtifactKind;
  language: string;
  title: string;
  content: string;
  sourceMessageId?: string;
  widgetId?: string;
  sessionId?: string;
  groupId?: string;
  patchSummary?: string;
}

export function normalizeWorkspaceArtifactPath(rawPath: string): string {
  const normalizedSlashes = rawPath.trim().replace(/\\/g, '/');
  if (!normalizedSlashes) return '';
  const parts: string[] = [];
  for (const segment of normalizedSlashes.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function createStarterHtmlCanvasInput(locale?: string): SandboxSessionInput {
  const isEn = (locale ?? '').toLowerCase().startsWith('en');
  return {
    sourceType: 'manual-snippet',
    sourceMessageId: `sandbox-starter-${Date.now()}`,
    language: 'html',
    artifactKind: 'html',
    initialMode: 'sandbox-run',
    title: isEn ? 'Interactive Wave Canvas' : '交互波浪实验画布',
    content: `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8" />
  <title>${isEn ? 'Interactive Wave Canvas' : '交互波浪实验画布'}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 16px; margin: 0; color: var(--foreground, #111827); }
    .panel { display: grid; gap: 12px; max-width: 640px; margin: 0 auto; }
    .controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; font-size: 13px; }
    canvas { width: 100%; height: 220px; border-radius: 12px; border: 1px solid rgba(148,163,184,0.35); background: rgba(148,163,184,0.06); }
  </style>
</head>
<body>
  <div class="panel">
    <div class="controls">
      <label>${isEn ? 'Frequency 1' : '频率 1'}: <input id="f1" type="range" min="1" max="8" value="2" /></label>
      <label>${isEn ? 'Frequency 2' : '频率 2'}: <input id="f2" type="range" min="1" max="8" value="5" /></label>
      <span id="readout">f1=2, f2=5</span>
    </div>
    <canvas id="wave" width="600" height="220"></canvas>
  </div>
  <script>
    (function () {
      var canvas = document.getElementById('wave');
      var ctx = canvas.getContext('2d');
      var f1 = document.getElementById('f1');
      var f2 = document.getElementById('f2');
      var readout = document.getElementById('readout');
      var phase = 0;
      function draw() {
        var k1 = Number(f1.value);
        var k2 = Number(f2.value);
        readout.textContent = 'f1=' + k1 + ', f2=' + k2;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        for (var x = 0; x <= canvas.width; x += 2) {
          var t = (x / canvas.width) * Math.PI * 2;
          var y = canvas.height / 2 + (Math.sin(k1 * t + phase) + Math.sin(k2 * t - phase * 0.7)) * 42;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        phase += 0.04;
        requestAnimationFrame(draw);
      }
      draw();
    })();
  </script>
</body>
</html>`,
  };
}

export function launchSandboxWorkbench(
  input: SandboxSessionInput,
  ownerKey?: SandboxOwnerKey,
): void {
  const state = useSandboxWorkbenchStore.getState();
  // Pointer/focus capture updates activeOwnerKey before CodeBlock's click handler.
  // Prefer it over document.activeElement, which can remain in another window on WebKit.
  const resolvedOwnerKey = resolveTargetSandboxOwnerKey(state, ownerKey, input.sessionId);
  const isHtmlInput =
    input.artifactKind === 'html' ||
    input.language.toLowerCase().startsWith('html') ||
    /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(input.content);
  const normalizedSourcePath = input.sourcePath
    ? normalizeWorkspaceArtifactPath(input.sourcePath)
    : input.sourcePath;
  const normalizedInput: SandboxSessionInput = {
    ...input,
    ...(normalizedSourcePath !== undefined ? { sourcePath: normalizedSourcePath } : {}),
    ...(!input.initialMode && isHtmlInput
      ? {
          artifactKind: input.artifactKind ?? 'html',
          initialMode: 'sandbox-run',
        }
      : {}),
  };
  state.openSession(normalizedInput, resolvedOwnerKey);
}

export function pinArtifactToCanvas(
  input: PinArtifactToCanvasInput,
  ownerKey?: SandboxOwnerKey,
): PinnedArtifactRecord {
  const state = useSandboxWorkbenchStore.getState();
  const resolvedOwnerKey = resolveTargetSandboxOwnerKey(state, ownerKey, input.sessionId);
  const resolvedKind: PinnedArtifactKind = input.artifactKind ?? input.kind ?? 'html';
  const record = usePinnedArtifactStore.getState().upsertPinnedArtifact({
    ownerKey: resolvedOwnerKey,
    sessionId: input.sessionId,
    groupId: input.groupId,
    widgetId: input.widgetId,
    kind: resolvedKind,
    language: input.language,
    title: input.title,
    sourceMessageId: input.sourceMessageId || 'chat-code-block',
    content: input.content,
    patchSummary: input.patchSummary,
  });
  const activeRevision =
    record.revisions.find((rev) => rev.version === record.activeVersion) ??
    record.revisions[record.revisions.length - 1];

  state.openSession(
    {
      sourceType: resolvedKind === 'generative-ui' ? 'chat-generative-ui' : 'chat-code-block',
      sourceMessageId: record.sourceMessageId,
      language: record.language,
      title: record.title,
      content: activeRevision?.content ?? input.content,
      artifactKind: record.kind,
      widgetId: record.widgetId,
      sessionId: record.sessionId,
      groupId: record.groupId,
      artifactId: record.artifactId,
      initialMode: record.kind === 'html' ? 'sandbox-run' : 'safe-preview',
    },
    resolvedOwnerKey,
  );

  return record;
}

export default launchSandboxWorkbench;
