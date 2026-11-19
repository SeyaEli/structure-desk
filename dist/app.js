const $ = id => document.getElementById(id);
let tf = '1h', candles = [], analysis = null, backtest = null, source = 'demo', request = 0, imported = null, saved = [], visibleBars = 120, showAllSignals = false;
try { saved = JSON.parse(localStorage.getItem('structure-setups') || '[]'); if (!Array.isArray(saved)) saved = []; } catch { saved = []; }

/* Adaptive precision so 0.16 DOGE and 67,000 BTC both read well. */
const format = n => {
  const a = Math.abs(n), d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= .01 ? 5 : 7;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d });
};
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const durations = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
const htfMap = { '5m': [12, '1H'], '15m': [16, '4H'], '1h': [4, '4H'], '4h': [6, '1D'], '1d': [7, '1W'] };
const COLORS = { bull: '#43cda5', bear: '#ef7c8e', green: '#a4ef63', grid: '#1c242e', axis: '#788698', e20: '#e0b764', e50: '#7aa7ff', entry: '#b6c4d8' };
const dirWord = d => d === 1 ? 'Bullish' : d === -1 ? 'Bearish' : 'Neutral';
const dirClass = d => d === 1 ? 'bull' : d === -1 ? 'bear' : 'flat';

/* ---------- data ---------- */
const sampleBases = { BTCUSDT: 67800, ETHUSDT: 3450, SOLUSDT: 162, BNBUSDT: 590, XRPUSDT: .62, DOGEUSDT: .16, ETCUSDT: 26 };
function demo(symbol) {
  const base = sampleBases[symbol], names = Object.keys(sampleBases);
  let seed = 42 + Object.keys(durations).indexOf(tf) * 117 + names.indexOf(symbol) * 91;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let p = base * .96;
  const end = Math.floor(Date.now() / durations[tf]) * durations[tf], len = 400;
  return Array.from({ length: len }, (_, i) => {
    const o = p, drift = (i > len - 70 ? .0008 : .00005) + Math.sin(i / 15) * .0007, c = o * (1 + drift + (rand() - .47) * .007);
    const h = Math.max(o, c) + base * rand() * .002, l = Math.min(o, c) - base * rand() * .002;
    p = c;
    return { t: end - (len - i) * durations[tf], o, h, l, c, v: (400 + rand() * 1000) * (1 + Math.abs(c - o) / o * 150) };
  });
}
function normalizeSymbol(value) { return value.trim().toUpperCase().replace(/[\s\/-]/g, ''); }
function htfFor(stepMs) {
  const key = Object.keys(durations).reduce((best, k) => Math.abs(Math.log(durations[k] / stepMs)) < Math.abs(Math.log(durations[best] / stepMs)) ? k : best, '1h');
  return htfMap[key];
}

function clearAnalysis(message) {
  analysis = null; backtest = null;
  $('message').textContent = message;
  ['lastPrice', 'trend', 'range', 'atr', 'rsi', 'score', 'bias', 'change', 'rangeNote', 'htfNote', 'rsiNote', 'chartMeta', 'candleCount', 'signalsCount', 'factorTotal', 'bullPts', 'bearPts', 'rr', 'grade', 'gateCount'].forEach(id => $(id).textContent = '—');
  $('sourceBadge').textContent = '● NO ANALYSIS';
  ['chart', 'signals', 'tradeLevels', 'sizing', 'factors', 'gates', 'cautions', 'targetNote'].forEach(id => $(id).innerHTML = '');
  $('backtest').innerHTML = '<p class="pad">Run an analysis to replay the rules.</p>';
  $('bullBar').style.width = $('bearBar').style.width = '0';
  $('grade').className = 'grade';
  $('reason').textContent = 'Enter a supported contract and analyze to continue.';
  $('save').disabled = true;
}

