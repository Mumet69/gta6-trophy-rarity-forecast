# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Mumet69/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Mumet69/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, the percent of Exophase-tracked players who will have earned it one week after launch (2026-11-26T00:00:00Z), as five quantiles per trophy, scored by pinball loss on the logit scale.

## How it works

Persistence — "rates stay where they are" — fails here because Exophase does not refresh continuously: the page sits frozen for hours, then jumps as a lump of newly tracked players appears and dilutes every rate (launch night: 638 players tracked, frozen for hours, then 3,868 tracked and every rate but the universal 100% one fell, because players who only just synced have earned almost nothing yet).

So `main.ts` is a counts-based cohort model, `rate = earners / players_tracked`:

- **Flat history** (one distinct snapshot, like the practice cases): no trend is visible, but a refresh is likely — the page has sat unchanged for hours and refreshes come hours apart. A Weibull hazard over the stale time gives the refresh probability and the expected tracked-player growth factor; the median dilutes the last rate by that growth, with new players assumed to have earned ~nothing yet (except a trophy everyone earns), and the spread is wide enough to cover "refresh lands" vs "no refresh".
- **Rich history** (several distinct snapshots, like the final case): the tracked count and each trophy's earner count are extrapolated in log(1 + hours since release) space, the new-cohort earn fraction is measured from the observed refresh jumps (shrunk toward the tier mean, since launch-night counts are tiny), and the median blends the earner-trend forecast with a dilution-only forecast. Spread comes from fit residuals plus refresh risk.

Only the Node standard library is used — no dependencies, no network, no randomness, so the same case always yields the same output.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This reads every `<id>.in` in the input directory and writes `<id>.out` (one `{"trophies": [{"id", "q": [q05, q25, q50, q75, q95]}]}` row per trophy, quantiles in percent, non-decreasing) to the output directory.

## Practice validation

On the practice cases (p00, p01 — flat launch-night histories straddling Exophase's first refresh), the model beats the persistence baseline by a wide margin. The kit ships no answer file, so the answering read was reconstructed from the facts stated in `competition.yaml` (04:30Z refresh: 3,868 players tracked, 4,276 trophies earned, trophy #2 still at 100%): two reconstructions bracket the truth — newcomers earning nothing beyond trophy #2, and the 103 remaining new earns spread in proportion to old earners. Under both, pinball loss (logit scale):

| case | this model | persistence baseline |
|---|---|---|
| p00 | 0.334 / 0.198 | 1.687 / 1.401 |
| p01 | 0.267 / 0.183 | 1.687 / 1.401 |

(The baseline's stated practice loss is ~1.51, between the two reconstructions — a sanity check on the reconstruction.) Typical miss drops from ~0.68–0.73 points to ~0.05–0.13 points, and 90% coverage rises from 0.00 to 0.98.

Built by an AI agent for make.fun's bounty, $250 in USDC.
