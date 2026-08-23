import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SyncSettingsSection 是与数据治理面板 SyncTab 重复的同步入口，
// 必须与 SyncTab 一样标注「实验版」徽章并提示先备份数据。
describe("SyncSettingsSection experimental badge & progress a11y", () => {
  const syncSettingsSection = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/SyncSettingsSection.tsx",
    ),
    "utf-8",
  );
  const progress = readFileSync(
    resolve(process.cwd(), "src/components/ui/shad/Progress.tsx"),
    "utf-8",
  );
  const zhData = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/locales/zh-CN/data.json"), "utf-8"),
  ) as { governance: Record<string, string>; sync_settings: Record<string, string> };
  const enData = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/locales/en-US/data.json"), "utf-8"),
  ) as { governance: Record<string, string>; sync_settings: Record<string, string> };

  it("shows the same experimental badge + backup tooltip as SyncTab", () => {
    expect(syncSettingsSection).toContain(
      "t('data:governance.experimental_badge')",
    );
    expect(syncSettingsSection).toContain(
      "title={t('sync:experimentalBadgeTooltip')}",
    );
    // 徽章文案依赖 sync 命名空间，必须在 useTranslation 中声明
    expect(syncSettingsSection).toContain("useTranslation(['data', 'common', 'sync'])");
  });

  it("keeps badge and tooltip locale keys available in zh-CN and en-US", () => {
    expect(zhData.governance.experimental_badge).toBeTruthy();
    expect(enData.governance.experimental_badge).toBeTruthy();
    const zhSync = JSON.parse(
      readFileSync(resolve(process.cwd(), "src/locales/zh-CN/sync.json"), "utf-8"),
    ) as Record<string, string>;
    const enSync = JSON.parse(
      readFileSync(resolve(process.cwd(), "src/locales/en-US/sync.json"), "utf-8"),
    ) as Record<string, string>;
    // tooltip 需包含「建议先备份」提示
    expect(zhSync.experimentalBadgeTooltip).toContain("备份");
    expect(enSync.experimentalBadgeTooltip.toLowerCase()).toContain("backing up");
  });

  it("labels both progress bars and keeps the progressbar role on Progress", () => {
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain("aria-valuemin={0}");
    expect(progress).toContain("aria-valuemax={100}");
    expect(syncSettingsSection).toContain(
      "aria-label={t('data:sync_settings.db_sync_progress_label')}",
    );
    expect(syncSettingsSection).toContain(
      "aria-label={t('data:sync_settings.sync_progress_label')}",
    );
    expect(zhData.sync_settings.db_sync_progress_label).toBeTruthy();
    expect(zhData.sync_settings.sync_progress_label).toBeTruthy();
    expect(enData.sync_settings.db_sync_progress_label).toBeTruthy();
    expect(enData.sync_settings.sync_progress_label).toBeTruthy();
  });
});
