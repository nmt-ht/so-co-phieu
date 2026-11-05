// Lõi tính toán: chỉ báo, đặc trưng, mô hình logistic, dự báo xác suất và khoảng giá.
// Không đụng DOM, nên chạy được cả trong trình duyệt lẫn Node (để huấn luyện và kiểm thử).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StockEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  function quantile(a, q) {
    const s = [...a].sort((x, y) => x - y);
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }
  const clip = (x, a = 4) => Math.max(-a, Math.min(a, x));

  // Φ⁻¹ theo Acklam, đủ chính xác cho xác suất dự báo.
  function probit(p) {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p <= 1 - pl) { const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // ---------- Chuỗi giá ----------

  // rows: [[date, open, high, low, close, volume], ...] → dạng cột, kèm log giá và tổng lũy tiến để tính nhanh.
  function prep(rows) {
    const n = rows.length;
    const S = { n, d: new Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), lc: new Float64Array(n) };
    const cum = new Float64Array(n + 1), cumV = new Float64Array(n + 1), cumR2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      S.d[i] = r[0]; S.o[i] = r[1]; S.h[i] = r[2]; S.l[i] = r[3]; S.c[i] = r[4]; S.v[i] = r[5]; S.lc[i] = Math.log(r[4]);
      cum[i + 1] = cum[i] + S.lc[i];
      cumV[i + 1] = cumV[i] + (r[5] || 0);
      const dr = i ? S.lc[i] - S.lc[i - 1] : 0;
      // Bước nhảy quá lớn gần như luôn là lỗi dữ liệu hoặc đổi sàn, không tính vào biến động.
      cumR2[i + 1] = cumR2[i] + Math.min(dr * dr, 0.04);
    }
    S.ma = (t, k) => (cum[t + 1] - cum[t + 1 - k]) / k; // trung bình log giá k phiên
    S.avgV = (t, k) => (cumV[t + 1] - cumV[t + 1 - k]) / k;
    S.vol = (t, k) => Math.max(Math.sqrt((cumR2[t + 1] - cumR2[Math.max(1, t + 1 - k)]) / Math.max(1, Math.min(k, t))), 0.004);
    S.at = new Map(S.d.map((x, i) => [x, i]));
    return S;
  }

  function smaSeries(v, k) {
    const out = new Array(v.length).fill(null);
    let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= k) s -= v[i - k]; if (i >= k - 1) out[i] = s / k; }
    return out;
  }

  function rsiSeries(c, k = 14) {
    const out = new Array(c.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const x = c[i] - c[i - 1], up = Math.max(x, 0), dn = Math.max(-x, 0);
      if (i <= k) { g += up; l += dn; if (i === k) { g /= k; l /= k; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (k - 1) + up) / k; l = (l * (k - 1) + dn) / k; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return out;
  }

  // ---------- Bối cảnh thị trường theo ngày ----------

  const MKT_MIN = 260;

  // Tính cho từng ngày: động lượng, xu hướng, biến động của VN-Index và độ rộng thị trường.
  function marketContext(index, stocks) {
    const above = new Map(), count = new Map();
    for (const S of stocks) {
      for (let t = 50; t < S.n; t++) {
        const d = S.d[t];
        count.set(d, (count.get(d) || 0) + 1);
        if (S.lc[t] > S.ma(t, 50)) above.set(d, (above.get(d) || 0) + 1);
      }
    }
    const byDate = new Map();
    for (let t = MKT_MIN; t < index.n; t++) {
      const vol = index.vol(t, 63), r = (k) => index.lc[t] - index.lc[t - k];
      const d = index.d[t];
      byDate.set(d, {
        r5: r(5), r21: r(21), r63: r(63), vol,
        f: [
          clip(r(5) / (vol * Math.sqrt(5))),
          clip(r(21) / (vol * Math.sqrt(21))),
          clip(r(63) / (vol * Math.sqrt(63))),
          clip((index.lc[t] - index.ma(t, 200)) / (vol * Math.sqrt(200))),
          clip(Math.log(index.vol(t, 21) / index.vol(t, 252))),
          count.get(d) ? ((above.get(d) || 0) / count.get(d) - 0.5) * 2 : 0,
        ],
        breadth: count.get(d) ? (above.get(d) || 0) / count.get(d) : null,
      });
      byDate.lastDate = d;
    }
    return byDate;
  }

  // ---------- Đặc trưng ----------

  const STOCK_MIN = 260;
  const FEATURES = [
    ['mom5', 'Đà tăng 1 tuần'], ['mom21', 'Đà tăng 1 tháng'], ['mom63', 'Đà tăng 3 tháng'], ['mom126', 'Đà tăng 6 tháng'], ['mom252', 'Đà tăng 1 năm'],
    ['rsi', 'RSI 14'], ['d20', 'So với MA20'], ['d50', 'So với MA50'], ['d200', 'So với MA200'], ['hi', 'Cách đỉnh 52 tuần'],
    ['vr', 'Biến động gần đây'], ['volu', 'Thanh khoản 1 tuần'], ['rs21', 'Mạnh hơn thị trường 1 tháng'], ['rs63', 'Mạnh hơn thị trường 3 tháng'],
    ['m5', 'VN-Index 1 tuần'], ['m21', 'VN-Index 1 tháng'], ['m63', 'VN-Index 3 tháng'], ['m200', 'VN-Index so với MA200'], ['mv', 'Biến động VN-Index'], ['br', 'Độ rộng thị trường'],
  ];

  // Chỉ dùng dữ liệu đến hết phiên t, không nhìn trước.
  function featureAt(S, t, ctx) {
    if (t < STOCK_MIN) return null;
    // Mã có thể mới hơn VN-Index một phiên khi cập nhật trực tuyến; khi đó dùng bối cảnh gần nhất.
    const m = ctx.get(S.d[t]) || (S.d[t] > ctx.lastDate ? ctx.get(ctx.lastDate) : null);
    if (!m) return null;
    const vol = S.vol(t, 63);
    const r = (k) => S.lc[t] - S.lc[t - k];
    const norm = (x, k) => clip(x / (vol * Math.sqrt(k)));
    let hi = -Infinity;
    for (let i = t - 251; i <= t; i++) if (S.lc[i] > hi) hi = S.lc[i];
    let g = 0, l = 0;
    for (let i = t - 13; i <= t; i++) { const x = S.lc[i] - S.lc[i - 1]; if (x > 0) g += x; else l -= x; }
    const rsi = g + l > 0 ? (100 * g) / (g + l) : 50;
    const v5 = S.avgV(t, 5), v60 = S.avgV(t, 60);
    return [
      norm(r(5), 5), norm(r(21), 21), norm(r(63), 63), norm(r(126), 126), norm(r(252), 252),
      clip((rsi - 50) / 15),
      norm(S.lc[t] - S.ma(t, 20), 20), norm(S.lc[t] - S.ma(t, 50), 50), norm(S.lc[t] - S.ma(t, 200), 200),
      norm(S.lc[t] - hi, 252),
      clip(Math.log(S.vol(t, 21) / S.vol(t, 126))),
      v5 > 0 && v60 > 0 ? clip(Math.log(v5 / v60)) : 0,
      norm(r(21) - m.r21, 21), norm(r(63) - m.r63, 63),
      ...m.f,
    ];
  }

  // ---------- Hồi quy logistic có ràng buộc L2 ----------

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let m = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[m][c])) m = r;
      [M[c], M[m]] = [M[m], M[c]];
      const pv = M[c][c] || 1e-9;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / pv;
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / (row[i] || 1e-9));
  }

  // X đã chuẩn hóa, không có cột hệ số chặn; y là 0/1. Trả về beta với beta[0] là hệ số chặn.
  function fitLogistic(X, y, lambda, iters = 8) {
    const p = X[0].length + 1;
    let beta = new Array(p).fill(0);
    for (let it = 0; it < iters; it++) {
      const A = Array.from({ length: p }, () => new Array(p).fill(0));
      const g = new Array(p).fill(0);
      for (let n = 0; n < X.length; n++) {
        const row = X[n];
        let z = beta[0];
        for (let j = 1; j < p; j++) z += beta[j] * row[j - 1];
        const pr = 1 / (1 + Math.exp(-z));
        const w = Math.max(pr * (1 - pr), 1e-4), e = y[n] - pr;
        g[0] += e;
        A[0][0] += w;
        for (let i = 1; i < p; i++) {
          const xi = row[i - 1];
          g[i] += e * xi;
          A[0][i] += w * xi;
          for (let j = i; j < p; j++) A[i][j] += w * xi * row[j - 1];
        }
      }
      for (let i = 0; i < p; i++) {
        for (let j = 0; j < i; j++) A[i][j] = A[j][i];
        if (i) { A[i][i] += lambda; g[i] -= lambda * beta[i]; }
      }
      const step = solve(A, g);
      beta = beta.map((b, i) => b + step[i]);
    }
    return beta;
  }

  function standardizer(X) {
    const p = X[0].length, mu = new Array(p).fill(0), sd = new Array(p).fill(0);
    for (const r of X) for (let j = 0; j < p; j++) mu[j] += r[j] / X.length;
    for (const r of X) for (let j = 0; j < p; j++) sd[j] += (r[j] - mu[j]) ** 2 / X.length;
    return { mu, sd: sd.map((x) => Math.sqrt(x) || 1) };
  }

  const standardize = (row, st) => row.map((x, j) => (x - st.mu[j]) / st.sd[j]);

  // Xác suất tăng và phần đóng góp của từng đặc trưng (logit) để giải thích được dự báo.
  function scoreRow(row, model) {
    const z = standardize(row, model.st);
    const parts = z.map((x, j) => x * model.beta[j + 1]);
    const logit = model.beta[0] + parts.reduce((s, x) => s + x, 0);
    return { p: 1 / (1 + Math.exp(-logit)), logit, parts };
  }

  // ---------- Phân phối lợi suất ----------

  // Các mức phân vị lưu trong mô hình để nội suy cả khoảng giá lẫn xác suất vượt ngưỡng.
  const Q_LEVELS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99];

  const zTable = (z) => { const s = [...z].sort((a, b) => a - b); return Q_LEVELS.map((q) => { const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }); };

  function zAt(tab, q) {
    if (q <= Q_LEVELS[0]) return tab[0];
    for (let i = 1; i < Q_LEVELS.length; i++) {
      if (q <= Q_LEVELS[i]) return tab[i - 1] + ((tab[i] - tab[i - 1]) * (q - Q_LEVELS[i - 1])) / (Q_LEVELS[i] - Q_LEVELS[i - 1]);
    }
    return tab[tab.length - 1];
  }

  function cdfAt(tab, z) {
    if (z <= tab[0]) return Q_LEVELS[0] / 2;
    for (let i = 1; i < tab.length; i++) {
      if (z <= tab[i]) return Q_LEVELS[i - 1] + ((Q_LEVELS[i] - Q_LEVELS[i - 1]) * (z - tab[i - 1])) / Math.max(1e-9, tab[i] - tab[i - 1]);
    }
    return (1 + Q_LEVELS[Q_LEVELS.length - 1]) / 2;
  }

  // Tâm phân phối suy từ xác suất tăng, nên khoảng giá luôn nhất quán với xác suất đang hiển thị.
  const centerOf = (p) => probit(Math.min(0.98, Math.max(0.02, p)));

  // Phần trăm thay đổi giá (log) ứng với mức phân vị q.
  function logReturnAt(q, p, vol, h, tab) {
    return (centerOf(p) + zAt(tab, q)) * vol * Math.sqrt(h);
  }

  // Xác suất lợi suất kỳ h không vượt quá mức x (theo tỷ lệ, ví dụ -0.05).
  function probBelow(x, p, vol, h, tab) {
    return cdfAt(tab, Math.log(1 + x) / (vol * Math.sqrt(h)) - centerOf(p));
  }

  function bandOf(price, p, vol, h, tab) {
    const at = (q) => price * Math.exp(logReturnAt(q, p, vol, h, tab));
    return { mid: at(0.5), lo50: at(0.25), hi50: at(0.75), lo80: at(0.1), hi80: at(0.9) };
  }

  // ---------- Dự báo biến động ----------

  // Biến động có xu hướng hồi về mức trung bình, nên dự báo từ nhiều khung thời gian (dạng HAR)
  // thay vì giả định biến động 3 tháng qua sẽ giữ nguyên.
  const volInputs = (S, t) => [1, Math.log(S.vol(t, 5)), Math.log(S.vol(t, 21)), Math.log(S.vol(t, 63)), Math.log(S.vol(t, 252))];
  const volHat = (S, t, coef) => Math.exp(volInputs(S, t).reduce((s, x, i) => s + x * coef[i], 0));

  function fitOLS(X, y) {
    const p = X[0].length;
    const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
    for (let n = 0; n < X.length; n++) {
      for (let i = 0; i < p; i++) { b[i] += X[n][i] * y[n]; for (let j = 0; j < p; j++) A[i][j] += X[n][i] * X[n][j]; }
    }
    return solve(A, b);
  }

  // ---------- Dự báo tại phiên cuối ----------

  const HORIZONS = [
    { key: 'w1', h: 5, label: '1 tuần', tail: 0.05 },
    { key: 'm1', h: 21, label: '1 tháng', tail: 0.1 },
  ];
  const STOCK_FEATURES = 14; // mô hình cuối chỉ dùng 14 đặc trưng riêng của mã, xem scripts/experiment.js

  function forecastStock(S, ctx, models) {
    const t = S.n - 1;
    const row = featureAt(S, t, ctx);
    if (!row) return null;
    const out = { date: S.d[t], price: S.c[t], vol: S.vol(t, 63) };
    for (const hz of HORIZONS) {
      const m = models[hz.key];
      const r = scoreRow(row.slice(0, STOCK_FEATURES), m);
      out[hz.key] = withRisk(S.c[t], r.p, volHat(S, t, m.vm), hz, m.zq, r.parts);
    }
    return out;
  }

  // Chỉ số không có mô hình hướng: xác suất tăng chính là tần suất tăng trong lịch sử của chỉ số đó.
  function forecastIndex(S, models) {
    const t = S.n - 1;
    if (t < 70) return null;
    const vol = S.vol(t, 63);
    const out = { date: S.d[t], price: S.c[t], vol };
    for (const hz of HORIZONS) {
      const m = models[hz.key];
      out[hz.key] = withRisk(S.c[t], m.pUp, vol, hz, m.zq, null);
    }
    return out;
  }

  function withRisk(price, p, vol, hz, zq, parts) {
    return {
      h: hz.h, p, parts,
      band: bandOf(price, p, vol, hz.h, zq),
      pDown: probBelow(-hz.tail, p, vol, hz.h, zq),
      pUp: 1 - probBelow(hz.tail, p, vol, hz.h, zq),
    };
  }

  // ---------- Phí và giới hạn vị thế ----------

  // Giả định: phí môi giới 0,15% mỗi chiều và thuế 0,1% khi bán. Mức thực tế tùy công ty chứng khoán.
  const COSTS = { buy: 0.0015, sell: 0.0015, tax: 0.001 };
  const ROUND_TRIP = COSTS.buy + COSTS.sell + COSTS.tax;
  const LOT = 100;

  // Số tiền tối đa nên đặt vào MỘT mã do người dùng tự chọn, để nếu giá về mức tham chiếu thì lỗ khoảng riskPct vốn.
  // price và refPrice cùng đơn vị đồng. Không chọn mã, không chia tỉ lệ giữa các mã.
  function positionLimit({ capital, riskPct, price, refPrice }) {
    if (!(capital > 0) || !(riskPct > 0) || !(price > 0)) return { ok: false, reason: 'input' };
    const refDrop = 1 - refPrice / price;
    if (!(refDrop > 0)) return { ok: false, reason: 'noDrop' };
    const budget = capital * (riskPct / 100);
    const raw = budget / refDrop;
    const capped = raw > capital;
    const limit = Math.min(raw, capital);
    // Phí mua cũng phải nằm trong vốn khi vị thế chạm trần vốn.
    const cash = capped ? capital / (1 + COSTS.buy) : limit;
    const shares = Math.floor(cash / price / LOT) * LOT;
    const value = shares * price;
    const buyFee = value * COSTS.buy;
    const sellValue = shares * refPrice;
    const sellFee = sellValue * (COSTS.sell + COSTS.tax);
    const priceLoss = value - sellValue;
    return { ok: true, refDrop, budget, raw, limit, capped, shares, value, buyFee, sellFee, priceLoss, totalLoss: priceLoss + buyFee + sellFee, lotCost: LOT * price * (1 + COSTS.buy) };
  }

  return {
    COSTS, ROUND_TRIP, LOT, positionLimit,
    mean, std, quantile, clip, probit, prep, smaSeries, rsiSeries, marketContext, FEATURES, STOCK_MIN, STOCK_FEATURES, HORIZONS, Q_LEVELS,
    featureAt, volInputs, volHat, fitOLS, fitLogistic, standardizer, standardize, scoreRow, zTable, zAt, cdfAt, centerOf, logReturnAt, probBelow, bandOf,
    forecastStock, forecastIndex,
  };
});
