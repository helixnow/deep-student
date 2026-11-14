import type { CSSProperties, ReactNode } from 'react';
import { brand, font } from '../theme';
import { ease, prog } from '../lib/time';

/**
 * 字幕层。排版直接落在画面上：不用毛玻璃胶囊；整行柔焦升起（不逐字揭示，中途不会出现残缺字形）。
 * 可读性优先靠构图留白；必须压在界面上时，用一片贴着字、边缘完全化开的柔光底（scrim），而不是一个框。
 *
 * 文案口径见主仓库 docs/brand/messaging.md：书面语，主语写「它」（动作是学习 Agent 做的）；
 * 不显示章节编号，主句读速 ≤ 4.5 字/秒。一段一个主意，英雄画面不压字，幕标题前后留白。
 */
type Kind = 'title' | 'feature';
type Tone = 'light' | 'dark';
/** none 不铺；soft 贴字的角落柔光；band 全宽底部渐变（壁纸 / 视频上读作镜头暗角）；top 居中标题的顶部渐变 */
type ScrimKind = 'none' | 'soft' | 'band' | 'top';

export type Super = {
  s: number;
  e: number;
  /** `\n` 换行；`|` 把一行分成几拍（各拍起点见 at），整行先按完整文字排好位置 */
  text: string;
  /** 各拍的起点（脚本秒），缺省时整行在 s 出现 */
  at?: number[];
  /** 副文案：主句之下一行小字，交代具体事实；晚主句约 0.3 秒（成片）出现，同时退出 */
  sub?: string;
  /** 副文案的起点（脚本秒），缺省为 s + 0.15 */
  subAt?: number;
  kind: Kind;
  tone?: Tone;
  pos?: CSSProperties;
  align?: 'left' | 'center';
  /** 缺省：功能字幕 soft，居中标题 top，左对齐标题 none */
  scrim?: ScrimKind;
};

const CENTER = { left: 0, right: 0, top: 380 } as const;
const LEFT = 120;

export const SUPERS: Super[] = [
  // 立题：前一句说难处，后一句把其余的事交出去；片尾口号「只专注学习本身就够了，剩下的都交给我」回收（Agent 最后才以「我」开口）
  { s: 0.15, e: 1.25, text: '学习本身，\n已经够难了。', kind: 'title', pos: { left: LEFT, top: 380 } },
  // 镜头 2.25 才推进书页，题眼完整停住约 0.9 秒（成片）
  { s: 1.33, e: 2.4, text: '其余的事，\n交给它。', kind: 'title', pos: { left: LEFT, top: 380 } },
  // 第一幕：读懂 → 记住
  { s: 2.8, e: 4.6, text: '选中原文，直接问它。', kind: 'feature' },
  // 命中纸片（教材 / 笔记 / 学习记忆）自己在说检索范围；8.6 收掉，命中卡落位不压字
  { s: 6.55, e: 8.6, text: '它先翻遍你的资料，再作答。', kind: 'feature' },
  { s: 9.3, e: 10.9, text: '点开引用，直达原文那一句。', kind: 'feature' },
  { s: 11.6, e: 13.3, text: '它直接画出思维导图。', kind: 'feature' },
  // 15.9 收掉：之后窗口缩进 Dock、夜色桌面露出来，浅色柔光底会压成一块白斑
  { s: 14.0, e: 15.9, text: '导图一键挖空，卡片一并做好。', kind: 'feature' },
  // 19.0 前退场，把 19.18 那张 ξ 卡被评「重来」让给画面
  { s: 17.1, e: 19.0, text: '它用 FSRS 排好每一次复习。', kind: 'feature', tone: 'dark' },
  { s: 19.95, e: 21.9, text: '记不牢的，它让你更早再见。', kind: 'feature', tone: 'dark' },
  // 21.9–24.0 无字：夜 → 晨
  // 第二幕：第二天，白天的学习桌面——练习与输出（24.0 落在配乐的小节线上）
  { s: 24.0, e: 25.9, text: '今天的安排，它已经列好。', kind: 'title', pos: CENTER, align: 'center', scrim: 'none' },
  // 题库显示「全部 18」
  { s: 30.6, e: 32.5, text: '它把整份试卷拆成 18 道题。', kind: 'feature' },
  // 判错时画面顶部的通知已经写着「第 7 题已加入今日复习」，字幕不再复述，留给 AI 解析
  { s: 35.1, e: 37.0, text: '它逐步讲清错因。', kind: 'feature' },
  // 跨过分数卡、雷达与润色提升
  { s: 39.3, e: 41.9, text: '作文按考试标准评分，逐句润色。', kind: 'feature' },
  { s: 43.3, e: 45.3, text: '整篇翻译，逐段对照。', kind: 'feature' },
  // 音视频：B 站链接导入 → 问答（时间引用可跳转）→ 讲义 → 练习。粘贴链接、导入分 P 画面里看得到，不再写副文案
  { s: 46.3, e: 48.0, text: '网课和讲座，它陪你一起学。', kind: 'feature', scrim: 'band' },
  // 落在播放器下缘的黑边上：暗色调
  { s: 48.9, e: 50.4, text: '它的回答能跳回原片那一刻。', kind: 'feature', tone: 'dark' },
  { s: 50.7, e: 52.3, text: '一节课，整理成讲义和卡片。', kind: 'feature' },
  { s: 54.4, e: 56.6, text: '调研，它自主完成。', sub: '检索、读文献、写笔记，每一步可见。', kind: 'feature' },
  // 笔记窗 58.1 自己弹开：AI 直接改、改动处渐隐高亮，顶部留「撤销本次修改」
  { s: 57.95, e: 59.5, text: '它直接改你的笔记，每处可撤销。', kind: 'feature' },
  // 59.5–62.6 无字：论文入库、资源库与知识库索引为终章「一整座知识库」铺垫
  // 第三幕：63.6 前退场，窗口 63.7 才升起
  { s: 62.6, e: 63.6, text: '它越来越懂你。', kind: 'title', pos: CENTER, align: 'center', scrim: 'none' },
  // 回扣 9.77 回答里的「你上次在 ξ 的取值上丢过分」
  { s: 63.8, e: 65.85, text: '它记得你在哪里丢过分。', kind: 'feature' },
  // 与同一时刻画面里技能窗的「全部 58 · 内置 58」对得上；副文案等镜头到了 MCP 窗（67.5）才出
  { s: 66.2, e: 68.25, text: '58 个技能，按需加载。', sub: '支持 MCP，接入外部工具。', subAt: 67.45, kind: 'feature' },
  // 69.75 前退场，不压纸页浮现
  { s: 68.6, e: 69.75, text: '多个模型，同时作答。', kind: 'feature' },
  // 收尾：分两拍，纸页浮现时说前半句、群山入画时说后半句；主运动 75.4 结束后退场，75.5–77.5 只留地形
  { s: 70.35, e: 75.5, text: '从一页纸，|到一整座知识库。', at: [70.35, 73.1], kind: 'title', pos: { left: 0, right: 0, top: 112 }, align: 'center' },
];

