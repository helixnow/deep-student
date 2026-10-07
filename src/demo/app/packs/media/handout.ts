/**
 * 讲义流水线的「模型回答」：大纲 JSON 与分节块 JSON（生产流水线解析、校验、配图、落笔记）。
 * P4 是手写的完整讲义；其余条目按字幕时间均分三节、由字幕行拼出要点。
 */
import { tr } from '../../../lang';
import { P4_ID, PRESET_HANDOUT, type DemoMedia } from './data';

const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

interface SectionScript {
  heading: string;
  start: number;
  end: number;
  points: string[];
  blocks: Array<Record<string, unknown>>;
}

const P4_TITLE = '对角化的条件 · 讲义';
const P4_SUMMARY = '本节回答「什么样的矩阵能相似对角化」：从定理 5.6 的特征向量判据出发，给出特征值互异的充分条件，再用几何重数与代数重数处理重特征值，最后以例 5.9 走完整个判断与求 P 的流程。';

const P4_SECTIONS: SectionScript[] = [
  {
    heading: '相似对角化与判定定理',
    start: 0,
    end: 299,
    points: ['相似对角化的定义', '定理 5.6', 'P 与 Λ 的对应关系'],
    blocks: [
      { type: 'lead', text: '矩阵 A 能相似对角化，等价于能找到 n 个线性无关的特征向量；把它们排成 P，P⁻¹AP 就是以对应特征值为对角元的 Λ。' },
      { type: 'h2', text: '定理 5.6' },
      { type: 'para', text: 'n 阶矩阵 A 可对角化，当且仅当 A 有 n 个线性无关的特征向量。把 AP = PΛ 按列拆开，第 i 列正是 Aξᵢ = λᵢξᵢ；P 可逆恰好要求这些列线性无关。' },
      { type: 'figure', pick: 1, caption: '定理 5.6 与 P、Λ 的构成' },
      { type: 'list', ordered: false, items: ['P 的第 i 列与 Λ 的第 i 个对角元一一对应，顺序要一致', '特征向量乘非零常数仍是特征向量，所以 P 不唯一', '不计顺序时 Λ 是唯一的'] },
      { type: 'note', text: '写答案时 P 的列序和 Λ 的对角元顺序对不上，是这一部分最常见的失分点。' },
    ],
  },
  {
    heading: '推论：特征值互不相同',
    start: 300,
    end: 569,
    points: ['推论 5.7', '充分不必要', '单位矩阵反例'],
    blocks: [
      { type: 'lead', text: '若 n 阶矩阵有 n 个互不相同的特征值，它一定可以对角化——这是一个充分条件，但不是必要条件。' },
      { type: 'para', text: '依据是属于不同特征值的特征向量线性无关：每个特征值至少取一个特征向量，恰好凑够 n 个。' },
      { type: 'figure', pick: 2, caption: '推论 5.7 及其反例' },
      { type: 'para', text: '反例是单位矩阵 E：它只有一个 n 重特征值 1，却本身就是对角阵。因此特征值有重复时不能直接下结论，需要进一步检查。' },
    ],
  },
  {
    heading: '重特征值：几何重数与代数重数',
    start: 570,
    end: 899,
    points: ['代数重数与几何重数', '定理 5.8', '用秩检查重根'],
    blocks: [
      { type: 'lead', text: '有重特征值时，A 可对角化当且仅当每个特征值的几何重数都等于代数重数——每个特征值都要「交够」自己那一份特征向量。' },
      { type: 'table', caption: '两种重数', header: ['概念', '含义', '计算'], rows: [['代数重数', 'λ 作为特征多项式根的重数', '因式分解 |λE − A|'], ['几何重数', '特征子空间 V_λ 的维数', 'n − r(λE − A)']] },
      { type: 'figure', pick: 3, caption: '定理 5.8：几何重数 = 代数重数' },
      { type: 'list', ordered: true, items: ['单根的两种重数必然都是 1，不用检查', '对 k 重根，检查 r(λE − A) 是否等于 n − k', '全部满足才可对角化'] },
    ],
  },
  {
    heading: '例 5.9：判断并求可逆矩阵 P',
    start: 900,
    end: 1368,
    points: ['求特征多项式', '检查二重根', '求特征向量并排成 P'],
    blocks: [
      { type: 'lead', text: '对角元为 4、其余元素为 1 的三阶矩阵：特征值为 3（二重）和 6，二重根的几何重数为 2，因此可以对角化。' },
      { type: 'figure', pick: 4, caption: '例 5.9 的特征多项式与秩的检查' },
      { type: 'list', ordered: true, items: ['|λE − A| = (λ − 6)(λ − 3)²', 'r(3E − A) = 1，几何重数 3 − 1 = 2，等于代数重数', 'λ = 3：ξ₁ = (−1, 1, 0)ᵀ，ξ₂ = (−1, 0, 1)ᵀ；λ = 6：ξ₃ = (1, 1, 1)ᵀ', 'P = (ξ₁, ξ₂, ξ₃)，P⁻¹AP = diag(3, 3, 6)'] },
      { type: 'figure', pick: 5, caption: '求出特征向量并写出 P' },
      { type: 'note', text: 'A 是实对称矩阵，下一讲会证明实对称矩阵一定可以对角化。' },
    ],
  },
];

