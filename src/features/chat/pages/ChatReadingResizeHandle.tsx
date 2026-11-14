import React, { useRef } from 'react';

const MIN_CHAT_WIDTH = 320;
const MIN_DOCUMENT_WIDTH = 440;
const DIVIDER_WIDTH = 8;
const KEYBOARD_STEP = 24;
export const MIN_READING_LAYOUT_WIDTH = 800;

function maxChatWidth(totalWidth: number) {
  return Math.max(MIN_CHAT_WIDTH, Math.min(totalWidth * 0.48, totalWidth - MIN_DOCUMENT_WIDTH - DIVIDER_WIDTH));
}

export function getChatReadingWidth(totalWidth: number, preferredWidth?: number) {
  const defaultWidth = Math.min(480, totalWidth * 0.32);
  return Math.round(Math.min(maxChatWidth(totalWidth), Math.max(MIN_CHAT_WIDTH, preferredWidth ?? defaultWidth)));
}

interface Props {
  label: string;
  totalWidth: number;
  chatWidth: number;
  onResize: (width: number) => void;
}

export function ChatReadingResizeHandle({ label, totalWidth, chatWidth, onResize }: Props) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const resize = (width: number) => onResize(getChatReadingWidth(totalWidth, width));

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={MIN_CHAT_WIDTH}
      aria-valuemax={Math.round(maxChatWidth(totalWidth))}
      aria-valuenow={chatWidth}
      tabIndex={0}
      className="group relative z-10 order-2 w-2 shrink-0 touch-none cursor-col-resize bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: chatWidth };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        let next: number;
        if (event.key === 'ArrowLeft') next = chatWidth + KEYBOARD_STEP;
        else if (event.key === 'ArrowRight') next = chatWidth - KEYBOARD_STEP;
        else if (event.key === 'Home') next = maxChatWidth(totalWidth);
        else if (event.key === 'End') next = MIN_CHAT_WIDTH;
        else return;
        event.preventDefault();
        resize(next);
      }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border group-hover:bg-primary/50 group-focus-visible:bg-primary/50" />
    </div>
  );
}
