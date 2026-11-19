/* Structure Desk analysis engine.
   Transparent OHLC heuristics. No performance or probability claims. */

const definitions = [
  ['Order Block', 'Last opposing candle before a body larger than 1.5 ATR that breaks a confirmed swing. Uninvalidated zones are entry candidates; fresher zones (fewer revisits) rank higher.'],
  ['Fair Value Gap', 'Three-candle gap: current low exceeds the high two bars earlier (bullish), or current high is below the earlier low (bearish). Fully traversed gaps are removed; partial fills are tracked.'],
  ['Break of Structure', 'Close crosses the latest confirmed swing in the prevailing swing trend direction.'],
  ['Change of Character', 'First close across an opposing confirmed swing against the prevailing structure.'],
  ['Market Structure Shift', 'A change of character with a candle body greater than 1.5 ATR.'],
  ['Liquidity Sweep', 'Wick passes the latest confirmed swing and the candle closes back inside.'],
  ['Liquidity Grab', 'A sweep with a rejection wick larger than its body; a narrower subset of the sweep heuristic.'],
  ['Breaker Block', 'An order block closed through its far edge, then retested from the opposing side.'],
  ['Mitigation Block', 'An uninvalidated order block revisited after at least three candles, with a close on its directional side.'],
  ['Premium / Discount', 'Position relative to the midpoint of the last 60 candles. Above is premium; below is discount.'],
  ['Equal Highs / Lows', 'Two confirmed swing prices within 0.15 ATR. Potential liquidity pools, not confirmed resting orders.'],
  ['Displacement', 'Directional candle body exceeds 1.5 times the preceding Wilder ATR (14). Volume above 1.5× its 20-bar average strengthens it.'],
  ['Inducement', 'Heuristic: a minor confirmed swing inside the 60-bar range is swept before a displacement. This interpretation is subjective.'],
  ['Balanced Price Range', 'A price overlap between opposing three-candle gaps formed within the last 20 candles.']
];

/* Weighted factors that make up the directional score (max 10 points). */
const factorDocs = [
  ['Swing structure', 2, 'Direction of the most recent confirmed break of a swing high or low.'],
  ['Higher-timeframe trend', 2, 'Structure and EMA (21) direction on candles aggregated to the next timeframe up (for example 1H → 4H).'],
  ['EMA trend (20 / 50)', 1, 'Close above a rising-order EMA 20 > EMA 50 is bullish; the mirror is bearish.'],
  ['Premium / discount', 1, 'Below 45% of the 60-candle range favours longs; above 55% favours shorts.'],
  ['Recent structure break', 1.5, 'Latest BOS, CHoCH or MSS within 20 candles.'],
  ['Liquidity sweep', 1, 'Latest sweep of a swing within 12 candles, in the direction of the rejection.'],
  ['Displacement', 1, 'Latest displacement within 10 candles. Full weight with above-average volume, half weight without.'],
  ['Momentum (RSI 14)', 0.5, 'RSI above 55 is bullish, below 45 bearish, otherwise neutral.']
];
const MAX_POINTS = factorDocs.reduce((s, f) => s + f[1], 0);

/* ---------- indicator helpers ---------- */
function emaSeries(values, len) {
  const out = Array(values.length).fill(null);
  if (values.length < len) return out;
  let prev = 0;
  for (let i = 0; i < len; i++) prev += values[i];
  prev /= len; out[len - 1] = prev;
  const k = 2 / (len + 1);
  for (let i = len; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function rsiSeries(closes, len = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= len; loss /= len;
  const val = () => loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  out[len] = val();
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = val();
  }
  return out;
}

/* Wilder ATR. out[i] is the ATR including bar i. */
function atrSeries(data, len = 14) {
  const tr = data.map((c, i) => i ? Math.max(c.h - c.l, Math.abs(c.h - data[i - 1].c), Math.abs(c.l - data[i - 1].c)) : c.h - c.l);
  const out = Array(data.length);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < len) { sum += tr[i]; out[i] = sum / (i + 1); }
    else out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
  }
  return out;
}

