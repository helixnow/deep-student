/**
 * 第 05 章的划词 AI：「翻译」（stream_chat_translation_* 流式事件）、「解释」
 * （call_llm_for_boundary）和翻译工作台的整篇翻译（translate_text_stream）。
 *
 * 演示 PDF 是《机器学习系统》第 3 章，正文句子在这里都有预置译文；选中任意一段时
 * 按句匹配拼出译文，匹配不到整句时退回术语表，再不行给出桌面版提示。
 * 只依赖演示模块与 @tauri-apps/api（不碰 app 代码）。
 */
import { emit } from '@tauri-apps/api/event';
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';
import { LIBRARY_TRANSLATION_SOURCE, LIBRARY_TRANSLATION_TARGET } from '../../data/library/seed';

/** 教材正文逐句译文（与 attachmentAssets 生成的 PDF 文本一致） */
const SENTENCES: Array<[string, string]> = [
  ['In this chapter: the mini-batch protocol, the parameter server, synchronization cost and the straggler effect, and the two escape hatches - gradient compression and pipeline parallelism.', '本章内容：小批量协议、参数服务器、同步代价与掉队者效应，以及两条出路——梯度压缩与流水线并行。'],
  ['Data parallelism splits each mini-batch across K workers.', '数据并行把每个小批量切分给 K 个工作节点。'],
  ['Every worker keeps a full replica of the model, computes gradients on its own shard, and hands them to the parameter server.', '每个工作节点都保存一份完整的模型副本，在自己分到的数据分片上计算梯度，再把梯度交给参数服务器。'],
  ['The server aggregates (mean) the K gradient tensors and broadcasts the updated parameters back to all workers before the next step begins.', '参数服务器对 K 份梯度张量求平均，并在下一步开始之前把更新后的参数广播回所有工作节点。'],
  ['The protocol is simple to reason about because every worker observes the same parameters at the start of a step.', '由于每个工作节点在每一步开始时看到的参数完全相同，这一协议很容易推理。'],
  ['Synchronous SGD requires every worker to wait for the slowest one.', '同步 SGD 要求每个工作节点都等待最慢的那一个。'],
  ['This is the straggler effect: a single slow link or a hotspot GPU stretches the whole step.', '这就是掉队者效应：一条慢链路或一块过热的 GPU 就会拉长整个训练步。'],
  ['As K grows, communication per step grows while computation per worker shrinks, so speedup deviates from linear scaling.', '随着 K 增大，每一步的通信量上升，而每个节点分到的计算量下降，因此加速比会偏离线性扩展。'],
  ['In practice utilization often drops below 60% beyond 64 workers on commodity Ethernet.', '在普通以太网上，节点数超过 64 个后，实际利用率往往会跌到 60% 以下。'],
  ['When communication is the bottleneck, quantization (FP16, 8-bit, or even 1-bit sign) and sparsification (top-k) cut the payload by one to two orders of magnitude with modest accuracy loss.', '当通信成为瓶颈时，量化（FP16、8 位，甚至 1 位符号）和稀疏化（top-k）能把传输量压缩一到两个数量级，而精度损失不大。'],
  ['An orthogonal direction is to change the partitioning scheme itself: pipeline parallelism assigns consecutive layers to different stages and streams micro-batches through them, trading bubble overhead for far less cross-node traffic.', '另一个正交的方向是改变切分方式本身：流水线并行把相邻的层分配到不同阶段，让微批次依次流过，用流水线气泡的开销换取少得多的跨节点通信。'],
  ['This page intentionally carries representative prose so that text extraction, page anchors and citation jumps behave the same as they do for a real textbook file.', '本页保留了有代表性的正文，使文本提取、页码锚点和引用跳转的表现与真实教材文件一致。'],
  ['3.1 The Data-Parallel Protocol', '3.1 数据并行协议'],
  ['3.2 Synchronization Cost and the Straggler Effect', '3.2 同步代价与掉队者效应'],
  ['3.4 Gradient Compression and Pipeline Parallelism', '3.4 梯度压缩与流水线并行'],
];

const GLOSSARY: Array<[string, string]> = [
  ['straggler effect', '掉队者效应'],
  ['parameter server', '参数服务器'],
  ['data parallelism', '数据并行'],
  ['data-parallel', '数据并行的'],
  ['pipeline parallelism', '流水线并行'],
  ['gradient compression', '梯度压缩'],
  ['linear scaling', '线性扩展'],
  ['mini-batch', '小批量'],
  ['micro-batches', '微批次'],
  ['sparsification', '稀疏化'],
  ['quantization', '量化'],
  ['gradient', '梯度'],
  ['replica', '副本'],
  ['shard', '数据分片'],
  ['workers', '工作节点'],
  ['worker', '工作节点'],
  ['straggler', '掉队者'],
  ['speedup', '加速比'],
  ['bottleneck', '瓶颈'],
  ['synchronization', '同步'],
];

