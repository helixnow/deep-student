import { render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock overlayscrollbars-react so jsdom can exercise the non-native branch
// without a real OverlayScrollbars runtime. The mock mirrors the ref contract
// (osInstance/getElement) that scroll-area.tsx depends on.
vi.mock("overlayscrollbars-react", () => {
  type Props = React.HTMLAttributes<HTMLDivElement> & { defer?: boolean };
  const OverlayScrollbarsComponent = React.forwardRef<
    { osInstance: () => null; getElement: () => HTMLDivElement | null },
    Props
  >(function OverlayScrollbarsComponent({ children, ...rest }, ref) {
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    React.useImperativeHandle(
      ref,
      () => ({
        osInstance: () => null,
        getElement: () => innerRef.current,
      }),
      [],
    );
    return (
      <div ref={innerRef} {...rest} data-testid="os-viewport">
        {children}
      </div>
    );
  });
  return { OverlayScrollbarsComponent };
});

// Mock scroll-platform so tests can force iOS auto-detection in a controlled way.
const detectScrollPlatformMock = vi.fn(() => ({
  isIOSWebView: false,
  isTauri: false,
  isTouchPrimary: false,
  preferNativeScrollbars: false,
}));
vi.mock("@/lib/scroll-platform", () => ({
  detectScrollPlatform: () => detectScrollPlatformMock(),
}));
vi.mock("../../lib/scroll-platform", () => ({
  detectScrollPlatform: () => detectScrollPlatformMock(),
}));

import { ScrollArea } from "./scroll-area";

describe("ScrollArea", () => {
  beforeEach(() => {
    detectScrollPlatformMock.mockReturnValue({
      isIOSWebView: false,
      isTauri: false,
      isTouchPrimary: false,
      preferNativeScrollbars: false,
    });
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
  });

  it("renders children with default data attributes", () => {
    render(
      <ScrollArea>
        <p>Hello</p>
      </ScrollArea>,
    );
    const region = screen.getByText("Hello").closest('[data-slot="scroll-area"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("data-orientation")).toBe("vertical");
    expect(region?.getAttribute("data-native-scrollbars")).toBe("false");
  });

  it("falls back to native scrollbars when nativeScrollbars=true is passed explicitly", () => {
    render(
      <ScrollArea nativeScrollbars>
        <p>Native</p>
      </ScrollArea>,
    );
    const region = screen.getByText("Native").closest('[data-slot="scroll-area"]');
    expect(region?.getAttribute("data-native-scrollbars")).toBe("true");
    const viewport = region?.firstElementChild as HTMLElement | null;
    expect(viewport?.classList.contains("scroll-area--native")).toBe(true);
  });

  it("auto-detects iOS WebView and falls back to native scrollbars", () => {
    detectScrollPlatformMock.mockReturnValue({
      isIOSWebView: true,
      isTauri: false,
      isTouchPrimary: true,
      preferNativeScrollbars: true,
    });
    render(
      <ScrollArea>
        <p>iOS</p>
      </ScrollArea>,
    );
    const region = screen.getByText("iOS").closest('[data-slot="scroll-area"]');
    expect(region?.getAttribute("data-native-scrollbars")).toBe("true");
  });

  it("forwards viewportRef as an HTMLDivElement in the native-fallback path", () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <ScrollArea nativeScrollbars viewportRef={ref}>
        <p>Target</p>
      </ScrollArea>,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.classList.contains("scroll-area--native")).toBe(true);
  });

  it("propagates orientation=horizontal to the data attribute", () => {
    render(
      <ScrollArea orientation="horizontal">
        <p>Scroll-x</p>
      </ScrollArea>,
    );
    const region = screen.getByText("Scroll-x").closest('[data-slot="scroll-area"]');
    expect(region?.getAttribute("data-orientation")).toBe("horizontal");
  });

  it("writes trackOffset values as CSS custom properties on the root element", () => {
    render(
      <ScrollArea trackOffset={{ top: 12, right: "1rem", bottom: 0 }}>
        <p>Offsets</p>
      </ScrollArea>,
    );
    const region = screen
      .getByText("Offsets")
      .closest('[data-slot="scroll-area"]') as HTMLElement;
    expect(region.style.getPropertyValue("--scroll-area-track-top")).toBe("12px");
    expect(region.style.getPropertyValue("--scroll-area-track-right")).toBe("1rem");
    expect(region.style.getPropertyValue("--scroll-area-track-bottom")).toBe("0px");
  });

  it("respects a custom data-slot for consumer-specific identifiers", () => {
    render(
      <ScrollArea data-slot="thread-scroll">
        <p>Thread</p>
      </ScrollArea>,
    );
    const region = screen.getByText("Thread").closest('[data-slot="thread-scroll"]');
    expect(region).not.toBeNull();
  });
});
