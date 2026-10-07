/**
 * 技能管理的内存后端：全局技能目录（~/.deep-student/skills）里放三个技能——
 * 自己写的「考研数学错题教练」（已信任）、从社区市场装的「英语长难句拆解」（已信任）、
 * 刚装还没信任的「有机化学反应机理」；社区技能市场有六个可装的示例技能。
 * 新建 / 编辑 / 删除 / 从市场安装都写进这张内存表；GitHub 技能源、导入 zip 需要联网或本机文件，提示去桌面版。
 *
 * 只依赖演示数据模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';

export const GLOBAL_SKILLS_DIR = '~/.deep-student/skills';

interface SkillFile {
  path: string;
  content: string;
}

const skillMd = (meta: { name: string; description: string; version: string; author: string; tags: string[] }, body: string) =>
  `---
name: ${meta.name}
description: ${meta.description}
version: ${meta.version}
author: ${meta.author}
tags: [${meta.tags.join(', ')}]
---

${body.trim()}
`;

const SEED: Record<string, { files: SkillFile[] }> = {
  'kaoyan-math-coach': {
    files: [
      {
        path: 'SKILL.md',
        content: skillMd(
          {
            name: '考研数学错题教练',
            description: '针对考研数学一的错题做归因：先判断是概念、计算还是审题问题，再给出同类变式题与易错点清单。用户上传错题、问「为什么我总错这类题」时使用。',
            version: '1.2.0',
            author: '我',
            tags: ['考研', '高等数学', '错题'],
          },
          `
# 考研数学错题教练

## 工作流程
1. 读题并复述已知条件，确认用户的错误答案与正确答案。
2. 归因：概念不清 / 计算失误 / 审题偏差 / 方法选择不当，四选一并说明依据。
3. 给出 1 道同类变式题，让用户先做；做完再讲评。
4. 把易错点整理成一张「错因 → 对策」小表，必要时建议做成闪卡。

## 风格
- 不直接给完整解答，先给提示；用户卡住两次再展开。
- 公式用 LaTeX，步骤编号。
`,
        ),
      },
      { path: 'references/易错点清单.md', content: '# 高数易错点\n\n- 洛必达法则使用前未验证 0/0 或 ∞/∞ 型\n- 定积分换元忘记换上下限\n- 多元函数可微与偏导存在混淆\n' },
    ],
  },
  'english-long-sentence': {
    files: [
      {
        path: 'SKILL.md',
        content: skillMd(
          {
            name: '英语长难句拆解',
            description: '把考研 / 四六级阅读里的长难句拆成主干与修饰成分，标出从句类型和翻译顺序，最后给出通顺译文。',
            version: '2.0.1',
            author: 'study-tools-lab',
            tags: ['考研英语', '阅读', '语法'],
          },
          `
# 英语长难句拆解

1. 找谓语动词，确定主干（主谓宾 / 主系表）。
2. 用方括号标出从句、圆括号标出非谓语与介词短语。
3. 说明每个修饰成分修饰谁。
4. 按中文语序给出译文，并指出一个可以积累的表达。
`,
        ),
      },
    ],
  },
  'organic-mechanism': {
    files: [
      {
        path: 'SKILL.md',
        content: skillMd(
          {
            name: '有机化学反应机理',
            description: '用电子推动箭头逐步讲解亲核取代、消除、加成等有机反应机理，并对比 SN1 / SN2 / E1 / E2 的条件差异。',
            version: '0.9.3',
            author: 'chem-notes',
            tags: ['有机化学', '反应机理'],
          },
          `
# 有机化学反应机理

- 每一步写出中间体，标明电子流向。
- 先判断底物级数、亲核试剂强弱、溶剂类型，再判断走哪条机理。
- 结尾用一张表对比四种机理的速率方程、立体化学与重排可能。
`,
        ),
      },
      { path: 'scripts/draw_mechanism.py', content: '# 用 RDKit 画反应机理示意图（需要本机 Python 环境）\n' },
    ],
  },
};

const MARKET = [
  ['linear-algebra-visual', '线性代数几何直观', '用二维 / 三维图像解释矩阵变换、特征向量与行列式的几何含义。', '1.4.0', 3_812, 'math-viz', 412],
  ['feynman-explainer', '费曼学习法讲解员', '让你用自己的话讲一遍概念，AI 找出讲不清的地方追问到底。', '2.1.0', 9_604, 'learn-better', 1_208],
  ['ml-paper-reader', '机器学习论文精读', '按「问题—方法—实验—局限」四段结构精读一篇机器学习论文，并生成复习卡片。', '1.0.6', 5_127, 'paper-club', 637],
  ['kaoyan-politics-outline', '考研政治知识框架', '把马原、毛中特、史纲知识点整理成可背诵的框架与关键词。', '3.0.2', 7_960, 'exam-notes', 889],
  ['ielts-writing-coach', '雅思写作教练', '按 TR / CC / LR / GRA 四项评分标准给出修改建议与范文片段。', '1.8.1', 6_245, 'writing-desk', 744],
  ['pomodoro-planner', '番茄学习计划', '把一周的学习任务拆成番茄钟，结合待办自动排进日程。', '0.7.0', 2_031, 'focus-kit', 198],
] as const;

const fs = new Map<string, SkillFile[]>(
  Object.entries(SEED).map(([id, { files }]) => [`${GLOBAL_SKILLS_DIR}/${id}`, files.map((f) => ({ ...f }))]),
);

const desktopOnly = (zh: string, en: string) => new Error(tr(`${zh}请在桌面版中使用。`, `${en} is available in the desktop app.`));

const sizeOf = (s: string) => new TextEncoder().encode(s).length;
const dirOf = (path: string) => path.replace(/\/[^/]*$/, '');
const fakeSha = (seed: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
};

function marketCard(row: (typeof MARKET)[number]) {
  const [slug, displayName, summary, version, downloads, ownerHandle, stars] = row;
  return {
    slug,
    displayName,
    summary,
    version,
    downloads,
    ownerHandle,
    stars,
    verify: {
      ok: true,
      decision: 'pass',
      reasons: [],
      slug,
      version,
      securityStatus: 'clean',
      securityPassed: true,
      publisherHandle: ownerHandle,
      publisherDisplayName: ownerHandle,
    },
  };
}

function scanResult(id: string, path: string, files: SkillFile[]) {
  const scripts = files.filter((f) => f.path.startsWith('scripts/')).length;
  return {
    skill_id: id,
    path,
    files_extracted: files.length,
    scripts_count: scripts,
    references_count: files.filter((f) => f.path.startsWith('references/')).length,
    allowed_tools_count: 0,
    package_sha256: fakeSha(id + files.map((f) => f.content).join('')),
    risk_level: scripts ? 'medium' : 'low',
    risk_signals: scripts ? ['包含脚本文件（scripts/）'] : [],
    requires: { bins: [], env: [], python_packages: [], invalid: [], missing_count: 0 },
  };
}

function marketFiles(row: (typeof MARKET)[number]): SkillFile[] {
  const [, displayName, summary, version, , ownerHandle] = row;
  return [
    {
      path: 'SKILL.md',
      content: skillMd(
        { name: displayName, description: summary, version, author: ownerHandle, tags: ['社区市场'] },
        `# ${displayName}\n\n${summary}\n`,
      ),
    },
  ];
}

/** 是不是演示里的非内置技能（全局目录里的，含访客新建的；或市场上的） */
export function isDemoUserSkill(id: string): boolean {
  return fs.has(`${GLOBAL_SKILLS_DIR}/${id}`) || MARKET.some((r) => r[0] === id);
}