const MID_PUNCT = /([，、；：])/;
const END_PUNCT = /[。，、；：！？]$/;

/** 句中标点压到约半个字宽（全角标点右半是空的），不让逗号处出现空洞。 */
export const squeeze = (text: string): ReactNode[] =>
  text.split(MID_PUNCT).map((part, i) =>
    MID_PUNCT.test(part) ? (
      <span key={i} style={{ marginRight: '-0.4em' }}>
        {part}
      </span>
    ) : (
      part
    ),
  );

/** 整行柔焦升起；收尾只淡出、略虚，不位移。hangEnd：居中时句末标点悬挂在外，不参与居中。 */
const LineIn = ({
  text,
  t,
  s,
  e,
  at,
  rise = 18,
  blur = 6,
  dur = 0.32,
  lineGap = 0.12,
  hangEnd = false,
}: {
  text: string;
  t: number;
  s: number;
  e: number;
  at?: number[];
  rise?: number;
  blur?: number;
  dur?: number;
  lineGap?: number;
  hangEnd?: boolean;
}) => {
  const out = prog(t, e - 0.2, e, ease.inCubic);
  let beat = 0;
  return (
    <>
      {text.split('\n').map((line, li) => {
        const parts = line.split('|');
        return (
          <span key={li} style={{ display: 'block' }}>
            {parts.map((part, pi) => {
              const start = at?.[beat++] ?? s + li * lineGap;
              const k = prog(t, start, start + dur, ease.brand);
              const tail = hangEnd && pi === parts.length - 1 && END_PUNCT.test(part) ? part.slice(-1) : '';
              const px = (1 - k) * blur + out * 3;
              return (
                <span
                  key={pi}
                  style={{
                    display: 'inline-block',
                    whiteSpace: 'pre',
                    opacity: k * (1 - out),
                    transform: `translateY(${(1 - k) * rise}px)`,
                    filter: px > 0.05 ? `blur(${px}px)` : undefined,
                  }}
                >
                  {squeeze(tail ? part.slice(0, -1) : part)}
                  {tail ? <span style={{ position: 'absolute' }}>{tail}</span> : null}
                </span>
              );
            })}
          </span>
        );
      })}
    </>
  );
};

