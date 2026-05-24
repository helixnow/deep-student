import { useReducedMotion, type Transition } from 'framer-motion';

type DisclosureMotionProps = {
  initial: { height: number; opacity: number } | false;
  animate: { height: 'auto' | number; opacity: number };
  exit: { height: number; opacity: number };
  transition: Transition;
};

const ENABLED: DisclosureMotionProps = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.2, ease: 'easeInOut' },
};

const REDUCED: DisclosureMotionProps = {
  initial: false,
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0 },
};

export function useDisclosureMotion(): DisclosureMotionProps {
  const prefersReduced = useReducedMotion();
  return prefersReduced ? REDUCED : ENABLED;
}
