import { invoke } from '@tauri-apps/api/core';
import {
  applyArtifactReply,
  parseArtifactReply,
} from '@/components/previews/artifactEditEngine';
import {
  applyHtmlSearchReplacePatch,
  type HtmlSearchReplacePatch,
} from '@/components/previews/InteractiveHtmlCanvas';

const COLOR_KEYWORDS: Array<{ patterns: RegExp[]; hex: string; label: string }> = [
  { patterns: [/红色|鲜红|赤红|\bred\b|\bcrimson\b/i], hex: '#ef4444', label: 'red' },
  { patterns: [/绿色|翠绿|青绿|\bgreen\b|\bemerald\b/i], hex: '#10b981', label: 'green' },
  { patterns: [/橙色|橘色|橙黄|\borange\b|\bamber\b/i], hex: '#f97316', label: 'orange' },
  { patterns: [/紫色|紫罗兰|\bpurple\b|\bviolet\b/i], hex: '#8b5cf6', label: 'purple' },
  { patterns: [/黄色|金黄|\byellow\b|\bgold\b/i], hex: '#eab308', label: 'yellow' },
  { patterns: [/青色|蓝绿|\bcyan\b|\bteal\b/i], hex: '#06b6d4', label: 'cyan' },
  { patterns: [/粉色|粉红|玫红|\bpink\b|\brose\b/i], hex: '#ec4899', label: 'pink' },
  { patterns: [/蓝色|天蓝|深蓝|\bblue\b|\bindigo\b/i], hex: '#3b82f6', label: 'blue' },
];

function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveRequestedColor(instruction: string): string | null {
  const explicitHex = /#[0-9a-fA-F]{3,8}\b/.exec(instruction);
  if (explicitHex) return explicitHex[0];
  const explicitFunc = /\b(?:rgb|rgba|hsl|hsla)\([^)]+\)/i.exec(instruction);
  if (explicitFunc) return explicitFunc[0];
  for (const entry of COLOR_KEYWORDS) {
    if (entry.patterns.some((re) => re.test(instruction))) {
      return entry.hex;
    }
  }
  return null;
}

/**
 * 确定性本地自然语言微调兜底：
 * 当后端 LLM 未配置或离线时，对常见的文本替换、标题修改、颜色调整、滑杆参数调整与重置按钮注入直接生成精准修改。
 */
