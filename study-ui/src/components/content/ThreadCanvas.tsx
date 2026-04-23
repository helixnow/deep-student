import { type CSSProperties, useState } from "react";
import {
  ArrowUp,
  MagicWand,
  Paperclip,
  Sparkle,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const composerSecondaryControlClassName = "rounded-full border-transparent px-2.5 text-xs font-normal text-muted-foreground";

const threadContentShellStyle = {
  paddingTop: "var(--page-gutter-block)",
  paddingBottom: "var(--page-gutter-block)",
  paddingLeft: "calc(var(--page-gutter-inline) + var(--layout-safe-area-left))",
  paddingRight: "calc(var(--page-gutter-inline) + var(--layout-safe-area-right))",
} satisfies CSSProperties;

const threadContentColumnStyle = {
  maxWidth: "var(--workspace-max-width)",
} satisfies CSSProperties;

const threadComposerShellStyle = {
  paddingTop: "calc(var(--page-gutter-block) * 0.5)",
  paddingBottom: "var(--composer-bottom-offset)",
  paddingLeft: "calc(var(--page-gutter-inline) + var(--layout-safe-area-left))",
  paddingRight: "calc(var(--page-gutter-inline) + var(--layout-safe-area-right))",
} satisfies CSSProperties;

const threadComposerColumnStyle = {
  maxWidth: "var(--composer-max-width)",
} satisfies CSSProperties;

export function ThreadCanvas() {
  const [draftMessage, setDraftMessage] = useState("");
  const isComposerEmpty = draftMessage.trim().length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-slot="thread-content-shell"
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto"
        style={threadContentShellStyle}
      >
        <div
          data-slot="thread-content-column"
          className="mx-auto flex min-h-full w-full items-center"
          style={threadContentColumnStyle}
        >
          <section
            data-slot="thread-empty-state"
            className="flex w-full flex-col items-center justify-center gap-5 py-12 text-center md:py-16"
          >
            <div className="inline-flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Sparkle size={20} weight="fill" />
            </div>

            <div className="space-y-2">
              <h2 className="text-balance text-xl font-medium text-foreground">开始一个新任务</h2>
              <p className="text-base text-muted-foreground">当前工作区：`study-ui`</p>
              <p className="mx-auto max-w-[32rem] text-pretty text-sm leading-6 text-muted-foreground">
                把需求直接发到底部输入区。首屏保持安静，只保留当前工作区、主动作和足够的留白。
              </p>
            </div>

            <Button variant="outline" className="min-w-36">
              <MagicWand size={16} />
              查看建议起点
            </Button>
          </section>
        </div>
      </div>

      <div
        data-slot="thread-composer-shell"
        className="border-t border-[color:var(--composer-divider)] bg-[color:var(--shell-panel-strong)]"
        style={threadComposerShellStyle}
      >
        <div
          data-slot="thread-composer-column"
          className="mx-auto w-full"
          style={threadComposerColumnStyle}
        >
          <div
            data-slot="thread-composer"
            className="overflow-hidden rounded-3xl border border-composer-border bg-card shadow-lg shadow-black/5 transition-shadow duration-150 ease-out motion-reduce:transition-none focus-within:[box-shadow:var(--shadow-composer-focus)]"
          >
            <Textarea
              aria-label="线程输入"
              className="min-h-[var(--composer-min-height)] resize-none border-0 bg-transparent px-4 pb-1.5 pt-3 shadow-none focus-visible:bg-transparent focus-visible:ring-0 md:px-5"
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="请输入问题"
            />

            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1 md:px-4">
              <div
                data-slot="thread-composer-secondary-actions"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              >
                <Button variant="ghost" size="sm" className={composerSecondaryControlClassName}>
                  <Paperclip size={16} />
                  附件
                </Button>
                <Button variant="ghost" size="sm" className={composerSecondaryControlClassName}>
                  GPT-5.4
                </Button>
                <Button variant="ghost" size="sm" className={composerSecondaryControlClassName}>
                  高强度
                </Button>
              </div>

              <Button
                aria-label="发送消息"
                className={cn(
                  "h-11 w-11 shrink-0 rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]",
                  isComposerEmpty && "border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]",
                )}
                size="icon"
                variant="primary"
              >
                <ArrowUp size={16} weight="bold" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
