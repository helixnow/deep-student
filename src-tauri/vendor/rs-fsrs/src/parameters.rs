use chrono::Utc;

use crate::alea;
use crate::Rating;

type Weights = [f64; 19];
const DEFAULT_WEIGHTS: Weights = [
    0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813,
    0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567,
];

#[derive(Debug, Clone)]
pub struct Parameters {
    pub request_retention: f64,
    pub maximum_interval: i32,
    pub w: Weights,
    pub decay: f64,
    pub factor: f64,
    pub enable_short_term: bool,
    pub enable_fuzz: bool,
    pub seed: Seed,
}

impl Parameters {
    pub const DECAY: f64 = -0.5;
    /// (9/10) ^ (1 / DECAY) - 1
    pub const FACTOR: f64 = 19f64 / 81f64;

    pub fn forgetting_curve(elapsed_days: f64, stability: f64) -> f64 {
        (1.0 + Self::FACTOR * elapsed_days / stability).powf(Self::DECAY)
    }

    pub fn init_difficulty(&self, rating: Rating) -> f64 {
        let rating_int: i32 = rating as i32;

        (self.w[4] - f64::exp(self.w[5] * (rating_int as f64 - 1.0)) + 1.0).clamp(1.0, 10.0)
    }

    pub fn init_stability(&self, rating: Rating) -> f64 {
        let rating_int: i32 = rating as i32;
        self.w[(rating_int - 1) as usize].max(0.1)
    }

    #[allow(clippy::suboptimal_flops)]
    pub fn next_interval(&self, stability: f64, elapsed_days: i64) -> f64 {
        let new_interval = (stability / Self::FACTOR
            * (self.request_retention.powf(1.0 / Self::DECAY) - 1.0))
            .round()
            .clamp(1.0, self.maximum_interval as f64);
        self.apply_fuzz(new_interval, elapsed_days)
    }

    pub fn next_difficulty(&self, difficulty: f64, rating: Rating) -> f64 {
        let rating_int = rating as i32;
        let next_difficulty = self.w[6].mul_add(-(rating_int as f64 - 3.0), difficulty);
        let mean_reversion =
            self.mean_reversion(self.init_difficulty(Rating::Easy), next_difficulty);
        mean_reversion.clamp(1.0, 10.0)
    }

    pub fn short_term_stability(&self, stability: f64, rating: Rating) -> f64 {
        let rating_int = rating as i32;
        stability * f64::exp(self.w[17] * (rating_int as f64 - 3.0 + self.w[18]))
    }

    pub fn next_recall_stability(
        &self,
        difficulty: f64,
        stability: f64,
        retrievability: f64,
        rating: Rating,
    ) -> f64 {
        let modifier = match rating {
            Rating::Hard => self.w[15],
            Rating::Easy => self.w[16],
            _ => 1.0,
        };

        stability
            * (((self.w[8]).exp()
                * (11.0 - difficulty)
                * stability.powf(-self.w[9])
                * (((1.0 - retrievability) * self.w[10]).exp_m1()))
            .mul_add(modifier, 1.0))
    }

    pub fn next_forget_stability(
        &self,
        difficulty: f64,
        stability: f64,
        retrievability: f64,
    ) -> f64 {
        self.w[11]
            * difficulty.powf(-self.w[12])
            * ((stability + 1.0).powf(self.w[13]) - 1.0)
            * f64::exp((1.0 - retrievability) * self.w[14])
    }

    fn mean_reversion(&self, initial: f64, current: f64) -> f64 {
        self.w[7].mul_add(initial, (1.0 - self.w[7]) * current)
    }

    fn apply_fuzz(&self, interval: f64, elapsed_days: i64) -> f64 {
        if !self.enable_fuzz || interval < 2.5 {
            return interval;
        }

        let mut generator = alea(self.seed.clone());
        let fuzz_factor = generator.double();
        let (min_interval, max_interval) =
            FuzzRange::get_fuzz_range(interval, elapsed_days, self.maximum_interval);

        fuzz_factor.mul_add(
            max_interval as f64 - min_interval as f64 + 1.0,
            min_interval as f64,
        )
    }
}

impl Default for Parameters {
    fn default() -> Self {
        Self {
            request_retention: 0.9,
            maximum_interval: 36500,
            w: DEFAULT_WEIGHTS,
            decay: Self::DECAY,
            factor: Self::FACTOR,
            enable_short_term: true,
            enable_fuzz: false,
            seed: Seed::default(),
        }
    }
}

struct FuzzRange {
    start: f64,
    end: f64,
    factor: f64,
}

impl FuzzRange {
    const fn new(start: f64, end: f64, factor: f64) -> Self {
        Self { start, end, factor }
    }

    fn get_fuzz_range(interval: f64, elapsed_days: i64, maximum_interval: i32) -> (i64, i64) {
        let mut delta: f64 = 1.0;
        for fuzz_range in FUZZ_RANGE {
            delta += fuzz_range.factor
                * f64::max(f64::min(interval, fuzz_range.end) - fuzz_range.start, 0.0);
        }

        let i = f64::min(interval, maximum_interval as f64);
        let mut min_interval = f64::max(2.0, f64::round(i - delta));
        let max_interval: f64 = f64::min(f64::round(i + delta), maximum_interval as f64);

        if i > elapsed_days as f64 {
            min_interval = f64::max(min_interval, elapsed_days as f64 + 1.0);
        }

        min_interval = f64::min(min_interval, max_interval);

        (min_interval as i64, max_interval as i64)
    }
}

const FUZZ_RANGE: [FuzzRange; 3] = [
    FuzzRange::new(2.5, 7.0, 0.15),
    FuzzRange::new(7.0, 20.0, 0.1),
    FuzzRange::new(20.0, f64::MAX, 0.05),
];

#[derive(Debug, Clone)]
pub enum Seed {
    String(String),
    Empty,
    Default,
}

impl Seed {
    pub fn new<T>(value: T) -> Self
    where
        T: std::fmt::Display,
    {
        if value.to_string().is_empty() {
            Self::default()
        } else {
            Self::String(value.to_string())
        }
    }

    pub fn inner_str(&self) -> &str {
        match self {
            Self::String(str) => str,
            Self::Empty => Self::Default.inner_str(),
            Self::Default => Self::Default.inner_str(),
        }
    }
}

impl std::fmt::Display for Seed {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.inner_str())
    }
}

impl From<&Seed> for String {
    fn from(d: &Seed) -> Self {
        d.inner_str().to_string()
    }
}

impl From<i32> for Seed {
    fn from(num: i32) -> Self {
        Self::String(num.to_string())
    }
}

impl From<String> for Seed {
    fn from(s: String) -> Self {
        Self::String(s)
    }
}

impl<'a> From<&'a str> for Seed {
    fn from(s: &'a str) -> Self {
        Self::String(s.to_string())
    }
}

impl Default for Seed {
    fn default() -> Self {
        Self::String(Utc::now().timestamp_millis().to_string())
    }
}
