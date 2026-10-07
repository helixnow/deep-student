/**
 * 学习页伴随分区的演示层：问答 / 练习 / 截帧提问在桌面版会新开一个对话（附上这节课 + 课程学习技能），
 * 单应用演示里没有聊天页，所以在分区里就地展示剧本回答——回答带时间引用，点一下经生产的
 * media-ref:focus 事件让播放器跳过去。讲义笔记在桌面版用笔记打开，这里给一个只读查看层。
 *
 * 只操作 DOM，不 import app 模块（通知函数由包在 afterMount 里动态 import 后注入）。
 */
import { tr } from '../../../lang';
import { getDemoMedia, getDemoNote, noteAssets } from './backend';
import { P4_ID, type DemoMedia, type Line } from './data';

type Notify = (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;

const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** 回答片段：文字 / 时间引用 */
type Piece = string | { t: number };
type Answer = Piece[];

// ---------------------------------------------------------------- 剧本回答

const P4_ANSWERS: Record<string, Answer> = {
  summary: [
    '这节课回答「什么样的矩阵可以相似对角化」，按讲解顺序是：\n\n',
    '1. 定理 5.6：n 阶矩阵 A 可对角化 ⟺ A 有 n 个线性无关的特征向量，P 的列就是这些特征向量，Λ 的对角元是对应特征值 ', { t: 37 }, '。\n',
    '2. 推论 5.7：n 个特征值互不相同 ⇒ 一定可对角化；这只是充分条件，单位矩阵就是反例 ', { t: 306 }, ' ', { t: 382 }, '。\n',
    '3. 有重特征值时，看每个特征值的几何重数是否等于代数重数，几何重数 = n − r(λE − A) ', { t: 606 }, ' ', { t: 668 }, '。\n',
    '4. 例 5.9 走完整个流程：特征多项式 (λ − 6)(λ − 3)² → 检查二重根 → 求特征向量排成 P ', { t: 900 }, ' ', { t: 1200 }, '。',
  ],
  keyPoints: [
    '重点\n',
    '· 定理 5.6 的特征向量判据，以及 AP = PΛ 按列拆开的理解 ', { t: 61 }, '\n',
    '· 用 r(λE − A) 计算几何重数，逐个检查重根 ', { t: 760 }, '\n\n',
    '难点与易错\n',
    '· P 的列序与 Λ 的对角元顺序必须一一对应——老师特别提醒这里常丢分 ', { t: 122 }, '\n',
    '· 「特征值互不相同」只是充分条件，有重根不代表不能对角化 ', { t: 365 }, '\n',
    '· 几何重数 ≤ 代数重数，且至少为 1 ', { t: 620 }, '',
  ],
};

function genericAnswer(m: DemoMedia, key: string): Answer {
  const lines = m.lines;
  if (lines.length === 0) return [tr('这节课还没有字幕，先转写或导入字幕，回答会更准确。', 'This lesson has no transcript yet — transcribe or import subtitles first.')];
  const picks = [0, Math.floor(lines.length / 3), Math.floor((2 * lines.length) / 3), lines.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => lines[i]);
  const head = key === 'keyPoints' ? tr('这节课的重点：\n\n', 'Key points of this lesson:\n\n') : tr('按讲解顺序：\n\n', 'In order:\n\n');
  return [head, ...picks.flatMap(([t, text], i): Piece[] => [`${i + 1}. ${text} `, { t }, '\n'])];
}

/** 当前播放位置附近：所在幻灯片 + 前后几句字幕 */
function explainAt(m: DemoMedia, sec: number): Answer {
  const slide = [...(m.slides ?? [])].reverse().find((s) => s.at <= sec);
  const near = m.lines.filter(([t]) => t <= sec + 20).slice(-3);
  const out: Answer = [tr(`你停在 ${clock(sec)} 附近。`, `You're around ${clock(sec)}. `)];
  if (slide) out.push(tr(`这时画面上是「${slide.title}」：${slide.caption.replace(/^[^：]*：/u, '')}。\n\n`, `The slide shows "${slide.title}".\n\n`));
  if (near.length > 0) {
    out.push(tr('老师在这里说的是：\n', 'What the lecturer says here:\n'));
    for (const [t, text] of near) out.push(`「${text}」`, { t }, '\n');
  }
  if (m.id === P4_ID && sec >= 470 && sec < 570) {
    out.push(tr('\n换句话说：特征值互不相同时直接下结论；一旦有重根，就要转到下一部分的「几何重数 = 代数重数」去检查 ', '\nIn short: distinct eigenvalues settle it; with repeated roots, check geometric = algebraic multiplicity '), { t: 570 }, '。');
  }
  return out;
}

/** 自由提问：按字面重合挑出最相关的几句字幕 */
function searchAnswer(m: DemoMedia, question: string): Answer {
  const grams = new Set<string>();
  const q = question.replace(/\s+/g, '');
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2));
  const scored = m.lines
    .map((line) => {
      let score = 0;
      for (const g of grams) if (line[1].includes(g)) score += 1;
      return { line, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.line[0] - b.line[0]);
  if (scored.length === 0) {
    return [tr('这节课的字幕里没有直接讲到这个问题。可以换个说法，或点「总结这节课」先看整体内容。', 'The transcript does not cover this directly. Try rephrasing, or ask for a summary first.')];
  }
  const out: Answer = [tr('这节课里相关的讲解：\n\n', 'Related parts of the lesson:\n\n')];
  for (const { line: [t, text] } of scored as Array<{ line: Line }>) out.push(`· ${text} `, { t }, '\n');
  out.push(tr('\n点时间引用可以直接回到原处再听一遍。', '\nClick a timestamp to replay that part.'));
  return out;
}

// ---------------------------------------------------------------- 练习剧本

interface Card { front: string; back: string; t: number }

const P4_CARDS: Card[] = [
  { front: 'n 阶矩阵 A 可相似对角化的充要条件？', back: 'A 有 n 个线性无关的特征向量（定理 5.6）', t: 37 },
  { front: '对角化时 P 与 Λ 的对应关系？', back: 'P 的第 i 列是属于 Λ 第 i 个对角元 λᵢ 的特征向量，顺序必须一致', t: 95 },
  { front: '「n 个特征值互不相同」与可对角化的关系？', back: '充分不必要：互不相同 ⇒ 可对角化；反例：单位矩阵 E', t: 365 },
  { front: '特征值 λ 的几何重数怎么算？', back: 'dim V_λ = n − r(λE − A)，且 1 ≤ 几何重数 ≤ 代数重数', t: 606 },
];

const P4_QUESTIONS: Card[] = [
  { front: '【单选】下列条件中，是 n 阶矩阵 A 可对角化的充分不必要条件的是：\nA. A 有 n 个线性无关的特征向量　B. A 有 n 个互不相同的特征值　C. A 可逆　D. A 的秩为 n', back: '答案 B。A 是充要条件；C、D 与可对角化无关。', t: 306 },
  { front: '【填空】设 λ = 3 是三阶矩阵 A 的二重特征值，A 可对角化，则 r(3E − A) = ____。', back: '答案 1。几何重数须等于代数重数 2，即 3 − r(3E − A) = 2。', t: 800 },
  { front: '【简答】A 的对角元为 4、其余元素为 1，求可逆矩阵 P 使 P⁻¹AP 为对角阵。', back: 'P = (ξ₁, ξ₂, ξ₃)，ξ₁ = (−1,1,0)ᵀ，ξ₂ = (−1,0,1)ᵀ，ξ₃ = (1,1,1)ᵀ，P⁻¹AP = diag(3,3,6)。', t: 1140 },
];

function genericCards(m: DemoMedia): Card[] {
  return m.lines.slice(0, 4).map(([t, text]) => ({ front: tr(`${clock(t)} 讲到了什么？`, `What is covered at ${clock(t)}?`), back: text, t }));
}

// ---------------------------------------------------------------- DOM

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function currentResourceId(root: HTMLElement): string | null {
  return root.querySelector<HTMLElement>('[data-media-study]')?.dataset.mediaStudy ?? null;
}

function videoOf(root: HTMLElement): HTMLMediaElement | null {
  return root.querySelector<HTMLMediaElement>('[data-media-study] video, [data-media-study] audio');
}

function seek(resourceId: string, seconds: number) {
  window.dispatchEvent(new CustomEvent('media-ref:focus', {
    detail: { resourceId, seconds, targetScopeId: 'media-studio', play: true },
  }));
}

function citationChip(resourceId: string, t: number): HTMLButtonElement {
  const chip = el('button', 'mx-0.5 inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-1.5 align-[1px] text-[11px] font-medium tabular-nums text-primary hover:bg-primary/20');
  chip.type = 'button';
  chip.dataset.demoCitation = String(t);
  chip.title = tr(`跳到 ${clock(t)}`, `Jump to ${clock(t)}`);
  chip.textContent = `▶ ${clock(t)}`;
  chip.addEventListener('click', () => seek(resourceId, t));
  return chip;
}

/** 分区里的对话层：盖住分区原内容，带返回 */
function panelFor(root: HTMLElement, tab: 'ask' | 'practice'): { body: HTMLElement; resourceId: string } | null {
  const host = root.querySelector<HTMLElement>(`[data-media-study-tab="${tab}"]`);
  const resourceId = currentResourceId(root);
  if (!host || !resourceId) return null;
  host.querySelector('[data-demo-chat]')?.remove();
  host.classList.add('demo-chat-active');
  const panel = el('div', 'flex min-h-0 flex-1 flex-col');
  panel.dataset.demoChat = tab;
  const header = el('div', 'flex shrink-0 items-center gap-2 border-b border-border px-3 py-2');
  const back = el('button', 'rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground', tr('← 返回', '← Back'));
  back.type = 'button';
  back.addEventListener('click', () => {
    panel.remove();
    host.classList.remove('demo-chat-active');
  });
  const title = el('span', 'min-w-0 truncate text-xs font-medium text-foreground', tab === 'ask'
    ? tr('课程学习 · 基于本课字幕回答', 'Course study · answers from this transcript')
    : tr('练习 · 按讲到的时刻生成', 'Practice · built from the transcript'));
  header.append(back, title);
  const body = el('div', 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3');
  panel.append(header, body);
  host.appendChild(panel);
  return { body, resourceId };
}

function bubble(body: HTMLElement, who: 'user' | 'assistant'): HTMLElement {
  const b = el('div', who === 'user'
    ? 'max-w-[88%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground'
    : 'max-w-full self-start whitespace-pre-wrap text-[13px] leading-relaxed text-foreground');
  body.appendChild(b);
  return b;
}

/** 逐字流出回答（引用整块出现） */
async function stream(target: HTMLElement, answer: Answer, resourceId: string, scroller: HTMLElement) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  for (const piece of answer) {
    if (typeof piece === 'string') {
      const span = el('span');
      target.appendChild(span);
      if (reduced) {
        span.textContent = piece;
      } else {
        for (let i = 0; i < piece.length; i += 3) {
          span.textContent = piece.slice(0, i + 3);
          scroller.scrollTop = scroller.scrollHeight;
          await new Promise((r) => setTimeout(r, 14));
        }
      }
    } else {
      target.appendChild(citationChip(resourceId, piece.t));
    }
  }
  scroller.scrollTop = scroller.scrollHeight;
}

function thinking(body: HTMLElement): HTMLElement {
  const t = el('div', 'self-start text-xs text-muted-foreground', tr('正在阅读本课字幕…', 'Reading the transcript…'));
  body.appendChild(t);
  return t;
}

function composer(root: HTMLElement, body: HTMLElement, resourceId: string) {
  const panel = body.parentElement!;
  const form = el('form', 'flex shrink-0 items-center gap-2 border-t border-border px-3 py-2');
  const input = el('input', 'h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground outline-none focus:border-primary');
  input.placeholder = tr('就这节课继续问…', 'Ask about this lesson…');
  const send = el('button', 'h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground', tr('发送', 'Send'));
  send.type = 'submit';
  form.append(input, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void ask(root, body, resourceId, text, searchAnswer(getDemoMedia(resourceId)!, text));
  });
  panel.appendChild(form);
}

