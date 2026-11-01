//! Watchdog：主系统之外的外部控制回路（Control Loop）。
//!
//! 持久在线的 Agent 系统光靠进程存活探测不够——许多异常不是崩溃，而是模型陷入
//! 无效循环、Worker 卡住、事件被领取后无人处理。本模块分两层：
//!
//! 1. **确定性检查**（本文件，零 LLM 成本）：启动恢复、孤儿领取回收、停滞/空转
//!    Worker 检测、订阅 TTL 清理。
//! 2. **语义判断**交给 Router：检测到“停滞/空转”时不擅自处置，而是生成一条
//!    `watchdog.*` 内部事件（最高优先级）送入 Router，由它决定重试、改派、关闭或
//!    告知用户——与文章里“由模型判断是否有实质进展”的 Watchdog Session 同构，
//!    但把昂贵的模型调用限制在真正出现异常信号的时候。

use serde::Serialize;
use serde_json::json;

use super::hub::SuperAgentHub;
use super::types::{WorkerStatus, TARGET_ROUTER};

const WATCHDOG_THREAD: &str = "system:watchdog";

const KV_LAST_PRUNE: &str = "retention:last_prune_ms";
const PRUNE_EVERY_MS: i64 = 3600 * 1000;

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub stalled_reported: usize,
    pub interrupted: usize,
    pub looping_reported: usize,
    pub orphan_claims_requeued: usize,
    pub subscriptions_expired: usize,
    pub workers_closed: usize,
    /// 按保留期清理掉的历史行数（事件 + 回复 + 已关闭 Worker）。
    pub pruned: usize,
}

impl SweepReport {
    pub fn is_quiet(&self) -> bool {
        *self == SweepReport::default()
    }
}

impl SuperAgentHub {
    /// 进程启动时调用：把上次运行遗留的在途项收敛回可处理状态。
    pub fn recover(&self) -> Result<usize, String> {
        let mut interrupted = 0;
        for w in self.store.list_workers(false)? {
            if w.status == WorkerStatus::Running {
                self.store
                    .set_worker_status(&w.id, WorkerStatus::Interrupted)?;
                interrupted += 1;
            }
        }
        // 上一进程里被领取、却没来得及完成的投递：放回队列，不消耗重试次数
        let requeued = self.store.requeue_claimed(None, i64::MAX)?;
        if interrupted > 0 {
            self.ingest_internal(
                WATCHDOG_THREAD,
                "watchdog.recovered",
                format!("应用重启：{interrupted} 个 Worker 的运行被中断，{requeued} 条在途事件已放回队列并将自动重试。"),
                "watchdog",
            )?;
        }
        if interrupted > 0 || requeued > 0 {
            self.notify.notify_one();
        }
        Ok(interrupted + requeued)
    }

