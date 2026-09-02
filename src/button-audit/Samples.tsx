import React from 'react';
import { ArrowUp, CaretLeft, Copy, Gear, Plus, Square, Trash, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
// eslint-disable-next-line no-restricted-imports -- audit page compares leftover shad Button
import { Button as ShadButton } from '@/components/ui/shad/Button';
import { cn } from '@/lib/utils';
import type { SampleSpec } from './catalog';

function Replica({ replica }: { replica: string }) {
  switch (replica) {
    case 'shell-toolbar':
      return <button type="button" className="ba-shell-toolbar" aria-label="toolbar"><Gear size={14} /></button>;
    case 'shell-accessory':
      return <button type="button" className="ba-shell-accessory" aria-label="accessory"><Gear size={14} /></button>;
    case 'shell-circle':
      return <button type="button" className="ba-shell-circle" aria-label="circle"><Gear size={14} /></button>;
    case 'nav-history':
      return <button type="button" className="ba-nav-history" aria-label="back"><CaretLeft size={14} /></button>;
    case 'chip-attachment':
      return <button type="button" className="ba-chip">PDF 讲义.pdf</button>;
    case 'chip-feature':
      return <button type="button" className="ba-chip-feature">知识库</button>;
    case 'pdf-ds-btn':
      return <button type="button" className="ba-pdf-btn" aria-label="pdf"><Gear size={14} /></button>;
    case 'pdf-ds-btn-sm':
      return <button type="button" className="ba-pdf-btn-sm" aria-label="pdf sm"><Gear size={12} /></button>;
    case 'pdf-ds-btn-active':
      return <button type="button" className="ba-pdf-btn-active" aria-label="pdf active"><Gear size={14} /></button>;
    case 'pdf-select':
      return <button type="button" className="ba-pdf-select">100%</button>;
    case 'mm-ds-btn':
      return <button type="button" className="ba-mm-ds"><Gear size={14} /> 结构</button>;
    case 'mm-toolbar':
      return <button type="button" className="ba-mm-toolbar" aria-label="mm"><Gear size={14} /></button>;
    case 'mm-toolbar-active':
      return <button type="button" className="ba-mm-toolbar-active" aria-label="mm active"><Gear size={14} /></button>;
    case 'mm-learning':
      return <button type="button" className="ba-mm-learning">背诵</button>;
    case 'mm-view':
      return <button type="button" className="ba-mm-view">大纲</button>;
    case 'mm-action-add':
      return <button type="button" className="ba-mm-action" aria-label="add">+</button>;
    case 'mm-action-del':
      return <button type="button" className="ba-mm-action-del" aria-label="del">×</button>;
    case 'mm-flow':
      return <button type="button" className="ba-mm-flow" aria-label="zoom">+</button>;
    case 'settings-tab':
      return <button type="button" className="ba-settings-tab">常规</button>;
    case 'ft-copy':
      return <button type="button" className="ba-ft-copy"><Copy size={12} /> 复制</button>;
    case 'dock-item':
      return <button type="button" className="ba-dock" aria-label="dock"><Gear size={18} /></button>;
    case 'dock-list':
      return <button type="button" className="ba-dock-list">Chat</button>;
    case 'crepe-toolbar':
      return <button type="button" className="ba-crepe" aria-label="bold">B</button>;
    case 'crepe-toolbar-active':
      return <button type="button" className="ba-crepe-active" aria-label="bold active">B</button>;
    case 'crepe-block':
      return <button type="button" className="ba-crepe-block">标题 1</button>;
    case 'crepe-lightbox':
      return <button type="button" className="ba-crepe-lightbox" aria-label="close"><X size={14} /></button>;
    case 'overlay-float':
      return <button type="button" className="ba-overlay-float" aria-label="close"><X size={16} /></button>;
    case 'overlay-ghost':
      return <button type="button" className="ba-overlay-ghost" aria-label="zoom"><Plus size={16} /></button>;
    case 'overlay-dark':
      return <button type="button" className="ba-overlay-dark" aria-label="remove"><X size={10} /></button>;
    case 'tree-row':
      return <button type="button" className="ba-tree">机器学习.md</button>;
    case 'tree-row-selected':
      return <button type="button" className="ba-tree-selected">机器学习.md</button>;
    case 'epub-toc':
      return <button type="button" className="ba-epub">第三章 优化</button>;
    case 'cp-mode':
      return <button type="button" className="ba-cp" aria-label="mode"><Gear size={14} /></button>;
    case 'cp-mode-active':
      return <button type="button" className="ba-cp-active" aria-label="mode on"><Gear size={14} /></button>;
    case 'cp-close':
      return <button type="button" className="ba-cp-close" aria-label="close"><X size={14} /></button>;
    case 'viewer':
      return <button type="button" className="ba-viewer" aria-label="viewer"><Gear size={14} /></button>;
    case 'viewer-primary':
      return <button type="button" className={cn('ba-viewer', 'ba-viewer-primary')} aria-label="primary"><Gear size={14} /></button>;
    case 'viewer-danger':
      return <button type="button" className={cn('ba-viewer', 'ba-viewer-danger')} aria-label="danger"><Trash size={14} /></button>;
    case 'win-close':
      return <button type="button" className="ba-win" aria-label="close"><X size={12} /></button>;
    case 'win-close-hover':
      return <button type="button" className="ba-win-hover" aria-label="close hover"><X size={12} /></button>;
    case 'swatch':
      return <button type="button" className="ba-swatch" aria-label="swatch" />;
    case 'swatch-selected':
      return <button type="button" className="ba-swatch-selected" aria-label="swatch on" />;
    case 'ghost-danger':
      return <button type="button" className="ba-ghost-danger" aria-label="delete"><Trash size={14} /></button>;
    case 'ghost-danger-hover':
      return <button type="button" className="ba-ghost-danger-hover" aria-label="delete hover"><Trash size={14} /></button>;
    case 'tour-ghost':
      return <button type="button" className={cn('ba-tour', 'ba-tour-ghost')}>跳过</button>;
    case 'tour-primary':
      return <button type="button" className={cn('ba-tour', 'ba-tour-primary')}>开始</button>;
    case 'hud':
      return <button type="button" className="ba-hud">FPS</button>;
    case 'agenda-add':
      return <button type="button" className="ba-agenda">添加</button>;
    case 'browser-icon':
      return <button type="button" className="ba-browser" aria-label="reload"><Gear size={14} /></button>;
    case 'tm-toggle':
      return <button type="button" className="ba-tm-toggle">卡片</button>;
    case 'qa-icon':
      return <button type="button" className="ba-qa-icon" aria-label="qa"><Gear size={12} /></button>;
    case 'qa-primary':
      return <button type="button" className="ba-qa-primary">保存</button>;
    case 'qa-rating':
      return <button type="button" className="ba-qa-rating">Good</button>;
    case 'sb-ghost':
      return <button type="button" className="ba-sb-ghost">收起</button>;
    case 'sb-icon':
      return <button type="button" className="ba-sb-icon" aria-label="sb"><Copy size={14} /></button>;
    case 'batch-action':
      return <button type="button" className="ba-batch">批量编辑</button>;
    case 'batch-danger':
      return <button type="button" className="ba-batch-danger">删除所选</button>;
    case 'tpl-btn':
      return <button type="button" className="ba-tpl">插入字段</button>;
    case 'settings-secondary':
      return <button type="button" className="ba-settings-secondary">恢复默认</button>;
    case 'card3d':
      return <button type="button" className="ba-card3d" aria-label="flip"><Gear size={16} /></button>;
    case 'card3d-active':
      return <button type="button" className="ba-card3d-active" aria-label="flip on"><Gear size={16} /></button>;
    case 'notes-icon':
      return <button type="button" className="ba-notes-icon" aria-label="notes"><Plus size={14} /></button>;
    case 'notes-scroll':
      return <button type="button" className="ba-notes-scroll" aria-label="scroll"><CaretLeft size={12} /></button>;
    case 'notes-mobile':
      return <button type="button" className="ba-notes-mobile" aria-label="mobile"><Gear size={16} /></button>;
    case 'notes-trash':
      return <button type="button" className="ba-notes-trash" aria-label="trash"><Trash size={14} /></button>;
    case 'fab':
      return <button type="button" className="ba-fab" aria-label="debug"><Gear size={18} /></button>;
    case 'dbg-inspect':
      return <button type="button" className="ba-dbg-inspect">Inspect</button>;
    case 'hero-primary':
      return <button type="button" className="ba-hero-primary">下载桌面版</button>;
    case 'hero-ghost':
      return <button type="button" className="ba-hero-ghost">GitHub</button>;
    default:
      return <span className="ba-label">未知样例 {replica}</span>;
  }
}

export function Sample({ spec }: { spec: SampleSpec }) {
  if (spec.kind === 'ds') {
    const label = spec.iconOnly || spec.size === 'icon' ? undefined : '按钮';
    return (
      <DsButton
        variant={spec.variant}
        size={spec.size}
        iconOnly={spec.iconOnly || spec.size === 'icon'}
        disabled={spec.disabled}
        aria-label={spec.iconOnly || spec.size === 'icon' ? '图标按钮' : undefined}
        className={spec.fullWidth ? 'w-full' : spec.variant === 'nav' ? 'w-full max-w-xs' : undefined}
      >
        {spec.iconOnly || spec.size === 'icon' ? <Gear size={16} /> : spec.variant === 'nav' ? <><Gear size={16} /> 会话标题</> : label}
      </DsButton>
    );
  }

  if (spec.kind === 'shad') {
    return (
      <ShadButton variant={spec.variant} size={spec.size}>
        {spec.size === 'icon' ? <Gear size={16} /> : '链接按钮'}
      </ShadButton>
    );
  }

  if (spec.kind === 'replica') {
    const dark = spec.replica === 'overlay-ghost' || spec.replica === 'overlay-dark' || spec.replica === 'crepe-lightbox' || spec.replica === 'hud';
    return (
      <div className={dark ? 'ba-sample-dark' : undefined}>
        <Replica replica={spec.replica} />
      </div>
    );
  }

  switch (spec.widget) {
    case 'segmented':
      return (
        <SegmentedControl
          ariaLabel="分段示例"
          value="a"
          onValueChange={() => {}}
          options={[
            { value: 'a', label: '外观' },
            { value: 'b', label: '系统' },
            { value: 'c', label: '深色' },
          ]}
          size="compact"
        />
      );
    case 'tabs-default':
      return (
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">常规</TabsTrigger>
            <TabsTrigger value="two">外观</TabsTrigger>
          </TabsList>
        </Tabs>
      );
    case 'tabs-bare':
      return (
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one" variant="bare">常规</TabsTrigger>
            <TabsTrigger value="two" variant="bare">外观</TabsTrigger>
          </TabsList>
        </Tabs>
      );
    case 'send-empty':
      return (
        <button type="button" className="ba-send ba-send-empty" aria-label="send empty">
          <ArrowUp size={16} weight="bold" />
        </button>
      );
    case 'send-ready':
      return (
        <button type="button" className="ba-send ba-send-ready" aria-label="send">
          <ArrowUp size={16} weight="bold" />
        </button>
      );
    case 'stop':
      return (
        <button type="button" className="ba-send ba-send-stop" aria-label="stop">
          <Square size={12} weight="fill" />
        </button>
      );
    case 'rating-bar':
      return (
        <div className="ba-rate">
          <button type="button" className="ba-rate-again">Again</button>
          <button type="button" className="ba-rate-hard">Hard</button>
          <button type="button" className="ba-rate-good">Good</button>
          <button type="button" className="ba-rate-easy">Easy</button>
        </div>
      );
    case 'nav-row':
      return (
        <DsButton variant="nav" className="w-full max-w-xs">
          未命名会话
        </DsButton>
      );
    case 'chip-close':
      return (
        <button type="button" className="ba-chip-x" aria-label="remove">
          <X size={10} />
        </button>
      );
    default:
      return null;
  }
}
