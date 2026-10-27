import React from 'react';
import { buildPaperSections } from '@/components/practice/paperDocument';
import { preparePaperBlocks, paperPdfBytes, buildPaperFile } from '@/components/practice/paperExport';
import type { GeneratedPaper } from '@/stores/questionBankStore';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';

export function PaperExportHarness() {
  const [status, setStatus] = React.useState('ready');
  return <div><button onClick={async () => {
    setStatus('running');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 480; canvas.height = 160;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, 480, 160);
      context.strokeStyle = '#15803d'; context.lineWidth = 3;
      context.strokeRect(40, 30, 360, 90);
      context.fillStyle = '#111'; context.font = '22px sans-serif';
      context.fillText('F = ma', 180, 85);
      const image = canvas.toDataURL('image/png');
      setCtInvokeHandlers({ vfs_get_attachment_content: () => ({ found: true, content: image.split(',')[1] }) });
      const paper = {
        title: '数学综合练习', id: 'paper1', exam_id: 'exam1', questions: [
          { id: 'q1', question_type: 'single_choice', content: '已知函数 $f(x)=x^2+2x$，求 $f(2)$。\n\n| 自变量 | 函数值 |\n|---|---|\n| 0 | 0 |\n| 1 | 3 |', options: [{ key: 'A', content: '$4$' }, { key: 'B', content: '$8$' }], answer: 'B', explanation: '代入得 $f(2)=2^2+2\\times 2=8$。', materials: [{ id: 'm1', content: '阅读下列条件，完成第 1 至 2 题。\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$', images: [] }], images: [] },
          { id: 'q2', question_type: 'proof', content: '证明柯西不等式，并说明等号成立的条件。\n\n$$\\left(\\sum_{i=1}^{n} a_i b_i\\right)^2\\le\\left(\\sum_{i=1}^{n}a_i^2\\right)\\left(\\sum_{i=1}^{n}b_i^2\\right)$$\n\n![示意图](attachment://figure1)', answer: '两组数成比例时等号成立。', explanation: '考虑二次函数的判别式。', materials: [{ id: 'm1', content: '阅读下列条件，完成第 1 至 2 题。', images: [] }], images: [] },
        ], config: {},
      } as unknown as GeneratedPaper;
      const sections = buildPaperSections(paper, { includeAnswers: true, includeExplanations: true }, { material: '共享材料', appendix: '参考答案与解析', answer: '答案', explanation: '解析', questions: '题号' });
      const blocks = await preparePaperBlocks(sections);
      const bytes = await paperPdfBytes(blocks, paper.title);
      const markdown = new TextDecoder().decode(await buildPaperFile(paper, { format: 'markdown', includeAnswers: true, includeExplanations: true }));
      (window as unknown as Record<string, unknown>).__PAPER_EXPORT_QA__ = { blocks, pdf: Array.from(bytes), markdown };
      setStatus('done');
    } catch (error) { setStatus(String(error)); }
  }}>{status}</button></div>;
}
