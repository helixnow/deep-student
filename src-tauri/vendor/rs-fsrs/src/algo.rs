use crate::models::{Card, Rating, RecordLog, SchedulingInfo};
use crate::parameters::Parameters;
use crate::scheduler_basic::BasicScheduler;
use crate::scheduler_longterm::LongtermScheduler;
use crate::ImplScheduler;

use chrono::{DateTime, Utc};

#[derive(Debug, Default, Clone)]
pub struct FSRS {
    parameters: Parameters,
}

impl FSRS {
    pub const fn new(parameters: Parameters) -> Self {
        Self { parameters }
    }

    pub fn scheduler(&self, card: Card, now: DateTime<Utc>) -> Box<dyn ImplScheduler> {
        if self.parameters.enable_short_term {
            Box::new(BasicScheduler::new(self.parameters.clone(), card, now))
        } else {
            Box::new(LongtermScheduler::new(self.parameters.clone(), card, now))
        }
    }

    pub fn repeat(&self, card: Card, now: DateTime<Utc>) -> RecordLog {
        self.scheduler(card, now).preview()
    }

    pub fn next(&self, card: Card, now: DateTime<Utc>, rating: Rating) -> SchedulingInfo {
        self.scheduler(card, now).review(rating)
    }
}
