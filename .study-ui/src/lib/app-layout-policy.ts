import type {
  FormFactor,
  InputMode,
  ResponsiveEnvironment,
  ShellMode,
} from "./responsive-env.ts";

export type SidebarMode = "drawer" | "docked";
export type Density = "touch" | "desktop";

export type AppLayoutPolicy = {
  formFactor: FormFactor;
  isCompact: boolean;
  inputMode: InputMode;
  shellMode: ShellMode;
  sidebarMode: SidebarMode;
  density: Density;
};

export function getAppLayoutPolicy(environment: ResponsiveEnvironment): AppLayoutPolicy {
  return {
    formFactor: environment.formFactor,
    isCompact: environment.isCompact,
    inputMode: environment.inputMode,
    shellMode: environment.shellMode,
    sidebarMode: environment.isCompact ? "drawer" : "docked",
    density: environment.isCompact || environment.inputMode === "coarse" ? "touch" : "desktop",
  };
}
