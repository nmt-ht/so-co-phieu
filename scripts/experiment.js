// So sánh các cấu hình trên giai đoạn phát triển. Giai đoạn giữ lại chỉ chấm sau khi đã chốt cấu hình.
// Chạy: node scripts/experiment.js            (chỉ in 2020-2023)
//       node scripts/experiment.js --holdout="lambda,subset,target"   (chấm 2024 trở đi cho đúng một cấu hình)
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { INDICES } = require('../src/universe.js');

const root = path.join(__dirname, '..');
const hist = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8')).series;
const idx = new Set(INDICES.map((x) => x.s));
const index = E.prep(hist.VNINDEX);
const stocks = Object.keys(hist).filter((s) => !idx.has(s)).map((s) => Object.assign(E.prep(hist[s]), { sym: s }));
const ctx = E.marketContext(index, stocks);
const dates = index.d;
const dateIdx = new Map(dates.map((d, i) => [d, i]));
const SPLIT = '2024-01-01';

const SUBSETS = {
  all: (x) => x,
  stock: (x) => x.slice(0, 14),
  market: (x) => x.slice(14),
  relative: (x) => [x[0], x[1], x[2], x[4], x[5], x[9], x[10], x[11], x[12], x[13]],
};

function samples(h) {
  const out = [];
  for (const S of stocks) {
    for (let t = E.STOCK_MIN; t + h < S.n; t++) {
      const di = dateIdx.get(S.d[t]);
      if (di === undefined || di + h >= dates.length || di % 3 && di % 5) continue;
      let bad = false;
      for (let i = t + 1; i <= t + h; i++) if (Math.abs(S.lc[i] - S.lc[i - 1]) > 0.35) bad = true;
      if (bad || !S.v[t]) continue;
      const f = E.featureAt(S, t, ctx);
      if (!f) continue;
      const ret = S.lc[t + h] - S.lc[t];
      const mkt = index.lc[di + h] - index.lc[di];
      out.push({ sym: S.sym, di, d: S.d[t], f, ret, mkt });
    }
  }
  return out;
}

function run(all, h, lambda, subset, target) {
  const pick = SUBSETS[subset];
  const yOf = target === 'rel' ? (s) => (s.ret > s.mkt ? 1 : 0) : (s) => (s.ret > 0 ? 1 : 0);
  const first = dates.findIndex((d) => d >= '2020-01-01');
  const preds = [];
  for (let start = first; start < dates.length; start += 63) {
    const tr = all.filter((s) => s.di % 3 === 0 && s.di + h < start);
    const te = all.filter((s) => s.di % 5 === 0 && s.di >= start && s.di < start + 63);
    if (!te.length) continue;
    const base = E.mean(tr.map(yOf));
    let m = null;
    if (subset !== 'none') {
      const X = tr.map((s) => pick(s.f));
      const st = E.standardizer(X);
      m = { st, beta: E.fitLogistic(X.map((r) => E.standardize(r, st)), tr.map(yOf), lambda, 6) };
    }
    for (const s of te) preds.push({ sym: s.sym, d: s.d, p: m ? E.scoreRow(pick(s.f), m).p : base, base, y: yOf(s), ret: s.ret, mkt: s.mkt });
  }
  return preds;
}

function summarize(p) {
  const bri = (f) => E.mean(p.map((r) => (f(r) - r.y) ** 2));
  const byDate = new Map();
  for (const r of p) { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r); }
  const ics = [], tops = [], bots = [];
  for (const a of byDate.values()) {
    if (a.length < 20) continue;
    const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((u, w) => u[0] - w[0]); const r = []; o.forEach((x, i) => { r[x[1]] = i; }); return r; };
    const rp = rank(a.map((r) => r.p)), rr = rank(a.map((r) => r.ret));
    const mp = E.mean(rp), mr = E.mean(rr);
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < a.length; i++) { xy += (rp[i] - mp) * (rr[i] - mr); xx += (rp[i] - mp) ** 2; yy += (rr[i] - mr) ** 2; }
    if (xx && yy) ics.push(xy / Math.sqrt(xx * yy));
    const s = [...a].sort((u, w) => w.p - u.p), k = Math.floor(a.length / 5);
    tops.push(E.mean(s.slice(0, k).map((r) => r.ret))); bots.push(E.mean(s.slice(-k).map((r) => r.ret)));
  }
  return {
    n: p.length,
    hit: E.mean(p.map((r) => ((r.p > 0.5) === !!r.y ? 1 : 0))) * 100,
    baseHit: E.mean(p.map((r) => ((r.base > 0.5) === !!r.y ? 1 : 0))) * 100,
    bss: (1 - bri((r) => r.p) / bri((r) => r.base)) * 100,
    ic: ics.length ? E.mean(ics) : 0,
    topMinusBot: tops.length ? (E.mean(tops) - E.mean(bots)) * 100 : 0,
  };
}

const fmt = (s) => ({ n: s.n, hit: +s.hit.toFixed(1), baseHit: +s.baseHit.toFixed(1), bss: +s.bss.toFixed(2), ic: +s.ic.toFixed(3), spread: +s.topMinusBot.toFixed(2) });

const holdoutArg = process.argv.find((x) => x.startsWith('--holdout='));
for (const h of [5, 21]) {
  const all = samples(h);
  if (holdoutArg) {
    const [lambda, subset, target] = holdoutArg.split('=')[1].split(',');
    const p = run(all, h, +lambda, subset, target).filter((r) => r.d >= SPLIT);
    console.log(`\nHOLDOUT 2024+ h=${h} ${lambda},${subset},${target}`, fmt(summarize(p)));
    const b = run(all, h, 1, 'none', target).filter((r) => r.d >= SPLIT);
    console.log('  chỉ tỷ lệ nền:', fmt(summarize(b)));
    continue;
  }
  const rows = {};
  for (const target of ['abs', 'rel']) {
    rows[`${target} nền`] = fmt(summarize(run(all, h, 1, 'none', target).filter((r) => r.d < SPLIT)));
    for (const subset of ['all', 'stock', 'market', 'relative']) {
      for (const lambda of [2000, 20000]) {
        rows[`${target} ${subset} λ${lambda}`] = fmt(summarize(run(all, h, lambda, subset, target).filter((r) => r.d < SPLIT)));
      }
    }
  }
  console.log(`\n=== h=${h}, giai đoạn phát triển 2020-2023 ===`);
  console.table(rows);
}
