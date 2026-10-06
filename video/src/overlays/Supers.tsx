import type { CSSProperties } from 'react';
import { brand, font } from '../theme';
import { clamp, ease, prog } from '../lib/time';

/**
 * 字幕层。排版直接落在画面上：不用毛玻璃胶囊、不用模糊渐显；
 * 可读性靠一片与底色同色、边缘完全化开的柔光底（scrim），而不是一个框。
 *
 * 文案口径见主仓库 docs/brand/messaging.md：主标题 + 副文案两层、书面语，
 * 主语写「它」（动作是学习 Agent 做的）；不显示章节编号，主句读速 ≤ 4.5 字/秒。
 */
type Kind = 'title' | 'feature';
type Tone = 'light' | 'dark';

export type Super = {
  s: number;
  e: number;
  text: string;
  /** 副文案：主句之下一行小字，交代具体事实；晚主句约 0.3 秒（成片）出现，同时退出 */
  sub?: string;
  kind: Kind;
  tone?: Tone;
  pos?: CSSProperties;
  align?: 'left' | 'center';
  /** 居中标题默认带顶部柔光底；落在壁纸 / 空白处的幕标题不需要 */
  scrim?: boolean;
};

const CENTER = { left: 0, right: 0, top: 380 } as const;

export const SUPERS: Super[] = [
  // 开场立题，片尾口号「只专注学习本身就够了」回收
  { s: 0.45, e: 2.15, text: '学习本身，\n已经够难了。', kind: 'title', pos: { left: 150, top: 380 } },
  { s: 3.3, e: 5.6, text: '选中原文，即可提问。', sub: '选中的段落自动作为上下文。', kind: 'feature' },
  // 命中纸片含学习记忆（retrieval/beats.ts 的 HITS）
  { s: 6.0, e: 8.7, text: '它先翻遍你的资料，再作答。', sub: '检索范围覆盖教材、笔记、错题与学习记忆。', kind: 'feature' },
  { s: 8.9, e: 10.9, text: '每一处引用，都可回溯原文。', kind: 'feature' },
  { s: 11.4, e: 13.95, text: '思维导图，由它直接画好。', sub: '生成后可随时切换导图结构。', kind: 'feature' },
  { s: 14.0, e: 15.35, text: '导图一键挖空，转为背诵材料。', kind: 'feature' },
  // 与 practice/beats.ts 的 ANKI_CARDS 张数一致
  { s: 15.5, e: 16.9, text: '讲解之余，它已做好 12 张卡片。', kind: 'feature' },
  { s: 17.0, e: 19.2, text: '卡片自动入队，FSRS 安排每一次复习。', kind: 'feature', tone: 'dark' },
  { s: 19.6, e: 22.3, text: '薄弱之处，优先复习。', sub: '掌握越不牢固的内容，再次出现得越早。', kind: 'feature', tone: 'dark' },
  // 第二幕：第二天，白天的学习桌面
  { s: 24.0, e: 25.9, text: '今天的安排，它已经列好。', kind: 'title', pos: CENTER, align: 'center', scrim: false },
  { s: 26.0, e: 28.9, text: '复习与待办，汇总在同一张清单。', sub: '可从清单直接开启番茄钟。', kind: 'feature' },
  { s: 30.4, e: 33.1, text: '整份试卷，自动拆分为题目。', sub: '拖入 PDF，自动识别题干与选项。', kind: 'feature' },
  // 答错时后端自动建复习计划、下次复习日 = 今天（题目进复习，不是「知识点」）
  { s: 34.35, e: 36.0, text: '错题自动加入今日复习。', kind: 'feature' },
  { s: 36.05, e: 37.85, text: '它逐步讲清错因。', kind: 'feature' },
  { s: 38.4, e: 41.1, text: '作文按考试标准逐项评分。', sub: '分项成绩、雷达图与逐条评语一并给出。', kind: 'feature' },
  { s: 41.25, e: 42.95, text: '逐句润色，改动之处清晰标注。', kind: 'feature' },
  { s: 43.1, e: 45.5, text: '整篇翻译，原文译文逐段对照。', kind: 'feature' },
  // 0.10.2 音视频：B 站链接导入（不下载视频、应用内播放，见 BilibiliLinkDialog 文案）→ 点字幕跳转
  { s: 46.15, e: 48.3, text: '网课和讲座，它陪你一起学。', sub: '粘贴 B 站链接即导入字幕，不下载视频，直接在应用内播放。', kind: 'feature' },
  { s: 49.0, e: 50.75, text: '点一句字幕，回到那一刻。', sub: '字幕随播放逐句高亮，它回答里的时间引用同样可以点开跳转。', kind: 'feature' },
  { s: 51.3, e: 54.3, text: '调研，交给它。', sub: '检索资料、阅读文献、撰写笔记，全程自主推进。', kind: 'feature' },
  // 笔记窗 clean 时 AI 直接改、改动处渐隐高亮，顶部留「撤销本次修改」
  { s: 54.5, e: 56.25, text: '它直接修改笔记，每处改动均可撤销。', kind: 'feature' },
  { s: 56.4, e: 58.85, text: '论文由它下载入库。', sub: '导入即建立索引，可在后续提问中引用。', kind: 'feature' },
  // 第三幕：越用越懂你
  { s: 59.1, e: 60.9, text: '越用，越懂你。', kind: 'title', pos: CENTER, align: 'center', scrim: false },
  { s: 61.1, e: 62.95, text: '它记得你的薄弱点与学习习惯。', kind: 'feature' },
  // 与同一时刻画面里技能窗的「全部 56 · 内置 56」对得上
  { s: 63.0, e: 65.3, text: '56 个技能，按需加载。', sub: '支持 MCP，可接入外部工具与服务。', kind: 'feature' },
  { s: 65.4, e: 67.0, text: '同一问题，多个模型同时作答。', kind: 'feature' },
  // 收尾
  { s: 67.3, e: 74.55, text: '从一页纸，到一整座知识库。', kind: 'title', pos: { left: 0, right: 0, top: 112 }, align: 'center' },
];

