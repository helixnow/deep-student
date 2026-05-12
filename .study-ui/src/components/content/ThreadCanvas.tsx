import { type CSSProperties, useState } from "react";
import {
  ArrowUp,
  Paperclip,
  Plus,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
      <ScrollArea
        data-slot="thread-content-shell"
        className="min-h-0 flex-1"
        viewportProps={{ style: threadContentShellStyle }}
      >
        <div
          data-slot="thread-content-column"
          className="mx-auto flex min-h-full w-full items-center"
          style={threadContentColumnStyle}
        >
          <section
            data-slot="thread-empty-state"
            className="flex min-h-full w-full flex-col items-center justify-center px-2 pb-16 pt-10 text-center sm:pb-20 md:pt-16"
          >
            <div className="mx-auto flex max-w-[24rem] flex-col items-center gap-4">
              <p
                data-slot="thread-empty-workspace"
                className="rounded-full bg-secondary/80 px-3.5 py-1.5 text-xs font-medium text-muted-foreground"
              >
                当前工作区：<code className="font-medium text-foreground">study-ui</code>
              </p>
              <h2
                data-slot="thread-empty-primary-action"
                className="text-balance text-2xl font-semibold tracking-[-0.04em] text-foreground sm:text-xl sm:font-medium sm:tracking-normal"
              >
                在「分组名」里学点什么？
              </h2>
            </div>
          </section>
        </div>
      </ScrollArea>

      <div
        data-slot="thread-composer-shell"
        className="bg-transparent sm:border-t sm:border-[color:var(--composer-divider)] sm:bg-[color:var(--shell-panel-strong)]"
        style={threadComposerShellStyle}
      >
        <div
          data-slot="thread-composer-column"
          className="mx-auto w-full"
          style={threadComposerColumnStyle}
        >
          <div
            data-slot="thread-phone-composer"
            className="flex min-h-14 items-center gap-1 rounded-full border border-composer-border bg-card px-2 shadow-[0_18px_50px_rgba(15,15,15,0.12)] sm:hidden"
          >
            <Button aria-label="添加附件" className="h-11 w-11 rounded-full" size="icon" variant="ghost">
              <Plus size={22} />
            </Button>
            <Textarea
              aria-label="线程输入"
              className="h-11 min-h-0 flex-1 resize-none overflow-hidden border-0 bg-transparent px-1 py-2.5 text-base leading-6 shadow-none focus-visible:bg-transparent focus-visible:ring-0"
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="询问 DeepStudent"
              rows={1}
            />
            <Button
              aria-label="发送消息"
              className={cn(
                "h-11 w-11 shrink-0 rounded-full",
                isComposerEmpty && "border-transparent bg-primary/90 text-primary-foreground hover:bg-primary active:bg-primary/85",
              )}
              size="icon"
              variant="primary"
            >
              <ArrowUp size={16} weight="bold" />
            </Button>
          </div>

          <div
            data-slot="thread-composer"
            className="hidden overflow-hidden rounded-3xl border border-composer-border bg-card shadow-lg shadow-black/5 transition-shadow duration-150 ease-out motion-reduce:transition-none focus-within:[box-shadow:var(--shadow-composer-focus)] sm:block"
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
                  "h-11 w-11 shrink-0 rounded-full lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]",
                  isComposerEmpty && "border-transparent bg-muted text-muted-foreground hover:bg-muted/80 active:bg-muted/70",
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
