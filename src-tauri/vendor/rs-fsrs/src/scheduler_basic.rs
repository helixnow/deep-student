use chrono::{DateTime, Duration, Utc};

use crate::{scheduler::Scheduler, Card, ImplScheduler, Parameters, Rating, SchedulingInfo};
use crate::{Rating::*, State::*};
pub struct BasicScheduler {
    pub scheduler: Scheduler,
}

impl BasicScheduler {
    pub fn new(parameters: Parameters, card: Card, now: DateTime<Utc>) -> Self {
        Self {
            scheduler: Scheduler::new(parameters, card, now),
        }
    }
    fn new_state(&mut self, rating: Rating) -> SchedulingInfo {
        if let Some(exist) = self.scheduler.next.get(&rating) {
            return exist.clone();
        }

        let mut next = self.scheduler.current.clone();
        next.difficulty = self.scheduler.parameters.init_difficulty(rating);
        next.stability = self.scheduler.parameters.init_stability(rating);

        match rating {
            Again => {
                next.scheduled_days = 0;
                next.due = self.scheduler.now + Duration::minutes(1);
                next.state = Learning;
            }
            Hard => {
                next.scheduled_days = 0;
                next.due = self.scheduler.now + Duration::minutes(5);
                next.state = Learning;
            }
            Good => {
                next.scheduled_days = 0;
                next.due = self.scheduler.now + Duration::minutes(10);
                next.state = Learning;
            }
            Easy => {
                let easy_interval = self
                    .scheduler
                    .parameters
                    .next_interval(next.stability, next.elapsed_days);
                next.scheduled_days = easy_interval as i64;
                next.due = self.scheduler.now + Duration::days(easy_interval as i64);
                next.state = Review;
            }
        };
        let item = SchedulingInfo {
            card: next,
            review_log: self.scheduler.build_log(rating),
        };

        self.scheduler.next.insert(rating, item.clone());
        item
    }

    fn learning_state(&mut self, rating: Rating) -> SchedulingInfo {
        if let Some(exist) = self.scheduler.next.get(&rating) {
            return exist.clone();
        }

        let mut next = self.scheduler.current.clone();
        let interval = self.scheduler.current.elapsed_days;
        next.difficulty = self
            .scheduler
            .parameters
            .next_difficulty(self.scheduler.last.difficulty, rating);
        next.stability = self
            .scheduler
            .parameters
            .short_term_stability(self.scheduler.last.stability, rating);

        match rating {
            Again => {
                next.scheduled_days = 0;
                next.due = self.scheduler.now + Duration::minutes(5);
                next.state = self.scheduler.last.state;
            }
            Hard => {
                next.scheduled_days = 0;
                next.due = self.scheduler.now + Duration::minutes(10);
                next.state = self.scheduler.last.state;
            }
            Good => {
                let good_interval = self
                    .scheduler
                    .parameters
                    .next_interval(next.stability, interval);
                next.scheduled_days = good_interval as i64;
                next.due = self.scheduler.now + Duration::days(good_interval as i64);
                next.state = Review;
            }
            Easy => {
                let good_stability = self
                    .scheduler
                    .parameters
                    .short_term_stability(self.scheduler.last.stability, Good);
                let good_interval = self
                    .scheduler
                    .parameters
                    .next_interval(good_stability, interval);
                let easy_interval = self
                    .scheduler
                    .parameters
                    .next_interval(next.stability, interval)
                    .max(good_interval + 1.0);
                next.scheduled_days = easy_interval as i64;
                next.due = self.scheduler.now + Duration::days(easy_interval as i64);
                next.state = Review;
            }
        }
        let item = SchedulingInfo {
            card: next,
            review_log: self.scheduler.build_log(rating),
        };

        self.scheduler.next.insert(rating, item.clone());
        item
    }

