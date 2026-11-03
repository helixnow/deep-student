# Task3 — 共享几何、输入与Canvas renderer

read this first — exact requirements. Repo `/home/xutao/deepstudent/deep-student`, branch feat/handwriting-annotation-chat. Hand role: tests first, NO tests/build/install/agents/commits. Main reviews/runs tests. Only modify `src/features/ink/{geometry,input,renderer}.ts`, its `__tests__`, `tests/ct/ink/` and `tasks/task-3-report.md`. Consume types.ts without modifying it. Storage/validation worker owns Rust/types. Geometry/render is independent of storage; no UI/editor/network implementations.

## Gates

First create focused unit and real browser tests plus minimal callable compiling stubs. Return NEEDS_RED_VERIFICATION and STOP. Main red then authorizes implementation. No missing-module/compile-error as red, no negative test proof using constant Err. Tests must assert behavior with literal expected values, not source grep or only mock invocation.

## APIs and behavior

Export narrow functions/types, straightforward names below (minor signatures changes document in report):

- `InkViewport {left,top,scale,pan_x,pan_y}`. `screenToPage({x,y},viewport)` and `pageToScreen` inverse: screen = left/top + pan + logical*scale. DPR irrelevant to logical mapping. `mapCropPoint(point,crop,pageSize)` normalized0..1 in crop→logical page. Validate finite, positive scale/crop and in-page geometry.
- `objectHitTest(object,point,radius)` for whole-stroke eraser and text/shapes. For stroke segment nearest distance and width/pressure extent; single point supported; avoid deleting line far away just inside its bounding box. Rect/ellipse/arrow/highlight straightforward bounded hit.
- `pointerSample(eventLike,viewport,startedAt,pressureEnabled)` yields InkSample logical coordinates, nonnegative elapsed_ms, pen pressure finite 0..1; mouse/touch fallback pressure=.5 (renderer fixed width when disabled). Do not require DOM globals in pure input helper. `collectPointerSamples(eventLike,...)` uses coalesced events when available (fall back to original), filter nonfinite events, clamp to page by caller or documented optional page bounds. pointerup terminal sample preserves last point; cancel policy: finish valid stroke rather than silently lose all samples (editor handles cancellation once).
- renderer `renderInkPage(canvas,pageRef,page,options?) -> {width_px,height_px}` synchronous after caller has decoded background. Options `{background?: CanvasImageSource,crop?: InkRect,scale?:number,max_pixels?:number}`; Canvas/DPR budget adapt size so longest side <= requested and total pixels<=16M default. Clear/white paper, ruling gray horizontal/grid, background image fixed full page, objects array order, clipped crop. Same renderer used editor/AI/export. Dimensions require positive finite; wrong page id reject. Default logical-size output, scale caller controlled. No DOM screenshots.
- `stroke` pressure width deterministic from raw samples (fixed simple factor e.g. baseWidth*(.25+.75*pressure) only when enabled), circular endpoints + segment continuity; no resmoothing after save. Highlighter translucent and multiply, once per stroke layer to avoid overlaps increasing alpha within same stroke. Preserve alpha embedded in #RRGGBBAA; explicit default highlighter alpha only if color lacks alpha. Pen uses source-over. Current pen overlay and completed content separation later editor, no React updates per point.
- text plain string draw/wrap with system sans-serif, explicit rect clip; no HTML interpretation or font URLs. Draw rect/ellipse/region_highlight/arrow with same ordering/opacity/stroke widths; highlighter/region opacity defined once. Region highlight fills; normal rect/ellipse outline; arrow head.
- background draw coordinate comes from frozen page geometry; PDF highlighting overlay API later can be minimal optional readonly objects (do not build storage now).

## Tests

unit: literal inverse viewport point at scale2/pan/left, DPR not in logical math; crop point mapping + out-of-bounds rejection; stroke hit with distant bbox interior not segment; single dot; pressure+fallback/coalesced+timestamp; invalid events discarded, pointercancel/pointerup policy.

CT: real Canvas renderer harness with fixture-like plain sample page (do not mutate shared fixtures); assert dimensions and actual pixel data at interior/background/pen/highlighter/shape locations. Render twice same state equals pixels; crop pixel mapping; text string containing `<b>` is plain and no DOM markup; highDPR/scale and max pixel budget. Test screen/ink frame independent of any editor mount and full-page object near bottom appears. No pixel assertions on jsdom mocks.

Use existing Playwright CT harness conventions; no new deps. Need no filesystem screenshots unless diagnostic; any artifacts in docs/handwriting-annotation/verification not .local-work. No new global test config unless actually required and main approval. Report exact selectors and API choices, stop before implementation. Keep implementation small; reuse browser Canvas/platform APIs.