async function load() {
  const token = ++request;
  $('analyze').disabled = true; $('analyze').textContent = 'Analyzing…';
  clearAnalysis('Loading contract analysis…');
  try {
    source = $('dataMode').value;
    const symbol = normalizeSymbol($('contract').value);
    $('contract').value = symbol;
    if (source !== 'csv' && !/^[A-Z0-9]{2,30}USDT$/.test(symbol)) throw Error('Enter a USDT futures symbol, for example SOLUSDT or ETCUSDT');
    if (source === 'demo' && !sampleBases[symbol]) throw Error(`Sample data exists only for ${Object.keys(sampleBases).join(', ')}. Choose Binance futures for other symbols`);
    if (source === 'live') {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=500`, { signal: AbortSignal.timeout(15000) });
      const rows = await response.json();
      if (!response.ok) {
        if (rows.code === -1121) throw Error(`Contract ${symbol} was not found on Binance USDT futures. Check the exact spelling (for example ETCUSDT)`);
        throw Error(rows.msg || 'Exchange returned ' + response.status);
      }
      if (!Array.isArray(rows)) throw Error('Invalid exchange response');
      if (token !== request) return;
      candles = rows.filter(r => r[6] < Date.now()).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      if (!candles.length) throw Error(`No closed candles available for ${symbol}`);
    } else if (source === 'csv') {
      if (!imported) throw Error('Import candles first.');
      candles = imported.rows;
    } else candles = demo(symbol);

    if (token !== request) return;
    const step = candles.length > 1 ? candles.at(-1).t - candles.at(-2).t : durations[tf];
    const [htfFactor, htfLabel] = source === 'csv' ? htfFor(step) : htfMap[tf];
    analysis = analyzeCandles(candles, { htfFactor, htfLabel });
    render();
    $('message').textContent = source === 'demo' ? 'Sample candles are simulated and do not represent current market prices.'
      : source === 'csv' ? `Imported ${imported.name}. Latest closed candle: ${new Date(candles.at(-1).t).toISOString()}. Verify contract and timeframe before use.`
      : `Binance USDⓈ-M · Snapshot fetched ${new Date().toLocaleTimeString()} · Latest closed candle ${new Date(candles.at(-1).t).toISOString()} · Refresh manually.`;
    // Replay runs after first paint so the desk stays responsive.
    $('backtest').innerHTML = '<p class="pad">Replaying rules on history…</p>';
    setTimeout(() => { if (token !== request) return; try { backtest = walkForward(candles); } catch { backtest = null; } renderBacktest(); }, 30);
  } catch (e) {
    if (token !== request) return;
    clearAnalysis(`Analysis unavailable: ${e.message}. Check the symbol or import a CSV. Previous results have been cleared.`);
  } finally {
    if (token === request) { $('analyze').disabled = false; $('analyze').textContent = 'Analyze market'; }
  }
}

/* ---------- rendering ---------- */
function render() {
  const a = analysis, c = candles.at(-1), first = candles.at(-25), pct = (c.c - first.c) / first.c * 100;
  $('sourceBadge').textContent = source === 'demo' ? '● SAMPLE DATA' : source === 'csv' ? '● IMPORTED DATA' : '● EXCHANGE SNAPSHOT';
  $('save').disabled = false;

  // Metrics
  $('lastPrice').textContent = '$' + format(c.c);
  $('change').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% · last 24 candles';
  $('change').className = pct >= 0 ? 'up' : 'down';
  $('trend').textContent = a.trend === 1 ? 'Bullish' : a.trend === -1 ? 'Bearish' : 'Ranging';
  $('trend').className = dirClass(a.trend);
  $('htfNote').innerHTML = `${escapeHTML(a.htf.label)} trend: <b class="${dirClass(a.htf.trend)}">${dirWord(a.htf.trend)}</b>`;
  $('range').textContent = a.pos < .45 ? 'Discount' : a.pos > .55 ? 'Premium' : 'Equilibrium';
  $('rangeMarker').style.left = Math.max(0, Math.min(100, a.pos * 100)) + '%';
  $('rangeNote').textContent = Math.round(a.pos * 100) + '% of 60-candle range';
  $('atr').textContent = '$' + format(a.atr);
  $('atrNote').textContent = a.atrPct.toFixed(2) + '% of price per candle';
  $('rsi').textContent = a.rsi == null ? '—' : a.rsi.toFixed(1);
  $('rsi').className = a.rsi > 55 ? 'bull' : a.rsi < 45 ? 'bear' : '';
  $('rsiNote').textContent = a.rsi > 70 ? 'Overbought zone' : a.rsi < 30 ? 'Oversold zone' : a.rsi > 55 ? 'Bullish momentum' : a.rsi < 45 ? 'Bearish momentum' : 'Neutral momentum';

  renderSetup();
  renderFactors();
  renderSignals();

  $('chartTitle').textContent = source === 'csv' ? imported.contract : $('contract').value;
  $('chartMeta').textContent = `${source === 'csv' ? 'Imported timeframe' : tf.toUpperCase()} · Closed candles · UTC`;
  $('candleCount').textContent = candles.length + ' candles loaded';
  draw();
  size();
}

function renderSetup() {
  const a = analysis, side = a.dir === 1 ? 'long' : 'short';
  const g = $('grade');
  g.textContent = a.wait ? 'WAIT' : `GRADE ${a.grade}`;
  g.className = 'grade ' + (a.wait ? 'wait' : 'g' + a.grade);
  $('bias').textContent = a.wait ? `Wait · ${a.dir === 1 ? 'long' : 'short'} lean` : a.dir === 1 ? 'Buy / Long bias' : 'Sell / Short bias';
  $('bias').className = 'bias ' + (a.wait ? 'wait' : dirClass(a.dir));

  const failed = a.gates.filter(x => !x.pass);
  $('reason').textContent = a.wait
    ? `Leaning ${side}, but ${failed.length} checklist ${failed.length === 1 ? 'item fails' : 'items fail'}: ${failed.map(x => x.label.toLowerCase()).join('; ')}. Levels below are hypothetical until the checklist passes.`
    : `Conditional ${side}: let price trade into the ${a.zone.dir === 1 ? 'bullish' : 'bearish'} ${a.zone.name.toLowerCase()} (${format(a.zone.low)} – ${format(a.zone.high)}) and show rejection. Invalid on a move beyond ${format(a.stop)}.`;

  $('bullPts').textContent = a.long.toFixed(1);
  $('bearPts').textContent = a.short.toFixed(1);
  $('score').textContent = Math.min(100, a.score) + '/100';
  $('bullBar').style.width = a.long / a.maxPoints * 100 + '%';
  $('bearBar').style.width = a.short / a.maxPoints * 100 + '%';

  const last = a.last.c, pctFrom = v => ((v - last) / last * 100), r = v => (v - a.entry) * a.dir / a.risk;
  $('tradeLevels').className = a.wait ? 'hypothetical' : '';
  $('tradeLevels').innerHTML = [
    ['Planned entry', a.entry, 'entry', ''],
    ['Stop loss', a.stop, 'bear', '−1.00R'],
    ['Take profit 1', a.tp1, 'bull', r(a.tp1).toFixed(2) + 'R'],
    ['Target · liquidity', a.tp2, 'green', r(a.tp2).toFixed(2) + 'R']
  ].map(([s, v, cls, rm]) => `<div><span>${s}</span><em>${rm}</em><small>${pctFrom(v) >= 0 ? '+' : ''}${pctFrom(v).toFixed(2)}%</small><b class="${cls}">${format(v)}</b></div>`).join('');
  $('rr').textContent = a.rr.toFixed(2) + ' R';
  $('rr').className = a.rr >= 2 ? 'bull' : a.rr >= 1.5 ? '' : 'bear';
  $('targetNote').textContent = a.targetSource;

  $('gateCount').textContent = `${a.gates.filter(x => x.pass).length}/${a.gates.length}`;
  $('gates').innerHTML = a.gates.map(x => `<li class="${x.pass ? 'pass' : 'fail'}"><i>${x.pass ? '✓' : '✕'}</i><div><b>${escapeHTML(x.label)}</b><small>${escapeHTML(x.detail)}</small></div></li>`).join('');
  $('cautions').innerHTML = a.cautions.map(c => `<div class="caution">⚠ ${escapeHTML(c)}</div>`).join('');
}

function renderFactors() {
  const a = analysis;
  $('factorTotal').textContent = `${a.long.toFixed(1)} : ${a.short.toFixed(1)}`;
  $('factors').innerHTML = a.factors.map(f => `
    <div class="factor ${dirClass(f.dir)}">
      <div class="factor-main"><b>${escapeHTML(f.label)}</b><p>${escapeHTML(f.detail)}</p></div>
      <div class="factor-vote"><span class="vote ${dirClass(f.dir)}">${f.dir === 1 ? '▲ Bull' : f.dir === -1 ? '▼ Bear' : '— Neutral'}</span>
      <div class="weight"><i style="width:${f.weight / 2 * 100}%"></i></div><small>${f.dir ? (f.dir === 1 ? '+' : '−') : ''}${f.weight} pt${f.weight === 1 ? '' : 's'}</small></div>
    </div>`).join('');
}

function renderSignals() {
  const a = analysis, n = candles.length, c = a.last;
  const rows = definitions.map(([name]) => {
    const event = a.recent.filter(e => e.name === name).sort((x, y) => x.i - y.i).at(-1), range = name === 'Premium / Discount';
    return { name, event, range, detected: !!event || range, age: event ? n - 1 - event.i : range ? -1 : 999 };
  }).sort((x, y) => (y.detected - x.detected) || (x.age - y.age));
  const detected = rows.filter(r => r.detected).length;
  $('signals').innerHTML = rows.filter(r => r.detected || showAllSignals).map(({ name, event, range }) => {
    const d = event ? event.dir : range ? (c.c < a.mid ? 1 : -1) : 0;
    const detail = event ? event.detail : range ? `${c.c < a.mid ? 'Below' : 'Above'} midpoint ${format(a.mid)}` : 'No recent match';
    const when = event ? (n - 1 - event.i === 0 ? 'latest candle' : (n - 1 - event.i === 1 ? '1 bar ago' : `${n - 1 - event.i} bars ago`)) : range ? 'now' : '';
    return `<div class="signal ${event || range ? dirClass(d) : 'no'}"><div class="signal-icon">${event || range ? (d === 1 ? '▲' : d === -1 ? '▼' : '•') : '·'}</div><div><b>${name}</b><p>${escapeHTML(detail)}</p></div><span class="state">${event || range ? `${range ? 'Context' : dirWord(d)}<small>${when}</small>` : '—'}</span></div>`;
  }).join('') || '<p class="pad">No patterns in the last 20 candles.</p>';
  $('signalsCount').textContent = `${detected} / ${definitions.length} DETECTED`;
  $('toggleSignals').textContent = showAllSignals ? 'Hide undetected patterns' : `Show ${definitions.length - detected} undetected patterns`;
}

function renderBacktest() {
  const b = backtest;
  if (!b) { $('backtest').innerHTML = '<p class="pad">Replay unavailable for this data.</p>'; return; }
  if (!b.signals) { $('backtest').innerHTML = '<p class="pad">The checklist never passed on this history, so there is nothing to replay. That is itself informative: these conditions are rare here.</p>'; return; }
  const pct = v => v == null ? '—' : Math.round(v * 100) + '%', rr = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
  const closed = b.wins + b.losses, small = closed < 20;
  $('backtest').innerHTML = `
    <div class="bt-stats">
      <div><span>Setups flagged</span><b>${b.signals}</b><small>${b.filled} filled · ${b.signals - b.filled} expired</small></div>
      <div><span>Hit 1R before stop</span><b class="${b.winRate >= .5 ? 'bull' : 'bear'}">${pct(b.winRate)}</b><small>${b.wins}W · ${b.losses}L${b.open ? ` · ${b.open} open` : ''}</small></div>
      <div><span>Avg result · 1R exit</span><b class="${b.exp1 > 0 ? 'bull' : 'bear'}">${rr(b.exp1)}</b><small>per closed trade</small></div>
      <div><span>Avg result · target exit</span><b class="${b.exp2 > 0 ? 'bull' : 'bear'}">${rr(b.exp2)}</b><small>exit at liquidity target</small></div>
    </div>
    <div class="bt-strip" aria-label="Trade outcomes in order">${b.trades.map(t => `<i class="${t.result}" title="${t.dir === 1 ? 'Long' : 'Short'} · ${t.result}${t.r2 != null ? ` · target exit ${rr(t.r2)}` : ''}"></i>`).join('')}</div>
    <div class="bt-legend"><span><i class="win"></i>1R hit</span><span><i class="loss"></i>Stopped</span><span><i class="open"></i>Open</span><span><i class="unfilled"></i>Never filled</span></div>
    ${small ? `<p class="bt-warn">Only ${closed} closed trade${closed === 1 ? '' : 's'} — far too few to judge the rules. Load more history or a lower timeframe.</p>` : ''}`;
}

/* ---------- chart ---------- */
let chartGeom = null;
function draw() {
  if (!analysis) return;
  const el = $('chart'), W = Math.max(320, el.clientWidth), H = Math.max(240, el.clientHeight);
  const a = analysis, n = candles.length, bars = Math.min(visibleBars, n), offset = n - bars, visible = candles.slice(offset);
  const left = 8, right = 88, top = 16, bottom = 26, showVol = $('volume').checked && visible.some(c => c.v > 0);
  const volH = showVol ? Math.round((H - top - bottom) * .16) : 0, priceBottom = H - bottom - volH - (showVol ? 6 : 0);
  const plotW = W - left - right, cw = plotW / (bars + 6); // leave room on the right for the plan boxes
  let values = visible.flatMap(c => [c.h, c.l]);
  if ($('levels').checked) values.push(a.entry, a.stop, a.tp2);
  const pad = a.atr * .6, low = Math.min(...values) - pad, high = Math.max(...values) + pad;
  const y = p => top + (high - p) / (high - low) * (priceBottom - top), x = i => left + (i - offset) * cw + cw / 2;
  const inView = p => p >= low && p <= high;
  const parts = [];
  const text = (tx, ty, s, fill, extra = '') => parts.push(`<text x="${tx}" y="${ty}" fill="${fill}" ${extra}>${s}</text>`);

  // Grid + price axis
  for (let i = 0; i <= 5; i++) {
    const p = low + (high - low) * i / 5, yy = y(p);
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="${COLORS.grid}"/>`);
    text(W - right + 8, yy + 4, format(p), COLORS.axis);
  }
  const tickEvery = Math.ceil(bars / Math.max(3, Math.floor(plotW / 110)));
  visible.forEach((c, k) => { if (k % tickEvery === 0) { const xx = x(offset + k); parts.push(`<line x1="${xx}" x2="${xx}" y1="${top}" y2="${H - bottom}" stroke="${COLORS.grid}"/>`); text(xx, H - 8, new Date(c.t).toISOString().slice(5, 16).replace('T', ' '), COLORS.axis, 'text-anchor="middle"'); } });

  // Equilibrium
  if (inView(a.mid)) { parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(a.mid)}" y2="${y(a.mid)}" stroke="#4a5666" stroke-dasharray="4 6"/>`); text(left + 4, y(a.mid) - 5, 'EQ', '#7d8a9b', 'font-size="9" letter-spacing="1"'); }

  // Zones: nearest three per side, labelled at the right edge.
  if ($('zones').checked) {
    const near = z => Math.abs((z.low + z.high) / 2 - a.last.c);
    const pick = d => a.zones.filter(z => z.dir === d && (z.high >= low && z.low <= high)).sort((p, q) => near(p) - near(q)).slice(0, 3);
    for (const z of [...pick(1), ...pick(-1)]) {
      const color = z.dir === 1 ? COLORS.bull : COLORS.bear, x0 = Math.max(left, x(z.i) - cw / 2), y0 = y(Math.min(high, z.high)), y1 = y(Math.max(low, z.low));
      const chosen = a.zone === z;
      parts.push(`<rect x="${x0}" y="${y0}" width="${W - right - x0}" height="${Math.max(2, y1 - y0)}" fill="${color}" fill-opacity="${chosen ? .18 : .08}" stroke="${color}" stroke-opacity="${chosen ? .7 : .22}" ${chosen ? 'stroke-dasharray="4 3"' : ''}/>`);
      const label = `${z.name === 'Order Block' ? 'OB' : 'FVG'}${z.confluent ? '+' : ''}${z.touches ? ` ·${z.touches}` : ''}`;
      text(W - right - 6, y0 + 11, label, color, 'text-anchor="end" font-size="9" font-weight="600"');
    }
  }

  // Plan: risk / reward boxes projected to the right of the last candle.
  if ($('levels').checked) {
    const x0 = x(n - 1) + cw, x1 = W - right, op = a.wait ? .06 : .14;
    parts.push(`<rect x="${x0}" y="${Math.min(y(a.entry), y(a.stop))}" width="${x1 - x0}" height="${Math.abs(y(a.entry) - y(a.stop))}" fill="${COLORS.bear}" fill-opacity="${op}"/>`);
    parts.push(`<rect x="${x0}" y="${Math.min(y(a.entry), y(a.tp2))}" width="${x1 - x0}" height="${Math.abs(y(a.entry) - y(a.tp2))}" fill="${COLORS.bull}" fill-opacity="${op}"/>`);
  }

  // EMAs
  if ($('emas').checked) for (const [arr, color] of [[a.ema20, COLORS.e20], [a.ema50, COLORS.e50]]) {
    const pts = []; for (let i = offset; i < n; i++) if (arr[i] != null && inView(arr[i])) pts.push(`${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`);
    if (pts.length > 1) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.3" opacity=".85"/>`);
  }

  // Volume
  if (showVol) {
    const vmax = Math.max(...visible.map(c => c.v)) || 1, vb = H - bottom;
    visible.forEach((c, k) => { const hh = c.v / vmax * volH; parts.push(`<rect x="${x(offset + k) - cw * .35}" y="${vb - hh}" width="${cw * .7}" height="${hh}" fill="${c.c >= c.o ? COLORS.bull : COLORS.bear}" opacity=".35"/>`); });
  }

  // Candles
  const bodyW = Math.max(1, cw * .62);
  visible.forEach((c, k) => {
    const i = offset + k, color = c.c >= c.o ? COLORS.bull : COLORS.bear;
    parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${color}"/><rect x="${x(i) - bodyW / 2}" y="${y(Math.max(c.o, c.c))}" width="${bodyW}" height="${Math.max(1, Math.abs(y(c.o) - y(c.c)))}" fill="${color}"/>`);
  });

  // Structure: swing points, BOS / CHoCH lines, sweeps.
  if ($('structure').checked) {
    for (const s of a.highs) if (s.i >= offset) parts.push(`<path d="M${x(s.i) - 3} ${y(s.p) - 9}h6l-3 4z" fill="#8a97a9"/>`);
    for (const s of a.lows) if (s.i >= offset) parts.push(`<path d="M${x(s.i) - 3} ${y(s.p) + 9}h6l-3 -4z" fill="#8a97a9"/>`);
    const breaks = a.events.filter(e => (e.name === 'Break of Structure' || e.name === 'Change of Character') && e.i >= offset).slice(-6);
    for (const e of breaks) {
      const color = e.dir === 1 ? COLORS.bull : COLORS.bear, yy = y(e.level), x0 = x(Math.max(offset, e.from)), x1 = x(e.i);
      const mss = a.events.some(m => m.name === 'Market Structure Shift' && m.i === e.i);
      const label = mss ? 'MSS' : e.name === 'Break of Structure' ? 'BOS' : 'CHoCH';
      parts.push(`<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="1.2" ${label === 'BOS' ? 'stroke-dasharray="3 3"' : ''}/>`);
      text((x0 + x1) / 2, yy + (e.dir === 1 ? -4 : 11), label, color, 'text-anchor="middle" font-size="9" font-weight="700"');
    }
    for (const e of a.events.filter(e => e.name === 'Liquidity Sweep' && e.i >= offset).slice(-6)) {
      const c = candles[e.i], py = e.dir === 1 ? y(c.l) + 8 : y(c.h) - 8;
      parts.push(`<circle cx="${x(e.i)}" cy="${py}" r="3" fill="none" stroke="#e0b764" stroke-width="1.3"/>`);
    }
  }

  // Plan lines with axis tags
  // Plan lines sit at their true price; axis tags are nudged apart so they never overlap.
  const tags = [];
  if ($('levels').checked) for (const [p, label, color] of [[a.stop, 'SL', COLORS.bear], [a.tp2, 'TP', COLORS.green], [a.entry, 'IN', COLORS.entry]]) {
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(p)}" y2="${y(p)}" stroke="${color}" stroke-dasharray="6 5" opacity="${a.wait ? .45 : .8}"/>`);
    tags.push({ y: y(p), text: `${label} ${format(p)}`, color });
  }
  parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(a.last.c)}" y2="${y(a.last.c)}" stroke="#e8edf4" stroke-opacity=".35" stroke-dasharray="1 3"/>`);
  tags.push({ y: y(a.last.c), text: format(a.last.c), color: '#e8edf4' });
  tags.sort((p, q) => p.y - q.y);
  for (let k = 1; k < tags.length; k++) tags[k].ty = Math.max(tags[k].y, (tags[k - 1].ty ?? tags[k - 1].y) + 19);
  const overflow = Math.max(0, (tags.at(-1).ty ?? tags.at(-1).y) - (H - bottom - 10));
  for (const t of tags) {
    const ty = (t.ty ?? t.y) - overflow;
    if (Math.abs(ty - t.y) > 1) parts.push(`<line x1="${W - right - 4}" x2="${W - right + 2}" y1="${t.y}" y2="${ty}" stroke="${t.color}" opacity=".6"/>`);
    parts.push(`<rect x="${W - right + 2}" y="${ty - 9}" width="${right - 4}" height="18" rx="3" fill="${t.color}"/>`);
    text(W - right + 7, ty + 4, t.text, '#0b0f14', 'font-size="9.5" font-weight="700"');
  }

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="DM Sans, sans-serif" font-size="10">${parts.join('')}<g id="crosshair" style="display:none"><line id="chx" y1="${top}" y2="${H - bottom}" stroke="#9aa5b4" stroke-dasharray="2 3"/><line id="chy" x1="${left}" x2="${W - right}" stroke="#9aa5b4" stroke-dasharray="2 3"/><rect id="chTag" x="${W - right + 2}" width="${right - 4}" height="18" rx="3" fill="#2a3442"/><text id="chText" x="${W - right + 7}" fill="#e8edf4" font-size="10"></text></g></svg>`;
  chartGeom = { W, H, left, right, top, bottom, priceBottom, cw, offset, bars, low, high };
}

function onChartMove(e) {
  if (!chartGeom || !analysis) return;
  const g = chartGeom, rect = $('chart').getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const k = Math.floor((mx - g.left) / g.cw), i = g.offset + k, ch = $('crosshair');
  if (!ch || k < 0 || i >= candles.length || mx > g.W - g.right || my < g.top || my > g.H - g.bottom) { if (ch) ch.style.display = 'none'; return; }
  ch.style.display = '';
  const xx = g.left + k * g.cw + g.cw / 2;
  $('chx').setAttribute('x1', xx); $('chx').setAttribute('x2', xx);
  const yy = Math.min(my, g.priceBottom);
  $('chy').setAttribute('y1', yy); $('chy').setAttribute('y2', yy);
  $('chTag').setAttribute('y', yy - 9); $('chText').setAttribute('y', yy + 4);
  $('chText').textContent = format(g.high - (yy - g.top) / (g.priceBottom - g.top) * (g.high - g.low));
  const c = candles[i], chg = (c.c - c.o) / c.o * 100, here = analysis.events.filter(ev => ev.i === i).map(ev => ev.name);
  $('candleInfo').innerHTML = `<b>${new Date(c.t).toISOString().slice(0, 16).replace('T', ' ')} UTC</b> · O ${format(c.o)} · H ${format(c.h)} · L ${format(c.l)} · C <span class="${chg >= 0 ? 'up' : 'down'}">${format(c.c)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)</span>${here.length ? ` · <span class="ev">${[...new Set(here)].join(', ')}</span>` : ''}`;
}

/* ---------- position sizing ---------- */
function size() {
  if (!analysis) return;
  const balance = +$('balance').value, risk = +$('risk').value, lev = +$('leverage').value, fees = +$('fees').value;
  if (balance <= 0 || risk <= 0 || risk > 5 || lev < 1 || lev > 125 || fees < 0 || fees > 5 || ![balance, risk, lev, fees].every(Number.isFinite)) {
    $('sizing').innerHTML = '<p class="warn">Enter valid values: risk 0–5%, leverage 1–125×, fees 0–5%.</p>'; return;
  }
  const a = analysis, budget = balance * risk / 100, feeUnit = a.entry * fees / 100, unitRisk = a.risk + feeUnit;
  const qty = budget / unitRisk, notional = qty * a.entry, margin = notional / lev, reward = qty * (Math.abs(a.tp2 - a.entry) - feeUnit);
  const liq = a.entry * (1 - a.dir / lev), stopBeyondLiq = a.dir === 1 ? a.stop <= liq : a.stop >= liq;
  $('sizing').innerHTML = [
    ['Planned maximum loss', '$' + format(budget), 'bear'],
    ['Reward at target (after fees)', (reward >= 0 ? '+$' : '−$') + format(Math.abs(reward)), reward >= 0 ? 'bull' : 'bear'],
    ['Position size', (qty >= 1000 ? qty.toLocaleString('en-US', { maximumFractionDigits: 0 }) : qty.toFixed(qty >= 1 ? 3 : 5)) + ' units', ''],
    ['Notional exposure', '$' + format(notional), ''],
    ['Estimated initial margin', `$${format(margin)} · ${(margin / balance * 100).toFixed(1)}% of balance`, '']
  ].map(([k, v, cls]) => `<div><span>${k}</span><b class="${cls}">${v}</b></div>`).join('')
    + (margin > balance ? '<p class="warn">Insufficient balance for this initial margin. Reduce risk or increase leverage.</p>' : '')
    + (stopBeyondLiq ? `<p class="warn">At ${lev}× the rough liquidation price (~${format(liq)}) is reached before your stop. Lower leverage.</p>` : '');
}

/* ---------- misc UI ---------- */
function toast(text) { $('toast').textContent = text; $('toast').style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => $('toast').style.display = 'none', 2800); }
function view(id) {
  ['desk', 'journal', 'guide'].forEach(v => $(v).hidden = v !== id);
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  $('viewName').textContent = { desk: 'Market overview', journal: 'Saved setups', guide: 'Strategy library' }[id];
  if (id === 'journal') renderSaved();
  if (id === 'desk') requestAnimationFrame(draw);
}
function renderSaved() {
  $('savedCount').textContent = saved.length;
  $('savedList').innerHTML = saved.length ? saved.map((s, i) => `<article class="panel"><div><h2>${escapeHTML(s.contract)} · <span class="${s.bias === 'Long' ? 'bull' : s.bias === 'Short' ? 'bear' : 'waitc'}">${escapeHTML(s.bias)}</span> <span class="tag">${escapeHTML(String(s.source).toUpperCase())}</span>${s.grade ? ` <span class="tag">GRADE ${escapeHTML(s.grade)}</span>` : ''}</h2><p>${escapeHTML(s.tf)} · ${new Date(s.time).toLocaleString()}${s.score != null ? ` · Confluence ${s.score}/100` : ''}${s.rr != null ? ` · ${(+s.rr).toFixed(2)}R` : ''}<br>Entry ${format(s.entry)} · SL ${format(s.stop)} · TP1 ${format(s.tp1)} · Target ${format(s.tp2)}</p></div><button class="secondary" data-delete="${i}">Delete</button></article>`).join('')
    : '<div class="panel guide-intro">No setups saved yet. Analyze a contract and save a snapshot of your plan.</div>';
  $('savedList').querySelectorAll('[data-delete]').forEach(b => b.onclick = () => { saved.splice(+b.dataset.delete, 1); persist(); renderSaved(); });
}
function persist() { try { localStorage.setItem('structure-setups', JSON.stringify(saved)); return true; } catch { toast('Browser storage unavailable. Export your setups to keep them.'); return false; } }

$('save').onclick = () => {
  if (!analysis) return;
  const a = analysis;
  saved.unshift({ contract: source === 'csv' ? imported.contract : $('contract').value, tf: source === 'csv' ? 'CSV' : tf, source, time: Date.now(), bias: a.wait ? 'Wait' : a.dir === 1 ? 'Long' : 'Short', grade: a.wait ? null : a.grade, score: a.score, rr: a.rr, entry: a.entry, stop: a.stop, tp1: a.tp1, tp2: a.tp2, failed: a.gates.filter(g => !g.pass).map(g => g.label) });
  if (persist()) toast('Setup saved to your research journal');
  renderSaved();
};
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'structure-desk-setups.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

document.querySelectorAll('.nav').forEach(b => b.onclick = () => view(b.dataset.view));
$('guideButton').onclick = () => view('guide');
$('analyze').onclick = load;
$('contract').oninput = () => {
  ++request;
  const s = normalizeSymbol($('contract').value);
  if ($('dataMode').value !== 'csv') $('dataMode').value = sampleBases[s] && $('dataMode').value === 'demo' ? 'demo' : 'live';
  $('analyze').disabled = false; $('analyze').textContent = 'Analyze market';
  clearAnalysis('Symbol changed. Press Enter or Analyze market to load its candles.');
};
$('contract').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); load(); } };
$('dataMode').onchange = load;
document.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => {
  tf = b.dataset.tf;
  document.querySelectorAll('[data-tf]').forEach(x => x.classList.toggle('selected', x === b));
  if ($('dataMode').value === 'csv') $('dataMode').value = 'demo';
  load();
});
document.querySelectorAll('[data-bars]').forEach(b => b.onclick = () => {
  visibleBars = +b.dataset.bars;
  document.querySelectorAll('[data-bars]').forEach(x => x.classList.toggle('selected', x === b));
  draw();
});
['zones', 'levels', 'structure', 'emas', 'volume'].forEach(id => $(id).onchange = draw);
['balance', 'risk', 'leverage', 'fees'].forEach(id => $(id).oninput = size);
$('toggleSignals').onclick = () => { showAllSignals = !showAllSignals; if (analysis) renderSignals(); };
$('chart').addEventListener('pointermove', onChartMove);
$('chart').addEventListener('pointerleave', () => { const ch = $('crosshair'); if (ch) ch.style.display = 'none'; });
let resizeFrame; new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(draw); }).observe($('chart'));

$('importButton').onclick = () => { toast('CSV: time,open,high,low,close,volume · 60+ closed candles · UTC'); $('file').click(); };
$('file').onchange = async e => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5000000) throw Error('Maximum CSV size is 5 MB');
    const lines = (await file.text()).trim().split(/\r?\n/), headers = lines.shift().toLowerCase().replace(/^\uFEFF/, '').split(',').map(x => x.trim());
    const index = n => headers.indexOf(n), required = ['time', 'open', 'high', 'low', 'close'];
    if (required.some(h => index(h) < 0)) throw Error('Header must contain time,open,high,low,close (volume optional)');
    let rows = lines.filter(s => s.trim()).map((line, i) => {
      const v = line.split(',').map(x => x.trim()), raw = v[index('time')], numeric = Number(raw);
      const t = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(raw.endsWith('Z') || /[+-]\d\d:\d\d$/.test(raw) ? raw : raw + 'Z');
      const o = +v[index('open')], h = +v[index('high')], l = +v[index('low')], c = +v[index('close')];
      if (![t, o, h, l, c].every(Number.isFinite) || Math.min(o, h, l, c) <= 0 || h < Math.max(o, c) || l > Math.min(o, c) || h < l) throw Error('Invalid OHLC or time on row ' + (i + 2));
      return { t, o, h, l, c, v: index('volume') < 0 ? 0 : +v[index('volume')] || 0 };
    });
    rows.sort((a, b) => a.t - b.t);
    if (rows.some((r, i) => i && r.t === rows[i - 1].t)) throw Error('Duplicate candle timestamps');
    const step = rows.length > 1 ? rows.at(-1).t - rows.at(-2).t : 0;
    rows = rows.filter(r => r.t + step < Date.now());
    if (rows.length < 60) throw Error('Need at least 60 closed candles');
    if (rows.some((r, i) => i && r.t - rows[i - 1].t !== step)) throw Error('Candles must have a consistent interval without gaps');
    const contract = prompt('Contract label for this CSV (for example BTCUSDT)', file.name.replace(/\.csv$/i, ''));
    if (!contract) return;
    imported = { rows: rows.slice(-1500), name: file.name, contract };
    if (!$('dataMode').querySelector('[value="csv"]')) $('dataMode').add(new Option('Imported CSV', 'csv'));
    $('dataMode').value = 'csv';
    await load();
  } catch (err) { toast(err.message); } finally { e.target.value = ''; }
};

$('library').innerHTML = definitions.map(([n, d]) => `<article class="panel"><h2>${n}</h2><p>${d}</p></article>`).join('');
$('factorLibrary').innerHTML = `<table><thead><tr><th>Factor</th><th>Weight</th><th>Rule</th></tr></thead><tbody>${factorDocs.map(([n, w, d]) => `<tr><td>${n}</td><td>${w}</td><td>${d}</td></tr>`).join('')}</tbody></table>`;
renderSaved();
load();