/* Group candles into higher-timeframe bars, aligned so the newest bar is complete. */
function aggregate(data, factor) {
  const out = [];
  for (let s = data.length % factor; s + factor <= data.length; s += factor) {
    const g = data.slice(s, s + factor);
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(c => c.h)), l: Math.min(...g.map(c => c.l)), c: g[g.length - 1].c, v: g.reduce((a, c) => a + (c.v || 0), 0) });
  }
  return out;
}

/* ---------- core structure detection ---------- */
function detectStructure(data) {
  const n = data.length, atr = atrSeries(data);
  const highs = [], lows = [], events = [], gaps = [], blocks = [], broken = new Set();
  let trend = 0, hi = null, lo = null;
  const vols = data.map(c => c.v || 0), hasVol = vols.some(v => v > 0);
  const relVol = i => {
    if (!hasVol || i < 20) return null;
    let s = 0; for (let j = i - 20; j < i; j++) s += vols[j];
    return s > 0 ? vols[i] / (s / 20) : null;
  };
  const event = (name, dir, i, detail, extra = {}) => events.push({ name, dir, i, detail, ...extra });

  for (let i = 4; i < n; i++) {
    const k = i - 2, c = data[i], p = data[i - 1], a = atr[i - 1];
    // Swing confirmed with two candles on either side.
    if (data.slice(k - 2, k + 3).every((x, j) => j === 2 || data[k].h > x.h)) { hi = { p: data[k].h, i: k }; highs.push(hi); }
    if (data.slice(k - 2, k + 3).every((x, j) => j === 2 || data[k].l < x.l)) { lo = { p: data[k].l, i: k }; lows.push(lo); }
    if (!trend && highs.length > 1 && lows.length > 1) {
      const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
      if (h2.p > h1.p && l2.p > l1.p) trend = 1; else if (h2.p < h1.p && l2.p < l1.p) trend = -1;
    }
    const body = Math.abs(c.c - c.o), disp = body > 1.5 * a, dir = c.c > c.o ? 1 : -1, rv = relVol(i);
    if (disp) event('Displacement', dir, i, `Body ${(body / a).toFixed(1)}× ATR${rv ? ` · volume ${rv.toFixed(1)}× avg` : ''}`, { relVol: rv });

    let swept = 0;
    if (hi && c.h > hi.p && c.c < hi.p) {
      event('Liquidity Sweep', -1, i, 'Buy-side swing swept, closed back below', { level: hi.p }); swept = -1;
      if (c.h - Math.max(c.o, c.c) > body) event('Liquidity Grab', -1, i, 'Upper wick rejection larger than body');
    }
    if (lo && c.l < lo.p && c.c > lo.p) {
      event('Liquidity Sweep', 1, i, 'Sell-side swing swept, closed back above', { level: lo.p }); swept = 1;
      if (Math.min(c.o, c.c) - c.l > body) event('Liquidity Grab', 1, i, 'Lower wick rejection larger than body');
    }
    if (swept && disp) {
      let rh = -Infinity, rl = Infinity;
      for (let j = Math.max(0, i - 60); j < i; j++) { if (data[j].h > rh) rh = data[j].h; if (data[j].l < rl) rl = data[j].l; }
      if (swept === 1 ? lo.p > rl : hi.p < rh) event('Inducement', swept, i, 'Internal swing swept, then displacement');
    }

    for (const [s, d] of [[hi, 1], [lo, -1]]) {
      if (!s || broken.has(d + ':' + s.i)) continue;
      if (d === 1 ? c.c > s.p && p.c <= s.p : c.c < s.p && p.c >= s.p) {
        broken.add(d + ':' + s.i);
        const change = trend && trend !== d;
        event(change ? 'Change of Character' : 'Break of Structure', d, i, `Close ${d === 1 ? 'above' : 'below'} swing ${d === 1 ? 'high' : 'low'}`, { level: s.p, from: s.i });
        if (change && disp) event('Market Structure Shift', d, i, 'Structure change with displacement', { level: s.p, from: s.i });
        trend = d;
        if (disp) for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          if ((data[j].c - data[j].o) * d < 0) {
            blocks.push({ name: 'Order Block', dir: d, low: data[j].l, high: data[j].h, i: j, born: i, invalid: false, touches: 0 });
            event('Order Block', d, i, 'Opposing candle before displacement break');
            break;
          }
        }
      }
    }

    if (c.l > data[i - 2].h) { gaps.push({ name: 'Fair Value Gap', dir: 1, low: data[i - 2].h, high: c.l, i, born: i, touches: 0 }); event('Fair Value Gap', 1, i, 'Bullish three-candle imbalance'); }
    if (c.h < data[i - 2].l) { gaps.push({ name: 'Fair Value Gap', dir: -1, low: c.h, high: data[i - 2].l, i, born: i, touches: 0 }); event('Fair Value Gap', -1, i, 'Bearish three-candle imbalance'); }

    for (const b of blocks) {
      if (i <= b.born) continue;
      const overlaps = c.l <= b.high && c.h >= b.low;
      if (!b.invalid && (b.dir === 1 ? c.c < b.low : c.c > b.high)) { b.invalid = true; b.failedAt = i; }
      if (b.invalid && i > b.failedAt && overlaps && (b.dir === 1 ? c.c < b.low : c.c > b.high)) event('Breaker Block', -b.dir, i, 'Failed block retested from the other side');
      if (!b.invalid && overlaps) {
        b.touches++;
        if (i > b.born + 2 && (b.dir === 1 ? c.c > b.high : c.c < b.low)) event('Mitigation Block', b.dir, i, 'Valid block revisited and held');
      }
    }
  }

  // Gap state: removed when fully traversed, otherwise track how much has been filled.
  for (const g of gaps) {
    let extreme = g.dir === 1 ? g.high : g.low;
    for (let j = g.i + 1; j < n; j++) {
      const c = data[j];
      if (c.l <= g.high && c.h >= g.low) g.touches++;
      extreme = g.dir === 1 ? Math.min(extreme, c.l) : Math.max(extreme, c.h);
    }
    g.fill = Math.min(1, Math.max(0, g.dir === 1 ? (g.high - extreme) / (g.high - g.low) : (extreme - g.low) / (g.high - g.low)));
    g.active = g.fill < 1;
  }
  return { atr, highs, lows, events, gaps, blocks, trend, relVol };
}

