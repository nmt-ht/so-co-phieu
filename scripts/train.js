// Kiểm định walk-forward cấu hình đã chốt (xem experiment.js), huấn luyện mô hình cuối, ghi data/model.json.
// Chạy: node scripts/train.js
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { INDICES } = require('../src/universe.js');

const LAMBDA = 20000;
const REFIT = 63;       // huấn luyện lại mỗi quý
const FIRST_TEST = '2020-01-01';
const HOLDOUT = '2024-01-01'; // chưa từng dùng để chọn cấu hình

const root = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'));
const hist = raw.series;
const idxSyms = INDICES.map((x) => x.s);
const index = E.prep(hist.VNINDEX);
const stocks = Object.keys(hist).filter((s) => !idxSyms.includes(s)).map((s) => Object.assign(E.prep(hist[s]), { sym: s }));
const ctx = E.marketContext(index, stocks);
const dates = index.d;
const dateIdx = new Map(dates.map((d, i) => [d, i]));

const pickStock = (x) => x.slice(0, E.STOCK_FEATURES);

function buildSamples(h) {
  const out = [];
  for (const S of stocks) {
    for (let t = E.STOCK_MIN; t + h < S.n; t++) {
      const di = dateIdx.get(S.d[t]);
      if (di === undefined || (di % 3 && di % 5)) continue;
      let bad = false;
      for (let i = t + 1; i <= t + h; i++) if (Math.abs(S.lc[i] - S.lc[i - 1]) > 0.35) bad = true;
      if (bad || !S.v[t]) continue;
      const f = E.featureAt(S, t, ctx);
      if (!f) continue;
      const ret = S.lc[t + h] - S.lc[t];
      let rv = 0;
      for (let i = t + 1; i <= t + h; i++) rv += Math.min((S.lc[i] - S.lc[i - 1]) ** 2, 0.04);
      out.push({ sym: S.sym, di, d: S.d[t], x: pickStock(f), vi: E.volInputs(S, t), lrv: Math.log(Math.max(Math.sqrt(rv / h), 0.002)), ret, price: S.c[t], y: ret > 0 ? 1 : 0 });
    }
  }
  return out;
}

const volOf = (s, vm) => Math.exp(s.vi.reduce((a, x, i) => a + x * vm[i], 0));

function fitStock(tr, h) {
  const X = tr.map((s) => s.x);
  const st = E.standardizer(X);
  const beta = E.fitLogistic(X.map((r) => E.standardize(r, st)), tr.map((s) => s.y), LAMBDA, 6);
  const vm = E.fitOLS(tr.map((s) => s.vi), tr.map((s) => s.lrv));
  const m = { st, beta, vm };
  const res = [];
  for (let i = 0; i < tr.length; i += 3) res.push(tr[i].ret / (volOf(tr[i], vm) * Math.sqrt(h)) - E.centerOf(E.scoreRow(tr[i].x, m).p));
  m.zq = E.zTable(res);
  return m;
}

function walkForward(hz) {
  const { h, tail } = hz;
  const all = buildSamples(h);
  const first = dates.findIndex((d) => d >= FIRST_TEST);
  const up = Math.log(1 + tail), dn = Math.log(1 - tail);
  const preds = [];
  for (let start = first; start < dates.length; start += REFIT) {
    const tr = all.filter((s) => s.di % 3 === 0 && s.di + h < start); // khoảng đệm h phiên, không để nhãn lọt vào
    const te = all.filter((s) => s.di % 5 === 0 && s.di >= start && s.di < start + REFIT);
    if (!te.length) continue;
    const m = fitStock(tr, h);
    const base = E.mean(tr.map((s) => s.y));
    // Chuẩn so sánh: tần suất chung và khoảng phần trăm cố định, không tính theo biến động của từng mã.
    const baseDown = E.mean(tr.map((s) => (s.ret <= dn ? 1 : 0)));
    const baseUp = E.mean(tr.map((s) => (s.ret >= up ? 1 : 0)));
    const naiveLo = E.quantile(tr.map((s) => s.ret), 0.1), naiveHi = E.quantile(tr.map((s) => s.ret), 0.9);
    for (const s of te) {
      const p = E.scoreRow(s.x, m).p;
      const vol = volOf(s, m.vm);
      const c = (q) => E.logReturnAt(q, p, vol, h, m.zq);
      preds.push({
        sym: s.sym, d: s.d, di: s.di, p, base, y: s.y, ret: s.ret, vol, price: s.price,
        lo80: c(0.1), hi80: c(0.9), lo50: c(0.25), hi50: c(0.75),
        naiveLo, naiveHi,
        pDown: E.probBelow(-tail, p, vol, h, m.zq), baseDown, isDown: s.ret <= dn ? 1 : 0,
        pUp: 1 - E.probBelow(tail, p, vol, h, m.zq), baseUp, isUp: s.ret >= up ? 1 : 0,
      });
    }
  }
  return { preds, all };
}

