import type { IStyleTheme } from '../../registry/types';

export const darkTheme: IStyleTheme = {
  id: 'dark',
  name: 'themes.dark',
  node: {
    root: {
      background: 'hsl(var(--primary))',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 16,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: 'hsl(var(--secondary))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: 'hsl(var(--foreground) / 0.09)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'hsl(var(--foreground) / 0.15)',
    strokeWidth: 1.5,
  },
  palette: [
    '#FF6B6B', // Red
    '#FF9F43', // Orange
    '#F1C40F', // Yellow
    '#2ECC71', // Green
    '#54A0FF', // Blue
    '#5F27CD', // Purple
    '#FF9FF3', // Pink
  ],
  canvas: {
    background: 'var(--mm-bg)',
  },
};
