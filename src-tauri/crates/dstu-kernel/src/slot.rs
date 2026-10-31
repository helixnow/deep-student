//! 单提供方服务槽。

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::Disposer;

/// 槽位已被占用：`provide` 的默认语义是“先注册者生效”，后来者返回该错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotOccupied;

impl fmt::Display for SlotOccupied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("service slot already occupied")
    }
}

impl std::error::Error for SlotOccupied {}

struct SlotState<T: ?Sized> {
    /// 每次安装/替换/清空都递增；旧 `Disposer` 因代号不匹配而失效。
    generation: u64,
    value: Option<Arc<T>>,
}

/// 单提供方服务槽：`static SLOT: Slot<dyn Trait> = Slot::new();`。
///
/// - [`Slot::provide`]：槽位空闲时安装并返回 [`Disposer`]；已占用时返回
///   [`SlotOccupied`]，保持“先注册者生效”（与原先 `let _ = set(..)` 一致）。
/// - [`Slot::replace`]：显式替换。替换后旧 `Disposer` 不能再清空新值。
/// - `Disposer` 被 drop 后槽位清空，可以重新 `provide`。
///
/// 锁中毒一律按 `unwrap_or_else(|p| p.into_inner())` 恢复，不 panic。
pub struct Slot<T: ?Sized> {
    state: Mutex<SlotState<T>>,
}

impl<T: ?Sized> Slot<T> {
    /// 构造空槽位（可用于 `static`）。
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(SlotState {
                generation: 0,
                value: None,
            }),
        }
    }

    /// 槽位是否已被提供。
    pub fn is_occupied(&self) -> bool {
        self.lock_state().value.is_some()
    }

    /// 取出当前实现（克隆 `Arc`，不持锁回调）。
    pub fn get(&self) -> Option<Arc<T>> {
        self.lock_state().value.clone()
    }

    fn lock_state(&self) -> MutexGuard<'_, SlotState<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clear_generation(&self, generation: u64) {
        let mut state = self.lock_state();
        if state.generation == generation {
            state.value = None;
            state.generation = state.generation.wrapping_add(1);
        }
    }
}

impl<T: ?Sized + Send + Sync + 'static> Slot<T> {
    /// 提供实现。槽位已占用时返回 [`SlotOccupied`]，不覆盖先注册者。
    pub fn provide(&'static self, value: Arc<T>) -> Result<Disposer, SlotOccupied> {
        let mut state = self.lock_state();
        if state.value.is_some() {
            return Err(SlotOccupied);
        }
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        state.value = Some(value);
        drop(state);
        Ok(Disposer::new(move || self.clear_generation(generation)))
    }

    /// 替换实现，返回新实现的 [`Disposer`]；旧 `Disposer` 从此失效。
    pub fn replace(&'static self, value: Arc<T>) -> Disposer {
        let mut state = self.lock_state();
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        state.value = Some(value);
        drop(state);
        Disposer::new(move || self.clear_generation(generation))
    }
}

impl<T: ?Sized> Default for Slot<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: ?Sized> fmt::Debug for Slot<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Slot")
            .field("occupied", &self.is_occupied())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::Slot;
    use std::sync::Arc;

    trait Service: Send + Sync {
        fn id(&self) -> u8;
    }

    struct Fixed(u8);

    impl Service for Fixed {
        fn id(&self) -> u8 {
            self.0
        }
    }

    fn slot() -> &'static Slot<dyn Service> {
        Box::leak(Box::new(Slot::new()))
    }

    #[test]
    fn first_registration_wins() {
        let slot = slot();
        assert!(!slot.is_occupied());
        assert!(slot.get().is_none());

        let _first = slot.provide(Arc::new(Fixed(1))).expect("first provide");
        assert!(slot.is_occupied());
        assert_eq!(slot.get().expect("occupied").id(), 1);

        assert_eq!(
            slot.provide(Arc::new(Fixed(2))).unwrap_err(),
            super::SlotOccupied
        );
        assert_eq!(slot.get().expect("occupied").id(), 1, "先注册者生效");
    }

    #[test]
    fn dropping_disposer_frees_the_slot_for_a_new_provider() {
        let slot = slot();
        let first = slot.provide(Arc::new(Fixed(1))).expect("first provide");
        drop(first);
        assert!(!slot.is_occupied());

        let _second = slot
            .provide(Arc::new(Fixed(7)))
            .expect("provide after drop");
        assert_eq!(slot.get().expect("occupied").id(), 7);
    }

    #[test]
    fn replace_invalidates_the_old_disposer() {
        let slot = slot();
        let old = slot.provide(Arc::new(Fixed(1))).expect("first provide");
        let _new = slot.replace(Arc::new(Fixed(2)));
        assert_eq!(slot.get().expect("occupied").id(), 2);

        drop(old);
        assert_eq!(
            slot.get()
                .expect("stale disposer must not clear new value")
                .id(),
            2
        );
    }

    #[test]
    fn replace_disposer_clears_the_replacement() {
        let slot = slot();
        let _first = slot.provide(Arc::new(Fixed(1))).expect("first provide");
        let replacement = slot.replace(Arc::new(Fixed(2)));
        replacement.dispose();
        assert!(!slot.is_occupied());
    }

    #[test]
    fn poisoned_slot_recovers() {
        let slot = slot();
        // 让持锁线程 panic，把 Mutex 置为中毒状态。
        let _ = std::thread::spawn(move || {
            let _guard = slot.state.lock().unwrap();
            panic!("poison slot");
        })
        .join();

        let _disposer = slot
            .provide(Arc::new(Fixed(3)))
            .expect("provide after poison");
        assert_eq!(slot.get().expect("occupied").id(), 3);
    }
}
