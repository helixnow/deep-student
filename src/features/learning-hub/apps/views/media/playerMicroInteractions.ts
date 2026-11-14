/**
 * playerMicroInteractions — 视频播放器 YouTube/Bilibili 级核心微交互状态机
 *
 * 包含三个纯控制器：
 * 1. HoldSpeedBoostController：长按 450ms 临时 3.0x 倍速播放，松手/失焦立即恢复原倍速
 * 2. CumulativeSeekController：700ms 窗口内连按快进退累加秒数，窗口结束后一次性提交底层 seek
 * 3. HoverThumbnailPreviewController：进度条悬停 160ms 延迟防抖唤醒预览解码 + 160px 横竖屏自适应封顶尺寸与水平边界夹逼
 */

export const BOOST_DELAY_MS = 450;
export const DEFAULT_BOOST_RATE = 3.0;

export const SEEK_ACCUMULATE_WINDOW_MS = 700;

export const HOVER_PREVIEW_DELAY_MS = 160;
export const MAX_PREVIEW_DIMENSION_PX = 160;
export const PREVIEW_END_SAFETY_MARGIN_SEC = 0.05;
export const PREVIEW_SEEK_MIN_DELTA_SEC = 0.25;

// ============================================================================
// 1. HoldSpeedBoostController — 长按临时倍速控制器
// ============================================================================

export interface HoldSpeedBoostControllerOptions {
  /** 长按触发延迟（毫秒），默认 450ms */
  delayMs?: number;
  /** 临时倍速值，默认 3.0 */
  boostRate?: number;
  /** 读取当前播放倍速 */
  getPlaybackRate?: () => number;
  /** 将播放倍速写入媒体元素 */
  applyPlaybackRate?: (rate: number) => void;
  /** 是否允许进入临时倍速（例如仅在视频就绪且未暂停时允许） */
  canBoost?: () => boolean;
  /** 倍速状态变更回调 */
  onBoostStateChange?: (isBoosting: boolean, rate: number) => void;
}

export interface HoldReleaseResult {
  /** 松手前是否已进入临时倍速状态 */
  wasBoosting: boolean;
  /** 恢复后的原始倍速；未进入倍速时为 null */
  restoredRate: number | null;
}

export function formatBoostRate(rate: number): string {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_BOOST_RATE;
  return `${safeRate.toFixed(1)}x`;
}

export class HoldSpeedBoostController {
  public readonly delayMs: number;
  public readonly boostRate: number;

  private readonly options: HoldSpeedBoostControllerOptions;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private holding = false;
  private boosting = false;
  private savedRate: number | null = null;

  public constructor(options: HoldSpeedBoostControllerOptions = {}) {
    this.options = options;
    this.delayMs = options.delayMs ?? BOOST_DELAY_MS;
    this.boostRate = options.boostRate ?? DEFAULT_BOOST_RATE;
  }

  public get isHolding(): boolean {
    return this.holding;
  }

  public get isBoosting(): boolean {
    return this.boosting;
  }

  public get originalPlaybackRate(): number | null {
    return this.savedRate;
  }

  /**
   * 开始长按计时（右键长按 / 触屏长按 / 右方向键按下）。
   * 若已在按住或倍速中，忽略重复触发（防止键盘长按 repeat 重置计时器或覆盖原始倍速）。
   */
  public startHold(currentPlaybackRate?: number): void {
    if (this.holding || this.boosting) return;

    const rateCandidate = currentPlaybackRate ?? this.options.getPlaybackRate?.() ?? 1;
    this.savedRate = Number.isFinite(rateCandidate) && rateCandidate > 0 ? rateCandidate : 1;
    this.holding = true;
    this.clearTimer();

    this.timerId = setTimeout(() => {
      this.timerId = null;
      if (!this.holding) return;
      if (this.options.canBoost && !this.options.canBoost()) {
        return;
      }
      this.boosting = true;
      this.options.applyPlaybackRate?.(this.boostRate);
      this.options.onBoostStateChange?.(true, this.boostRate);
    }, this.delayMs);
  }

