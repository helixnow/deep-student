import type { IStyleTheme } from '../../registry/types';

export const minimalTheme: IStyleTheme = {
  id: 'minimal',
  name: 'themes.minimal',
  node: {
    root: {
      background: '#000000',
      foreground: '#FFFFFF',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: '#FFFFFF',
      foreground: '#37352F',
      border: '1px solid #E0E0E0',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: '#37352F',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#E0E0E0',
    strokeWidth: 1,
  },
  canvas: {
    background: '#FFFFFF',
  },
};
