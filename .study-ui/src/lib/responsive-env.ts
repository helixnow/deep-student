export const RESPONSIVE_BREAKPOINTS = {
  phoneMax: 639,
  tabletMin: 640,
  tabletMax: 1023,
  desktopMin: 1024,
  compactMax: 1023,
} as const;

export type FormFactor = "phone" | "tablet" | "desktop";
export type InputMode = "coarse" | "fine";
export type ShellMode = "compact-webview" | "desktop-window";

export type ResponsiveEnvironment = {
  width: number;
  formFactor: FormFactor;
  isCompact: boolean;
  inputMode: InputMode;
  shellMode: ShellMode;
};

function normalizeWidth(width: number) {
  if (!Number.isFinite(width)) {
    return 0;
  }

  return Math.max(0, Math.floor(width));
}

export function getFormFactor(width: number): FormFactor {
  const normalizedWidth = normalizeWidth(width);

  if (normalizedWidth <= RESPONSIVE_BREAKPOINTS.phoneMax) {
    return "phone";
  }

  if (normalizedWidth <= RESPONSIVE_BREAKPOINTS.tabletMax) {
    return "tablet";
  }

  return "desktop";
}

export function isCompactWidth(width: number): boolean {
  return normalizeWidth(width) <= RESPONSIVE_BREAKPOINTS.compactMax;
}

export function createResponsiveEnvironment(input: {
  width: number;
  inputMode?: InputMode;
}): ResponsiveEnvironment {
  const width = normalizeWidth(input.width);
  const isCompact = isCompactWidth(width);

  return {
    width,
    formFactor: getFormFactor(width),
    isCompact,
    inputMode: input.inputMode ?? "fine",
    shellMode: isCompact ? "compact-webview" : "desktop-window",
  };
}

function areResponsiveEnvironmentsEqual(
  current: ResponsiveEnvironment,
  next: ResponsiveEnvironment,
) {
  return current.width === next.width &&
    current.formFactor === next.formFactor &&
    current.isCompact === next.isCompact &&
    current.inputMode === next.inputMode &&
    current.shellMode === next.shellMode;
}

const serverResponsiveEnvironment = createResponsiveEnvironment({
  width: RESPONSIVE_BREAKPOINTS.desktopMin,
  inputMode: "fine",
});

let browserResponsiveEnvironment: ResponsiveEnvironment | null = null;

export function getBrowserResponsiveEnvironment(): ResponsiveEnvironment {
  if (typeof window === "undefined") {
    return getServerResponsiveEnvironment();
  }

  const nextEnvironment = createResponsiveEnvironment({
    width: window.innerWidth,
    inputMode: window.matchMedia?.("(pointer: coarse)")?.matches ? "coarse" : "fine",
  });

  if (
    browserResponsiveEnvironment &&
    areResponsiveEnvironmentsEqual(browserResponsiveEnvironment, nextEnvironment)
  ) {
    return browserResponsiveEnvironment;
  }

  browserResponsiveEnvironment = nextEnvironment;
  return browserResponsiveEnvironment;
}

export function getServerResponsiveEnvironment(): ResponsiveEnvironment {
  return serverResponsiveEnvironment;
}

export function subscribeResponsiveEnvironment(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener("resize", listener);

  return () => window.removeEventListener("resize", listener);
}