function emaDirection(closes, len) {
  const e = emaSeries(closes, len), n = closes.length, last = e[n - 1], prior = e[n - 4];
  if (last == null || prior == null) return 0;
  if (closes[n - 1] > last && last > prior) return 1;
  if (closes[n - 1] < last && last < prior) return -1;
  return 0;
}

function htfContext(data, factor, label) {
  const agg = aggregate(data, factor);
  if (agg.length < 30) return { trend: 0, structure: 0, ema: 0, label, bars: agg.length, note: `Not enough data for ${label} (${agg.length} bars)` };
  const structure = detectStructure(agg).trend, ema = emaDirection(agg.map(c => c.c), 21);
  const trend = structure === ema ? structure : !structure ? ema : !ema ? structure : 0;
  const word = d => d === 1 ? 'bullish' : d === -1 ? 'bearish' : 'neutral';
  return { trend, structure, ema, label, bars: agg.length, note: `${label}: structure ${word(structure)}, EMA 21 ${word(ema)}` };
}

/* ---------- main analysis ---------- */
function analyzeCandles(data, opts = {}) {
  if (data.length < 60) throw Error('At least 60 closed candles are required.');
  const n = data.length, last = data[n - 1];
  const core = detectStructure(data);
  const atr = core.atr[n - 1];
  if (!(atr > 0)) throw Error('Candles have no measurable volatility.');
  const closes = data.map(c => c.c);
  const ema20 = emaSeries(closes, 20), ema50 = emaSeries(closes, 50), ema200 = emaSeries(closes, 200);
  const rsi = rsiSeries(closes), rsiNow = rsi[n - 1];

  const rangeData = data.slice(-60);
  const top = Math.max(...rangeData.map(c => c.h)), bottom = Math.min(...rangeData.map(c => c.l)), mid = (top + bottom) / 2;
  const pos = (last.c - bottom) / (top - bottom || 1);

  const recent = core.events.filter(e => e.i >= n - 20);
  // Equal highs / lows near the latest swings.
  for (const [arr, d, label] of [[core.highs, -1, 'Equal highs'], [core.lows, 1, 'Equal lows']]) {
    outer: for (let j = arr.length - 1; j >= 0; j--) {
      if (arr[j].i < n - 60) break;
      for (let k = j - 1; k >= 0; k--) if (Math.abs(arr[j].p - arr[k].p) < atr * .15) {
        recent.push({ name: 'Equal Highs / Lows', dir: d, i: arr[j].i, level: arr[j].p, detail: `${label} within 0.15 ATR — resting liquidity likely` });
        break outer;
      }
    }
  }
  const rawRecent = core.gaps.filter(g => g.i >= n - 20);
  bpr: for (const g of rawRecent) for (const h of rawRecent)
    if (g.dir !== h.dir && Math.max(g.low, h.low) < Math.min(g.high, h.high)) { recent.push({ name: 'Balanced Price Range', dir: core.trend, i: Math.max(g.i, h.i), detail: 'Opposing gaps overlap' }); break bpr; }

  // Active zones, flagging OB + FVG overlaps as confluent.
  const zones = [...core.blocks.filter(b => !b.invalid), ...core.gaps.filter(g => g.active)].filter(z => z.i >= n - 150);
  for (const z of zones) z.confluent = zones.some(o => o !== z && o.dir === z.dir && o.name !== z.name && Math.max(o.low, z.low) < Math.min(o.high, z.high));

  const htf = opts.lite ? { trend: 0, label: 'HTF', note: 'Skipped' } : htfContext(data, opts.htfFactor || 4, opts.htfLabel || 'HTF');

  /* Factors */
  const ago = e => { const k = n - 1 - e.i; return k === 0 ? 'on the latest candle' : k === 1 ? '1 bar ago' : `${k} bars ago`; };
  const latest = (names, within) => core.events.filter(e => names.includes(e.name) && e.i >= n - within).at(-1);
  const factors = [];
  const add = (label, weight, dir, detail) => factors.push({ label, weight, dir, detail });
  const word = d => d === 1 ? 'Bullish' : d === -1 ? 'Bearish' : 'Neutral';

  add('Swing structure', 2, core.trend, core.trend ? `Last confirmed break was ${word(core.trend).toLowerCase()}` : 'No confirmed break yet');
  add('Higher-timeframe trend', opts.lite ? 0 : 2, htf.trend, htf.note);
  const e20 = ema20[n - 1], e50 = ema50[n - 1];
  const emaDir = e20 == null || e50 == null ? 0 : last.c > e50 && e20 > e50 ? 1 : last.c < e50 && e20 < e50 ? -1 : 0;
  add('EMA trend (20 / 50)', 1, emaDir, e50 == null ? 'Not enough data' : `Close ${last.c > e50 ? 'above' : 'below'} EMA 50; EMA 20 ${e20 > e50 ? 'above' : 'below'} EMA 50`);
  add('Premium / discount', 1, pos < .45 ? 1 : pos > .55 ? -1 : 0, `${Math.round(pos * 100)}% of 60-candle range${pos >= .45 && pos <= .55 ? ' · near equilibrium' : ''}`);
  const brk = latest(['Break of Structure', 'Change of Character', 'Market Structure Shift'], 20);
  add('Recent structure break', 1.5, brk ? brk.dir : 0, brk ? `${brk.name} ${ago(brk)}` : 'None in last 20 candles');
  const sweep = latest(['Liquidity Sweep'], 12);
  add('Liquidity sweep', 1, sweep ? sweep.dir : 0, sweep ? `${sweep.detail} · ${ago(sweep)}` : 'None in last 12 candles');
  const dsp = latest(['Displacement'], 10), volOk = dsp && dsp.relVol != null && dsp.relVol >= 1.5;
  add('Displacement', dsp ? (volOk ? 1 : .5) : 1, dsp ? dsp.dir : 0, dsp ? `${dsp.detail} · ${ago(dsp)}` : 'None in last 10 candles');
  add('Momentum (RSI 14)', .5, rsiNow > 55 ? 1 : rsiNow < 45 ? -1 : 0, `RSI ${rsiNow == null ? '—' : rsiNow.toFixed(1)}`);

  const long = factors.filter(f => f.dir === 1).reduce((s, f) => s + f.weight, 0);
  const short = factors.filter(f => f.dir === -1).reduce((s, f) => s + f.weight, 0);
  const maxPoints = factors.reduce((s, f) => s + f.weight, 0);
  const dir = long > short ? 1 : short > long ? -1 : (core.trend || htf.trend || 1);
  const points = Math.max(long, short), margin = Math.abs(long - short);
  const score = Math.round(points / maxPoints * 100);
  const grade = points >= 6 && margin >= 3.5 ? 'A' : points >= 4.5 && margin >= 2 ? 'B' : 'C';

  /* Entry zone: aligned, on the right side of price, prefer near, fresh and confluent. */
  const candidates = zones.filter(z => z.dir === dir && (dir === 1 ? z.high <= last.c + atr : z.low >= last.c - atr))
    .map(z => ({ z, rank: Math.abs((z.low + z.high) / 2 - last.c) / atr + z.touches * .3 - (z.confluent ? .75 : 0) }))
    .sort((a, b) => a.rank - b.rank);
  const zone = candidates[0] ? candidates[0].z : null;
  const entry = zone ? (zone.low + zone.high) / 2 : last.c;

  // Stop beyond the zone; include the latest swing only if it sits close beyond it.
  const lo = core.lows.at(-1), hi = core.highs.at(-1);
  let stop;
  if (dir === 1) {
    const base = zone ? zone.low : entry - atr;
    stop = (lo && lo.p < base && base - lo.p < atr ? lo.p : base) - atr * .25;
  } else {
    const base = zone ? zone.high : entry + atr;
    stop = (hi && hi.p > base && hi.p - base < atr ? hi.p : base) + atr * .25;
  }
  const risk = Math.abs(entry - stop);

  // Target: nearest untaken opposing liquidity (swing not yet traded through).
  const pools = (dir === 1 ? core.highs : core.lows)
    .filter(s => (dir === 1 ? s.p > entry + risk * .5 : s.p < entry - risk * .5))
    .filter(s => !data.slice(s.i + 3).some(c => dir === 1 ? c.h > s.p : c.l < s.p))
    .sort((a, b) => Math.abs(a.p - entry) - Math.abs(b.p - entry));
  const pool = pools[0];
  const tp2 = pool ? pool.p : entry + dir * risk * 2;
  const targetSource = pool ? `Untaken swing ${dir === 1 ? 'high' : 'low'} (liquidity)` : 'Fixed 2R — no untaken liquidity found';
  const tp1 = entry + dir * Math.min(risk, Math.abs(tp2 - entry));
  const rr = risk ? Math.abs(tp2 - entry) / risk : 0;

  const gates = [
    { label: 'Directional edge ≥ 2 points', pass: margin >= 2, detail: `${long.toFixed(1)} bull vs ${short.toFixed(1)} bear` },
    { label: 'Higher timeframe not opposing', pass: opts.lite || htf.trend !== -dir, detail: htf.note },
    { label: 'Active zone in bias direction', pass: !!zone, detail: zone ? `${zone.dir === 1 ? 'Bullish' : 'Bearish'} ${zone.name}${zone.confluent ? ' + overlap' : ''}` : 'No unmitigated zone near price' },
    { label: 'Entry within 2 ATR of price', pass: !!zone && Math.abs(entry - last.c) <= atr * 2, detail: `${(Math.abs(entry - last.c) / atr).toFixed(1)} ATR away` },
    { label: 'Stop size 0.3 ATR – 8% of price', pass: risk >= atr * .3 && risk / entry <= .08, detail: `${(risk / atr).toFixed(1)} ATR · ${(risk / entry * 100).toFixed(2)}%` },
    { label: 'Target ≥ 1.5R', pass: rr >= 1.5, detail: `${rr.toFixed(2)}R to target` }
  ];
  const wait = gates.some(g => !g.pass);

  const cautions = [];
  if (rsiNow > 75) cautions.push('RSI above 75 — momentum stretched; chasing longs is riskier.');
  if (rsiNow < 25) cautions.push('RSI below 25 — momentum stretched; chasing shorts is riskier.');
  if (e20 != null && Math.abs(last.c - e20) > atr * 2.5) cautions.push(`Price is ${(Math.abs(last.c - e20) / atr).toFixed(1)} ATR from EMA 20 — extended; mean reversion is common.`);
  if (atr / last.c < .001) cautions.push('Very low volatility — spreads and fees are large relative to the stop.');
  if (htf.trend && htf.trend !== core.trend && core.trend) cautions.push('Lower and higher timeframe structure disagree — counter-trend conditions.');

  return {
    atr, atrPct: atr / last.c * 100, top, bottom, mid, pos, trend: core.trend, htf, dir, long, short, points, margin, maxPoints, score, grade,
    entry, stop, tp1, tp2, rr, risk, targetSource, wait, gates, cautions, factors, zone, zones, recent,
    events: core.events, highs: core.highs, lows: core.lows, last, ema20, ema50, ema200, rsi: rsiNow, relVol: core.relVol(n - 1)
  };
}