    fn review_state(&mut self, rating: Rating) -> SchedulingInfo {
        if let Some(exist) = self.scheduler.next.get(&rating) {
            return exist.clone();
        }

        let next = self.scheduler.current.clone();
        let interval = self.scheduler.current.elapsed_days;
        let stability = self.scheduler.last.stability;
        let difficulty = self.scheduler.last.difficulty;
        let retrievability = self.scheduler.last.get_retrievability(self.scheduler.now);

        let mut next_again = next.clone();
        let mut next_hard = next.clone();
        let mut next_good = next.clone();
        let mut next_easy = next;

        self.next_difficulty_stability(
            &mut next_again,
            &mut next_hard,
            &mut next_good,
            &mut next_easy,
            difficulty,
            stability,
            retrievability,
        );
        self.next_interval(
            &mut next_again,
            &mut next_hard,
            &mut next_good,
            &mut next_easy,
            interval,
        );
        self.next_state(
            &mut next_again,
            &mut next_hard,
            &mut next_good,
            &mut next_easy,
        );
        next_again.lapses += 1;

        let item_again = SchedulingInfo {
            card: next_again,
            review_log: self.scheduler.build_log(Again),
        };
        let item_hard = SchedulingInfo {
            card: next_hard,
            review_log: self.scheduler.build_log(Hard),
        };
        let item_good = SchedulingInfo {
            card: next_good,
            review_log: self.scheduler.build_log(Good),
        };
        let item_easy = SchedulingInfo {
            card: next_easy,
            review_log: self.scheduler.build_log(Easy),
        };

        self.scheduler.next.insert(Again, item_again);
        self.scheduler.next.insert(Hard, item_hard);
        self.scheduler.next.insert(Good, item_good);
        self.scheduler.next.insert(Easy, item_easy);

        self.scheduler.next.get(&rating).unwrap().to_owned()
    }

    #[allow(clippy::too_many_arguments)]
    fn next_difficulty_stability(
        &self,
        next_again: &mut Card,
        next_hard: &mut Card,
        next_good: &mut Card,
        next_easy: &mut Card,
        difficulty: f64,
        stability: f64,
        retrievability: f64,
    ) {
        next_again.difficulty = self.scheduler.parameters.next_difficulty(difficulty, Again);
        next_again.stability =
            self.scheduler
                .parameters
                .next_forget_stability(difficulty, stability, retrievability);

        next_hard.difficulty = self.scheduler.parameters.next_difficulty(difficulty, Hard);
        next_hard.stability = self.scheduler.parameters.next_recall_stability(
            difficulty,
            stability,
            retrievability,
            Hard,
        );

        next_good.difficulty = self.scheduler.parameters.next_difficulty(difficulty, Good);
        next_good.stability = self.scheduler.parameters.next_recall_stability(
            difficulty,
            stability,
            retrievability,
            Good,
        );

        next_easy.difficulty = self.scheduler.parameters.next_difficulty(difficulty, Easy);
        next_easy.stability = self.scheduler.parameters.next_recall_stability(
            difficulty,
            stability,
            retrievability,
            Easy,
        );
    }

    fn next_interval(
        &self,
        next_again: &mut Card,
        next_hard: &mut Card,
        next_good: &mut Card,
        next_easy: &mut Card,
        elapsed_days: i64,
    ) {
        let mut hard_interval = self
            .scheduler
            .parameters
            .next_interval(next_hard.stability, elapsed_days);
        let mut good_interval = self
            .scheduler
            .parameters
            .next_interval(next_good.stability, elapsed_days);
        hard_interval = hard_interval.min(good_interval);
        good_interval = good_interval.max(hard_interval + 1.0);
        let easy_interval = self
            .scheduler
            .parameters
            .next_interval(next_easy.stability, elapsed_days)
            .max(good_interval + 1.0);

        next_again.scheduled_days = 0;
        next_again.due = self.scheduler.now + Duration::minutes(5);

        next_hard.scheduled_days = hard_interval as i64;
        next_hard.due = self.scheduler.now + Duration::days(hard_interval as i64);

        next_good.scheduled_days = good_interval as i64;
        next_good.due = self.scheduler.now + Duration::days(good_interval as i64);

        next_easy.scheduled_days = easy_interval as i64;
        next_easy.due = self.scheduler.now + Duration::days(easy_interval as i64);
    }

    fn next_state(
        &self,
        next_again: &mut Card,
        next_hard: &mut Card,
        next_good: &mut Card,
        next_easy: &mut Card,
    ) {
        next_again.state = Relearning;
        next_hard.state = Review;
        next_good.state = Review;
        next_easy.state = Review;
    }
}

impl ImplScheduler for BasicScheduler {
    fn review(&mut self, rating: Rating) -> SchedulingInfo {
        match self.scheduler.last.state {
            New => self.new_state(rating),
            Learning | Relearning => self.learning_state(rating),
            Review => self.review_state(rating),
        }
    }
}
