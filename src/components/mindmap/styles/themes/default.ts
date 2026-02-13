import type { IStyleTheme } from '../../registry/types';

export const defaultTheme: IStyleTheme = {
  id: 'default',
  name: 'themes.default',
  node: {
    root: {
      background: '#ffffff',
      foreground: '#37352F',
      border: '2px solid #37352F',
      borderRadius: 6,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#ffffff',
      foreground: '#37352F',
      border: '1px solid rgba(55, 53, 47, 0.16)',
      borderRadius: 4,
      fontSize: 15,
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
    stroke: 'rgba(55, 53, 47, 0.16)',
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
    background: '#ffffff',
  },
};