// ---------- Thước đo ----------

function groupBy(a, f) {
  const m = new Map();
  for (const x of a) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// Bootstrap theo khối quý: các mã trong cùng giai đoạn tương quan cao, nên phải lấy mẫu theo thời gian.
function blockCI(preds, stat, B = 300) {
  const blocks = [...groupBy(preds, (r) => r.d.slice(0, 4) + 'Q' + Math.ceil(+r.d.slice(5, 7) / 3)).values()];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const vals = [];
  for (let b = 0; b < B; b++) {
    const s = [];
    for (let i = 0; i < blocks.length; i++) { const bl = blocks[Math.floor(rnd() * blocks.length)]; for (const x of bl) s.push(x); }
    vals.push(stat(s));
  }
  return [E.quantile(vals, 0.025), E.quantile(vals, 0.975)];
}

const skill = (a, pf, bf, yf) => {
  let m = 0, b = 0;
  for (const r of a) { m += (pf(r) - yf(r)) ** 2; b += (bf(r) - yf(r)) ** 2; }
  return (1 - m / b) * 100;
};
const dirSkill = (a) => skill(a, (r) => r.p, (r) => r.base, (r) => r.y);
const downSkill = (a) => skill(a, (r) => r.pDown, (r) => r.baseDown, (r) => r.isDown);
const upSkill = (a) => skill(a, (r) => r.pUp, (r) => r.baseUp, (r) => r.isUp);
const avg = (a, f) => E.mean(a.map(f));
const pct = (a, f) => avg(a, (r) => (f(r) ? 1 : 0)) * 100;
const in80 = (r) => r.ret >= r.lo80 && r.ret <= r.hi80;
const in50 = (r) => r.ret >= r.lo50 && r.ret <= r.hi50;
const naiveIn = (r) => r.ret >= r.naiveLo && r.ret <= r.naiveHi;

function rankIC(a) {
  const by = groupBy(a, (r) => r.d);
  const out = [];
  const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((u, w) => u[0] - w[0]); const r = []; o.forEach((x, i) => { r[x[1]] = i; }); return r; };
  for (const g of by.values()) {
    if (g.length < 20) continue;
    const rp = rank(g.map((r) => r.p)), rr = rank(g.map((r) => r.ret));
    const mp = E.mean(rp), mr = E.mean(rr);
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < g.length; i++) { xy += (rp[i] - mp) * (rr[i] - mr); xx += (rp[i] - mp) ** 2; yy += (rr[i] - mr) ** 2; }
    if (xx && yy) out.push(xy / Math.sqrt(xx * yy));
  }
  return out.length ? E.mean(out) : 0;
}

