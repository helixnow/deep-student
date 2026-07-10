use chrono::{DateTime, Utc};

use crate::models::State::*;
use crate::Seed;
use crate::{
    models::{RecordLog, SchedulingInfo},
    Card, Parameters, Rating, ReviewLog,
};

#[derive(Debug, Clone)]
pub struct Scheduler {
    pub parameters: Parameters,
    pub last: Card,
    pub current: Card,
    pub now: DateTime<Utc>,
    pub next: RecordLog,
}

impl Scheduler {
    pub fn new(parameters: Parameters, card: Card, now: DateTime<Utc>) -> Self {
        let mut current_card: Card = card.clone();
        current_card.elapsed_days = match card.state {
            New => 0,
            _ => (now - card.last_review).num_days(),
        };
        current_card.last_review = now;
        current_card.reps += 1;
        let mut scheduler = Self {
            parameters,
            last: card,
            current: current_card,
            now,
            next: RecordLog::new(),
        };
        scheduler.init_seed();

        scheduler
    }

    pub const fn build_log(&self, rating: Rating) -> ReviewLog {
        ReviewLog {
            rating,
            state: self.current.state,
            elapsed_days: self.current.elapsed_days,
            scheduled_days: self.current.scheduled_days,
            reviewed_date: self.now,
        }
    }

    fn init_seed(&mut self) {
        let time = self.now.timestamp_millis();
        let reps = self.current.reps;
        let mul = self.current.difficulty * self.current.stability;
        self.parameters.seed = Seed::new(format!("{}_{}_{}", time, reps, mul));
    }
}

pub trait ImplScheduler {
    fn preview(&mut self) -> RecordLog {
        Rating::iter()
            .map(|&rating| (rating, self.review(rating)))
            .collect()
    }
    fn review(&mut self, rating: Rating) -> SchedulingInfo;
}
