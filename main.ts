// GTA VI trophy rarity forecast — gta6-trophy-rarity-forecast-01
// Forecasts each trophy's Exophase earn rate at the case target as five
// quantiles, scored by pinball loss on the logit scale.
//
// Model: a counts-based cohort model, not persistence.
//
//   rate(t) = earners(t) / players_tracked(t)
//
// Exophase does not refresh continuously: the page sits frozen for hours,
// then jumps — newly tracked players appear in a lump and dilute every
// rate, because a player who only just synced has earned almost nothing
// yet (launch night: 638 tracked, frozen for hours, then 3,868 tracked
// and every rate but the universal 100% one fell). So the forecast is
// built from counts, in two regimes:
//
//   * Flat history (one distinct snapshot, e.g. the practice cases):
//     no trend is visible, but a refresh is likely — the page has not
//     changed for hours, refreshes come hours apart, and a refresh
//     multiplies the tracked count several-fold while new players earn
//     ~nothing yet (except a trophy everyone earns). The median is the
//     dilution of the last rate by the expected growth factor, and the
//     spread is wide enough to cover "refresh lands" vs "no refresh".
//   * Rich history (several distinct snapshots, e.g. the final case):
//     the tracked count and the earner counts are extrapolated in
//     log(1 + hours since release) space, the new-cohort earn fraction
//     is measured from the observed refresh jumps, and the median blends
//     the earner-trend forecast with a dilution-only forecast. Spread
//     comes from fit residuals plus refresh risk.
//
// Only the Node standard library is used. No network, no randomness:
// the same case always yields the same bytes.

import * as fs from "node:fs";
import * as path from "node:path";

