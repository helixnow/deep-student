#[cfg(test)]
use {
    crate::{
        alea::{alea, AleaState},
        algo::FSRS,
        models::{Card, Rating, State},
        parameters::{Parameters, Seed},
    },
    chrono::{DateTime, Duration, TimeZone, Utc},
    rand::Rng,
};

#[cfg(test)]
static TEST_RATINGS: [Rating; 13] = [
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Again,
    Rating::Again,
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Good,
    Rating::Good,
];

#[cfg(test)]
static WEIGHTS: [f64; 19] = [
    0.4197, 1.1869, 3.0412, 15.2441, 7.1434, 0.6477, 1.0007, 0.0674, 1.6597, 0.1712, 1.1178,
    2.0225, 0.0904, 0.3025, 2.1214, 0.2498, 2.9466, 0.4891, 0.6468,
];

#[cfg(test)]
fn string_to_utc(date_string: &str) -> DateTime<Utc> {
    let datetime = DateTime::parse_from_str(date_string, "%Y-%m-%d %H:%M:%S %z %Z").unwrap();
    Utc.from_local_datetime(&datetime.naive_utc()).unwrap()
}
#[cfg(test)]
trait RoundFloat {
    fn round_float(self, precision: i32) -> f64;
}
#[cfg(test)]
impl RoundFloat for f64 {
    fn round_float(self, precision: i32) -> f64 {
        let multiplier = 10.0_f64.powi(precision);
        (self * multiplier).round() / multiplier
    }
}

#[test]
fn test_basic_scheduler_interval() {
    let fsrs = FSRS::default();
    let mut card = Card::new();
    let mut now = string_to_utc("2022-11-29 12:30:00 +0000 UTC");
    let mut interval_history = vec![];

    for rating in TEST_RATINGS.iter() {
        let next = fsrs.next(card, now, *rating);
        card = next.card;
        interval_history.push(card.scheduled_days);
        now = card.due;
    }
    let expected = [0, 4, 15, 48, 136, 351, 0, 0, 7, 13, 24, 43, 77];
    assert_eq!(interval_history, expected);
}

#[test]
fn test_basic_scheduler_state() {
    let params = Parameters {
        w: WEIGHTS,
        ..Default::default()
    };

    let fsrs = FSRS::new(params);
    let mut card = Card::new();
    let mut now = string_to_utc("2022-11-29 12:30:00 +0000 UTC");
    let mut state_list = vec![];
    let mut record_log = fsrs.repeat(card, now);

    for rating in TEST_RATINGS.iter() {
        card = record_log[rating].card.clone();
        let rev_log = record_log[rating].review_log.clone();
        state_list.push(rev_log.state);
        now = card.due;
        record_log = fsrs.repeat(card, now);
    }
    use State::*;
    let expected = [
        New, Learning, Review, Review, Review, Review, Review, Relearning, Relearning, Review,
        Review, Review, Review,
    ];
    assert_eq!(state_list, expected);
}

#[test]
fn test_basic_scheduler_memo_state() {
    let params = Parameters {
        w: WEIGHTS,
        ..Default::default()
    };

    let fsrs = FSRS::new(params);
    let mut card = Card::new();
    let mut now = string_to_utc("2022-11-29 12:30:00 +0000 UTC");
    let mut record_log = fsrs.repeat(card.clone(), now);
    let ratings = [
        Rating::Again,
        Rating::Good,
        Rating::Good,
        Rating::Good,
        Rating::Good,
        Rating::Good,
    ];
    let intervals = [0, 0, 1, 3, 8, 21];
    for (index, rating) in ratings.iter().enumerate() {
        card = record_log[rating].card.clone();
        now = now + Duration::days(intervals[index] as i64);
        record_log = fsrs.repeat(card.clone(), now);
    }

    card = record_log[&Rating::Good].to_owned().card;
    assert_eq!(card.stability.round_float(4), 71.4554);
    assert_eq!(card.difficulty.round_float(4), 5.0976);
}