export function applySmartLocalHtmlPatch(
  instruction: string,
  currentHtml: string,
): string | null {
  const trimmed = instruction.trim();
  if (!trimmed || !currentHtml.trim()) return null;

  // 1. 显式引号对替换：把 "A" 改为 "B" / 将「A」替换为「B」 / replace "A" with "B" / "A" -> "B"
  const quotedPairPatterns = [
    /(?:把|将)?\s*["'“”‘’「」『』`]([^"'“”‘’「」『』`]+)["'“”‘’「」『』`]\s*(?:改为|改成|替换为|替换成|换成|修改为|->|=>|to|with)\s*["'“”‘’「」『』`]([^"'“”‘’「」『』`]*)["'“”‘’「」『』`]/i,
    /\breplace\s+["'`]([^"'`]+)["'`]\s+with\s+["'`]([^"'`]*)["'`]/i,
  ];
  for (const re of quotedPairPatterns) {
    const match = re.exec(trimmed);
    if (match && match[1]) {
      const target = match[1];
      const replacement = match[2] ?? '';
      const firstIdx = currentHtml.indexOf(target);
      if (firstIdx >= 0 && currentHtml.indexOf(target, firstIdx + 1) < 0) {
        const next =
          currentHtml.slice(0, firstIdx) + replacement + currentHtml.slice(firstIdx + target.length);
        if (next !== currentHtml && next.trim()) return next;
      }
    }
  }

  // 2. 标题修改或新增：把标题改为 XXX / 修改标题为 XXX / change title to XXX / 添加标题 XXX
  const titleChangeMatch =
    /(?:把|将)?(?:页面|画布|主)?(?:标题|title|heading)\s*(?:改为|改成|修改为|设为|设置为|换成|to|=|:|：)\s*["'“”「」`]?([^"'“”「」`\r\n]+?)["'“”「」`]?$/i.exec(
      trimmed,
    );
  if (titleChangeMatch && titleChangeMatch[1]?.trim()) {
    const newTitle = escapeHtmlText(titleChangeMatch[1].trim());
    let next = currentHtml;
    let changed = false;
    if (/<h1\b[^>]*>[\s\S]*?<\/h1>/i.test(next)) {
      next = next.replace(/<h1(\b[^>]*)>[\s\S]*?<\/h1>/i, `<h1$1>${newTitle}</h1>`);
      changed = true;
    } else if (/<h2\b[^>]*>[\s\S]*?<\/h2>/i.test(next)) {
      next = next.replace(/<h2(\b[^>]*)>[\s\S]*?<\/h2>/i, `<h2$1>${newTitle}</h2>`);
      changed = true;
    }
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(next)) {
      next = next.replace(/<title(\b[^>]*)>[\s\S]*?<\/title>/i, `<title$1>${newTitle}</title>`);
      changed = true;
    }
    if (!changed) {
      if (/<div\s+class=["']panel["'][^>]*>/i.test(next)) {
        next = next.replace(
          /<div(\s+class=["']panel["'][^>]*)>/i,
          `<div$1>\n    <h2 style="margin:0;font-size:16px;">${newTitle}</h2>`,
        );
        changed = true;
      } else if (/<body\b[^>]*>/i.test(next)) {
        next = next.replace(
          /<body(\b[^>]*)>/i,
          `<body$1>\n  <h2 style="margin:0 0 12px;font-size:16px;">${newTitle}</h2>`,
        );
        changed = true;
      }
    }
    if (changed && next !== currentHtml) return next;
  }

  const addHeadingMatch =
    /(?:添加|增加|加上|插入)(?:一个)?(?:主|副)?(?:标题|说明|提示)[:：\s]*["'“”「」`]?([^"'“”「」`\r\n]+?)["'“”「」`]?$/i.exec(
      trimmed,
    );
  if (addHeadingMatch && addHeadingMatch[1]?.trim() && !/按钮|button/i.test(trimmed)) {
    const headingText = escapeHtmlText(addHeadingMatch[1].trim());
    const headingHtml = `<div data-local-edit-note="1" style="font-size:14px;font-weight:600;margin-bottom:8px;">${headingText}</div>`;
    if (/<body\b[^>]*>/i.test(currentHtml)) {
      return currentHtml.replace(/<body(\b[^>]*)>/i, `<body$1>\n  ${headingHtml}`);
    }
    return `${headingHtml}\n${currentHtml}`;
  }

  // 3. 颜色调整（波形/线条/画笔 strokeStyle、背景色、文字主色）
  const targetColor = resolveRequestedColor(trimmed);
  if (targetColor) {
    if (/背景|background/i.test(trimmed)) {
      if (/background(?:-color)?\s*:\s*[^;}\r\n]+/i.test(currentHtml)) {
        const next = currentHtml.replace(
          /background(?:-color)?\s*:\s*[^;}\r\n]+/i,
          `background: ${targetColor}`,
        );
        if (next !== currentHtml) return next;
      }
      if (/<body\b[^>]*>/i.test(currentHtml)) {
        return currentHtml.replace(
          /<body(\b[^>]*)>/i,
          `<body$1 style="background:${targetColor};">`,
        );
      }
    }
    if (/strokeStyle\s*=\s*['"][^'"]+['"]/.test(currentHtml)) {
      const next = currentHtml.replace(
        /strokeStyle\s*=\s*['"][^'"]+['"]/,
        `strokeStyle = '${targetColor}'`,
      );
      if (next !== currentHtml) return next;
    }
    if (/fillStyle\s*=\s*['"][^'"]+['"]/.test(currentHtml)) {
      const next = currentHtml.replace(
        /fillStyle\s*=\s*['"][^'"]+['"]/,
        `fillStyle = '${targetColor}'`,
      );
      if (next !== currentHtml) return next;
    }
    if (/color\s*:\s*[^;}\r\n]+/i.test(currentHtml)) {
      const next = currentHtml.replace(/color\s*:\s*[^;}\r\n]+/i, `color: ${targetColor}`);
      if (next !== currentHtml) return next;
    }
  }

  // 4. 滑杆最大/最小值或线宽调整
  const maxMatch = /(?:最大(?:频率|值)|max)\s*(?:改为|改成|设为|to|=)\s*(\d+(?:\.\d+)?)/i.exec(trimmed);
  if (maxMatch && /type=["']range["']/i.test(currentHtml)) {
    const next = currentHtml.replace(/max=["']\d+(?:\.\d+)?["']/gi, `max="${maxMatch[1]}"`);
    if (next !== currentHtml) return next;
  }

  const lineWidthMatch = /(?:线宽|线条粗细|lineWidth)\s*(?:改为|改成|设为|to|=)\s*(\d+(?:\.\d+)?)/i.exec(trimmed);
  if (lineWidthMatch && /lineWidth\s*=\s*\d+(?:\.\d+)?/.test(currentHtml)) {
    const next = currentHtml.replace(
      /lineWidth\s*=\s*\d+(?:\.\d+)?/,
      `lineWidth = ${lineWidthMatch[1]}`,
    );
    if (next !== currentHtml) return next;
  }

  // 5. 添加重置按钮（针对含滑杆的交互实验画布）
  if (/(?:添加|增加|加上|add)\s*(?:一个\s*)?(?:重置|复位|reset)\s*(?:按钮|button)/i.test(trimmed)) {
    const resetBtnHtml = `<button id="ds-local-reset-btn" type="button" onclick="document.querySelectorAll('input[type=range]').forEach(function(el){el.value=el.defaultValue;el.dispatchEvent(new Event('input',{bubbles:true}));});">重置参数</button>`;
    if (!currentHtml.includes('id="ds-local-reset-btn"')) {
      if (/<div\s+class=["']controls["'][^>]*>/i.test(currentHtml)) {
        return currentHtml.replace(
          /<div(\s+class=["']controls["'][^>]*>[\s\S]*?)<\/div>/i,
          `<div$1  ${resetBtnHtml}\n    </div>`,
        );
      }
      if (/<\/body>/i.test(currentHtml)) {
        return currentHtml.replace(/<\/body>/i, `  ${resetBtnHtml}\n</body>`);
      }
      return `${currentHtml}\n${resetBtnHtml}`;
    }
  }

  return null;
}

function buildHtmlPatchPrompt(instruction: string, currentHtml: string): string {
  return [
    '你是一个精准的前端 HTML 画布局部修改引擎。',
    '请根据用户的修改要求，对给定的 HTML 源码生成最小化的精确片段替换补丁。',
    '必须只输出合法 JSON 对象，格式二选一：',
    '1) 局部替换（优先）：{"edits":[{"search":"源码中唯一存在的精确原片段","replace":"替换后的新片段"}]}',
    '2) 若涉及大范围重构：{"source":"完整的新 HTML 源码"}',
    '禁止输出 Markdown 解释文字。',
    '',
    '【用户修改要求】',
    instruction,
    '',
    '【当前 HTML 源码】',
    currentHtml,
  ].join('\n');
}

function applyParsedModelOutput(rawReply: string, currentHtml: string): string {
  const trimmed = rawReply.trim();
  const htmlFenceMatch = /^```(?:html?|xml)\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (htmlFenceMatch && htmlFenceMatch[1]?.trim()) {
    const next = htmlFenceMatch[1].trim();
    if (next !== currentHtml) return next;
  }

  const parsed = parseArtifactReply(trimmed);
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed)) {
      return applyHtmlSearchReplacePatch(currentHtml, parsed as HtmlSearchReplacePatch[]);
    }
    const obj = parsed as {
      search?: unknown;
      replace?: unknown;
      edits?: unknown;
      source?: unknown;
    };
    if (typeof obj.search === 'string' && typeof obj.replace === 'string') {
      return applyHtmlSearchReplacePatch(currentHtml, {
        search: obj.search,
        replace: obj.replace,
      });
    }
    if (Array.isArray(obj.edits)) {
      return applyArtifactReply(currentHtml, obj, 'patch');
    }
    if (typeof obj.source === 'string') {
      return applyArtifactReply(currentHtml, obj, 'rewrite');
    }
  }
  throw new Error('模型未返回有效的局部补丁');
}

/**
 * 沙盒画布「就地局部修改」处理器：
 * 1. 支持直接传入 JSON 补丁；
 * 2. 优先调用后端 `handout_llm_complete` 生成结构化 `{ edits: [{ search, replace }] }` 补丁；
 * 3. 若后端模型未配置或离线，回退到确定性本地智能补丁（标题/文本/颜色/参数/重置按钮）。
 */
export async function requestSandboxHtmlPatch(
  instruction: string,
  currentHtml: string,
  options?: { isEnglish?: boolean },
): Promise<HtmlSearchReplacePatch | HtmlSearchReplacePatch[] | string> {
  const trimmed = instruction.trim();
  if (!trimmed) {
    throw new Error(options?.isEnglish ? 'Edit instruction cannot be empty' : '修改要求不能为空');
  }

  let llmError: unknown = null;
  try {
    const requestId = `sandbox-patch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reply = await invoke<string>('handout_llm_complete', {
      prompt: buildHtmlPatchPrompt(trimmed, currentHtml),
      jsonMode: true,
      requestId,
    });
    if (typeof reply === 'string' && reply.trim()) {
      return applyParsedModelOutput(reply, currentHtml);
    }
  } catch (err) {
    llmError = err;
  }

  const localPatched = applySmartLocalHtmlPatch(trimmed, currentHtml);
  if (localPatched && localPatched !== currentHtml) {
    return localPatched;
  }

  const reason =
    llmError instanceof Error && llmError.message.trim()
      ? llmError.message.trim()
      : '';
  throw new Error(
    options?.isEnglish
      ? `Unable to apply natural-language edit${reason ? ` (${reason})` : ''}. You can also use Find & Replace or paste a { "search", "replace" } JSON patch.`
      : `自动改写未能完成${reason ? `（${reason}）` : ''}，也可直接使用上方「查找原片段 / 替换为新片段」或粘贴 { "search", "replace" } JSON 补丁。`,
  );
}

/**
 * 校正沙盒运行时错误行号：
 * 当宿主向 srcdoc 注入了额外前置行时，按用户 `<script>` 或首个非空代码行的真实行差还原用户源码行号；
 * 当注入保持单行（行差为 0）或无法定位偏移时，原样保留原始行号。
 */
export function adjustSandboxRuntimeErrorLine(
  lineno: number,
  userHtml: string,
  srcDoc?: string | null,
): number {
  if (!Number.isFinite(lineno) || lineno <= 0) return 0;
  if (!userHtml || !srcDoc) return lineno;

  const userLines = userHtml.split(/\r\n|\r|\n/);
  const srcLines = srcDoc.split(/\r\n|\r|\n/);

  // 优先匹配用户脚本内的非空特征行，精确计算注入产生的行号偏移
  let anchorText = '';
  let userAnchorLine = -1;
  let inScript = false;

  for (let i = 0; i < userLines.length; i += 1) {
    const line = userLines[i];
    if (/<script\b/i.test(line)) inScript = true;
    const candidate = line.trim();
    if (inScript && candidate.length >= 4 && !/^<\/?script\b/i.test(candidate)) {
      const occurrencesInUser = userLines.filter((l) => l.includes(candidate)).length;
      if (occurrencesInUser === 1) {
        anchorText = candidate;
        userAnchorLine = i + 1;
        break;
      }
    }
    if (/<\/script\s*>/i.test(line)) inScript = false;
  }

  if (!anchorText) {
    for (let i = 0; i < userLines.length; i += 1) {
      const candidate = userLines[i].trim();
      if (
        candidate.length >= 6 &&
        !/^<!doctype\b/i.test(candidate) &&
        !/^<\/?(?:html|head|body|meta)\b/i.test(candidate)
      ) {
        const occurrencesInUser = userLines.filter((l) => l.includes(candidate)).length;
        if (occurrencesInUser === 1) {
          anchorText = candidate;
          userAnchorLine = i + 1;
          break;
        }
      }
    }
  }

  if (!anchorText || userAnchorLine <= 0) return lineno;

  let srcAnchorLine = -1;
  for (let j = 0; j < srcLines.length; j += 1) {
    if (srcLines[j].includes(anchorText)) {
      srcAnchorLine = j + 1;
      break;
    }
  }

  if (srcAnchorLine <= 0) return lineno;
  const lineOffset = srcAnchorLine - userAnchorLine;
  if (lineOffset === 0) return lineno;
  return Math.max(1, lineno - lineOffset);
}
