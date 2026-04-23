import { type CSSProperties, useState } from "react";
import {
  ArrowUp,
  MagicWand,
  Microphone,
  Paperclip,
  Plus,
  Sparkle,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const composerSecondaryControlClassName = "rounded-full border-transparent px-2.5 text-xs font-normal text-muted-foreground";

const mobilePromptCards = [
  {
    id: "focus-map",
    className: "bg-[#164a9f] text-white",
    eyebrow: "MAP",
    title: "拆解任务",
    accentClassName: "border-white/35 bg-white/10",
  },
  {
    id: "paper-note",
    className: "bg-[#f5c84b] text-[#241c0b]",
    eyebrow: "NOTE",
    title: "整理资料",
    accentClassName: "border-[#241c0b]/15 bg-white/45",
  },
  {
    id: "study-room",
    className: "bg-[#283a2b] text-white",
    eyebrow: "FLOW",
    title: "生成计划",
    accentClassName: "border-white/25 bg-white/12",
  },
  {
    id: "review-card",
    className: "bg-[#f2f0ec] text-[#1f1f1d]",
    eyebrow: "REVIEW",
    title: "复盘重点",
    accentClassName: "border-[#1f1f1d]/10 bg-white/70",
  },
] as const;

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
            data-slot="thread-mobile-empty-state"
            className="flex min-h-full w-full flex-col justify-center overflow-hidden pb-10 pt-8 text-center sm:hidden"
          >
            <div
              data-slot="thread-mobile-prompt-strip"
              aria-hidden="true"
              className="relative left-1/2 mb-9 flex w-screen -translate-x-1/2 overflow-hidden"
            >
              <div className="flex translate-x-[-4.75rem] gap-5 px-4">
                {mobilePromptCards.map((card) => (
                  <div
                    key={card.id}
                    className={cn(
                      "relative h-20 w-36 shrink-0 overflow-hidden rounded-[1.75rem] p-4 text-left shadow-[0_18px_40px_rgba(15,15,15,0.12)]",
                      card.className,
                    )}
                  >
                    <div className={cn("absolute right-3 top-3 h-8 w-8 rounded-full border", card.accentClassName)} />
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">{card.eyebrow}</p>
                    <p className="mt-3 text-lg font-semibold leading-none tracking-[-0.03em]">{card.title}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mx-auto max-w-[20rem] space-y-3 px-2">
              <h2 className="text-balance text-2xl font-semibold tracking-[-0.04em] text-foreground">开启新的学习任务</h2>
              <p className="text-pretty text-base leading-7 text-muted-foreground">
                把问题、资料和想法放进来，DeepStudent 会帮你收敛成更清晰的下一步。
              </p>
            </div>

            <Button variant="outline" className="mx-auto mt-7 min-w-32 rounded-full bg-card/85 shadow-sm shadow-black/5">
              <MagicWand size={16} />
              查看建议起点
            </Button>
          </section>

          <section
            data-slot="thread-empty-state"
            className="hidden w-full flex-col items-center justify-center gap-5 py-12 text-center sm:flex md:py-16"
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
            <Button aria-label="语音输入" className="h-11 w-11 rounded-full text-muted-foreground" size="icon" variant="ghost">
              <Microphone size={21} />
            </Button>
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