#[test]
fn test_long_term_scheduler() {
    let params = Parameters {
        w: WEIGHTS,
        enable_short_term: false,
        ..Default::default()
    };

    let fsrs = FSRS::new(params);
    let mut card = Card::new();
    let mut now = string_to_utc("2022-11-29 12:30:00 +0000 UTC");
    let mut interval_history = vec![];
    let mut stability_history = vec![];
    let mut difficulty_history = vec![];

    for rating in TEST_RATINGS.iter() {
        let record = fsrs.repeat(card.clone(), now)[rating].to_owned();
        let next = fsrs.next(card, now, *rating);

        assert_eq!(record.card, next.card);

        card = record.card;
        interval_history.push(card.scheduled_days);
        stability_history.push(card.stability.round_float(4));
        difficulty_history.push(card.difficulty.round_float(4));
        now = card.due;
    }

    let expected_interval = [3, 13, 48, 155, 445, 1158, 17, 3, 9, 27, 74, 190, 457];
    let expected_stability = [
        3.0412, 13.0913, 48.1585, 154.9373, 445.0556, 1158.0778, 16.6306, 2.9888, 9.4633, 26.9474,
        73.9723, 189.7037, 457.4379,
    ];
    let expected_difficulty = [
        4.4909, 4.2666, 4.0575, 3.8624, 3.6804, 3.5108, 5.219, 6.8122, 6.4314, 6.0763, 5.7452,
        5.4363, 5.1483,
    ];

    assert_eq!(interval_history, expected_interval);
    assert_eq!(stability_history, expected_stability);
    assert_eq!(difficulty_history, expected_difficulty);
}

#[test]
fn test_prng_get_state() {
    let prng_1 = alea(Seed::new(1));
    let prng_2 = alea(Seed::new(2));
    let prng_3 = alea(Seed::new(1));

    let alea_state_1 = prng_1.get_state();
    let alea_state_2 = prng_2.get_state();
    let alea_state_3 = prng_3.get_state();

    assert_eq!(alea_state_1, alea_state_3);
    assert_ne!(alea_state_1, alea_state_2);
}

#[test]
fn test_alea_get_next() {
    let seed = Seed::new(12345);
    let mut generator = alea(seed);
    assert_eq!(generator.gen_next(), 0.27138191112317145);
    assert_eq!(generator.gen_next(), 0.19615925149992108);
    assert_eq!(generator.gen_next(), 0.6810678059700876);
}

#[test]
fn test_alea_int32() {
    let seed = Seed::new(12345);
    let mut generator = alea(seed);
    assert_eq!(generator.int32(), 1165576433);
    assert_eq!(generator.int32(), 842497570);
    assert_eq!(generator.int32(), -1369803343);
}

#[test]
fn test_alea_import_state() {
    let mut rng = rand::thread_rng();
    let mut prng_1 = alea(Seed::new(rng.gen::<i32>()));
    prng_1.gen_next();
    prng_1.gen_next();
    prng_1.gen_next();
    let prng_1_state = prng_1.get_state();
    let mut prng_2 = alea(Seed::Empty).import_state(prng_1_state);

    assert_eq!(prng_1.get_state(), prng_2.get_state());

    for _ in 1..10000 {
        let a = prng_1.gen_next();
        let b = prng_2.gen_next();

        assert_eq!(a, b);
        assert!(a >= 0.0 && a < 1.0);
        assert!(b >= 0.0 && b < 1.0);
    }
}

#[test]
fn test_seed_example_1() {
    let seed = Seed::new("1727015666066");
    let mut generator = alea(seed);
    let results = generator.gen_next();
    let state = generator.get_state();

    let expect_alea_state = AleaState {
        c: 1828249.0,
        s0: 0.5888567129150033,
        s1: 0.5074866858776659,
        s2: 0.6320083506871015,
    };
    assert_eq!(results, 0.6320083506871015);
    assert_eq!(state, expect_alea_state);
}

#[test]
fn test_seed_example_2() {
    let seed = Seed::new("Seedp5fxh9kf4r0");
    let mut generator = alea(seed);
    let results = generator.gen_next();
    let state = generator.get_state();

    let expect_alea_state = AleaState {
        c: 1776946.0,
        s0: 0.6778371171094477,
        s1: 0.0770602801349014,
        s2: 0.14867847645655274,
    };
    assert_eq!(results, 0.14867847645655274);
    assert_eq!(state, expect_alea_state);
}

#[test]
fn test_seed_example_3() {
    let seed = Seed::new("NegativeS2Seed");
    let mut generator = alea(seed);
    let results = generator.gen_next();
    let state = generator.get_state();

    let expect_alea_state = AleaState {
        c: 952982.0,
        s0: 0.25224833423271775,
        s1: 0.9213257452938706,
        s2: 0.830770346801728,
    };
    assert_eq!(results, 0.830770346801728);
    assert_eq!(state, expect_alea_state);
}

#[test]
fn test_get_retrievability() {
    let fsrs = FSRS::default();
    let card = Card::new();
    let now = string_to_utc("2022-11-29 12:30:00 +0000 UTC");
    let expect_retrievability = [1.0, 1.0, 1.0, 0.9026208];
    let scheduler = fsrs.repeat(card, now);

    for (i, rating) in Rating::iter().enumerate() {
        let card = scheduler.get(rating).unwrap().card.clone();
        let retrievability = card.get_retrievability(card.due);

        assert_eq!(retrievability.round_float(7), expect_retrievability[i]);
    }
}
