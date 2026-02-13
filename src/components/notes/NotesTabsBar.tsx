import React from "react";
import { Tabs, TabsList, TabsTrigger } from "../ui/shad/Tabs";
import { cn } from "../../lib/utils";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./NotesTabsBar.css";

type NotesTabItem = {
  id: string;
  title: string;
};

type NotesTabsBarProps = {
  tabs: NotesTabItem[];
  activeId?: string | null;
  onActivate?: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onReorder?: (newTabs: NotesTabItem[]) => void;
};

type SortableTabProps = {
  tab: NotesTabItem;
  active?: boolean;
  onClose?: (tabId: string) => void;
};

const SortableTab: React.FC<SortableTabProps> = ({ tab, active, onClose }) => {
  const { t } = useTranslation(['notes']);
  const {
    setNodeRef,
    listeners,
    attributes,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex-shrink-0 select-none h-full",
        isDragging ? "z-20" : "z-10",
      )}
      {...listeners}
      {...attributes}
    >
      <TabsTrigger
        value={tab.id}
        className={cn(
          "group relative flex h-full min-w-[132px] max-w-[260px] items-center gap-2 rounded-none border-x border-t-0 border-b-0 border-transparent px-3 pr-8 text-sm font-medium transition-all duration-150",
          "cursor-grab active:cursor-grabbing",
          "data-[state=inactive]:bg-transparent data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-[hsl(var(--titlebar-background)/0.5)] data-[state=inactive]:hover:text-foreground/80",
          "data-[state=active]:bg-[hsl(var(--titlebar-background)/0.9)] data-[state=active]:text-foreground data-[state=active]:border-x-border/40 data-[state=active]:font-semibold",
          isDragging && "shadow-lg bg-[hsl(var(--titlebar-background)/0.6)]",
        )}
      >
        <span className="truncate" title={tab.title}>
          {tab.title}
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-label={t('notes:tabs.close')}
          className={cn(
            "absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/70 transition-all duration-150",
            "hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            active
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.(tab.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClose?.(tab.id);
            }
          }}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      </TabsTrigger>
    </div>
  );
};

const NotesTabsBar: React.FC<NotesTabsBarProps> = ({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReorder,
}) => {
  const { t } = useTranslation(['notes']);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = tabs.findIndex((tab) => tab.id === active.id);
      const toIndex = tabs.findIndex((tab) => tab.id === over.id);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

      // Create new array with reordered items
      const newTabs = [...tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);

      onReorder?.(newTabs);
    },
    [tabs, onReorder],
  );

  const currentValue = activeId ?? tabs[0]?.id ?? "";
  const items = React.useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);
  const [containerWidth, setContainerWidth] = React.useState<number | null>(null);

  const scrollByDirection = React.useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;

    const step = 180;
    const maxScroll = el.scrollWidth - el.clientWidth;

    if (direction === 'left') {
      const scrollAmount = Math.min(el.scrollLeft, step);
      el.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
    } else {
      const remainingScroll = maxScroll - el.scrollLeft;
      const scrollAmount = Math.min(remainingScroll, step);
      el.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  }, []);

  const updateArrows = React.useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const scrollLeft = container.scrollLeft;
    const maxScrollLeft = container.scrollWidth - container.clientWidth;

    setCanLeft(scrollLeft > 0.5);
    setCanRight(scrollLeft < maxScrollLeft - 0.5);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // 使用 requestAnimationFrame 确保 DOM 渲染完成后再计算
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateArrows();
      });
    });

    const onScroll = () => updateArrows();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll as any);
      ro.disconnect();
    };
  }, [updateArrows]);

  React.useEffect(() => {
    // tabs 变化后重新计算，延迟更长确保渲染完成
    const t = setTimeout(updateArrows, 100);
    return () => clearTimeout(t);
  }, [tabs, updateArrows]);

  // 计算并设置容器的实际可用宽度
  React.useEffect(() => {
    const updateContainerWidth = () => {
      const container = containerRef.current;
      if (!container) return;
      // Fix: Use parent width to respect layout (e.g. right panels), 
      // instead of window.innerWidth calculation which assumes full screen width.
      if (container.parentElement) {
          setContainerWidth(container.parentElement.clientWidth);
      }
    };

    updateContainerWidth();
    window.addEventListener('resize', updateContainerWidth, { passive: true });
    let ro: ResizeObserver | null = null;
    const target = containerRef.current?.parentElement ?? containerRef.current;
    if (target && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        updateContainerWidth();
        updateArrows();
      });
      ro.observe(target);
    }

    return () => {
      window.removeEventListener('resize', updateContainerWidth);
      ro?.disconnect();
    };
  }, [updateArrows]);

  // 监听窗口尺寸变化
  React.useEffect(() => {
    const handleResize = () => updateArrows();
    window.addEventListener('resize', handleResize, { passive: true });

    // 字体加载完成后再计算一次
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        updateArrows();
      }).catch((err) => { console.warn('[NotesTabsBar] fonts.ready failed:', err); });
    }

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateArrows]);

  return (
    <Tabs
      value={currentValue}
      onValueChange={(value) => {
        if (!value) return;
        onActivate?.(value);
      }}
      className="w-full h-full"
    >
      <div
        ref={containerRef}
        className="relative h-full"
        style={{
          width: containerWidth !== null ? `${containerWidth}px` : '100%',
          overflow: 'visible'
        }}
      >
        {canLeft && (
          <button
            type="button"
            aria-label="scroll-left"
            className="notes-tabs-scroll-btn left-0"
            onClick={() => scrollByDirection('left')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {canRight && (
          <button
            type="button"
            aria-label="scroll-right"
            className="notes-tabs-scroll-btn right-0"
            onClick={() => scrollByDirection('right')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={items} strategy={horizontalListSortingStrategy}>
            <TabsList
              ref={scrollRef as any}
              className="notes-tabs-scroll flex h-full w-full items-stretch gap-0 overflow-x-auto overflow-y-hidden rounded-none border-none bg-transparent px-7 !justify-start"
            >
              {tabs.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  {t('notes:common.untitledNote')}
                </div>
              ) : (
                tabs.map((tab) => (
                  <SortableTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === currentValue}
                    onClose={onClose}
                  />
                ))
              )}
            </TabsList>
          </SortableContext>
        </DndContext>
      </div>
    </Tabs>
  );
};

export default NotesTabsBar;
export type { NotesTabItem };