function bins(a, pf, yf, edges) {
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const g = a.filter((r) => pf(r) >= edges[i] && pf(r) < edges[i + 1]);
    if (g.length >= 50) out.push({ lo: edges[i], hi: edges[i + 1], n: g.length, pred: avg(g, pf) * 100, real: avg(g, yf) * 100 });
  }
  return out;
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// So sánh nhóm 20% xếp đầu và 20% xếp cuối theo xác suất tăng, tính theo từng ngày dự báo.
// Mua giữ cả rổ không trả phí mỗi kỳ, nên đó là mốc so sánh công bằng với người đổi danh mục mỗi kỳ.
function quintiles(a) {
  const rt = E.ROUND_TRIP * 100;
  const rows = [];
  for (const [d, g] of groupBy(a, (r) => r.d)) {
    if (g.length < 20) continue;
    const s = [...g].sort((x, y) => y.p - x.p), k = Math.floor(g.length / 5);
    const simple = (r) => (Math.exp(r.ret) - 1) * 100;
    const top = avg(s.slice(0, k), simple), bot = avg(s.slice(-k), simple), all = avg(g, simple);
    rows.push({ d, top, bot, all, spread: top - bot, vsHold: top - rt - all, topNet: top - rt, botNet: bot - rt });
  }
  const m = (f) => (x) => avg(x, f);
  return {
    dates: rows.length, roundTrip: rt,
    top: avg(rows, (r) => r.top), bot: avg(rows, (r) => r.bot), all: avg(rows, (r) => r.all),
    topNet: avg(rows, (r) => r.topNet), botNet: avg(rows, (r) => r.botNet),
    spread: avg(rows, (r) => r.spread), spreadCI: blockCI(rows, m((r) => r.spread)),
    vsHold: avg(rows, (r) => r.vsHold), vsHoldCI: blockCI(rows, m((r) => r.vsHold)),
    topNetCI: blockCI(rows, m((r) => r.topNet)),
  };
}

function period(a, tail) {
  const volT = [E.quantile(a.map((r) => r.vol), 1 / 3), E.quantile(a.map((r) => r.vol), 2 / 3)];
  const terc = [(r) => r.vol <= volT[0], (r) => r.vol > volT[0] && r.vol <= volT[1], (r) => r.vol > volT[1]];
  const long = a.filter((r) => r.p >= 0.55), short = a.filter((r) => r.p <= 0.45);
  return {
    n: a.length, quarters: groupBy(a, (r) => r.d.slice(0, 4) + 'Q' + Math.ceil(+r.d.slice(5, 7) / 3)).size, from: a.reduce((m, r) => (r.d < m ? r.d : m), '9'), to: a.reduce((m, r) => (r.d > m ? r.d : m), '0'),
    upRate: pct(a, (r) => r.y), hit: pct(a, (r) => (r.p > 0.5) === !!r.y), baseHit: pct(a, (r) => (r.base > 0.5) === !!r.y),
    dirSkill: dirSkill(a), dirCI: blockCI(a, dirSkill), ic: rankIC(a),
    lean: {
      upN: long.length, upReal: long.length ? pct(long, (r) => r.y) : null, upRet: long.length ? avg(long, (r) => r.ret) * 100 : null,
      downN: short.length, downReal: short.length ? pct(short, (r) => r.y) : null, downRet: short.length ? avg(short, (r) => r.ret) * 100 : null,
      allRet: avg(a, (r) => r.ret) * 100,
    },
    cover80: pct(a, in80), cover50: pct(a, in50), naive80: pct(a, naiveIn),
    width80: avg(a, (r) => (Math.exp(r.hi80) - Math.exp(r.lo80))) * 100,
    terciles: terc.map((f) => { const g = a.filter(f); return { n: g.length, cover80: pct(g, in80), naive80: pct(g, naiveIn), width: avg(g, (r) => (Math.exp(r.hi80) - Math.exp(r.lo80))) * 100 }; }),
    downSkill: downSkill(a), downCI: blockCI(a, downSkill), downRate: pct(a, (r) => r.isDown),
    upSkill: upSkill(a), upCI: blockCI(a, upSkill), upTailRate: pct(a, (r) => r.isUp),
    quint: quintiles(a),
    relDir: bins(a, (r) => r.p, (r) => r.y, [0, 0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 1]),
    relDown: bins(a, (r) => r.pDown, (r) => r.isDown, [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 1]),
    tail,
  };
}