  /** startHold 的语义别名 */
  public press(currentPlaybackRate?: number): void {
    this.startHold(currentPlaybackRate);
  }

  /**
   * 结束按住（pointerup / keyup / pointercancel / blur）。
   * - 未满 450ms：取消定时器，返回 { wasBoosting: false, restoredRate: null }，交由调用方按普通单击/短按处理
   * - 已满 450ms：立即恢复按下前的 originalPlaybackRate 并触发 onBoostStateChange(false, restoredRate)
   */
  public endHold(): HoldReleaseResult {
    this.clearTimer();
    const wasBoosting = this.boosting;
    const restoredRate = this.savedRate;

    this.holding = false;
    this.boosting = false;
    this.savedRate = null;

    if (wasBoosting && restoredRate !== null) {
      this.options.applyPlaybackRate?.(restoredRate);
      this.options.onBoostStateChange?.(false, restoredRate);
      return { wasBoosting: true, restoredRate };
    }

    return { wasBoosting: false, restoredRate: null };
  }

  /** endHold 的语义别名 */
  public release(): HoldReleaseResult {
    return this.endHold();
  }

  /** 取消或失焦时恢复原状 */
  public cancel(): HoldReleaseResult {
    return this.endHold();
  }

  public dispose(): void {
    this.endHold();
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}

// ============================================================================
// 2. CumulativeSeekController — 连按快进退 700ms 窗口累加器
// ============================================================================

export interface CumulativeSeekSnapshot {
  /** 是否处于累加窗口期 */
  isAccumulating: boolean;
  /** 本轮累加起始基准时间（秒） */
  anchorTime: number;
  /** 累计偏移秒数（如 +5 -> +10 -> +15 或 -10 -> -20） */
  accumulatedDelta: number;
  /** 经 [0, duration] 夹逼后的目标时间（秒） */
  targetTime: number;
}

export interface CumulativeSeekControllerOptions {
  /** 累加窗口时长（毫秒），默认 700ms */
  windowMs?: number;
  /** 窗口结束或 flush 时一次性执行底层 seek */
  commitSeek: (targetTime: number, accumulatedDelta: number) => void;
  /** 每次累加或结束时的预览状态回调 */
  onStateChange?: (snapshot: CumulativeSeekSnapshot) => void;
}

function clampSeekTime(time: number, duration?: number): number {
  const lowerClamped = Math.max(0, Number.isFinite(time) ? time : 0);
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
    return Math.min(lowerClamped, duration);
  }
  return lowerClamped;
}

export class CumulativeSeekController {
  public readonly windowMs: number;

  private readonly options: CumulativeSeekControllerOptions;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private accumulating = false;
  private anchor = 0;
  private delta = 0;
  private target = 0;
  private lastDuration: number | undefined = undefined;

  public constructor(options: CumulativeSeekControllerOptions) {
    this.options = options;
    this.windowMs = options.windowMs ?? SEEK_ACCUMULATE_WINDOW_MS;
  }

  public get isAccumulating(): boolean {
    return this.accumulating;
  }

  public get anchorTime(): number {
    return this.anchor;
  }

  public get accumulatedDelta(): number {
    return this.delta;
  }

  public get targetTime(): number {
    return this.target;
  }

  public getSnapshot(): CumulativeSeekSnapshot {
    return {
      isAccumulating: this.accumulating,
      anchorTime: this.anchor,
      accumulatedDelta: this.delta,
      targetTime: this.target,
    };
  }