/* Walk-forward replay: re-run the rules on each historical window using only data
   available at that time, then see what happened next. In-sample, small and fee-free. */
function walkForward(data, opts = {}) {
  const { step = 3, window = 300, expiry = 12, horizon = 48 } = opts;
  const n = data.length, trades = [];
  let i = Math.max(120, Math.min(200, n - 60));
  if (n - i < 30) i = Math.max(80, n - 60);
  for (; i < n - 1; i += step) {
    let a;
    try { a = analyzeCandles(data.slice(Math.max(0, i - window), i), { lite: true }); } catch { continue; }
    if (a.wait) continue;
    let fill = -1;
    for (let j = i; j < Math.min(n, i + expiry); j++) if (data[j].l <= a.entry && data[j].h >= a.entry) { fill = j; break; }
    if (fill < 0) { trades.push({ i, dir: a.dir, r1: null, r2: null, result: 'unfilled' }); continue; }
    let r1 = null, r2 = null, end = fill;
    for (let j = fill; j < Math.min(n, fill + horizon) && (r1 === null || r2 === null); j++) {
      const c = data[j], hitStop = a.dir === 1 ? c.l <= a.stop : c.h >= a.stop;
      const hitT1 = j > fill && (a.dir === 1 ? c.h >= a.tp1 : c.l <= a.tp1);
      const hitT2 = j > fill && (a.dir === 1 ? c.h >= a.tp2 : c.l <= a.tp2);
      if (r1 === null) { if (hitStop) r1 = -1; else if (hitT1) r1 = 1; }
      if (r2 === null) { if (hitStop) r2 = -1; else if (hitT2) r2 = a.rr; }
      end = j;
    }
    trades.push({ i, fill, dir: a.dir, r1, r2, rr: a.rr, result: r1 === null ? 'open' : r1 > 0 ? 'win' : 'loss' });
    i = Math.max(i, end - step + 1); // avoid overlapping trades
  }
  const closed1 = trades.filter(t => t.r1 !== null), closed2 = trades.filter(t => t.r2 !== null);
  const wins = closed1.filter(t => t.r1 > 0).length;
  return {
    trades, signals: trades.length, filled: trades.filter(t => t.result !== 'unfilled').length,
    wins, losses: closed1.length - wins, open: trades.filter(t => t.result === 'open').length,
    winRate: closed1.length ? wins / closed1.length : null,
    exp1: closed1.length ? closed1.reduce((s, t) => s + t.r1, 0) / closed1.length : null,
    exp2: closed2.length ? closed2.reduce((s, t) => s + t.r2, 0) / closed2.length : null,
    tested: Math.max(0, Math.ceil((n - 1 - Math.max(80, Math.min(200, n - 60))) / step))
  };
}

if (typeof module !== 'undefined') module.exports = { analyzeCandles, walkForward, definitions, factorDocs, aggregate, emaSeries, rsiSeries, atrSeries };
