import React from 'react';
import { createRoot } from 'react-dom/client';
import '../i18n';
import '../styles/tailwind.css';
import '../styles/shadcn-variables.css';
import '../styles/theme-colors.css';
import '../shared/styles/index.css';
import '../styles/responsive-utilities.css';
import './audit.css';
import { OverlayCoordinatorProvider } from '@/components/shared/OverlayCoordinator';
import { ButtonAuditPage } from './ButtonAuditPage';

const params = new URLSearchParams(window.location.search);
const dark = params.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
document.documentElement.lang = 'zh-CN';
document.title = params.get('tab') === 'controls' ? '控件样式裁定' : '按钮样式裁定';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayCoordinatorProvider>
      <ButtonAuditPage />
    </OverlayCoordinatorProvider>
  </React.StrictMode>,
);
