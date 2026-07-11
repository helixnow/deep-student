import type { IStyleTheme } from '../../registry/types';

export const defaultTheme: IStyleTheme = {
  id: 'default',
  name: 'themes.default',
  node: {
    root: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'var(--mm-text)',
      border: '1px solid var(--mm-border-strong)',
      borderRadius: 4,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'var(--mm-text)',
      border: '1px solid var(--mm-border)',
      borderRadius: 4,
      fontSize: 15,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'var(--mm-text)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'var(--mm-edge)',
    strokeWidth: 1.5,
  },
  palette: [
    '#E05252', // Red
    '#E69038', // Orange
    '#EBCB4B', // Yellow
    '#5BB98C', // Green
    '#2EAADC', // Blue (Primary)
    '#6C63FF', // Purple
    '#F2668B', // Pink
  ],
  canvas: {
    background: 'var(--mm-bg)',
  },
};