    /// 一次巡检。`now` 由调用方传入以便测试。
    pub fn watchdog_sweep(&self, now: i64) -> Result<SweepReport, String> {
        let cfg = self.config();
        let mut report = SweepReport::default();

        for w in self.store.list_workers(false)? {
            // —— 1) 停滞：运行时间超过阈值
            if w.status == WorkerStatus::Running {
                if let Some(started) = w.run_started_ms {
                    if now - started > cfg.stall_secs * 1000 {
                        let marker = format!("wd:stall:{}:{}", w.id, started);
                        if self.store.kv_get(&marker)?.is_none() {
                            self.store.kv_set(&marker, "1")?;
                            let in_flight = self.is_busy(&w.id);
                            if !in_flight {
                                // 本进程里没有任何任务在跑它——运行记录是孤儿
                                self.store
                                    .set_worker_status(&w.id, WorkerStatus::Interrupted)?;
                                self.store.requeue_claimed(Some(&w.id), i64::MAX)?;
                                report.interrupted += 1;
                            }
                            self.ingest_internal(
                                WATCHDOG_THREAD,
                                "watchdog.worker_stalled",
                                format!(
                                    "Worker {} (\"{}\", 话题 {}) 已运行 {} 分钟仍未结束{}。请判断是继续等待、改派还是关闭，并视情况告知用户。",
                                    w.id,
                                    w.title,
                                    w.thread_key,
                                    (now - started) / 60_000,
                                    if in_flight { "（仍有进行中的回合）" } else { "（回合已丢失，已标记为中断并将重试）" }
                                ),
                                "watchdog",
                            )?;
                            report.stalled_reported += 1;
                        }
                    }
                }
            }

            // —— 2) 空转：连续产出相同结果
            if w.repeat_count >= cfg.repeat_threshold && w.status != WorkerStatus::Closed {
                let marker = format!("wd:loop:{}:{}", w.id, w.runs);
                if self.store.kv_get(&marker)?.is_none() {
                    self.store.kv_set(&marker, "1")?;
                    self.ingest_internal(
                        WATCHDOG_THREAD,
                        "watchdog.worker_looping",
                        format!(
                            "Worker {} (\"{}\", 话题 {}) 已连续 {} 次产出相同结果，疑似空转或没有实质进展。请判断是否应关闭、改派或向用户确认。",
                            w.id,
                            w.title,
                            w.thread_key,
                            w.repeat_count + 1
                        ),
                        "watchdog",
                    )?;
                    report.looping_reported += 1;
                }
            }

            // —— 3) 孤儿领取：被领取很久、本进程却没有任务在处理
            if !self.is_busy(&w.id) {
                let n = self
                    .store
                    .requeue_claimed(Some(&w.id), now - cfg.orphan_claim_secs * 1000)?;
                report.orphan_claims_requeued += n;
            }
        }
        if !self.is_busy(TARGET_ROUTER) {
            report.orphan_claims_requeued += self
                .store
                .requeue_claimed(Some(TARGET_ROUTER), now - cfg.orphan_claim_secs * 1000)?;
        }

        // —— 4) 订阅 TTL：长期没有事件的话题自动解除订阅，空闲 Worker 随之关闭
        for (thread, worker_id) in self
            .store
            .stale_subscriptions(now - cfg.subscription_ttl_secs * 1000)?
        {
            self.store.unsubscribe(&thread, &worker_id)?;
            report.subscriptions_expired += 1;
            if self.store.subscriptions_of(&worker_id)?.is_empty() && !self.is_busy(&worker_id) {
                self.store.close_worker(&worker_id)?;
                report.workers_closed += 1;
            }
        }

        // —— 5) 保留期：每小时最多清理一次已处理完的历史（在途投递永不清理）
        if cfg.retention_days > 0 {
            let last = self
                .store
                .kv_get(KV_LAST_PRUNE)?
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            if now - last >= PRUNE_EVERY_MS {
                self.store.kv_set(KV_LAST_PRUNE, &now.to_string())?;
                report.pruned = self
                    .store
                    .prune_before(now - cfg.retention_days * 24 * 3600 * 1000)?;
            }
        }

        if !report.is_quiet() {
            self.ports.emit_activity("watchdog_sweep", json!(report));
            self.notify.notify_one();
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::superagent::hub::test_support::*;
    use crate::chat_v2::superagent::types::{now_ms, Worker};
    use std::sync::Arc;

    fn running_worker(id: &str, thread: &str, started: i64) -> Worker {
        Worker {
            id: id.into(),
            thread_key: thread.into(),
            title: "长任务".into(),
            brief: "b".into(),
            brief_sent: true,
            session_id: Some("worker-x".into()),
            status: WorkerStatus::Running,
            created_ms: started,
            last_progress_ms: started,
            run_started_ms: Some(started),
            runs: 1,
            last_output_hash: None,
            repeat_count: 0,
        }
    }

    #[tokio::test]
    async fn recover_interrupts_running_workers_and_requeues_claims() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        hub.store
            .create_worker(&running_worker("swk_a", "t", now - 1000))
            .unwrap();
        hub.store.subscribe("t", "swk_a", now).unwrap();
        // 一条被领取后进程崩溃的事件
        hub.ingest(msg("t", "崩溃前的消息")).unwrap();
        let claimed = hub.store.claim("swk_a", 5, now).unwrap();
        assert_eq!(claimed.len(), 1);

        assert!(hub.recover().unwrap() >= 2);
        let w = hub.store.get_worker("swk_a").unwrap().unwrap();
        assert_eq!(w.status, WorkerStatus::Interrupted);
        // 事件回到 pending，且不消耗重试次数
        assert_eq!(hub.store.claim("swk_a", 5, now).unwrap().len(), 1);
        // Router 收到恢复通知
        assert_eq!(hub.store.stats().unwrap().pending_router, 1);
        // Interrupted 的 Worker 可以再次启动
        hub.store.requeue_claimed(None, i64::MAX).unwrap();
        ports.worker_says("补做完成");
        assert!(hub.step_worker("swk_a").await.unwrap());
    }

    #[tokio::test]
    async fn recover_once_does_not_interrupt_workers_started_after_first_enable() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        assert_eq!(
            hub.recover_once().unwrap(),
            0,
            "nothing to recover on a fresh store"
        );
        // 之后启动的、真正在运行的 Worker：反复开关设置不能把它误判为崩溃遗留
        let now = now_ms();
        hub.store
            .create_worker(&running_worker("swk_live", "t", now))
            .unwrap();
        hub.set_enabled(false).unwrap();
        hub.set_enabled(true).unwrap();
        assert_eq!(hub.recover_once().unwrap(), 0);
        assert_eq!(
            hub.store.get_worker("swk_live").unwrap().unwrap().status,
            WorkerStatus::Running
        );
    }