const EXPLANATIONS: Array<[RegExp, string]> = [
  [/straggler/i, '**掉队者效应（straggler effect）**：同步训练里，每一步都要等所有节点算完才能聚合梯度，所以整步耗时由**最慢的那个节点**决定。\n\n- 常见原因：某条网络链路慢、某块 GPU 过热降频、数据分片不均\n- 后果：节点越多，"等人"的时间占比越大，加速比偏离线性\n- 缓解：异步 / 半同步 SGD、备份 worker、梯度压缩减少通信'],
  [/parameter server|aggregat|broadcast/i, '**参数服务器（Parameter Server）**是数据并行里的"汇总点"：\n\n1. 各 worker 在自己的数据分片上算出梯度，推送给它；\n2. 它把 K 份梯度**求平均**，更新模型参数；\n3. 再把新参数**广播**回所有 worker，下一步从同一份参数出发。\n\n优点是逻辑简单、一致性好；缺点是它容易成为通信瓶颈。'],
  [/speedup|linear scaling|utilization/i, '**加速比偏离线性**：理想情况下 K 个节点应快 K 倍，但每步的通信量随 K 增加，而每个节点分到的计算变少，**通信占比越来越高**，所以实际加速比会越来越"弯"。文中给的经验值：普通以太网上超过 64 个节点，利用率常低于 60%。'],
  [/compression|quantiz|sparsif|pipeline/i, '这段讲的是通信受限时的两条出路：\n\n- **梯度压缩**：量化（FP16 / 8 位 / 1 位符号）或只传 top-k 稀疏梯度，传输量降一到两个数量级，精度损失不大；\n- **流水线并行**：改按层切分模型，微批次像流水线一样依次流过各阶段，用"气泡"开销换取更少的跨节点通信。'],
  [/data parallel|mini-batch|replica|shard/i, '**数据并行**：把一个小批量（mini-batch）拆给 K 个节点，每个节点都有**完整的模型副本**，各算各的梯度，最后汇总平均再更新。\n\n可以理解为"多人分头做同一套题，再对答案取平均"——模型不拆，拆的是数据。'],
];

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[“”]/g, '"').trim();
}

/** 按句匹配预置译文；整句匹配不到时退回术语表 */
export function translateDemoText(source: string): string {
  const text = normalize(source);
  if (!text) return '';
  if (normalize(LIBRARY_TRANSLATION_SOURCE) === text) return LIBRARY_TRANSLATION_TARGET;
  const lower = text.toLowerCase();
  const hits = SENTENCES.filter(([en]) => lower.includes(en.toLowerCase().replace(/\s+/g, ' ')));
  if (hits.length) return hits.map(([, zh]) => zh).join('');
  // 选区落在某一句之内：给出所在句的译文
  const inside = SENTENCES.find(([en]) => en.toLowerCase().includes(lower));
  if (inside && lower.length > 24) return inside[1];
  const terms = GLOSSARY.filter(([en]) => lower.includes(en));
  if (terms.length) {
    const exact = GLOSSARY.find(([en]) => en === lower.replace(/[.,:;]$/, ''));
    if (exact) return exact[1];
    return terms.slice(0, 4).map(([en, zh]) => `${en}：${zh}`).join('；');
  }
  return tr(
    '这段文字在演示里没有预置译文。桌面版会调用你配置的翻译模型，参考前后文给出译文。',
    'This passage has no prepared translation in the demo. The desktop app translates it with your configured model, using the surrounding context.',
  );
}

function explainDemoText(prompt: string): string {
  const quoted = /"([\s\S]*)"\s*$/.exec(prompt)?.[1] ?? prompt;
  const hit = EXPLANATIONS.find(([re]) => re.test(quoted));
  if (hit) return hit[1];
  return tr(
    `这段话的大意：${translateDemoText(quoted)}\n\n桌面版会结合整页上下文，由你配置的模型给出更完整的讲解。`,
    `Gist: ${translateDemoText(quoted)}\n\nThe desktop app explains it in full with your configured model, using the whole page as context.`,
  );
}

/** 把文本切成 2–4 字的小块，模拟模型逐 token 吐字 */
function chunks(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const n = 2 + ((i * 7) % 3);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamPopover(eventName: string, text: string, aligned: boolean, source: string) {
  await sleep(350);
  const body = aligned
    ? `${JSON.stringify({ src: normalize(source), tgt: text })}\n{"done": true}\n`
    : text;
  for (const delta of chunks(body)) {
    await emit(eventName, { type: 'chunk', delta });
    await sleep(aligned ? 12 : 28);
  }
  await emit(eventName, { type: 'complete' });
}

async function streamWorkbench(sessionId: string, text: string) {
  const eventName = `translation_stream_${sessionId}`;
  await sleep(300);
  let count = 0;
  for (const chunk of chunks(text)) {
    count += chunk.length;
    await emit(eventName, { type: 'data', chunk, char_count: count });
    await sleep(22);
  }
  await emit(eventName, { type: 'complete', translated_text: text, detected_lang: 'en' });
}

export function handleReadingAi(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'stream_chat_translation_plain':
    case 'stream_chat_translation_aligned': {
      const request = (args.request ?? {}) as { request_id?: string; source?: string };
      const source = String(request.source ?? '');
      void streamPopover(
        `chat_translation_${String(request.request_id ?? '')}`,
        translateDemoText(source),
        cmd === 'stream_chat_translation_aligned',
        source,
      );
      return null;
    }
    case 'translate_text_stream': {
      const request = (args.request ?? {}) as { text?: string; session_id?: string };
      void streamWorkbench(String(request.session_id ?? ''), translateDemoText(String(request.text ?? '')));
      return null;
    }
    case 'cancel_stream':
      return null;
    case 'call_llm_for_boundary':
      return sleep(700).then(() => ({
        assistant_message: explainDemoText(String(args.prompt ?? '')),
        input_tokens: 0,
        output_tokens: 0,
      }));
    default:
      return undefined;
  }
}