function genericSections(m: DemoMedia): SectionScript[] {
  const end = Math.round(m.durationMs / 1000);
  const lines = m.lines;
  const third = Math.ceil(lines.length / 3);
  return [0, 1, 2]
    .map((i) => lines.slice(i * third, (i + 1) * third))
    .filter((chunk) => chunk.length > 0)
    .map((chunk, i, all) => {
      const start = i === 0 ? 0 : chunk[0][0];
      const stop = i === all.length - 1 ? end : all[i + 1][0][0] - 1;
      const heading = chunk[0][1].replace(/[，。,.!?：:]+$/u, '').slice(0, 18);
      return {
        heading,
        start,
        end: stop,
        points: chunk.map(([, t]) => t).slice(0, 3),
        blocks: [
          { type: 'lead', text: chunk.map(([, t]) => t).join('') },
          { type: 'figure', pick: i, caption: heading },
          { type: 'list', ordered: false, items: chunk.map(([, t]) => t.replace(/[，,]$/u, '')) },
        ],
      };
    });
}

const sectionsFor = (m: DemoMedia) => (m.id === P4_ID ? P4_SECTIONS : genericSections(m));

export function handoutOutlineFor(m: DemoMedia) {
  const name = m.name.replace(/\.[^.]+$/, '');
  return {
    title: m.id === P4_ID ? P4_TITLE : `${name.split(' ').pop() ?? name} · ${tr('讲义', 'Handout')}`,
    summary: m.id === P4_ID ? P4_SUMMARY : '',
    sections: sectionsFor(m).map((s) => ({ heading: s.heading, start: clock(s.start), end: clock(s.end), points: s.points })),
  };
}

/** 分节块：figure 的 pick 换成提示里给出的配图时间（没有就不配图） */
export function handoutBlocksFor(m: DemoMedia, prompt: string, figureTimes: string[]) {
  const section = sectionsFor(m).find((s) => prompt.includes(s.heading)) ?? sectionsFor(m)[0];
  const used = new Set<string>();
  return section.blocks.flatMap((b) => {
    if (b.type !== 'figure') return [b];
    const time = figureTimes.find((t) => !used.has(t));
    if (!time) return [];
    used.add(time);
    return [{ type: 'figure', time, caption: b.caption }];
  });
}

/** 已有的 P4 讲义正文（同生产 handoutToMarkdown 的格式；配图路径由查看器按时间抽帧） */
export function presetHandoutMarkdown(): string {
  const CN = ['一', '二', '三', '四'];
  const figureAt = [50, 300, 575, 900, 1150];
  let fig = 0;
  const parts = [`# ${PRESET_HANDOUT.title}`, P4_SUMMARY];
  P4_SECTIONS.forEach((s, i) => {
    parts.push(`## ${CN[i]}、${s.heading}`);
    parts.push(`[媒体@${P4_ID}:${clock(s.start)}]`);
    for (const b of s.blocks) {
      switch (b.type) {
        case 'lead':
        case 'para':
          parts.push(String(b.text));
          break;
        case 'h2':
          parts.push(`### ${String(b.text)}`);
          break;
        case 'note':
          parts.push(`> ${String(b.text)}`);
          break;
        case 'list':
          parts.push((b.items as string[]).map((it, k) => (b.ordered ? `${k + 1}. ${it}` : `- ${it}`)).join('\n'));
          break;
        case 'table': {
          const header = b.header as string[];
          const rows = b.rows as string[][];
          parts.push(`**表 1 ${String(b.caption)}**`);
          parts.push([`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n'));
          break;
        }
        case 'figure': {
          const ts = figureAt[Number(b.pick)] ?? 50;
          fig += 1;
          parts.push(`![图 ${fig} ${String(b.caption)}](demo-frame:${P4_ID}:${ts})`);
          parts.push(`*图 ${fig} ${String(b.caption)}*`);
          break;
        }
      }
    }
  });
  return `${parts.join('\n\n')}\n`;
}
