import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowsIn } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { exitImmersive, useImmersiveWindowId } from '../core/immersiveMode';
import './ImmersiveHint.css';

export const IMMERSIVE_HINT_VISIBLE_MS = 4200;
const TOP_REVEAL_ZONE_PX = 6;

function isCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

const ImmersiveHintComponent: React.FC = () => {
  const { t } = useTranslation('workbench');
  const immersiveWindowId = useImmersiveWindowId();
  const [visible, setVisible] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const reveal = useCallback(() => {
    setVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, IMMERSIVE_HINT_VISIBLE_MS);
  }, []);

  useEffect(() => {
    if (!immersiveWindowId) {
      setVisible(false);
      return undefined;
    }
    setCoarse(isCoarsePointer());
    reveal();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
  }, [immersiveWindowId, reveal]);

  useEffect(() => {
    if (!immersiveWindowId) return undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (event.clientY <= TOP_REVEAL_ZONE_PX && !visible) reveal();
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [immersiveWindowId, reveal, visible]);

  if (!immersiveWindowId) return null;

  return (
    <div
      className="wb-immersive-hint"
      data-testid="wb-immersive-hint"
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="wb-immersive-hint-text">
        {coarse ? t('immersive.hintTouch') : t('immersive.hint')}
      </span>
      <button
        type="button"
        className="wb-immersive-hint-exit"
        data-testid="wb-immersive-hint-exit"
        onClick={exitImmersive}
      >
        <ArrowsIn size={13} weight="bold" aria-hidden="true" />
        {t('immersive.exit')}
      </button>
    </div>
  );
};

export const ImmersiveHint = React.memo(ImmersiveHintComponent);
ImmersiveHint.displayName = 'ImmersiveHint';

export default ImmersiveHint;