async function ask(root: HTMLElement, body: HTMLElement, resourceId: string, question: string | HTMLElement, answer: Answer) {
  const user = bubble(body, 'user');
  if (typeof question === 'string') user.textContent = question;
  else user.appendChild(question);
  const wait = thinking(body);
  body.scrollTop = body.scrollHeight;
  await new Promise((r) => setTimeout(r, 650));
  wait.remove();
  await stream(bubble(body, 'assistant'), answer, resourceId, body);
}

function openAsk(root: HTMLElement, kind: 'start' | 'summary' | 'keyPoints' | 'explain', label: string) {
  const panel = panelFor(root, 'ask');
  if (!panel) return;
  const m = getDemoMedia(panel.resourceId);
  if (!m) return;
  composer(root, panel.body, panel.resourceId);
  if (kind === 'start') {
    const hello = bubble(panel.body, 'assistant');
    hello.textContent = tr(
      `已附上「${m.name.replace(/\.[^.]+$/, '')}」并启用「课程学习」技能。回答基于字幕，时间引用可以点击跳转。`,
      'This lesson is attached and the Course study skill is on. Answers cite timestamps you can click.',
    );
    panel.body.parentElement?.querySelector('input')?.focus();
    return;
  }
  const answer = kind === 'explain'
    ? explainAt(m, Math.floor(videoOf(root)?.currentTime ?? m.positionSec))
    : m.id === P4_ID ? P4_ANSWERS[kind] : genericAnswer(m, kind);
  void ask(root, panel.body, panel.resourceId, label, answer);
}

