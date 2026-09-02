/**
 * Web 演示壳 - 附件资产（全部代码生成，无外部文件依赖）
 *
 * 演示"上传附件"关键能力所需的真实数据：
 * - 3 张错题照片：SVG 源在内联生成，mock 解析时经 canvas 栅格化为真实 PNG
 *   base64（缩略图 / InlineImageViewer 全屏 / 发送链路全走生产代码）
 * - 《机器学习系统》第 3 章 PDF：运行时构建的 60 页合法 PDF（pdf.js 可直接
 *   渲染，页码 45/47/52 对应剧本里的 [PDF@file_demo_mlsys:N] 引用跳转）
 *
 * 数据流（与桌面版完全同构）：
 *   消息 _meta.contextSnapshot.userRefs (res_xxx)
 *     → vfs_get_resource 取 VfsContextRefData（引用清单）
 *     → vfs_resolve_resource_refs 解析出图片 PNG / 文件解析文本
 *   点击 PDF chip → CHAT_OPEN_ATTACHMENT_PREVIEW → 右侧 UnifiedAppPanel
 *     → dstu_get 取节点 → vfs_get_attachment_content 取 PDF base64 → pdf.js 渲染
 *   点击 [PDF@file_demo_mlsys:47] 徽章 → pdf-ref:open（file_ 前缀走附件通道）
 *     → 同一面板 + pdf-ref:focus 跳页
 */

import type { DstuNode } from '@/dstu/types';

// ============================================================================
// ID 与命名
// ============================================================================

export const DEMO_PDF_SOURCE_ID = 'file_demo_mlsys';
export const DEMO_PDF_RESOURCE_ID = 'res_demo_pdf';
export const DEMO_PDF_NAME = '机器学习系统（第 3 章）·数据并行训练.pdf';

export interface DemoImageAsset {
  /** 消息 contextSnapshot 里的 resourceId（res_xxx） */
  resourceId: string;
  /** VFS 业务 id（att_xxx，附件表语义） */
  sourceId: string;
  name: string;
  svg: string;
}

// ============================================================================
// 错题照片（SVG 源：白纸 + 蓝黑题目 + 红笔批改痕迹）
// ============================================================================