export function handleDemoSkills(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'skill_list_directories': {
      const base = String(args.path ?? '');
      if (base !== GLOBAL_SKILLS_DIR) return [];
      return [...fs.keys()].map((path) => ({ name: path.slice(base.length + 1), path }));
    }
    case 'skill_read_file': {
      const path = String(args.path ?? '');
      const file = fs.get(dirOf(path))?.find((f) => `${dirOf(path)}/${f.path}` === path);
      if (!file) throw new Error(`File not found: ${path}`);
      return { content: file.content, path };
    }
    case 'skill_list_package_files': {
      const files = fs.get(String(args.path ?? '')) ?? [];
      return files.map((f) => ({ path: f.path, size: sizeOf(f.content) }));
    }
    case 'skill_create': {
      const dir = `${String(args.basePath ?? GLOBAL_SKILLS_DIR)}/${String(args.skillId)}`;
      fs.set(dir, [{ path: 'SKILL.md', content: String(args.content ?? '') }]);
      return { content: args.content, path: `${dir}/SKILL.md` };
    }
    case 'skill_update': {
      const path = String(args.path ?? '');
      const files = fs.get(dirOf(path));
      if (!files) throw new Error(`File not found: ${path}`);
      const entry = files.find((f) => f.path === 'SKILL.md');
      if (entry) entry.content = String(args.content ?? '');
      return { content: args.content, path };
    }
    case 'skill_delete':
      fs.delete(String(args.path ?? '').replace(/\/SKILL\.md$/, ''));
      return null;
    case 'chat_v2_set_skill_trust': {
      const root = String(args.packageRoot ?? '');
      const files = fs.get(root) ?? [];
      return { skill_id: args.skillId, trusted: Boolean(args.trusted), package_sha256: args.trusted ? fakeSha(root + files.map((f) => f.content).join('')) : null };
    }
    case 'skill_check_updates':
      return [
        {
          skillId: 'english-long-sentence',
          checkable: true,
          updateAvailable: false,
          sourceKind: 'skill_market',
          sourceSummary: 'skill_market:english-long-sentence@2.0.1',
          currentSha256: fakeSha('english-long-sentence'),
          remoteSha256: null,
          currentVersion: '2.0.1',
          remoteVersion: '2.0.1',
          error: null,
        },
      ];
    // 社区技能市场
    case 'skill_market_search': {
      const q = String(args.q ?? '').trim().toLowerCase();
      const rows = MARKET.filter((r) => !q || `${r[0]} ${r[1]} ${r[2]}`.toLowerCase().includes(q));
      const sort = String(args.sort ?? 'trending');
      const sorted = [...rows].sort((a, b) => (sort === 'stars' ? b[6] - a[6] : b[4] - a[4]));
      return { mode: q ? 'search' : 'browse', items: sorted.slice(0, Number(args.limit ?? 30)).map(marketCard) };
    }
    case 'skill_market_skill_detail': {
      const row = MARKET.find((r) => r[0] === args.slug);
      if (!row) throw new Error('not found');
      const card = marketCard(row);
      return { ...card, description: card.summary, ownerDisplayName: card.ownerHandle };
    }
    case 'skill_market_verify': {
      const row = MARKET.find((r) => r[0] === args.slug);
      if (!row) throw new Error('not found');
      return marketCard(row).verify;
    }
    case 'skill_market_download_and_scan': {
      const row = MARKET.find((r) => r[0] === args.slug);
      if (!row) throw new Error('not found');
      const files = marketFiles(row);
      const dir = `${GLOBAL_SKILLS_DIR}/${row[0]}`;
      if (args.install) fs.set(dir, files);
      return {
        slug: row[0],
        version: row[3],
        provenance: `skill_market:${row[0]}@${row[3]}`,
        tempZipPath: args.install ? null : `/tmp/skill-market/${row[0]}.zip`,
        sourceKind: 'skill_market',
        scan: scanResult(row[0], dir, files),
        installed: Boolean(args.install),
      };
    }
    // 需要联网或本机文件的入口
    case 'skill_tap_catalog':
    case 'skill_tap_install':
      throw desktopOnly('从 GitHub 技能源安装需要联网，', 'Installing from a GitHub skill source');
    case 'skill_import_zip':
      throw desktopOnly('导入技能包要读取本机文件，', 'Importing a skill package');
    case 'skill_export_tap':
      throw desktopOnly('导出技能源要写入本机文件，', 'Exporting a skill source');
    case 'skill_update_from_source':
      throw desktopOnly('更新技能需要联网，', 'Updating a skill');
    default:
      return undefined;
  }
}

/** 预置信任：前两个全局技能已信任（无指纹的旧格式条目，应用会惰性补指纹） */
export const DEMO_SKILL_LOCAL_STORAGE: Record<string, string> = {
  'deep-student.skill-trust-overrides': JSON.stringify({
    'kaoyan-math-coach': { trust: 'trusted', grantedAt: Date.now() - 12 * 86_400_000 },
    'english-long-sentence': { trust: 'trusted', grantedAt: Date.now() - 5 * 86_400_000 },
  }),
};
