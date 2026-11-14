# FSRS-6 / FSRS-7 offline replay

The offline replay reads a public CSV of review events. It never opens an application database or writes card states or due dates. Its copy of the pinned FSRS-7 package can be installed outside the checkout.

From the repository root with Node 24 or later:

```sh
eval_dir=$(mktemp -d /tmp/dstu-fsrs-eval.XXXXXXXX)
npm install --prefix "$eval_dir" --cache "$eval_dir/npm-cache" --ignore-scripts --no-audit --no-fund ts-fsrs@6.0.0
curl --fail --location 'https://github.com/open-spaced-repetition/fsrs-rs/files/15046782/revlog.csv' -o "$eval_dir/revlog.csv"
node scripts/fsrs-eval/replay.mjs "$eval_dir/revlog.csv" "$eval_dir/node_modules/ts-fsrs/package.json"
```

The [official playground](https://open-spaced-repetition.github.io/ts-fsrs/playground) links to this 123,730-row example. The script expects that sample's simple CSV layout with numeric card IDs. It excludes filtered-deck rows (state 4), sorts each card's events by time, and starts at the last recorded New event. It predicts recall before consuming each subsequent grade. Hard, Good and Easy count as recall. Same-day means the same study day (Asia/Shanghai, 04:00 rollover); the timezone is fixed to UTC+8 for the sample period.

All models use their published defaults. V6 updates memory with the application’s whole study days. Its first column also uses whole days for prediction; its second column evaluates the same V6 state with continuous time, like the statistics chart. V7 uses fractional days for both. For log loss, probabilities are bounded to [0.000001, 0.999999]; Brier score uses the original probabilities.

| Scope | Reviews | Actual recall | V6 whole-day log loss | V6 continuous log loss | V7 log loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Same study day | 25,703 | 93.22% | 0.9369 | 0.3772 | 0.2216 |
| Across study days | 87,296 | 89.65% | 0.3142 | 0.3137 | 0.3138 |

The replay used 9,793 cards and excluded 938 filtered-deck rows. First exposures initialize memory and are not scored. Same-day V6 whole-day recall is always 100%, so its log loss is particularly sensitive to the bound. Use the continuous column to compare with the chart. On cross-day reviews V7 was slightly worse than continuous V6 on both log loss and Brier score (0.08960 versus 0.08923).

The report also gives p10/median/p90 raw days to the 90% target after each scored event. Same-day median raw intervals were 1.90 days (V6) and 0.81 days (V7); across-day medians were 19.85 and 24.65 days. The paired cross-day interval ratio had a median of 0.99× and a p10–p90 range of 0.25×–2.93×. These are theoretical intervals on the observed histories, before any learning steps, rounding, fuzzing or daily limits. The sample does not establish what the live workload or recall would be under a different schedule, or how either model performs after personal optimization.


## Isolated Electron desktop trial

From the Node checkout with the application dependencies installed:

```sh
node scripts/fsrs-eval/desktop.mjs
node scripts/fsrs-eval/desktop.mjs --resume '<trial directory printed at launch>'
node scripts/fsrs-eval/desktop.mjs --smoke
```

The launcher starts the real desktop in debug mode. It creates a new local trial directory containing a separate Node Host data directory and Chromium profile. Resume takes only a directory created by this launcher and reuses its data and UI origin. Open Flashcards from the workbench app launcher. Preview, scheduling, undo, current estimated recall and each segment of the single-card history use the [V7 model](https://open-spaced-repetition.github.io/ts-fsrs/guide/model/fsrs-7) from the application's pinned `ts-fsrs@6.0.0`. The observed answer rate uses the first formal review of each card per study day. The V6 optimizer, exam sprint and importing pre-scheduled card states are unavailable in the trial. Normal desktop startup still uses V6.

The smoke command uses a new trial directory. It creates its test card using normal app commands, opens and grades it through the UI, compares the due time to the preview, undoes and repeats the rating, and opens the statistics and single-card history. It verifies SQLite and the live renderer IPC responses and saves screenshots in that trial directory.

## Isolated Node Host workload comparison

After downloading the public CSV above, run from the checkout with the application dependencies installed:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/fsrs-eval/trial.mjs "$eval_dir/revlog.csv"
```

The runner creates its own temporary directory with a separate SQLite database per model and per run. It uses the normal V6 plugin and the same V7 implementation as the isolated desktop. It checks preview, grading and undo before comparing the two schedules; it accepts no application data directory.

The simulation reuses the same 300 public cards and the same sequence of recorded grades per card, applying each card's next grade when the respective scheduler offers that card. It selects evenly across numeric card IDs with at least 40 grades since the last New event. Both models use published default weights, 90% target retention, 04:00 Asia/Shanghai rollover, 1 and 10 minute learning steps, a 10 minute relearning step, 20 new cards and up to 200 regular reviews per day, due order, and no fuzz or mastery bias. The daily window is 08:00–22:00; each recorded grade advances the clock by three seconds. These are model comparisons under the same application policy. They do not use the upstream package's complete scheduler.

`report.json` includes checks and interval/workload summaries; `daily.csv` contains counts by day and review stage. Total actions include new, learning, regular review and relearning grades. Scheduled interval quantiles cover all ratings that result in a card entering or staying in regular review. Once a card needs a grade that was never observed, it is suspended in that trial database and counted under `ratingsUnavailable`. The report separates the common prefix before any such suspension; full-horizon totals are descriptive and increasingly subject to missing ratings. Because the exercise holds each card's grade sequence fixed even when the scheduled time changes, it compares workload conditional on those sequences. It does not measure recall under the new schedule or forecast an individual user's workload.


To explain a completed trial without rerunning the workload or changing its databases:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/fsrs-eval/diagnose.mjs \
  /tmp/dstu-fsrs-trial-XXXXXX/report.json "$eval_dir/node_modules/ts-fsrs/package.json"
```

The diagnosis reads only databases created by that trial. It checks the persisted logs against daily counts, then groups the common complete window by grade, phase before the grade, and same/across study days (first exposure is separate). It pairs each card's nth recorded grade across the two trials. It also evaluates both models on each lane's fixed timestamps and rating histories separately, checking that each lane's native model reproduces all its original due times. That control distinguishes model differences from the effect of previously diverging schedules. `breakdown.json` contains counts and the fixed-clock results; `card-schedules.md` aligns every recorded event in the 90-day window for four illustrative cards. The sample IDs are specific to the public CSV above.