/** 全宽渐变：居中标题的顶部（top），或壁纸 / 视频上的底部（band）。 */
const Band = ({ kind, color, edge, opacity }: { kind: 'top' | 'band'; color: string; edge: string; opacity: number }) => {
  if (opacity <= 0.001) return null;
  const style: CSSProperties =
    kind === 'top'
      ? { top: 0, height: 400, background: `linear-gradient(180deg, ${color} 0%, ${edge} 52%, transparent 100%)` }
      : { bottom: 0, height: 300, background: `linear-gradient(0deg, ${color} 0%, ${edge} 45%, transparent 100%)` };
  return <div style={{ position: 'absolute', left: 0, right: 0, opacity, ...style }} />;
};

const SuperView = ({ sp, t }: { sp: Super; t: number }) => {
  const dark = sp.tone === 'dark';
  const ink = dark ? 'hsl(0 0% 97%)' : brand.ink;
  const ground = dark ? '220 12% 7%' : '0 0% 97%';
  if (sp.kind === 'title') {
    const centered = sp.align === 'center';
    const scrim = sp.scrim ?? (centered ? 'top' : 'none');
    const k = prog(t, sp.s - 0.1, sp.s + 0.4, ease.brand) * (1 - prog(t, sp.e - 0.26, sp.e, ease.inCubic));
    return (
      <>
        {scrim === 'top' ? <Band kind="top" color={`hsl(${ground} / ${dark ? 0.86 : 0.94})`} edge={`hsl(${ground} / ${dark ? 0.5 : 0.62})`} opacity={k} /> : null}
        <div
          style={{
            position: 'absolute',
            ...sp.pos,
            textAlign: sp.align ?? 'left',
            fontFamily: font.serif,
            fontSize: 72,
            lineHeight: 1.2,
            fontWeight: 400,
            letterSpacing: '0.01em',
            color: ink,
          }}
        >
          <LineIn text={sp.text} t={t} s={sp.s} e={sp.e} at={sp.at} rise={24} blur={10} hangEnd={centered} />
        </div>
      </>
    );
  }
  // 主句 40/600 + 副文案 24/400：两层层级，而不是一块 PPT 式的大标题板
  const k = prog(t, sp.s - 0.05, sp.s + 0.3, ease.brand);
  const out = prog(t, sp.e - 0.2, sp.e, ease.inCubic);
  const subAt = sp.subAt ?? sp.s + 0.15;
  const subK = prog(t, subAt, subAt + 0.3, ease.brand);
  const scrim = sp.scrim ?? 'soft';
  return (
    <>
      {scrim === 'band' ? <Band kind="band" color={`hsl(${ground} / ${dark ? 0.7 : 0.78})`} edge={`hsl(${ground} / ${dark ? 0.4 : 0.45})`} opacity={k * (1 - out)} /> : null}
      <div style={{ position: 'absolute', left: LEFT, bottom: 92, fontFamily: font.super, color: ink, ...sp.pos }}>
        {/* 柔光底跟着文字的外框走，四周化开：只垫住字，不在画面角上铺一片雾 */}
        {scrim === 'soft' ? <div style={{ position: 'absolute', inset: '-30px -56px', borderRadius: 48, background: `hsl(${ground} / 0.9)`, filter: 'blur(26px)', opacity: k * (1 - out) }} /> : null}
        <div style={{ position: 'relative', fontSize: 40, fontWeight: 600, letterSpacing: '0.015em' }}>
          <LineIn text={sp.text} t={t} s={sp.s} e={sp.e} />
        </div>
        {sp.sub ? (
          <div
            style={{
              position: 'relative',
              marginTop: 14,
              fontSize: 24,
              fontWeight: 400,
              letterSpacing: '0.02em',
              color: dark ? 'hsl(0 0% 76%)' : brand.ink2,
              opacity: subK * (1 - out),
              transform: `translateY(${(1 - subK) * 10}px)`,
              filter: subK < 0.99 ? `blur(${(1 - subK) * 4}px)` : undefined,
            }}
          >
            {squeeze(sp.sub)}
          </div>
        ) : null}
      </div>
    </>
  );
};
export const Supers = ({ t, items = SUPERS }: { t: number; items?: Super[] }) => (
  <>
    {items.filter((sp) => t >= sp.s - 0.12 && t <= sp.e + 0.05).map((sp) => (
      <SuperView key={sp.text} sp={sp} t={t} />
    ))}
  </>
);
