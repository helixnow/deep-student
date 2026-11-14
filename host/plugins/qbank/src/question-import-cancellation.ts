/**
 * 流式题目集导入的取消状态与进程内登记表。
 *
 * - `QuestionImportCancellation`：`question_import_service.rs:141-190`。
 *   单靠取消令牌不够：取消请求可能与"导入已完成、命令仍在清理登记"竞争。
 *   终态 CAS 保证只有一方获胜（0 = 运行中，1 = 已接受取消，2 = 已完成），
 *   因此导入完成后到达的取消永远不会被报告为"取消成功"。
 * - `QuestionImportCancellations`：`AppState.question_import_cancellations`
 *   （`src-tauri/src/lib.rs:3579` 的 `DashMap<String, Arc<QuestionImportCancellation>>`），
 *   由 `import_question_bank_stream` / `resume_question_import` 按调用方提供的
 *   import_id 登记（`commands.rs:1139-1153`、`1300-1310`），
 *   `cancel_question_bank_import`（`commands.rs:1265-1275`）按 id 查找并请求取消。
 *
 * JS 单线程：Rust 的 `compare_exchange(AcqRel)` 在这里是普通的"检查后写入"，
 * 不存在交错；`CancellationToken` 对应 `AbortController`，令牌即其 `signal`。
 */

const RUNNING = 0;
const CANCELLED = 1;
const COMPLETED = 2;

export class QuestionImportCancellation {
  readonly #controller = new AbortController();
  #state: typeof RUNNING | typeof CANCELLED | typeof COMPLETED = RUNNING;

  /**
   * `request_cancel`：只有本次请求把导入从运行中切到取消中时返回 true。
   * 已完成与先前的取消都在竞争中胜过后来的请求。
   */
  requestCancel(): boolean {
    if (this.#state !== RUNNING) return false;
    this.#state = CANCELLED;
    this.#controller.abort();
    return true;
  }

  /** `token`：传给导入管线的取消信号（`CancellationToken::clone`）。 */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * `finish_or_cancelled`：把正常返回标记为完成。已被接受的取消先胜出时返回 false，
   * 调用方必须丢弃竞争中得到的成功结果，改报取消。
   */
  finishOrCancelled(): boolean {
    if (this.#state !== RUNNING) return false;
    this.#state = COMPLETED;
    return true;
  }
}

/** `AppState.question_import_cancellations`：每个插件实例一张表（Rust 每个 AppState 一张）。 */
export class QuestionImportCancellations {
  readonly #entries = new Map<string, QuestionImportCancellation>();

  /**
   * `DashMap::entry(id)`：空位则登记并返回新令牌；已占用返回 null，
   * 由调用方按各自命令的消息报错（流式导入与恢复的文案不同）。
   */
  register(importId: string): QuestionImportCancellation | null {
    if (this.#entries.has(importId)) return null;
    const cancellation = new QuestionImportCancellation();
    this.#entries.set(importId, cancellation);
    return cancellation;
  }

  /**
   * `import_question_bank_stream` 收尾（`commands.rs:1238-1246`）：
   * 只在表中仍是同一个令牌（`Arc::ptr_eq`）时移除，避免误删更新的一次尝试。
   */
  releaseIfCurrent(importId: string, cancellation: QuestionImportCancellation): void {
    if (this.#entries.get(importId) === cancellation) this.#entries.delete(importId);
  }

  /** `resume_question_import` 收尾（`commands.rs:1342-1344`）：无条件移除。 */
  remove(importId: string): void {
    this.#entries.delete(importId);
  }

  /**
   * `cancel_question_bank_import`（`commands.rs:1265-1275`）：
   * 未登记返回 false；否则返回 `request_cancel()` 的结果。登记项不在此处移除，
   * 由导入命令收尾时移除（Rust 同样只 clone 出 Arc）。
   */
  cancel(importId: string): boolean {
    const cancellation = this.#entries.get(importId);
    if (cancellation === undefined) return false;
    return cancellation.requestCancel();
  }

  /** 插件卸载：对每个登记项请求取消；登记项仍由各导入命令收尾时移除。 */
  cancelAll(): void {
    for (const cancellation of this.#entries.values()) cancellation.requestCancel();
  }
}