function wrongProblemSvg(title: string, lines: string[], redNote: string): string {
  const textLines = lines
    .map(
      (l, i) =>
        `<text x="60" y="${170 + i * 56}" font-size="30" fill="#1f2937" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${l}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620">
  <rect width="900" height="620" fill="#f8f7f4"/>
  <rect x="18" y="18" width="864" height="584" rx="10" fill="#ffffff" stroke="#e5e2dc" stroke-width="2"/>
  <line x1="18" y1="96" x2="882" y2="96" stroke="#f0ede6" stroke-width="2"/>
  <text x="60" y="66" font-size="26" font-weight="600" fill="#9ca3af" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${title}</text>
  ${textLines}
  <text x="60" y="500" font-size="28" fill="#dc2626" font-family="'PingFang SC','Microsoft YaHei',sans-serif" transform="rotate(-2 60 500)">${redNote}</text>
  <path d="M560 470 q 40 -30 90 -12 q 50 18 96 -16" stroke="#dc2626" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M742 424 l 22 6 m -4 -18 l -18 24" stroke="#dc2626" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`;
}

export const DEMO_IMAGE_ASSETS: DemoImageAsset[] = [
  {
    resourceId: 'res_demo_img1',
    sourceId: 'att_demo_img1',
    name: '错题1·等价无穷小替换.png',
    svg: wrongProblemSvg(
      '高等数学 · 错题照片 1',
      ['求 lim(x→0) (sin x − x) / x³', '解：sin x ~ x，原式 = (x − x) / x³ = 0'],
      '✗ 等价无穷小不能用于相减项！',
    ),
  },
  {
    resourceId: 'res_demo_img2',
    sourceId: 'att_demo_img2',
    name: '错题2·换元积分忘换限.png',
    svg: wrongProblemSvg(
      '高等数学 · 错题照片 2',
      ['∫₀^π sin²x dx，令 u = cos x', '原式 = ∫ √1−u² du（上下限照抄 0→π）'],
      '✗ 换元必须换限：x=0→u=1，x=π→u=−1',
    ),
  },
  {
    resourceId: 'res_demo_img3',
    sourceId: 'att_demo_img3',
    name: '错题3·中值定理辅助函数.png',
    svg: wrongProblemSvg(
      '高等数学 · 错题照片 3',
      ['证：∃ξ∈(a,b)，使 f′(ξ) = (f(b)−f(a))/(b−a)', '证明：由拉格朗日中值定理显然成立。'],
      '✗ 循环论证！先构造 F(x) 再落罗尔定理',
    ),
  },
];

// ============================================================================
// SVG → PNG 栅格化（在 mock 解析时执行，结果缓存）
// ============================================================================

const pngCache = new Map<string, Promise<string>>();

/** 把 SVG 源栅格化为 PNG base64（2x 超采样；无 DOM 环境时退化为 SVG base64） */
export function rasterizeSvgToPngBase64(svg: string): Promise<string> {
  const cached = pngCache.get(svg);
  if (cached) return cached;
  const task = (async () => {
    const svgB64 = btoa(unescape(encodeURIComponent(svg)));
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      return svgB64; // 测试/SSR 环境兜底
    }
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${svgB64}`;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = (img.naturalWidth || 900) * scale;
    canvas.height = (img.naturalHeight || 620) * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return svgB64;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1] || svgB64;
  })().catch(() => btoa(unescape(encodeURIComponent(svg))));
  pngCache.set(svg, task);
  return task;
}

// ============================================================================
// 《机器学习系统》PDF：纯 TS 构建的 60 页合法 PDF（Helvetica，Latin 文本）
// ============================================================================

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageContentStream(lines: string[]): string {
  const cmds = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join(' ');
  return `BT /F1 11 Tf 56 792 Td 17 TL ${cmds} ET`;
}

/** 组装多页 PDF 并返回 base64（全部 ASCII，btoa 安全） */
function buildPdfBase64(pages: string[][]): string {
  const parts: string[] = [];
  const offsets: number[] = [];
  let bytes = 0;
  const push = (s: string) => {
    parts.push(s);
    bytes += s.length;
  };
  const addObj = (id: number, body: string) => {
    offsets[id] = bytes;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  addObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, i) => {
    const stream = pageContentStream(lines);
    addObj(
      4 + i * 2,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    addObj(5 + i * 2, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const xrefStart = bytes;
  const objCount = 4 + pages.length * 2;
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objCount; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return btoa(parts.join(''));
}

/** 章节正文（英文排版保证任何 PDF 阅读器可提取；中文摘要走解析文本字段） */
const CH3_SPECIAL_PAGES: Record<number, string[]> = {
  44: [
    'Machine Learning Systems',
    '',
    'Chapter 3',
    '',
    'Data-Parallel Training',
    '',
    'In this chapter: the mini-batch protocol, the parameter server,',
    'synchronization cost and the straggler effect, and the two',
    'escape hatches - gradient compression and pipeline parallelism.',
  ],
  45: [
    '3.1  The Data-Parallel Protocol',
    '',
    'Data parallelism splits each mini-batch across K workers. Every',
    'worker keeps a full replica of the model, computes gradients on',
    'its own shard, and hands them to the parameter server.',
    '',
    'The server aggregates (mean) the K gradient tensors and',
    'broadcasts the updated parameters back to all workers before',
    'the next step begins.',
    '',
    'The protocol is simple to reason about because every worker',
    'observes the same parameters at the start of a step.',
  ],
  47: [
    '3.2  Synchronization Cost and the Straggler Effect',
    '',
    'Synchronous SGD requires every worker to wait for the slowest',
    'one. This is the straggler effect: a single slow link or a',
    'hotspot GPU stretches the whole step.',
    '',
    'As K grows, communication per step grows while computation per',
    'worker shrinks, so speedup deviates from linear scaling. In',
    'practice utilization often drops below 60% beyond 64 workers',
    'on commodity Ethernet.',
  ],
  52: [
    '3.4  Gradient Compression and Pipeline Parallelism',
    '',
    'When communication is the bottleneck, quantization (FP16, 8-bit,',
    'or even 1-bit sign) and sparsification (top-k) cut the payload',
    'by one to two orders of magnitude with modest accuracy loss.',
    '',
    'An orthogonal direction is to change the partitioning scheme',
    'itself: pipeline parallelism assigns consecutive layers to',
    'different stages and streams micro-batches through them,',
    'trading bubble overhead for far less cross-node traffic.',
  ],
};

function buildMlsysPages(): string[][] {
  const pages: string[][] = [];
  for (let p = 1; p <= 60; p += 1) {
    const special = CH3_SPECIAL_PAGES[p];
    if (special) {
      pages.push([...special, '', `- ${p} -`]);
      continue;
    }
    const chapter = p < 44 ? Math.ceil(p / 22) : p <= 56 ? 3 : 4;
    pages.push([
      `Machine Learning Systems  (A. Chen, 2024)`,
      `Chapter ${chapter}`,
      '',
      `This page intentionally carries representative prose so that`,
      `text extraction, page anchors and citation jumps behave the`,
      `same as they do for a real textbook file.`,
      '',
      `- ${p} -`,
    ]);
  }
  return pages;
}

let cachedPdfBase64: string | null = null;

/** 《机器学习系统》演示 PDF（60 页）的 base64，惰性构建一次 */
export function getDemoPdfBase64(): string {
  if (!cachedPdfBase64) {
    cachedPdfBase64 = buildPdfBase64(buildMlsysPages());
  }
  return cachedPdfBase64;
}

/** 后端 DocumentParser 对 PDF 的解析文本（文件 chip 解析结果用） */
export const DEMO_PDF_PARSED_TEXT = `机器学习系统 · 第 3 章 数据并行训练（解析文本摘要）

3.1 数据并行的基本范式：mini-batch 切分到 K 个 worker，各自在完整模型副本上计算梯度，由参数服务器（Parameter Server）聚合后再广播更新值。
3.2 同步的代价：同步 SGD 要求所有 worker 等待最慢的一步，straggler 效应使加速比随 worker 数增加而显著偏离线性。
3.4 破局方向：通信受限场景下，梯度压缩（量化 / 稀疏化）与流水线并行是降低同步开销的两条主要路径。

（共 60 页，第 3 章为第 44–56 页）`;

// ============================================================================
// mock 查询接口（mockIpc 调用）
// ============================================================================

/** vfs_get_resource 的演示数据：resourceId → BackendResource（data 为引用清单 JSON） */
export function getDemoAttachmentResource(resourceId: string): Record<string, unknown> | null {
  const img = DEMO_IMAGE_ASSETS.find((a) => a.resourceId === resourceId);
  if (img) {
    return {
      id: img.resourceId,
      hash: `hash_${img.sourceId}`,
      type: 'image',
      sourceId: img.sourceId,
      storageMode: 'inline',
      data: JSON.stringify({
        refs: [
          { sourceId: img.sourceId, resourceHash: `hash_${img.sourceId}`, type: 'image', name: img.name },
        ],
        totalCount: 1,
        truncated: false,
      }),
      metadata: { name: img.name, mimeType: 'image/png' },
      refCount: 1,
      createdAt: Date.now(),
    };
  }
  if (resourceId === DEMO_PDF_RESOURCE_ID) {
    return {
      id: DEMO_PDF_RESOURCE_ID,
      hash: `hash_${DEMO_PDF_SOURCE_ID}`,
      type: 'file',
      sourceId: DEMO_PDF_SOURCE_ID,
      storageMode: 'inline',
      data: JSON.stringify({
        refs: [
          {
            sourceId: DEMO_PDF_SOURCE_ID,
            resourceHash: `hash_${DEMO_PDF_SOURCE_ID}`,
            type: 'file',
            name: DEMO_PDF_NAME,
          },
        ],
        totalCount: 1,
        truncated: false,
      }),
      metadata: { name: DEMO_PDF_NAME, mimeType: 'application/pdf' },
      refCount: 1,
      createdAt: Date.now(),
    };
  }
  return null;
}

/** vfs_resolve_resource_refs 的演示解析结果（图片给 PNG base64，文件给解析文本） */
export async function resolveDemoAttachmentRef(
  sourceId: string,
): Promise<Record<string, unknown> | null> {
  const img = DEMO_IMAGE_ASSETS.find((a) => a.sourceId === sourceId);
  if (img) {
    const pngBase64 = await rasterizeSvgToPngBase64(img.svg);
    return {
      sourceId: img.sourceId,
      resourceHash: `hash_${img.sourceId}`,
      type: 'image',
      name: img.name,
      path: `/上传/${img.name}`,
      found: true,
      content: pngBase64,
      metadata: { mimeType: 'image/png', size: Math.floor((pngBase64.length * 3) / 4) },
    };
  }
  if (sourceId === DEMO_PDF_SOURCE_ID) {
    return {
      sourceId: DEMO_PDF_SOURCE_ID,
      resourceHash: `hash_${DEMO_PDF_SOURCE_ID}`,
      type: 'file',
      name: DEMO_PDF_NAME,
      path: `/上传/${DEMO_PDF_NAME}`,
      found: true,
      content: DEMO_PDF_PARSED_TEXT,
      metadata: { mimeType: 'application/pdf', size: Math.floor((getDemoPdfBase64().length * 3) / 4) },
    };
  }
  return null;
}

/** vfs_get_attachment_content：PDF 预览面板取整文件 base64 */
export function getDemoAttachmentContent(attachmentId: string): { content: string; found: boolean } | null {
  if (attachmentId === DEMO_PDF_SOURCE_ID) {
    return { content: getDemoPdfBase64(), found: true };
  }
  return null;
}

/** dstu_get：附件预览面板的节点信息 */
export function getDemoDstuNode(path: string): Partial<DstuNode> | null {
  const id = path.replace(/^\//, '');
  if (id === DEMO_PDF_SOURCE_ID) {
    const size = Math.floor((getDemoPdfBase64().length * 3) / 4);
    return {
      id: DEMO_PDF_SOURCE_ID,
      path: `/${DEMO_PDF_SOURCE_ID}`,
      name: DEMO_PDF_NAME,
      type: 'file',
      sourceId: DEMO_PDF_SOURCE_ID,
      resourceHash: `hash_${DEMO_PDF_SOURCE_ID}`,
      previewType: 'pdf',
      size,
      createdAt: Date.now() - 18 * 60_000,
      updatedAt: Date.now() - 18 * 60_000,
      metadata: { mimeType: 'application/pdf', size, pageCount: 60 },
    };
  }
  return null;
}