// Chỉ số: xác suất tăng bằng tần suất lịch sử, khoảng giá từ phân phối riêng của chỉ số.
function indexModel(S, hz) {
  const { h } = hz;
  const rows = [];
  for (let t = 70; t + h < S.n; t++) {
    const vol = S.vol(t, 63), ret = S.lc[t + h] - S.lc[t];
    rows.push({ t, d: S.d[t], ret, vol, z: ret / (vol * Math.sqrt(h)), y: ret > 0 ? 1 : 0 });
  }
  const fitZ = (tr) => { const pUp = E.mean(tr.map((r) => r.y)); const c = E.centerOf(pUp); return { pUp, zq: E.zTable(tr.map((r) => r.z - c)) }; };
  const test = [];
  for (const r of rows) {
    if (r.d < FIRST_TEST || r.t % 5) continue;
    const tr = rows.filter((x) => x.t + h < r.t);
    const m = fitZ(tr);
    test.push({ d: r.d, ret: r.ret, y: r.y, in80: r.ret >= E.logReturnAt(0.1, m.pUp, r.vol, h, m.zq) && r.ret <= E.logReturnAt(0.9, m.pUp, r.vol, h, m.zq), in50: r.ret >= E.logReturnAt(0.25, m.pUp, r.vol, h, m.zq) && r.ret <= E.logReturnAt(0.75, m.pUp, r.vol, h, m.zq), hit: (m.pUp > 0.5) === !!r.y });
  }
  const m = fitZ(rows);
  return { model: { h, pUp: round(m.pUp, 4), zq: m.zq.map((x) => round(x, 4)) }, bt: { n: test.length, cover80: pct(test, (r) => r.in80), cover50: pct(test, (r) => r.in50), hit: pct(test, (r) => r.hit), upRate: pct(test, (r) => r.y) } };
}

// Nhật ký dự báo từng mã: các lần không chồng lấn gần nhất, dự báo tại thời điểm đó so với kết quả thật.
function trackRecord(preds, h) {
  const out = {};
  for (const [sym, a] of groupBy(preds, (r) => r.sym)) {
    const s = [...a].sort((x, y) => y.di - x.di);
    const log = [];
    let lastDi = Infinity;
    for (const r of s) {
      if (lastDi - r.di >= Math.max(h, 5)) {
        log.push([r.d, round(r.p, 3), round(r.price, 2), round(r.price * Math.exp(r.lo80), 2), round(r.price * Math.exp(r.hi80), 2), round(r.price * Math.exp(r.ret), 2)]);
        lastDi = r.di;
      }
      if (log.length >= 8) break;
    }
    out[sym] = { n: a.length, cover80: round(pct(a, in80), 1), hit: round(pct(a, (r) => (r.p > 0.5) === !!r.y), 1), upRate: round(pct(a, (r) => r.y), 1), log };
  }
  return out;
}

// ---------- Chạy ----------

const out = { generatedAt: new Date().toISOString(), dataEnd: dates.at(-1), trainedSyms: stocks.length, models: {}, indexModels: {}, backtest: {}, indexBacktest: {}, track: {} };
for (const s of idxSyms) out.indexModels[s] = {};

