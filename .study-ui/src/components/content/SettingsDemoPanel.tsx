import { useEffect, useRef, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Surface } from "@/components/ui/surface";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  demoSidebarPreviewFolders,
  demoSidebarPreviewItems,
  demoSidebarPreviewThreads,
} from "@/lib/demo-fixtures";

import { comboboxSuggestions, demoHeaderStats, demoSectionMeta } from "./settings-demo-data";
import {
  ButtonSection,
  CardListItemSection,
  DemoSectionCard,
  DropdownSection,
  type DemoSectionCardProps,
  DialogSection,
  FeedbackPatternsSection,
  InputSection,
  SelectComboboxSection,
  SheetSection,
  SidebarPreviewSection,
  StateRegressionSection,
  SwitchSection,
  TabsSection,
  TextareaSection,
  TypographySection,
  TooltipSection,
} from "./settings-demo-sections";

export function SettingsDemoPanel() {
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const showToast = () => {
    setToastVisible(true);

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
      toastTimerRef.current = null;
    }, 2400);
  };

  const sections: DemoSectionCardProps[] = [
    {
      ...demoSectionMeta.button,
      children: <ButtonSection />,
    },
    {
      ...demoSectionMeta.input,
      children: <InputSection />,
    },
    {
      ...demoSectionMeta.textarea,
      children: <TextareaSection />,
    },
    {
      ...demoSectionMeta.switch,
      children: <SwitchSection />,
    },
    {
      ...demoSectionMeta.selectCombobox,
      children: <SelectComboboxSection suggestions={comboboxSuggestions} />,
    },
    {
      ...demoSectionMeta.tabs,
      children: <TabsSection />,
    },
    {
      ...demoSectionMeta.tooltip,
      children: <TooltipSection />,
    },
    {
      ...demoSectionMeta.dropdown,
      children: <DropdownSection />,
    },
    {
      ...demoSectionMeta.sidebar,
      children: (
        <SidebarPreviewSection
          folderItems={demoSidebarPreviewFolders}
          settingsNavItems={demoSidebarPreviewItems}
          threadItems={demoSidebarPreviewThreads}
        />
      ),
    },
  ];

  return (
    <TooltipProvider delayDuration={120}>
      <div className="space-y-3.5">
        <Card className="border-border/70 bg-background/90 shadow-sm shadow-black/5">
          <CardHeader className="gap-3.5 md:flex-row md:items-end md:justify-between md:space-y-0">
            <div className="space-y-1.5">
              <div className="space-y-1.5">
                <CardTitle className="text-xl leading-6">组件与状态预览</CardTitle>
                <CardDescription className="max-w-3xl text-sm">
                  集中检查常用控件、反馈状态和侧栏样式，方便做视觉回归与交互核对。
                </CardDescription>
              </div>
            </div>

            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              {demoHeaderStats.map((item) => (
                <Surface key={item.label} className="min-w-28 rounded-2xl border border-border/70 bg-secondary/78 px-3 py-2 shadow-sm shadow-black/5">
                  <p className="font-medium text-foreground">{item.label}</p>
                  <p>{item.description}</p>
                </Surface>
              ))}
            </div>
          </CardHeader>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <StateRegressionSection
            title={demoSectionMeta.stateRegression.title}
            description={demoSectionMeta.stateRegression.description}
            className={demoSectionMeta.stateRegression.className}
          />
          <TypographySection
            title={demoSectionMeta.typography.title}
            description={demoSectionMeta.typography.description}
          />
          <DialogSection
            title={demoSectionMeta.dialog.title}
            description={demoSectionMeta.dialog.description}
          />
          <SheetSection
            title={demoSectionMeta.sheet.title}
            description={demoSectionMeta.sheet.description}
          />
          {sections.map((section) => (
            <DemoSectionCard
              key={section.title}
              title={section.title}
              description={section.description}
              className={section.className}
            >
              {section.children}
            </DemoSectionCard>
          ))}
          <CardListItemSection
            title={demoSectionMeta.cardListItem.title}
            description={demoSectionMeta.cardListItem.description}
          />
          <FeedbackPatternsSection
            title={demoSectionMeta.feedback.title}
            description={demoSectionMeta.feedback.description}
            toastVisible={toastVisible}
            onShowToast={showToast}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