  /**
   * 在 700ms 窗口内累加一次快进/快退步长：
   * - 首次触发时锁定 anchorTime = clamp(baseTime, 0, duration)
   * - 窗口内后续触发沿用同一 anchorTime 累加 accumulatedDelta，避免解码器尚未完成 seek 导致基准时间停留在原地
   * - 重置 700ms 定时器，到期后一次性调用 commitSeek(targetTime, accumulatedDelta)
   */
  public stepSeek(
    deltaSeconds: number,
    baseTime: number,
    duration?: number,
  ): CumulativeSeekSnapshot {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) {
      return this.getSnapshot();
    }

    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      this.lastDuration = duration;
    }

    if (!this.accumulating) {
      this.anchor = clampSeekTime(baseTime, this.lastDuration);
      this.delta = deltaSeconds;
      this.accumulating = true;
    } else {
      this.delta += deltaSeconds;
    }

    this.target = clampSeekTime(this.anchor + this.delta, this.lastDuration);
    this.clearTimer();
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.flush();
    }, this.windowMs);

    const snapshot = this.getSnapshot();
    this.options.onStateChange?.(snapshot);
    return snapshot;
  }

  /**
   * 立即提交当前未落盘的累加 seek（例如失焦、卸载或测试显式结算）。
   */
  public flush(): number | null {
    this.clearTimer();
    if (!this.accumulating) {
      return null;
    }

    const committedTarget = this.target;
    const committedDelta = this.delta;

    this.accumulating = false;
    this.anchor = 0;
    this.delta = 0;
    this.target = 0;

    this.options.commitSeek(committedTarget, committedDelta);
    this.options.onStateChange?.(this.getSnapshot());
    return committedTarget;
  }

  /** 取消未提交的累加，不触发 commitSeek */
  public cancel(): void {
    this.clearTimer();
    if (!this.accumulating) return;
    this.accumulating = false;
    this.anchor = 0;
    this.delta = 0;
    this.target = 0;
    this.options.onStateChange?.(this.getSnapshot());
  }

  public dispose(): void {
    this.cancel();
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}

// ============================================================================
// 3. HoverThumbnailPreviewController — 进度条悬停 160ms 防抖与 160px 封顶尺寸计算器
// ============================================================================

export interface PreviewBoxDimensions {
  width: number;
  height: number;
  aspectRatio: number;
  isPortrait: boolean;
}

/**
 * 计算缩略图预览框尺寸：
 * - 横屏/方屏视频（videoWidth >= videoHeight）：宽度封顶 160px，高度按原始宽高比缩放
 * - 竖屏视频（videoHeight > videoWidth）：高度封顶 160px，宽度按原始宽高比缩放
 * - 元数据未就绪（宽高无效）时默认按 16:9 横屏（160x90）占位
 */
export function computePreviewBoxDimensions(
  videoWidth: number,
  videoHeight: number,
  maxDimensionPx: number = MAX_PREVIEW_DIMENSION_PX,
): PreviewBoxDimensions {
  const safeMax = Number.isFinite(maxDimensionPx) && maxDimensionPx > 0
    ? maxDimensionPx
    : MAX_PREVIEW_DIMENSION_PX;

  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    const defaultAspect = 16 / 9;
    return {
      width: safeMax,
      height: Math.round(safeMax / defaultAspect),
      aspectRatio: defaultAspect,
      isPortrait: false,
    };
  }

  const aspectRatio = videoWidth / videoHeight;
  if (videoWidth >= videoHeight) {
    return {
      width: safeMax,
      height: Math.max(1, Math.round(safeMax / aspectRatio)),
      aspectRatio,
      isPortrait: false,
    };
  }

  return {
    width: Math.max(1, Math.round(safeMax * aspectRatio)),
    height: safeMax,
    aspectRatio,
    isPortrait: true,
  };
}

/**
 * 将预览卡片的中心点 X 坐标夹逼在进度条左右边界 [previewWidth / 2, trackWidth - previewWidth / 2] 内，
 * 防止鼠标靠近进度条两端时缩略图溢出播放器容器。
 */
export function clampPreviewCenterX(
  pointerOffsetX: number,
  trackWidth: number,
  previewWidth: number,
): number {
  const safePointerX = Number.isFinite(pointerOffsetX) ? pointerOffsetX : 0;
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) {
    return Math.max(0, safePointerX);
  }
  const halfPreview = Math.max(0, Number.isFinite(previewWidth) ? previewWidth : 0) / 2;
  if (trackWidth <= halfPreview * 2) {
    return trackWidth / 2;
  }
  return Math.min(Math.max(safePointerX, halfPreview), trackWidth - halfPreview);
}