    #[test]
    fn loop_start_is_claimed_exactly_once() {
        let hub = hub_with(Arc::new(MockPorts::default()));
        assert!(hub.claim_loop_start());
        assert!(!hub.claim_loop_start());
    }

    #[tokio::test]
    async fn orphaned_running_worker_is_interrupted_and_reported_once() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        let started = now - 20 * 60 * 1000;
        hub.store
            .create_worker(&running_worker("swk_a", "t", started))
            .unwrap();

        let r1 = hub.watchdog_sweep(now).unwrap();
        assert_eq!((r1.stalled_reported, r1.interrupted), (1, 1));
        assert_eq!(
            hub.store.get_worker("swk_a").unwrap().unwrap().status,
            WorkerStatus::Interrupted
        );
        // 同一次运行不重复上报
        let r2 = hub.watchdog_sweep(now + 1000).unwrap();
        assert_eq!(r2.stalled_reported, 0);

        ports.router_says("```superagent-decisions\n{\"decisions\":[]}\n```");
        hub.step_router().await.unwrap();
        assert!(ports.router_calls()[0].contains("watchdog.worker_stalled"));
    }

    #[tokio::test]
    async fn in_flight_stall_is_reported_but_not_interrupted() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        hub.store
            .create_worker(&running_worker("swk_a", "t", now - 20 * 60 * 1000))
            .unwrap();
        let _guard = hub.try_acquire_for_test("swk_a");
        let r = hub.watchdog_sweep(now).unwrap();
        assert_eq!((r.stalled_reported, r.interrupted), (1, 0));
        assert_eq!(
            hub.store.get_worker("swk_a").unwrap().unwrap().status,
            WorkerStatus::Running
        );
    }

    #[tokio::test]
    async fn looping_worker_is_reported_once_per_run_count() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        let mut w = running_worker("swk_a", "t", now);
        w.status = WorkerStatus::Idle;
        w.run_started_ms = None;
        w.repeat_count = 2;
        w.runs = 5;
        hub.store.create_worker(&w).unwrap();
        assert_eq!(hub.watchdog_sweep(now).unwrap().looping_reported, 1);
        assert_eq!(hub.watchdog_sweep(now).unwrap().looping_reported, 0);
    }

    #[tokio::test]
    async fn idle_subscriptions_expire_and_close_workers() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        let mut w = running_worker("swk_a", "t", now);
        w.status = WorkerStatus::Idle;
        w.run_started_ms = None;
        hub.store.create_worker(&w).unwrap();
        hub.store
            .subscribe("t", "swk_a", now - 48 * 3600 * 1000)
            .unwrap();
        let r = hub.watchdog_sweep(now).unwrap();
        assert_eq!((r.subscriptions_expired, r.workers_closed), (1, 1));
        assert_eq!(
            hub.store.get_worker("swk_a").unwrap().unwrap().status,
            WorkerStatus::Closed
        );
    }

    #[tokio::test]
    async fn orphan_claims_are_requeued_after_timeout() {
        let ports = Arc::new(MockPorts::default());
        let hub = hub_with(ports.clone());
        let now = now_ms();
        hub.ingest(msg("t", "x")).unwrap();
        hub.store.claim("router", 5, now - 30 * 60 * 1000).unwrap();
        let r = hub.watchdog_sweep(now).unwrap();
        assert_eq!(r.orphan_claims_requeued, 1);
        assert_eq!(hub.store.stats().unwrap().pending_router, 1);
    }
}