function openPractice(root: HTMLElement, kind: 'cards' | 'questions') {
  const panel = panelFor(root, 'practice');
  if (!panel) return;
  const m = getDemoMedia(panel.resourceId);
  if (!m) return;
  const items = m.id === P4_ID ? (kind === 'cards' ? P4_CARDS : P4_QUESTIONS) : genericCards(m);
  const intro = el('p', 'text-xs text-muted-foreground', kind === 'cards'
    ? tr(`根据字幕生成了 ${items.length} 张闪卡（桌面版会进入「闪卡」复习，来源可跳回视频）：`, `${items.length} flashcards from the transcript (they go to Flashcards in the desktop app):`)
    : tr(`根据字幕出了 ${items.length} 道题（桌面版会建成题目集）：`, `${items.length} questions from the transcript (saved as a question set in the desktop app):`));
  panel.body.appendChild(intro);
  items.forEach((card, i) => {
    const box = el('div', 'study-shell-secondary-card flex flex-col gap-1.5 px-3 py-2.5');
    box.style.opacity = '0';
    box.style.transition = 'opacity 240ms ease';
    const front = el('div', 'whitespace-pre-wrap text-[13px] font-medium text-foreground', card.front);
    const back = el('div', 'whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground', card.back);
    const meta = el('div', 'flex items-center gap-1 text-[11px] text-muted-foreground', tr('来源', 'Source'));
    meta.appendChild(citationChip(panel.resourceId, card.t));
    box.append(front, back, meta);
    panel.body.appendChild(box);
    window.setTimeout(() => { box.style.opacity = '1'; }, 250 + i * 220);
  });
}

