use crate::Seed;

#[derive(Debug, PartialEq)]
pub struct AleaState {
    pub c: f64,
    pub s0: f64,
    pub s1: f64,
    pub s2: f64,
}

impl From<Alea> for AleaState {
    fn from(alea: Alea) -> Self {
        Self {
            c: alea.c,
            s0: alea.s0,
            s1: alea.s1,
            s2: alea.s2,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Alea {
    c: f64,
    s0: f64,
    s1: f64,
    s2: f64,
}

impl Alea {
    fn new(seed: Seed) -> Self {
        let mut mash = Mash::new();
        let blank_seed = Seed::new(" ");
        let mut alea = Self {
            c: 1.0,
            s0: mash.mash(&blank_seed),
            s1: mash.mash(&blank_seed),
            s2: mash.mash(&blank_seed),
        };

        alea.s0 -= mash.mash(&seed);
        if alea.s0 < 0.0 {
            alea.s0 += 1.0;
        }
        alea.s1 -= mash.mash(&seed);
        if alea.s1 < 0.0 {
            alea.s1 += 1.0;
        }
        alea.s2 -= mash.mash(&seed);
        if alea.s2 < 0.0 {
            alea.s2 += 1.0;
        }

        alea
    }
}

impl Iterator for Alea {
    type Item = f64;

    fn next(&mut self) -> Option<Self::Item> {
        let t = 2091639.0f64.mul_add(self.s0, self.c * TWO_TO_THE_POWER_OF_MINUS_32);
        self.s0 = self.s1;
        self.s1 = self.s2;
        self.c = t.floor();
        self.s2 = t - self.c;

        Some(self.s2)
    }
}

impl From<AleaState> for Alea {
    fn from(state: AleaState) -> Self {
        Self {
            c: state.c,
            s0: state.s0,
            s1: state.s1,
            s2: state.s2,
        }
    }
}

const TWO_TO_THE_POWER_OF_32: u64 = 1 << 32;
const TWO_TO_THE_POWER_OF_21: u64 = 1 << 21;
const TWO_TO_THE_POWER_OF_MINUS_32: f64 = 1.0 / (TWO_TO_THE_POWER_OF_32 as f64);
const TWO_TO_THE_POWER_OF_MINUS_53: f64 = 1.0 / ((1u64 << 53) as f64);

struct Mash {
    n: f64,
}

impl Mash {
    const N: u64 = 0xefc8249d;
    const fn new() -> Self {
        Self { n: Self::N as f64 }
    }

    fn mash(&mut self, seed: &Seed) -> f64 {
        let mut n: f64 = self.n;
        for c in seed.inner_str().chars() {
            n += c as u32 as f64;
            let mut h = 0.02519603282416938 * n;
            n = (h as u32) as f64;
            h -= n;
            h *= n;
            n = (h as u32) as f64;
            h -= n;
            n += h * TWO_TO_THE_POWER_OF_32 as f64;
        }
        self.n = n;
        self.n * TWO_TO_THE_POWER_OF_MINUS_32 // 2^-32
    }
}

#[derive(Debug)]
pub struct Prng {
    pub xg: Alea,
}

impl Prng {
    fn new(seed: Seed) -> Self {
        Self {
            xg: Alea::new(seed),
        }
    }

    pub fn gen_next(&mut self) -> f64 {
        self.xg.next().unwrap()
    }

    pub fn int32(&mut self) -> i32 {
        wrap_to_i32(self.gen_next() * TWO_TO_THE_POWER_OF_32 as f64)
    }

    pub fn double(&mut self) -> f64 {
        ((self.gen_next() * TWO_TO_THE_POWER_OF_21 as f64) as u64 as f64)
            .mul_add(TWO_TO_THE_POWER_OF_MINUS_53, self.gen_next())
    }

    pub fn get_state(&self) -> AleaState {
        self.xg.into()
    }

    pub fn import_state(mut self, state: impl Into<Alea>) -> Self {
        self.xg = state.into();
        self
    }
}

// The rem_euclid() wraps within a positive range, then casting u32 to i32 makes half of that range negative.
fn wrap_to_i32(input: f64) -> i32 {
    input.rem_euclid((u32::MAX as f64) + 1.0) as u32 as i32
}

pub fn alea(seed: Seed) -> Prng {
    match seed {
        Seed::String(_) => Prng::new(seed),
        Seed::Empty => Prng::new(Seed::default()),
        Seed::Default => Prng::new(Seed::default()),
    }
}
