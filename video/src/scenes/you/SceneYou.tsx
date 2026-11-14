import { AbsoluteFill } from 'remotion';
import { CameraView, smoothCam, type CamKey } from '../../lib/camera';
import { clamp, ease, motion, prog } from '../../lib/time';
import { brand, light } from '../../theme';
import { CHAT_H, CHAT_W, ChatTitlebar } from '../../ui/research';
import { MCP_TITLE, McpChat, mcpTL, MEM_TITLE, MemoryChat, memoryTL, MODELS_TITLE, ModelsChat, modelsDoneAt, SKILL_H, SKILL_W, SkillsToolbar, SkillsWindow } from '../../ui/you';
import { WbWindow } from '../../ui/workbench';

/**
 * 第三幕「它越来越懂你」（成片 2:04–2:20）：纸面上一条横向铺开的面板带，
 * 镜头在四块面板之间平移——记忆 → 技能 → MCP → 多模型。
 * skills / mcp / models 三个时刻踩在配乐的换和弦上（scripts/audio/arrangement.mjs 的第三幕和弦表），不要单独改。
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

/** MCP 那轮对话提前到横移途中起步：回答 68.18 写完、68.30 起名，镜头 68.32 才走（原来写完 1 帧后镜头就走了）。 */
export const MCP_AT = YOU.mcp - 0.1;
/** 多模型三张卡的起流时刻：等镜头落定，「同时作答」的起点要被看清。 */
const MODELS_AT = YOU.models + 0.16;

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
// 技能窗下缘停在屏幕 y≈905，不让左下角字幕压住最下一排卡片；MCP 内容只有上半截，裁掉下面的空白。
// 面板之间是 0.36 脚本秒的干净横移（中点落在换和弦上），不加运动模糊。
const CAM: CamKey[] = [
  [YOU.in0 - 0.1, { x: MEM_CX, y: 580, zoom: 1.06 }],
  [YOU.memory + 0.55, { x: MEM_CX, y: 578, zoom: 1.14 }, motion.camMove],
  [YOU.answer + 0.1, { x: MEM_CX, y: 562, zoom: 1.38 }, motion.camMove],
  // 回答写到「这正是你之前容易写错的地方 [忆2]」（65.41 写完）时推到那一行：这一幕的英雄时刻
  [YOU.answer + 0.2, { x: MEM_CX + 4, y: 562, zoom: 1.39 }, ease.linear],
  [YOU.answer + 0.65, { x: 1100, y: 548, zoom: 2.0 }, motion.camMove],
  [YOU.skills - 0.22, { x: 1104, y: 548, zoom: 2.03 }, ease.linear],
  [YOU.skills + 0.14, { x: SKILL_CX, y: 619, zoom: 1.28 }, motion.camMove],
  [YOU.mcp - 0.2, { x: SKILL_CX + 20, y: 619, zoom: 1.31 }, ease.linear],
  [YOU.mcp + 0.16, { x: MCP_CX, y: 470, zoom: 1.6 }, motion.camMove],
  [YOU.models - 0.18, { x: MCP_CX + 20, y: 468, zoom: 1.66 }, ease.linear],
  [YOU.models + 0.18, { x: MODELS_CX, y: 560, zoom: 1.42 }, motion.camMove],
  [YOU.out1, { x: MODELS_CX + 20, y: 560, zoom: 1.47 }, ease.linear],
];

const rise = (t: number, at: number) => {
  const k = prog(t, at - 0.12, at + 0.22, ease.outExpo);
  return { opacity: clamp(k * 1.5), transform: `translateY(${(1 - k) * 36}px) scale(${0.97 + 0.03 * k})` };
};

export const SceneYou = ({ t }: { t: number }) => {
  if (t < YOU.in0 - 0.15 || t > YOU.out1 + 0.05) return null;
  const tk = light;
  const cam = smoothCam(t, CAM);
  const fade = 1 - prog(t, YOU.out0, YOU.out1, ease.inOutCubic);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <CameraView cam={cam}>
        {/* 垫上纸色盖住 PV 的全局网格（否则两层网格错位叠在一起）；起点对齐到 28 的整数倍 */}
        <div
          style={{
            position: 'absolute',
            left: -1204,
            top: -616,
            width: 9016,
            height: 2408,
            backgroundColor: brand.paper,
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
        <WbWindow tk={tk} rect={MCP_RECT} toolbar={<ChatTitlebar title="新对话" next={MCP_TITLE} k={prog(t, mcpTL(MCP_AT).title, mcpTL(MCP_AT).title + 0.06)} />} style={rise(t, YOU.mcp - 0.1)}>
          <McpChat t={t} at={MCP_AT} />
        </WbWindow>
        <WbWindow
          tk={tk}
          rect={MODELS_RECT}
          toolbar={<ChatTitlebar title="新对话" next={MODELS_TITLE} k={prog(t, modelsDoneAt(MODELS_AT) + 0.12, modelsDoneAt(MODELS_AT) + 0.18)} />}
          style={rise(t, YOU.models - 0.1)}
        >
          <ModelsChat t={t} at={MODELS_AT} />
        </WbWindow>
      </CameraView>
    </AbsoluteFill>
  );
};