async function captureAndAsk(root: HTMLElement) {
  const video = videoOf(root);
  const resourceId = currentResourceId(root);
  if (!(video instanceof HTMLVideoElement) || !resourceId || video.videoWidth === 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth);
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
  const sec = Math.floor(video.currentTime);
  // 切到问答分区
  const tabButtons = [...root.querySelectorAll<HTMLElement>('[data-media-study-companion] [role="radio"]')];
  tabButtons.find((b) => /问答|Q&A|Ask/i.test(b.textContent ?? ''))?.click();
  await new Promise((r) => setTimeout(r, 60));
  const panel = panelFor(root, 'ask');
  if (!panel) return;
  const m = getDemoMedia(resourceId);
  if (!m) return;
  composer(root, panel.body, panel.resourceId);
  const q = el('div', 'flex flex-col gap-1.5');
  const img = el('img', 'w-full rounded-lg border border-white/20');
  img.src = canvas.toDataURL('image/jpeg', 0.85);
  img.alt = '';
  q.append(img, el('span', '', tr(`截帧 ${clock(sec)} · 这一页在讲什么？`, `Frame at ${clock(sec)} · what is this slide about?`)));
  void ask(root, panel.body, panel.resourceId, q, explainAt(m, sec));
}

// ---------------------------------------------------------------- 讲义查看层

