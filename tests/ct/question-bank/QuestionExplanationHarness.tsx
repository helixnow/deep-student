import React from 'react';
import { QuestionExplanation } from '@/components/practice/QuestionExplanation';
import { ExamShell } from './ExamShell';

export function QuestionExplanationHarness() {
  return <ExamShell><div className="h-full overflow-y-auto p-4">
    <p className="mb-4">说明牛顿第二定律。</p>
    <QuestionExplanation questionId="explanation-ct" explanation={'由牛顿第二定律 $F = ma$，合外力等于质量与加速度的乘积。\n\n方向与加速度一致。'} />
  </div></ExamShell>;
}