/**
 * 根据指针比例计算预览目标时间（秒），末端留出 0.05s 余量避免落入空尾帧。
 */
export function computePreviewTargetTime(pointerRatio: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  const clampedRatio = Math.min(1, Math.max(0, Number.isFinite(pointerRatio) ? pointerRatio : 0));
  const maxSafeTime = Math.max(0, duration - PREVIEW_END_SAFETY_MARGIN_SEC);
  return Math.min(clampedRatio * duration, maxSafeTime);
}

export interface HoverPreviewSnapshot {
  /** 指针是否正悬停在进度条上 */
  isHovering: boolean;
  /** 是否已满 160ms 防抖并激活缩略图解码 */
  isDecodeActive: boolean;
  /** 预览视频首帧是否已解码就绪（未就绪时保持 opacity: 0 防黑块闪烁） */
  isFirstFrameReady: boolean;
  /** 指针相对进度条的归一化比例 [0, 1] */
  pointerRatio: number;
  /** 指针对应的预览时间（秒） */
  targetTime: number;
  /** 经左右边界夹逼后的预览框中心 X 坐标（px） */
  clampedCenterX: number;
  /** 预览框尺寸（横竖屏 160px 封顶） */
  dimensions: PreviewBoxDimensions;
}

export interface HoverThumbnailPreviewControllerOptions {
  /** 悬停防抖延迟（毫秒），默认 160ms */
  delayMs?: number;
  /** 预览框最大边长（px），默认 160px */
  maxDimensionPx?: number;
  /** 连续解码请求的最小时间步长（秒），默认 0.25s */
  minSeekDeltaSec?: number;
  /** 满 160ms 激活后或指针移动时的解码请求回调 */
  onDecodeRequest?: (targetTime: number) => void;
  /** 状态快照变化回调 */
  onStateChange?: (snapshot: HoverPreviewSnapshot) => void;
}

export interface HoverUpdateInput {
  /** 指针相对进度条左边缘的水平偏移（px） */
  pointerOffsetX: number;
  /** 进度条轨道总宽度（px） */
  trackWidth: number;
  /** 视频总时长（秒） */
  duration: number;
}

export class HoverThumbnailPreviewController {
  public readonly delayMs: number;
  public readonly maxDimensionPx: number;
  public readonly minSeekDeltaSec: number;

  private readonly options: HoverThumbnailPreviewControllerOptions;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private hovering = false;
  private decodeActive = false;
  private firstFrameReady = false;
  private pointerRatio = 0;
  private targetTime = 0;
  private lastPointerOffsetX = 0;
  private lastTrackWidth = 0;
  private clampedCenterX = 0;
  private lastDecodedTime = Number.NaN;
  private dimensions: PreviewBoxDimensions;

  public constructor(options: HoverThumbnailPreviewControllerOptions = {}) {
    this.options = options;
    this.delayMs = options.delayMs ?? HOVER_PREVIEW_DELAY_MS;
    this.maxDimensionPx = options.maxDimensionPx ?? MAX_PREVIEW_DIMENSION_PX;
    this.minSeekDeltaSec = options.minSeekDeltaSec ?? PREVIEW_SEEK_MIN_DELTA_SEC;
    this.dimensions = computePreviewBoxDimensions(0, 0, this.maxDimensionPx);
  }

  public get isHovering(): boolean {
    return this.hovering;
  }

  public get isDecodeActive(): boolean {
    return this.decodeActive;
  }

  public get isFirstFrameReady(): boolean {
    return this.firstFrameReady;
  }

  public getSnapshot(): HoverPreviewSnapshot {
    return {
      isHovering: this.hovering,
      isDecodeActive: this.decodeActive,
      isFirstFrameReady: this.firstFrameReady,
      pointerRatio: this.pointerRatio,
      targetTime: this.targetTime,
      clampedCenterX: this.clampedCenterX,
      dimensions: this.dimensions,
    };
  }