function frameAt(src: string, sec: number): Promise<string> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = src;
    const done = (url: string) => { v.removeAttribute('src'); v.load(); resolve(url); };
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(sec + 1, Math.max(0, v.duration - 1)); }, { once: true });
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = Math.round((640 * v.videoHeight) / Math.max(1, v.videoWidth));
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
      done(c.toDataURL('image/jpeg', 0.85));
    }, { once: true });
    v.addEventListener('error', () => done(''), { once: true });
  });
}

function inlineText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) frag.appendChild(el('strong', 'font-semibold', part.slice(2, -2)));
    else if (part) frag.appendChild(document.createTextNode(part));
  }
  return frag;
}

/** 讲义 Markdown（handoutToMarkdown 的固定子集）→ DOM */
function renderHandout(markdown: string, container: HTMLElement, close: () => void) {
  for (const block of markdown.split(/\n{2,}/)) {
    const text = block.trim();
    if (!text) continue;
    const anchor = /^\[媒体@([^:\]]+):(\d{2}):(\d{2})\]$/.exec(text);
    if (anchor) {
      const t = Number(anchor[2]) * 60 + Number(anchor[3]);
      const row = el('div', '-mt-1 mb-1');
      const chip = citationChip(anchor[1], t);
      chip.addEventListener('click', close);
      row.appendChild(chip);
      container.appendChild(row);
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(text);
    if (image) {
      const img = el('img', 'my-1 w-full rounded-lg border border-border');
      img.alt = image[1];
      const src = image[2];
      const frame = /^demo-frame:([^:]+):(\d+)$/.exec(src);
      if (frame) {
        const m = getDemoMedia(frame[1]);
        if (m) void frameAt(m.src, Number(frame[2])).then((url) => { if (url) img.src = url; });
      } else {
        img.src = noteAssets.get(src) ?? '';
      }
      container.appendChild(img);
      continue;
    }
    if (text.startsWith('# ')) container.appendChild(el('h1', 'mb-1 text-xl font-bold text-foreground', text.slice(2)));
    else if (text.startsWith('## ')) container.appendChild(el('h2', 'mt-4 text-base font-semibold text-foreground', text.slice(3)));
    else if (text.startsWith('### ')) container.appendChild(el('h3', 'mt-2 text-sm font-semibold text-foreground', text.slice(4)));
    else if (text.startsWith('> ')) container.appendChild(el('blockquote', 'border-l-2 border-primary/60 bg-primary/5 px-3 py-1.5 text-[13px] text-foreground', text.slice(2)));
    else if (/^\*[^*].*\*$/.test(text)) container.appendChild(el('p', '-mt-1 text-center text-xs text-muted-foreground', text.slice(1, -1)));
    else if (text.startsWith('|')) {
      const rows = text.split('\n').filter((r) => !/^\|\s*-/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const table = el('table', 'w-full border-collapse text-xs');
      rows.forEach((cells, i) => {
        const tr0 = el('tr');
        for (const c of cells) tr0.appendChild(el(i === 0 ? 'th' : 'td', `border border-border px-2 py-1 text-left ${i === 0 ? 'bg-muted font-medium' : ''}`, c));
        table.appendChild(tr0);
      });
      container.appendChild(table);
    } else if (/^(-|\d+\.) /.test(text)) {
      const ordered = /^\d+\. /.test(text);
      const list = el(ordered ? 'ol' : 'ul', `${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5 text-[13px] leading-relaxed text-foreground`);
      for (const line of text.split('\n')) list.appendChild(el('li', '', line.replace(/^(-|\d+\.) /, '')));
      container.appendChild(list);
    } else {
      const p = el('p', 'text-[13px] leading-relaxed text-foreground');
      p.appendChild(inlineText(text));
      container.appendChild(p);
    }
  }
}

function openHandout(root: HTMLElement, noteId: string, notify: Notify) {
  const note = getDemoNote(noteId);
  if (!note) {
    notify('info', tr('桌面版会在笔记里打开这份讲义。', 'The desktop app opens this handout in Notes.'));
    return;
  }
  document.querySelector('[data-demo-handout]')?.remove();
  const overlay = el('div', 'fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-3');
  overlay.dataset.demoHandout = noteId;
  const sheet = el('div', 'flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl');
  const head = el('div', 'flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5');
  head.append(el('span', 'min-w-0 flex-1 truncate text-sm font-medium text-foreground', tr(`笔记 · ${note.title}`, `Note · ${note.title}`)));
  const closeBtn = el('button', 'rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground', tr('关闭', 'Close'));
  closeBtn.type = 'button';
  head.append(closeBtn);
  const content = el('div', 'flex min-h-0 flex-col gap-2 overflow-y-auto px-5 py-4');
  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  renderHandout(note.content, content, close);
  content.appendChild(el('p', 'mt-3 text-xs text-muted-foreground', tr('桌面版里这是一篇普通笔记：可继续编辑、导出 Word；每节的时间锚点点一下回到视频。', 'In the desktop app this is a regular note you can edit and export to Word; each section anchor jumps back to the video.')));
  sheet.append(head, content);
  overlay.appendChild(sheet);
  (root.ownerDocument.body).appendChild(overlay);
  closeBtn.focus();
}

// ---------------------------------------------------------------- 安装

export function installMediaCompanion(root: HTMLElement, notify: Notify, captureLabels: string[]) {
  const style = document.createElement('style');
  style.textContent = '.demo-chat-active > :not([data-demo-chat]) { display: none !important; }';
  document.head.appendChild(style);

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>('button, [role="button"]');
    if (!button || button.closest('[data-demo-chat]')) return;
    const stop = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    if (button.matches('[data-media-ask]')) {
      stop();
      openAsk(root, 'start', button.textContent ?? '');
      return;
    }
    if (button.closest('[data-media-study-tab="ask"]') && !button.matches('[data-media-ask]')) {
      const label = (button.textContent ?? '').trim();
      const kind = /总结|Summar/i.test(label) ? 'summary' : /重点|难点|key/i.test(label) ? 'keyPoints' : 'explain';
      stop();
      openAsk(root, kind, label);
      return;
    }
    const practice = button.getAttribute('data-media-practice');
    if (practice === 'cards' || practice === 'questions') {
      stop();
      openPractice(root, practice);
      return;
    }
    if (captureLabels.includes(button.getAttribute('aria-label') ?? '')) {
      stop();
      void captureAndAsk(root);
      return;
    }
    if (button.matches('[data-bilibili-open]')) {
      stop();
      notify('info', tr('演示里的课程是虚构的。桌面版会在 B 站打开这个分 P，并从当前时间开始播放。', 'This course is fictional. The desktop app opens this part on Bilibili at the current time.'));
      return;
    }
    if (button.matches('[data-bilibili-playback]')) {
      stop();
      notify('info', tr('B 站外链播放器需要联网，演示里不切换。桌面版在应用内播放失败时会自动换到外链播放器。', 'The Bilibili embed player needs network access. The desktop app switches to it automatically when in-app playback fails.'));
    }
  }, true);

  window.addEventListener('DSTU_OPEN_NOTE', (event) => {
    const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
    if (noteId) openHandout(root, noteId, notify);
  });
}
