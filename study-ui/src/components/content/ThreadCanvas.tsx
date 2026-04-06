import { useState } from "react";
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

export function ThreadCanvas() {
  const [draftMessage, setDraftMessage] = useState("");
  const isComposerEmpty = draftMessage.trim().length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 md:px-8 md:pb-8 md:pt-4">
        <div className="mx-auto flex min-h-full w-full max-w-[44rem] items-center">
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

      <div className="border-t border-[color:var(--composer-divider)] bg-[color:var(--shell-panel-strong)] px-4 pb-3 pt-2.5 md:px-8 md:pb-4">
        <div className="mx-auto w-full max-w-[44rem]">
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

            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1 md:px-4">
              <div className="flex flex-wrap items-center gap-2">
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
                  "h-11 w-11 rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]",
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