for (const hz of E.HORIZONS) {
  const { preds, all } = walkForward(hz);
  const hold = preds.filter((r) => r.d >= HOLDOUT);
  out.backtest[hz.key] = { all: period(preds, hz.tail), dev: period(preds.filter((r) => r.d < HOLDOUT), hz.tail), holdout: period(hold, hz.tail), years: [...groupBy(preds, (r) => r.d.slice(0, 4)).entries()].sort().map(([y, a]) => ({ y, n: a.length, upRate: pct(a, (r) => r.y), hit: pct(a, (r) => (r.p > 0.5) === !!r.y), cover80: pct(a, in80) })) };
  out.track[hz.key] = trackRecord(preds, hz.h);

  // Mô hình cuối: học trên toàn bộ dữ liệu.
  const m = fitStock(all.filter((s) => s.di % 3 === 0), hz.h);
  out.models[hz.key] = { h: hz.h, st: { mu: m.st.mu.map((x) => round(x, 5)), sd: m.st.sd.map((x) => round(x, 5)) }, beta: m.beta.map((x) => round(x, 5)), vm: m.vm.map((x) => round(x, 5)), zq: m.zq.map((x) => round(x, 4)) };

  for (const s of idxSyms) {
    const r = indexModel(E.prep(hist[s]), hz);
    out.indexModels[s][hz.key] = r.model;
    if (s === 'VNINDEX' || s === 'VN30') (out.indexBacktest[s] ||= {})[hz.key] = r.bt;
  }

  for (const [tag, b] of [['phát triển 2020-23', out.backtest[hz.key].dev], ['giữ lại 2024+', out.backtest[hz.key].holdout]]) {
  console.log(`\n== ${hz.label}, ${tag} ==  n=${b.n} quý=${b.quarters} tăng=${b.upRate.toFixed(1)}%`);
  console.log(`hướng: đúng ${b.hit.toFixed(1)}% (nền ${b.baseHit.toFixed(1)}%) skill ${b.dirSkill.toFixed(2)}% CI[${b.dirCI.map((x) => x.toFixed(2))}] IC ${b.ic.toFixed(3)}`);
  console.log(`nghiêng tăng n=${b.lean.upN} tăng thật ${b.lean.upReal?.toFixed(1)}% lợi suất ${b.lean.upRet?.toFixed(2)} | nghiêng giảm n=${b.lean.downN} tăng thật ${b.lean.downReal?.toFixed(1)}% lợi suất ${b.lean.downRet?.toFixed(2)} | chung ${b.lean.allRet.toFixed(2)}`);
  console.log(`khoảng: 80%→${b.cover80.toFixed(1)} 50%→${b.cover50.toFixed(1)} rộng ${b.width80.toFixed(1)}%  | khoảng cố định 80%→${b.naive80.toFixed(1)}`);
  console.log('theo biến động:', b.terciles.map((t) => `model ${t.cover80.toFixed(1)} / cố định ${t.naive80.toFixed(1)} (rộng ${t.width.toFixed(1)})`).join(' · '));
  console.log(`rủi ro giảm ≥${hz.tail * 100}%: skill ${b.downSkill.toFixed(1)}% CI[${b.downCI.map((x) => x.toFixed(1))}] tần suất ${b.downRate.toFixed(1)}%; tăng ≥${hz.tail * 100}%: skill ${b.upSkill.toFixed(1)}% CI[${b.upCI.map((x) => x.toFixed(1))}]`);
  console.log(`nhóm đầu ${b.quint.top.toFixed(2)}% (sau phí ${b.quint.topNet.toFixed(2)}%), nhóm cuối ${b.quint.bot.toFixed(2)}% (sau phí ${b.quint.botNet.toFixed(2)}%), cả rổ ${b.quint.all.toFixed(2)}%; đầu trừ cuối ${b.quint.spread.toFixed(2)} CI[${b.quint.spreadCI.map((x) => x.toFixed(2))}]; đầu sau phí trừ giữ cả rổ ${b.quint.vsHold.toFixed(2)} CI[${b.quint.vsHoldCI.map((x) => x.toFixed(2))}]`);
  console.table(b.relDown.map((x) => ({ band: `${x.lo}-${x.hi}`, n: x.n, dự_báo: +x.pred.toFixed(1), thực_tế: +x.real.toFixed(1) })));
  }
  console.log('chỉ số VNINDEX:', JSON.stringify(out.indexBacktest.VNINDEX[hz.key]));
}

const file = path.join(root, 'data', 'model.json');
fs.writeFileSync(file, JSON.stringify(out, (k, v) => (typeof v === 'number' ? round(v, 4) : v)));
console.log('\nwrote', file, (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
