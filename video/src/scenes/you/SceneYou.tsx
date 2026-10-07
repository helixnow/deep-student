import { AbsoluteFill } from 'remotion';
import { camAt, CameraView, type CamKey } from '../../lib/camera';
import { clamp, ease, FPS, PACE, prog } from '../../lib/time';
import { brand, light } from '../../theme';
import { CHAT_H, CHAT_W, ChatTitlebar } from '../../ui/research';
import { MCP_TITLE, McpChat, mcpTL, MEM_TITLE, MemoryChat, memoryTL, MODELS_TITLE, ModelsChat, modelsDoneAt, SKILL_H, SKILL_W, SkillsToolbar, SkillsWindow } from '../../ui/you';
import { WbWindow } from '../../ui/workbench';

/**
 * 第三幕「越用，越懂你」（成片 2:04–2:20）：纸面上一条横向铺开的面板带，
 * 镜头在四块面板之间快速平移——记忆 → 技能 → MCP → 多模型。全片节奏最快的一段。
 */
export const YOU = {
  start: 62.0,
  in0: 63.7, // 第一块面板浮现
  memory: 63.85,
  answer: 64.9,
  skills: 66.1,
  mcp: 67.35,
  models: 68.5,
  out0: 69.45,
  out1: 69.9,
} as const;

type Rect = { x: number; y: number; w: number; h: number };
const centered = (cx: number, w: number, h: number, dy = 20): Rect => ({ x: cx - w / 2, y: 540 - h / 2 + dy, w, h });
const MEM_CX = 960;
const SKILL_CX = MEM_CX + 1500;
const MCP_CX = SKILL_CX + 1350;
const MODELS_CX = MCP_CX + 1450;
const MEM_RECT = centered(MEM_CX, CHAT_W, CHAT_H);
const SKILL_RECT = centered(SKILL_CX, SKILL_W, SKILL_H);
const MCP_RECT = centered(MCP_CX, CHAT_W, CHAT_H);
const MODELS_RECT = centered(MODELS_CX, CHAT_W, CHAT_H);

// 每块面板都推到让内容看得清：对话窗基本框满（章节标签淡出后才推，免得压住红绿灯）；
// 技能窗下缘停在屏幕 y≈905，不让左下角字幕压住最下一排卡片；MCP 内容只有上半截，裁掉下面的空白
const CAM: CamKey[] = [
  [YOU.in0 - 0.1, { x: MEM_CX, y: 580, zoom: 1.06 }],
  [YOU.memory + 0.55, { x: MEM_CX, y: 578, zoom: 1.14 }, ease.outCubic],
  [YOU.answer + 0.1, { x: MEM_CX, y: 562, zoom: 1.38 }, ease.inOutCubic],
  [YOU.skills - 0.2, { x: MEM_CX + 20, y: 560, zoom: 1.43 }, ease.linear],
  [YOU.skills + 0.08, { x: SKILL_CX, y: 619, zoom: 1.28 }, ease.inOutCubic],
  [YOU.mcp - 0.2, { x: SKILL_CX + 20, y: 619, zoom: 1.3 }, ease.linear],
  [YOU.mcp + 0.06, { x: MCP_CX, y: 470, zoom: 1.6 }, ease.inOutCubic],
  [YOU.models - 0.2, { x: MCP_CX + 20, y: 468, zoom: 1.66 }, ease.linear],
  [YOU.models + 0.08, { x: MODELS_CX, y: 560, zoom: 1.42 }, ease.inOutCubic],
  [YOU.out1, { x: MODELS_CX + 20, y: 560, zoom: 1.47 }, ease.linear],
];

const rise = (t: number, at: number) => {
  const k = prog(t, at - 0.12, at + 0.22, ease.outExpo);
  return { opacity: clamp(k * 1.5), transform: `translateY(${(1 - k) * 36}px) scale(${0.97 + 0.03 * k})` };
};

/** 横移时按镜头每帧位移给一点水平运动模糊（只在快速横移的几帧里生效）。 */
const FRAME = 1 / (FPS * PACE);
const motionBlur = (t: number) => {
  const a = camAt(t - FRAME, CAM);
  const b = camAt(t, CAM);
  const v = Math.abs(b.x - a.x) * b.zoom;
  return Math.min(16, Math.max(0, (v - 6) * 0.28));
};

export const SceneYou = ({ t }: { t: number }) => {
  if (t < YOU.in0 - 0.15 || t > YOU.out1 + 0.05) return null;
  const tk = light;
  const cam = camAt(t, CAM);
  const fade = 1 - prog(t, YOU.out0, YOU.out1, ease.inOutCubic);
  const blur = motionBlur(t);
  return (
    <AbsoluteFill style={{ opacity: fade, filter: blur > 0.3 ? 'url(#you-mblur)' : undefined }}>
      {blur > 0.3 ? (
        <svg width={0} height={0} style={{ position: 'absolute' }}>
          <defs>
            <filter id="you-mblur" x="-4%" y="0%" width="108%" height="100%" colorInterpolationFilters="sRGB">
              <feGaussianBlur stdDeviation={`${blur.toFixed(2)} 0`} />
            </filter>
          </defs>
        </svg>
      ) : null}
      <CameraView cam={cam}>
        <div
          style={{
            position: 'absolute',
            left: -1200,
            top: -600,
            width: 9000,
            height: 2400,
            backgroundImage: `linear-gradient(${brand.gridLine} 1px, transparent 1px), linear-gradient(90deg, ${brand.gridLine} 1px, transparent 1px)`,
            backgroundSize: '28px 28px',
          }}
        />
        <WbWindow
          tk={tk}
          rect={MEM_RECT}
          toolbar={<ChatTitlebar title="新对话" next={MEM_TITLE} k={prog(t, memoryTL(YOU.memory).title, memoryTL(YOU.memory).title + 0.06)} />}
          style={rise(t, YOU.memory - 0.05)}
        >
          <MemoryChat t={t} at={YOU.memory} />
        </WbWindow>
        <WbWindow tk={tk} rect={SKILL_RECT} toolbar={<SkillsToolbar />} style={rise(t, YOU.skills - 0.1)}>
          <SkillsWindow />
        </WbWindow>
        <WbWindow
          tk={tk}
          rect={MCP_RECT}
          toolbar={<ChatTitlebar title="新对话" next={MCP_TITLE} k={prog(t, mcpTL(YOU.mcp).title, mcpTL(YOU.mcp).title + 0.06)} />}
          style={rise(t, YOU.mcp - 0.1)}
        >
          <McpChat t={t} at={YOU.mcp} />
        </WbWindow>
        <WbWindow
          tk={tk}
          rect={MODELS_RECT}
          toolbar={<ChatTitlebar title="新对话" next={MODELS_TITLE} k={prog(t, modelsDoneAt(YOU.models) + 0.12, modelsDoneAt(YOU.models) + 0.18)} />}
          style={rise(t, YOU.models - 0.1)}
        >
          <ModelsChat t={t} at={YOU.models} />
        </WbWindow>
      </CameraView>
    </AbsoluteFill>
  );
};
