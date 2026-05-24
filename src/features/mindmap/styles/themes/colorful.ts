import type { IStyleTheme } from '../../registry/types';

export const colorfulTheme: IStyleTheme = {
  id: 'colorful',
  name: 'themes.colorful',
  node: {
    root: {
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      foreground: '#FFFFFF',
      border: 'transparent',
      borderRadius: 8,
      fontSize: 18,
      fontWeight: '600',
      padding: '12px 24px',
      shadow: '0 4px 15px rgba(102, 126, 234, 0.4)',
    },
    branch: {
      background: '#F8F9FA',
      foreground: '#2D3748',
      border: '1px solid #E2E8F0',
      borderRadius: 6,
      fontSize: 14,
      padding: '8px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: '#4A5568',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 13,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#CBD5E0',
    strokeWidth: 2,
  },
  palette: [
    '#F56565', // Red
    '#ED8936', // Orange
    '#ECC94B', // Yellow
    '#48BB78', // Green
    '#4299E1', // Blue
    '#9F7AEA', // Purple
    '#ED64A6', // Pink
  ],
  canvas: {
    background: '#FFFFFF',
  },
};
