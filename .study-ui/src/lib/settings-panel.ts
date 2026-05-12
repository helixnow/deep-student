type SettingsPanelSection =
  | "general"
  | "model-service"
  | "model-assign"
  | "appearance"
  | "shortcuts"
  | "developer"
  | "memory"
  | "privacy"
  | "data-governance"
  | "demo"
  | "about"
  | "advanced";

export function getVisibleSettingsPanelSections(activeTab: string): SettingsPanelSection[] {
  if (activeTab === "general") {
    return ["general"];
  }

  if (activeTab === "appearance") {
    return ["appearance"];
  }

  if (activeTab === "about") {
    return ["about"];
  }

  if (activeTab === "models") {
    return ["model-service", "model-assign"];
  }

  if (activeTab === "tools") {
    return ["memory", "privacy", "shortcuts"];
  }

  if (activeTab === "advanced") {
    return ["developer", "data-governance"];
  }

  if (activeTab === "demo") {
    return ["demo"];
  }

  return [];
}