const Z: number[] = [-1.645, -0.674, 0, 0.674, 1.645];
const LEVELS: number[] = [0.05, 0.25, 0.5, 0.75, 0.95];

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function logitPct(ratePct: number): number {
  const p = clamp(ratePct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogitPct(l: number): number {
  const v = 1 / (1 + Math.exp(-clamp(l, -12, 12)));
  return clamp(v * 100, 0.01, 99.99);
}

function round4(x: number): number {
  const r = Math.round(x * 10000) / 10000;
  return clamp(r, 0.01, 99.99);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// Least-squares slope of y on x. Returns { slope, intercept }.
function linfit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? ys[0] : 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return { slope: 0, intercept: my };
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

interface Trophy {
  id: number;
  tier: string;
}

interface Read {
  atMs: number;
  players: number;
  rates: (number | null)[];
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

// Collapse consecutive identical reads into snapshots: Exophase pages sit
// frozen between refreshes, so the repeated reads carry no new signal.
// Keep the FIRST time a state appears (closest to the refresh that made it).
function snapshots(history: Read[]): Read[] {
  const out: Read[] = [];
  let prevKey = "";
  for (const h of history) {
    const key = h.players + "|" + h.rates.map((r) => (r === null ? "" : r)).join(",");
    if (key !== prevKey) {
      out.push(h);
      prevKey = key;
    }
  }
  return out;
}

function forecastCase(c: Case): { id: number; q: number[] }[] {
  const trophies = c.trophies || [];
  const nTr = trophies.length;
  const history = (c.history || []).slice().sort((a, b) => a.atMs - b.atMs);
  const checkpointMs = Date.parse(c.at);
  const horizonMin = typeof c.horizon_minutes === "number" && c.horizon_minutes > 0
    ? c.horizon_minutes
    : 90;
  const horizonDays = horizonMin / 1440;
  const horizonH = horizonMin / 60;
  const targetMs = Number.isFinite(Date.parse(c.target))
    ? Date.parse(c.target)
    : checkpointMs + horizonMin * 60000;

  // Hours since release; fall back to the first read when no release date.
  let releaseMs = c.game && c.game.release_date ? Date.parse(c.game.release_date) : NaN;
  if (!Number.isFinite(releaseMs)) {
    releaseMs = history.length > 0 ? history[0].atMs : checkpointMs;
  }
  const hoursSince = (ms: number): number => Math.max(0, (ms - releaseMs) / 3600000);
  const logT = (ms: number): number => Math.log1p(hoursSince(ms));

  const snaps = snapshots(history);
  const last = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const lastN = last && last.players > 0 ? last.players : 1;
  const lastRates: (number | null)[] = last ? last.rates : [];
  const globalLastRate = (() => {
    const vals: number[] = [];
    for (const r of lastRates) if (typeof r === "number" && Number.isFinite(r)) vals.push(r);
    vals.sort((a, b) => a - b);
    return vals.length > 0 ? vals[Math.floor(vals.length / 2)] : 1;
  })();

  // ---- Expected tracked-player growth factor G over the horizon ----
  // Distinct snapshots with real movement in the tracked count?
  const nVaried = (() => {
    const seen = new Set<number>();
    for (const s of snaps) seen.add(s.players);
    return seen.size;
  })();

  let growthFactor = 1;
  let refreshProb = 0;
  if (snaps.length >= 3 && nVaried >= 3) {
    // Rich history: log(tracked) is roughly linear in log(1 + hours
    // since release) while the launch cohort keeps arriving; extrapolate.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of snaps) {
      if (s.players > 0) {
        xs.push(logT(s.atMs));
        ys.push(Math.log(s.players));
      }
    }
    const fit = linfit(xs, ys);
    const slope = clamp(fit.slope, 0, 2.5);
    const predLogN = fit.intercept + slope * logT(targetMs);
    const predN = Math.exp(predLogN);
    growthFactor = clamp(predN / lastN, 1, 25);
    // Refresh risk over a multi-day horizon is real but the fitted
    // growth already prices the average dilution; keep a modest term.
    refreshProb = clamp(1 - Math.exp(-horizonH / 12), 0, 0.9);
  } else {
    // Flat history: the page has not refreshed since the first read.
    // Refreshes come hours apart (rules: "hours apart"), so the longer
    // the page has sat unchanged, the more likely a refresh lands inside
    // the horizon. Weibull hazard with a ~4 h scale: P and the jump
    // size both grow with the stale time.
    const firstMs = snaps.length > 0 ? snaps[0].atMs : checkpointMs;
    const staleH = Math.max(0, (checkpointMs - firstMs) / 3600000);
    const scaleH = 4;
    const a = Math.pow((staleH + horizonH) / scaleH, 2);
    const b = Math.pow(staleH / scaleH, 2);
    refreshProb = clamp(1 - Math.exp(-(a - b)), 0, 0.95);
    const jump = 1 + 4.5 * Math.min((staleH + horizonH) / scaleH, 2);
    growthFactor = 1 + refreshProb * (jump - 1);
    growthFactor = clamp(growthFactor, 1, 8);
  }
  const targetN = lastN * growthFactor;

  // ---- New-cohort earn fractions, measured from observed jumps ----
  // At each snapshot transition, new players ΔN arrive and new earners
  // ΔE appear; g_i = ΔE_i / ΔN is the share of the newly tracked cohort
  // that had earned trophy i by then. Pool across transitions, shrink
  // rare trophies toward the tier mean (counts are tiny at launch).
  const tierOf: string[] = trophies.map((t) => t.tier || "bronze");
  const tiers = Array.from(new Set(tierOf));
  const transNewN: number[] = [];
  const transNewE: number[][] = []; // per transition, per trophy
  for (let k = 1; k < snaps.length; k++) {
    const prev = snaps[k - 1];
    const cur = snaps[k];
    const dN = cur.players - prev.players;
    if (dN <= 0) continue;
    transNewN.push(dN);
    const row: number[] = [];
    for (let i = 0; i < nTr; i++) {
      const rp = prev.rates[i];
      const rc = cur.rates[i];
      if (typeof rp === "number" && typeof rc === "number") {
        const ePrev = (rp / 100) * prev.players;
        const eCur = (rc / 100) * cur.players;
        row.push(Math.max(0, eCur - ePrev));
      } else {
        row.push(NaN);
      }
    }
    transNewE.push(row);
  }
  const totalNewN = transNewN.reduce((s, v) => s + v, 0);
  const hasTransitions = totalNewN > 0 && transNewE.length > 0;

  // Pooled new-cohort rate per tier (for shrinkage).
  const tierPool = new Map<string, number>();
  for (const tier of tiers) {
    let e = 0;
    let n = 0;
    for (let k = 0; k < transNewE.length; k++) {
      for (let i = 0; i < nTr; i++) {
        if (tierOf[i] !== tier) continue;
        const v = transNewE[k][i];
        if (Number.isFinite(v)) {
          e += v;
          n += transNewN[k];
        }
      }
    }
    tierPool.set(tier, n > 0 ? e / n : 0);
  }

  // Per-trophy series over snapshots (non-null reads only).
  interface Pt { lt: number; n: number; rate: number; earners: number }
  const series: Pt[][] = [];
  for (let i = 0; i < nTr; i++) {
    const pts: Pt[] = [];
    for (const s of snaps) {
      const r = s.rates[i];
      if (typeof r === "number" && Number.isFinite(r) && s.players > 0) {
        pts.push({ lt: logT(s.atMs), n: s.players, rate: r, earners: (r / 100) * s.players });
      }
    }
    series.push(pts);
  }

  // Tier-median logit slope of earners on log-time (for shrinkage).
  const tierSlope = new Map<string, number>();
  for (const tier of tiers) {
    const slopes: number[] = [];
    for (let i = 0; i < nTr; i++) {
      if (tierOf[i] !== tier) continue;
      const pts = series[i].filter((p) => p.earners > 0);
      if (pts.length >= 3) {
        const fit = linfit(pts.map((p) => p.lt), pts.map((p) => Math.log(p.earners + 0.5)));
        slopes.push(clamp(fit.slope, -0.5, 3));
      }
    }
    slopes.sort((a, b) => a - b);
    tierSlope.set(tier, slopes.length > 0 ? slopes[Math.floor(slopes.length / 2)] : 0.5);
  }

  const out: { id: number; q: number[] }[] = [];
  for (let i = 0; i < nTr; i++) {
    const tid = trophies[i].id;
    const pts = series[i];
    const lastPt = pts.length > 0 ? pts[pts.length - 1] : null;
    const rLast = lastPt ? lastPt.rate : globalLastRate;
    const eLast = lastPt ? lastPt.earners : (rLast / 100) * lastN;
    const lLast = logitPct(rLast);

    // New-cohort earn fraction f_i (percent).
    let fPct: number;
    if (hasTransitions) {
      let e = 0;
      let n = 0;
      for (let k = 0; k < transNewE.length; k++) {
        const v = transNewE[k][i];
        if (Number.isFinite(v)) {
          e += v;
          n += transNewN[k];
        }
      }
      const gPool = tierPool.get(tierOf[i]) ?? 0;
      // Shrink toward the tier pool with a 200-player pseudo-count.
      const g = (e + 200 * gPool) / (n + 200);
      // New joiners get up to the full horizon to play, so their earn
      // share by the target is a little above what past joiners showed.
      fPct = clamp(g * (1 + 0.25 * Math.min(horizonDays, 5)) * 100, 0, 98);
    } else {
      // No jump ever observed: new players have earned ~nothing yet,
      // except a trophy essentially everyone earns (rate ~100%).
      fPct = rLast * (0.06 + 0.94 * Math.pow(clamp(rLast, 0, 100) / 100, 6));
    }

    // ---- Median rate ----
    let medPct: number;
    let residSd = 0.55; // flat history: regime unknown, stay honest
    if (snaps.length >= 3 && nVaried >= 3 && pts.filter((p) => p.earners > 0).length >= 3) {
      // Earner-trend forecast: log(earners) vs log(1 + hours), anchored
      // on the last snapshot, slope shrunk toward the tier median.
      const epts = pts.filter((p) => p.earners > 0);
      const fit = linfit(epts.map((p) => p.lt), epts.map((p) => Math.log(p.earners + 0.5)));
      const w = epts.length;
      const slopeOwn = clamp(fit.slope, -0.5, 3);
      const slopeTier = tierSlope.get(tierOf[i]) ?? 0.5;
      const slope = (w * slopeOwn + 2 * slopeTier) / (w + 2);
      const ltLast = epts[epts.length - 1].lt;
      const ltTarget = logT(targetMs);
      let eTrend = (eLast + 0.5) * Math.exp(slope * (ltTarget - ltLast)) - 0.5;
      eTrend = clamp(eTrend, eLast, targetN);
      const rateTrend = (eTrend / targetN) * 100;
      // Dilution-only forecast: old earners frozen, new cohort at f_i.
      const eDil = eLast + (fPct / 100) * (targetN - lastN);
      const rateDil = clamp((eDil / targetN) * 100, 0.01, 99.99);
      // Blend in logit space: trend 60%, dilution-only 40%.
      const lMed = 0.6 * logitPct(rateTrend) + 0.4 * logitPct(rateDil);
      medPct = invLogitPct(lMed);
      // Residual spread around the earner trend.
      const res: number[] = [];
      for (const p of epts) {
        const pred = Math.log(eLast + 0.5) + slope * (p.lt - ltLast);
        res.push(Math.log(p.earners + 0.5) - pred);
      }
      residSd = clamp(stddev(res), 0.25, 1.0);
    } else {
      // Flat history: dilute the last rate by the expected growth
      // factor (the refresh, if it lands, brings a lump of new players
      // who have earned ~nothing yet). The jump prior is set so a
      // refresh after ~4–5 h stale multiplies the tracked count ~6x,
      // as the rules describe the first refresh doing.
      medPct = (rLast + fPct * (growthFactor - 1)) / growthFactor;
      medPct = clamp(medPct, 0.01, 99.99);
      // If the trophy is universal (rate ~100%), dilution does nothing.
      if (rLast >= 99.9) medPct = 99.99;
    }

    // ---- Spread (logit SD) ----
    const sBase = 0.5 * Math.sqrt(horizonDays);
    const drift = Math.abs(logitPct(medPct) - lLast);
    let sRefresh: number;
    if (snaps.length >= 3 && nVaried >= 3) {
      sRefresh = clamp(0.3 * drift + 0.2 * refreshProb, 0, 0.6);
    } else {
      // Flat history: the refresh may or may not land, and its size is
      // uncertain — the spread must cover both outcomes.
      sRefresh = 0.55 * refreshProb * Math.max(drift, 0.5);
    }
    let s = Math.sqrt(sBase * sBase + residSd * residSd + sRefresh * sRefresh);
    // Universal trophies barely move; rare trophies are noisier.
    if (rLast >= 99.9) s = Math.min(s, 0.3);
    s = clamp(s, 0.3, 1.5);

    const lMed = logitPct(medPct);
    const q: number[] = [];
    let prev = -Infinity;
    for (let j = 0; j < LEVELS.length; j++) {
      let v = round4(invLogitPct(lMed + Z[j] * s));
      if (v < prev) v = prev;
      prev = v;
      q.push(v);
    }
    out.push({ id: tid, q });
  }

  out.sort((a, b) => a.id - b.id);
  return out;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(inDir).filter((f) => f.endsWith(".in")).sort();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(inDir, file), "utf8");
    const parsed = JSON.parse(raw);
    const c: Case = {
      id: parsed.id ?? file.replace(/\.in$/, ""),
      at: parsed.at,
      horizon_minutes: parsed.horizon_minutes,
      target: parsed.target,
      game: parsed.game || {},
      trophies: parsed.trophies || [],
      history: (parsed.history || []).map((h: any) => ({
        atMs: Date.parse(h.at ?? h.slot),
        players: typeof h.players_tracked === "number" ? h.players_tracked : 0,
        rates: Array.isArray(h.rates) ? h.rates : [],
      })),
    };
    const rows = forecastCase(c);
    const outObj = { trophies: rows };
    const outPath = path.join(outDir, file.replace(/\.in$/, ".out"));
    fs.writeFileSync(outPath, JSON.stringify(outObj));
  }
}

main();