  public computePreviewBoxDimensions(
    videoWidth: number,
    videoHeight: number,
  ): PreviewBoxDimensions {
    return computePreviewBoxDimensions(videoWidth, videoHeight, this.maxDimensionPx);
  }

  public clampPreviewCenterX(
    pointerOffsetX: number,
    trackWidth: number,
    previewWidth = this.dimensions.width,
  ): number {
    return clampPreviewCenterX(pointerOffsetX, trackWidth, previewWidth);
  }

  /**
   * 指针进入或在进度条上移动：
   * - 首次进入启动 160ms 防抖定时器，未满 160ms 离开不会触发 onDecodeRequest
   * - 已满 160ms 后移动时，按 minSeekDeltaSec 节流触发新的帧解码请求
   */
  public updateHover(input: HoverUpdateInput): HoverPreviewSnapshot {
    const { pointerOffsetX, trackWidth, duration } = input;
    this.lastPointerOffsetX = pointerOffsetX;
    this.lastTrackWidth = trackWidth;

    const ratio =
      Number.isFinite(trackWidth) && trackWidth > 0
        ? Math.min(1, Math.max(0, pointerOffsetX / trackWidth))
        : 0;
    this.pointerRatio = ratio;
    this.targetTime = computePreviewTargetTime(ratio, duration);
    this.clampedCenterX = clampPreviewCenterX(
      pointerOffsetX,
      trackWidth,
      this.dimensions.width,
    );

    if (!this.hovering) {
      this.hovering = true;
      this.decodeActive = false;
      this.clearTimer();
      this.timerId = setTimeout(() => {
        this.timerId = null;
        if (!this.hovering) return;
        this.decodeActive = true;
        this.lastDecodedTime = this.targetTime;
        this.options.onDecodeRequest?.(this.targetTime);
        this.emit();
      }, this.delayMs);
    } else if (this.decodeActive) {
      if (
        !Number.isFinite(this.lastDecodedTime) ||
        Math.abs(this.targetTime - this.lastDecodedTime) >= this.minSeekDeltaSec
      ) {
        this.lastDecodedTime = this.targetTime;
        this.options.onDecodeRequest?.(this.targetTime);
      }
    }

    this.emit();
    return this.getSnapshot();
  }

  /**
   * 更新预览视频元数据宽高，重算 160px 封顶尺寸并重新夹逼水平位置。
   */
  public setVideoMetadata(videoWidth: number, videoHeight: number): PreviewBoxDimensions {
    this.dimensions = computePreviewBoxDimensions(
      videoWidth,
      videoHeight,
      this.maxDimensionPx,
    );
    this.clampedCenterX = clampPreviewCenterX(
      this.lastPointerOffsetX,
      this.lastTrackWidth,
      this.dimensions.width,
    );
    this.emit();
    return this.dimensions;
  }

  /**
   * 标记预览视频首帧是否解码完成（用于首帧未就绪防黑块闪烁）。
   */
  public markFirstFrameReady(ready = true): void {
    if (this.firstFrameReady === ready) return;
    this.firstFrameReady = ready;
    this.emit();
  }

  /**
   * 指针离开进度条：若尚未满 160ms 则取消防抖定时器，不触发任何解码请求。
   */
  public leaveHover(): HoverPreviewSnapshot {
    this.clearTimer();
    const hadState = this.hovering || this.decodeActive || this.firstFrameReady;
    this.hovering = false;
    this.decodeActive = false;
    this.firstFrameReady = false;
    this.lastDecodedTime = Number.NaN;
    if (hadState) {
      this.emit();
    }
    return this.getSnapshot();
  }

  public dispose(): void {
    this.clearTimer();
    this.hovering = false;
    this.decodeActive = false;
    this.firstFrameReady = false;
  }

  private emit(): void {
    this.options.onStateChange?.(this.getSnapshot());
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
