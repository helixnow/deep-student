import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArrowLineLeft,
  ArrowLineRight,
  CaretLineLeft,
  CaretLineRight,
  ColumnsPlusLeft,
  ColumnsPlusRight,
  Rows,
  Sidebar,
  SidebarSimple,
  TextColumns,
} from '@phosphor-icons/react';

const candidates = [
  ['CaretLine', CaretLineLeft, CaretLineRight],
  ['ArrowLine', ArrowLineLeft, ArrowLineRight],
  ['SidebarSimple', SidebarSimple, SidebarSimple],
  ['Sidebar', Sidebar, Sidebar],
  ['Rows', Rows, Rows],
  ['TextColumns', TextColumns, TextColumns],
  ['ColumnsPlus', ColumnsPlusLeft, ColumnsPlusRight],
];

function Card({ label, Left, Right }) {
  return React.createElement('div', {
    style: {
      background: '#0b0d12',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '16px',
      padding: '20px',
      color: '#f5f7fb',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    }
  }, [
    React.createElement('div', { key: 'label', style: { fontSize: '14px', opacity: 0.8 } }, label),
    React.createElement('div', { key: 'icons', style: { display: 'flex', gap: '20px', alignItems: 'center' } }, [
      React.createElement('div', { key: 'left', style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' } }, [
        React.createElement(Left, { key: 'icon', size: 28, weight: 'regular' }),
        React.createElement('span', { key: 'text', style: { fontSize: '12px', opacity: 0.65 } }, 'collapse')
      ]),
      React.createElement('div', { key: 'right', style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' } }, [
        React.createElement(Right, { key: 'icon', size: 28, weight: 'regular' }),
        React.createElement('span', { key: 'text', style: { fontSize: '12px', opacity: 0.65 } }, 'expand')
      ])
    ])
  ]);
}

const html = renderToStaticMarkup(
  React.createElement('html', null,
    React.createElement('body', {
      style: {
        margin: 0,
        background: '#030507',
        padding: '24px',
      }
    },
      React.createElement('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '16px',
        }
      }, candidates.map(([label, Left, Right]) => React.createElement(Card, { key: label, label, Left, Right })))
    )
  )
);

console.log('<!doctype html>' + html);
