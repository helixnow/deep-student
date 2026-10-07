/**
 * 剧本作文②：雅思大作文（Task 2），9 分制，6.5 分。
 */
import type { Annotation } from './build';

export const IELTS_TOPIC = `Some people believe that universities should require every student to take courses outside their main field of study. Others think students should focus only on their chosen subject.

Discuss both views and give your own opinion. Write at least 250 words.`;

export const IELTS_ESSAY = `It is often argued that university students should concentrate on their own major, while others believe that every student need to take courses from other disciplines. In my opinion, although specialisation is important, a broad education brings more benefits in the long run.

On the one hand, there are good reasons for focusing on a single subject. Modern professions such as medicine or engineering requires a huge amount of specialised knowledge, and time spent on unrelated courses may reduce the depth of students' expertise. Moreover, tuition fees are expensive, so many students prefer to spend their money on courses that directly improve their employability.

On the other hand, studying outside one's field can broaden students' horizons. For example, a computer science student who takes a course in psychology may design more user-friendly software, because he understand how people actually think and behave. In addition, many of today's most pressing problems, from climate change to public health, cannot be solved by experts of a single discipline. Students who have learned to communicate across subjects are therefore better prepared for the teamwork that these problems demand.

In conclusion, while a deep knowledge of one subject is essential, I believe universities should encourage students to explore other fields, as this makes them more creative and adaptable. The ideal graduate is not just an expert, but also a curious learner who can connect ideas from different areas.`;

export const IELTS_ANNOTATIONS: Annotation[] = [
  { kind: 'err', type: 'agreement', text: 'every student need to', explanation: '主语 every student 是第三人称单数，谓语应为 needs；every 修饰的名词一律按单数处理' },
  { kind: 'good', text: 'although specialisation is important, a broad education brings more benefits in the long run' },
  { kind: 'err', type: 'agreement', text: 'such as medicine or engineering requires', explanation: '主语是 Modern professions（复数），谓语应为 require；中间的 such as 短语不影响主谓一致' },
  { kind: 'replace', text: 'tuition fees are expensive', to: 'tuition fees are high', reason: 'fee 与 high / low 搭配，expensive 用于修饰商品或服务本身，属搭配不当' },
  { kind: 'err', type: 'agreement', text: 'he understand how', explanation: '主语 he 为第三人称单数，应为 understands；另外可改用 they 避免默认性别' },
  { kind: 'good', text: 'from climate change to public health' },
  { kind: 'note', text: 'Students who have learned to communicate across subjects are therefore better prepared for the teamwork that these problems demand.', comment: '论证推进自然。若再补一个具体例子（如跨学科团队研发疫苗），Task Response 可再上一档' },
  { kind: 'replace', text: 'experts of a single discipline', to: 'experts in a single discipline', reason: '表示「某领域的专家」用 expert in，介词搭配错误' },
  { kind: 'good', text: 'The ideal graduate is not just an expert, but also a curious learner who can connect ideas from different areas.' },
];

export const IELTS_SCORE = {
  total: 6.5,
  max: 9,
  dims: [
    { name: 'Task Response', score: 7, max: 9, comment: '两方观点都有讨论，立场清晰且贯穿全文；第二段的论据略显笼统，缺少具体例子。' },
    { name: 'Coherence & Cohesion', score: 7, max: 9, comment: '段落分工明确，On the one hand / On the other hand / In conclusion 衔接得当，但衔接词略模板化。' },
    { name: 'Lexical Resource', score: 6.5, max: 9, comment: '有 employability、pressing problems 等较地道的表达；fees are expensive、experts of 两处搭配错误。' },
    { name: 'Grammatical Range & Accuracy', score: 6, max: 9, comment: '复合句使用较多，但主谓一致错误出现 3 次（need / requires / understand），是本篇最主要的失分点。' },
  ],
};

export const IELTS_POLISH = [
  {
    original: 'Moreover, tuition fees are expensive, so many students prefer to spend their money on courses that directly improve their employability.',
    polished: 'Moreover, with tuition fees rising, many students understandably prefer to invest in courses that directly enhance their employability.',
  },
  {
    original: 'In conclusion, while a deep knowledge of one subject is essential, I believe universities should encourage students to explore other fields, as this makes them more creative and adaptable.',
    polished: 'In conclusion, while in-depth knowledge of one subject remains essential, universities should actively encourage students to venture beyond their discipline, since doing so fosters creativity and adaptability.',
  },
];

export const IELTS_MODEL_ESSAY = `Whether university students should be required to study subjects outside their major is a matter of ongoing debate. While a focused curriculum has clear advantages, I believe a degree of breadth is essential for today's graduates.

Supporters of specialisation argue that many careers demand deep expertise. A future surgeon or structural engineer must master an enormous body of technical knowledge, and every hour spent on unrelated courses is an hour taken away from that goal. Given the rising cost of higher education, it is also understandable that students want every module to contribute directly to their career prospects.

Nevertheless, the case for breadth is stronger. Real-world problems rarely respect disciplinary boundaries: developing a vaccine, for instance, requires not only biologists but also statisticians, engineers and communication specialists. Graduates who have encountered other fields are better able to collaborate in such teams. Moreover, exposure to different ways of thinking often sparks innovation, as when insights from psychology improve the design of software.

In conclusion, although specialist knowledge is indispensable, universities should require students to take at least some courses beyond their major, because breadth makes graduates more adaptable, more creative and better prepared for collaborative work.`;
