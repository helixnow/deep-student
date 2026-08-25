/**
 * 数值题编辑器：答案值 + 容差 + 单位 + 容差模式
 *
 * 2026-07 题库题型扩展
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { AppSelect } from '@/components/ui/app-menu';
import { WarningCircle } from '@phosphor-icons/react';
import type { NumericToleranceMode } from './structured';

export interface NumericEditorValue {
  /** 文本态存储，保存时再转数字（避免输入过程中丢失小数点等中间态） */
  answerValue: string;
  tolerance: string;
  unit: string;
  toleranceMode: NumericToleranceMode;
}

export interface NumericEditorProps {
  value: NumericEditorValue;
  onChange: (value: NumericEditorValue) => void;
  /** 保存时校验未通过则由宿主传入以标红 */
  showValidation?: boolean;
  className?: string;
}

export const NumericEditor: React.FC<NumericEditorProps> = ({
  value,
  onChange,
  showValidation = false,
  className,
}) => {
  const { t } = useTranslation('practice');

  const valueInvalid = !Number.isFinite(Number(value.answerValue.trim())) || value.answerValue.trim() === '';
  const toleranceInvalid = value.tolerance.trim() !== ''
    && (!Number.isFinite(Number(value.tolerance.trim())) || Number(value.tolerance.trim()) < 0);

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">
            {t('editor.structEdit.numericValue')}
            <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
          </Label>
          <Input
            value={value.answerValue}
            onChange={(e) => onChange({ ...value, answerValue: e.target.value })}
            inputMode="decimal"
            autoComplete="off"
            placeholder="3.14"
            aria-invalid={showValidation && valueInvalid}
            className={cn(
              'h-8 text-sm tabular-nums [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]',
              showValidation && valueInvalid && 'border-destructive/60 focus-visible:ring-destructive/30'
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('editor.structEdit.numericUnit')}</Label>
          <Input
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: e.target.value })}
            autoComplete="off"
            placeholder={t('editor.structEdit.numericUnitPlaceholder')}
            className="h-8 text-sm [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('editor.structEdit.numericTolerance')}</Label>
          <Input
            value={value.tolerance}
            onChange={(e) => onChange({ ...value, tolerance: e.target.value })}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.01"
            aria-invalid={toleranceInvalid}
            className={cn(
              'h-8 text-sm tabular-nums [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:text-[16px]',
              toleranceInvalid && 'border-destructive/60 focus-visible:ring-destructive/30'
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('editor.structEdit.numericToleranceMode')}</Label>
          <AppSelect
            value={value.toleranceMode}
            onValueChange={(v) => onChange({ ...value, toleranceMode: v as NumericToleranceMode })}
            options={[
              { value: 'absolute', label: t('editor.structEdit.toleranceAbsolute') },
              { value: 'relative', label: t('editor.structEdit.toleranceRelative') },
            ]}
            variant="outline"
          />
        </div>
      </div>
      {(toleranceInvalid || (showValidation && valueInvalid)) && (
        <p className="ui-fade-in flex items-center gap-1 text-xs text-destructive">
          <WarningCircle size={12} className="flex-shrink-0" />
          {showValidation && valueInvalid
            ? t('editor.structEdit.numericValueRequired')
            : t('editor.structEdit.numericToleranceInvalid')}
        </p>
      )}
    </div>
  );
};

export default NumericEditor;
