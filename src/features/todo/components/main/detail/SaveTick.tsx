/**
 * SaveTick — 字段保存成功的细腻对勾闪现
 *
 * 父组件每次保存后递增 pulse；对勾以 springSnap 弹入、短暂停留后淡出。
 * pulse 连续递增时重播（key 变化重挂载）。reduced-motion 退化为瞬时显隐。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check } from '@phosphor-icons/react';
import { springSnap, transitionInstant } from '@/styles/motion-springs';

const VISIBLE_MS = 1400;

export const SaveTick: React.FC<{ pulse: number }> = ({ pulse }) => {
  const { t } = useTranslation(['todo']);
  const prefersReducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pulse === 0) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  return (
    // mode="wait"：快速连续保存时 key 变化触发重播，旧对勾先退场再进场，
    // 避免新旧两个「已保存」并排闪现挤压顶栏布局
    <AnimatePresence mode="wait">
      {visible && (
        <motion.span
          key={pulse}
          initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.5, y: 2 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={
            prefersReducedMotion
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.85, transition: { duration: 0.2 } }
          }
          transition={prefersReducedMotion ? transitionInstant : springSnap}
          className="inline-flex items-center gap-1 text-xs text-[color:hsl(var(--success))]"
          role="status"
          aria-label={t('todo:detail.saved')}
        >
          <Check size={12} weight="bold" />
          {t('todo:detail.saved')}
        </motion.span>
      )}
    </AnimatePresence>
  );
};

export default SaveTick;