/** 逐字从一道看不见的基线下升起（遮罩揭示），收尾时整行轻轻下沉淡出。 */
const MaskIn = ({ text, t, s, e, stagger, dur = 0.42 }: { text: string; t: number; s: number; e: number; stagger: number; dur?: number }) => {
  const out = prog(t, e - 0.26, e, ease.inCubic);
  let n = 0;
  return (
    <>
      {text.split('\n').map((line, li) => (
        <span key={li} style={{ display: 'block', overflow: 'hidden', paddingBottom: '0.1em', marginBottom: '-0.1em' }}>
          {[...line].map((ch, i) => {
            const at = s + n++ * stagger;
            const k = prog(t, at, at + dur, ease.outExpo);
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  whiteSpace: 'pre',
                  transform: `translateY(${(1 - k) * 112 + out * 16}%)`,
                  opacity: clamp(k * 3) * (1 - out),
                }}
              >
                {ch}
              </span>
            );
          })}
        </span>
      ))}
    </>
  );
};

const Scrim = ({
  at,
  w,
  h,
  color,
  edge,
  opacity,
  solid = 0.3,
}: {
  at: 'tl' | 'bl' | 'top';
  w: number;
  h: number;
  color: string;
  edge: string;
  opacity: number;
  /** 从角上算起，完全不透的那一段占半径的比例 */
  solid?: number;
}) => {
  if (opacity <= 0.001) return null;
  const style: CSSProperties =
    at === 'top'
      ? { left: 0, right: 0, top: 0, height: h, background: `linear-gradient(180deg, ${color} 0%, ${edge} 52%, transparent 100%)` }
      : {
          left: 0,
          [at === 'tl' ? 'top' : 'bottom']: 0,
          width: w,
          height: h,
          background: `radial-gradient(ellipse 100% 100% at 0% ${at === 'tl' ? '0%' : '100%'}, ${color} 0%, ${color} ${solid * 100}%, ${edge} ${(solid + 0.32) * 100}%, transparent 100%)`,
        };
  return <div style={{ position: 'absolute', opacity, ...style }} />;
};

const SuperView = ({ sp, t }: { sp: Super; t: number }) => {
  const dark = sp.tone === 'dark';
  const ink = dark ? 'hsl(0 0% 97%)' : brand.ink;
  const ground = dark ? 'hsl(220 12% 7% / 0.86)' : 'hsl(0 0% 97% / 0.94)';
  const groundEdge = dark ? 'hsl(220 12% 7% / 0.5)' : 'hsl(0 0% 97% / 0.62)';
  if (sp.kind === 'title') {
    const centered = sp.align === 'center';
    const k = prog(t, sp.s - 0.1, sp.s + 0.4, ease.brand) * (1 - prog(t, sp.e - 0.26, sp.e, ease.inCubic));
    return (
      <>
        {centered && sp.scrim !== false ? <Scrim at="top" w={0} h={400} color={ground} edge={groundEdge} opacity={k} /> : null}
        <div
          style={{
            position: 'absolute',
            ...sp.pos,
            textAlign: sp.align ?? 'left',
            fontFamily: font.serif,
            fontSize: 72,
            lineHeight: 1.35,
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: ink,
          }}
        >
          <MaskIn text={sp.text} t={t} s={sp.s} e={sp.e} stagger={0.035} dur={0.5} />
        </div>
      </>
    );
  }
  // 主句 40/600 + 副文案 24/400：两层层级，而不是一块 PPT 式的大标题板
  const k = prog(t, sp.s - 0.05, sp.s + 0.3, ease.brand);
  const out = prog(t, sp.e - 0.3, sp.e, ease.inCubic);
  const subK = prog(t, sp.s + 0.15, sp.s + 0.45, ease.brand);
  const w = Math.max(1000, sp.text.length * 44 + 560, (sp.sub?.length ?? 0) * 26 + 560);
  return (
    <>
      <Scrim at="bl" w={w} h={sp.sub ? 370 : 310} color={ground} edge={groundEdge} solid={sp.sub ? 0.42 : 0.3} opacity={k * (1 - out)} />
      <div style={{ position: 'absolute', left: 96, bottom: 92, fontFamily: font.ui, color: ink }}>
        <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: '0.03em' }}>
          <MaskIn text={sp.text} t={t} s={sp.s + 0.03} e={sp.e} stagger={0.022} />
        </div>
        {sp.sub ? (
          <div
            style={{
              marginTop: 14,
              fontSize: 24,
              fontWeight: 400,
              letterSpacing: '0.04em',
              color: dark ? 'hsl(0 0% 76%)' : brand.ink2,
              opacity: subK * (1 - out),
              transform: `translateY(${(1 - subK) * 8}px)`,
            }}
          >
            {sp.sub}
          </div>
        ) : null}
      </div>
    </>
  );
};

export const Supers = ({ t }: { t: number }) => (
  <>
    {SUPERS.filter((sp) => t >= sp.s - 0.12 && t <= sp.e + 0.05).map((sp) => (
      <SuperView key={sp.text} sp={sp} t={t} />
    ))}
  </>
);
