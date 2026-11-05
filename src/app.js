// Giao diện Sổ Cổ Phiếu. Mọi phép tính nằm ở engine.js.
(function () {
  const E = window.StockEngine, U = window.StockUniverse, SNAP = window.__SNAPSHOT__, M = SNAP.model;
  const STANDALONE = window.__STANDALONE__;
  const NAMES = SNAP.names;
  const API = 'https://dchart-api.vndirect.com.vn/dchart/history';
  const IDX = U.INDICES.map((x) => x.s);
  const $ = (id) => document.getElementById(id);
  const HZ = Object.fromEntries(E.HORIZONS.map((h) => [h.key, h]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('socophieu.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('socophieu.' + k, JSON.stringify(v)); } catch { /* bộ nhớ đầy hoặc bị chặn: bỏ qua */ } },
  };

  const state = { tab: 'thi-truong', idx: 'VNINDEX', sym: 'FPT', hz: store.get('hz', 'w1'), range: '3T', sort: 'risk', sector: '', onlyWatch: false, ma: store.get('ma', ['m50']), intro: store.get('intro', true), watch: store.get('watch', []), loading: null, updatedAt: null };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (d) => new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (x, d = 2) => nf(d).format(x);
  const minus = (s) => s.replace('-', '−');
  // Làm tròn trước khi xét dấu để không hiện "−0,0%".
  const pct = (x, d = 1) => minus(num(+x.toFixed(d) || 0, d)) + '%';
  const sPct = (x, d = 1) => { const r = +x.toFixed(d) || 0; return (r > 0 ? '+' : '') + minus(num(r, d)) + '%'; };
  const prob = (p) => Math.round(p * 100) + '%';
  const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const isIdx = (s) => IDX.includes(s);
  const idxName = (s) => U.INDICES.find((x) => x.s === s).n;
  const fmtPrice = (s, x) => (isIdx(s) ? num(x, 2) : num(x, 2));

  function addSessions(d, n) {
    const t = new Date(d + 'T00:00:00Z');
    while (n > 0) { t.setUTCDate(t.getUTCDate() + 1); const w = t.getUTCDay(); if (w !== 0 && w !== 6) n--; }
    return t.toISOString().slice(0, 10);
  }

  // ---------- Dữ liệu ----------

  // Trong giờ giao dịch, VNDirect trả nến giữ chỗ cho cổ phiếu (giá bằng hôm trước, khối lượng 0).
  // Dự báo chỉ dùng phiên đã đóng cửa; giá trong phiên được giữ riêng để hiển thị.
  const live = new Map();
  const vnNow = () => new Date(Date.now() + 7 * 3600e3);
  const inSessionToday = (d) => { const n = vnNow(); return d === n.toISOString().slice(0, 10) && n.getUTCHours() * 60 + n.getUTCMinutes() < 15 * 60 + 5; };
  function closedOnly(sym, a) {
    let end = a.length;
    while (end > 0 && (!a[end - 1][5] || inSessionToday(a[end - 1][0]))) {
      const r = a[end - 1], prev = a[end - 2];
      if (inSessionToday(r[0]) && prev && r[4] !== prev[4]) live.set(sym, { price: r[4], chg: (r[4] / prev[4] - 1) * 100 });
      end--;
    }
    return end === a.length ? a : a.slice(0, end);
  }

  const rows = new Map();
  for (const [s, a] of Object.entries(SNAP.series)) rows.set(s, a.map((r) => [SNAP.dates[r[0]], r[1], r[2], r[3], r[4], r[5]]));
  const saved = store.get('rows', {});
  for (const [s, r] of Object.entries(saved)) mergeRows(s, r.rows, r.full);

  function mergeRows(s, fresh, full) {
    if (!fresh || !fresh.length) return;
    const clean = closedOnly(s, fresh);
    if (full || !rows.has(s)) { rows.set(s, clean); return; }
    const old = rows.get(s);
    const first = fresh[0][0];
    rows.set(s, old.filter((r) => r[0] < first).concat(clean));
  }

  const series = new Map();
  const forecasts = new Map();
  let ctx = null, lastDate = '';

  function recompute() {
    series.clear(); forecasts.clear();
    for (const [s, r] of rows) series.set(s, E.prep(r));
    const stocks = U.UNIVERSE.filter((s) => series.has(s)).map((s) => series.get(s));
    ctx = E.marketContext(series.get('VNINDEX'), stocks);
    lastDate = series.get('VNINDEX').d.at(-1);
    for (const s of series.keys()) forecasts.set(s, forecastOf(s));
  }

  function forecastOf(s) {
    const S = series.get(s);
    if (isIdx(s)) return E.forecastIndex(S, M.indexModels[s]);
    return E.forecastStock(S, ctx, M.models);
  }

  function ret(S, k) { const t = S.n - 1; return t - k >= 0 ? (S.c[t] / S.c[t - k] - 1) * 100 : null; }

  async function getBars(sym, fromSec) {
    const to = Math.floor(Date.now() / 1000);
    const res = await fetch(`${API}?resolution=D&symbol=${encodeURIComponent(sym)}&from=${fromSec}&to=${to}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.s !== 'ok' || !j.t || !j.t.length) return [];
    const out = [];
    for (let i = 0; i < j.t.length; i++) if (j.c[i] > 0) out.push([new Date(j.t[i] * 1000).toISOString().slice(0, 10), j.o[i], j.h[i], j.l[i], j.c[i], j.v[i]]);
    return out;
  }

  const FIVE_YEARS = 5.3 * 365 * 86400;

  // Giá lịch sử được điều chỉnh khi có chia tách, cổ tức: nếu phần trùng lệch thì tải lại cả chuỗi của mã đó.
  async function refreshSymbol(sym, fresh) {
    const old = rows.get(sym);
    const lastD = old.at(-1)[0];
    const from = Math.floor(Date.parse(lastD + 'T00:00:00Z') / 1000) - 14 * 86400;
    const bars = await getBars(sym, from);
    if (!bars.length) return;
    const onOld = new Map(old.slice(-20).map((r) => [r[0], r[4]]));
    const overlap = bars.filter((b) => onOld.has(b[0]) && b[0] < lastD).at(-1);
    if (overlap && Math.abs(overlap[4] / onOld.get(overlap[0]) - 1) > 0.005) {
      const all = await getBars(sym, Math.floor(Date.now() / 1000 - FIVE_YEARS));
      if (all.length) { mergeRows(sym, all, true); fresh[sym] = { rows: all, full: true }; }
      return;
    }
    mergeRows(sym, bars, false);
    const prev = fresh[sym] && fresh[sym].full ? fresh[sym].rows : (fresh[sym] && fresh[sym].rows) || [];
    const merged = prev.filter((r) => r[0] < bars[0][0]).concat(bars);
    fresh[sym] = { rows: merged, full: !!(fresh[sym] && fresh[sym].full) };
  }

  async function refreshAll() {
    if (!STANDALONE) return;
    setStatus('Đang lấy giá mới…');
    $('refresh').hidden = true;
    const list = [...IDX, ...U.UNIVERSE];
    const fresh = store.get('rows', {});
    let failed = 0;
    for (let i = 0; i < list.length; i += 6) {
      await Promise.all(list.slice(i, i + 6).map((s) => refreshSymbol(s, fresh).catch(() => { failed++; })));
    }
    store.set('rows', fresh);
    if (failed === list.length) {
      showNotice(`Không lấy được giá mới. App đang dùng dữ liệu đến ${dmy(lastDate)}. Kiểm tra mạng rồi bấm Làm mới.`, true);
    } else {
      showNotice(failed ? `Chưa cập nhật được ${failed} mã, các mã đó vẫn dùng dữ liệu cũ.` : '');
      state.updatedAt = new Date();
      recompute();
      render();
    }
    updateStatus();
    $('refresh').hidden = false;
  }

  function setStatus(t) { $('status').textContent = t; }
  function updateStatus() {
    setStatus(`Đóng cửa ${dmy(lastDate)}`);
    if (STANDALONE) $('refresh').hidden = false;
  }
  function showNotice(t, err) { const n = $('notice'); n.hidden = !t; n.textContent = t || ''; n.classList.toggle('error', !!err); }

  // ---------- Biểu đồ ----------

  const pending = [];
  const niceStep = (span, count) => { const raw = span / count, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };

  // spec: { h, n, dateOf(i), series:[{name,color,vals,w,dash}], bars:{vals}, bands:[{lo,hi,fill}], refs:[y], yFmt, yMin, yMax, readout(i) }
  function drawChart(id, spec) {
    const host = $(id);
    if (!host) return;
    const plot = host.querySelector('.plot'), out = host.querySelector('.readout');
    const W = Math.max(280, plot.clientWidth || 640), H = spec.h;
    const pad = { l: 2, r: 50, t: 6, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    let lo = Infinity, hi = -Infinity;
    const scan = (v) => { for (const x of v) if (x != null && isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } };
    for (const s of spec.series || []) scan(s.vals);
    for (const b of spec.bands || []) { scan(b.lo); scan(b.hi); }
    if (spec.bars) { scan(spec.bars.vals); lo = 0; }
    if (spec.yMin != null) lo = spec.yMin;
    if (spec.yMax != null) hi = spec.yMax;
    if (!spec.bars && spec.yMin == null) { const m = (hi - lo) * 0.06 || hi * 0.02 || 1; lo -= m; hi += m; }
    const y = (v) => pad.t + ih * (1 - (v - lo) / (hi - lo || 1));
    const x = (i) => pad.l + (spec.n <= 1 ? 0 : (iw * i) / (spec.n - 1));
    const step = spec.yStep || niceStep(hi - lo, H < 110 ? 2 : 4);
    let g = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--color-grid)"/><text x="${W - pad.r + 6}" y="${y(v) + 4}">${esc(spec.yFmt(v))}</text>`;
    }
    for (const r of spec.refs || []) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(r)}" y2="${y(r)}" stroke="var(--color-muted)" stroke-dasharray="3 3"/>`;
    // Mốc thời gian theo tháng hoặc năm, đủ thưa để không chồng chữ.
    const maxTicks = Math.floor(iw / 72);
    const ticks = [];
    let prevKey = '';
    const span = spec.n;
    const keyOf = (d) => (span > 500 ? d.slice(0, 4) : span > 70 ? d.slice(0, 7) : d.slice(0, 10));
    for (let i = 0; i < spec.n; i++) { const d = spec.dateOf(i), k = keyOf(d); if (k !== prevKey) { if (prevKey) ticks.push(i); prevKey = k; } }
    const every = Math.max(1, Math.ceil(ticks.length / maxTicks));
    ticks.filter((_, i) => i % every === 0).filter((i) => x(i) >= 20 && x(i) <= W - pad.r - 8).forEach((i) => {
      const d = spec.dateOf(i), lab = span > 500 ? d.slice(0, 4) : span > 70 ? `${d.slice(5, 7)}/${d.slice(2, 4)}` : dm(d);
      g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
    });
    for (const b of spec.bands || []) {
      const idx = []; for (let i = 0; i < spec.n; i++) if (b.lo[i] != null) idx.push(i);
      if (idx.length) g += `<path fill="${b.fill}" d="M${idx.map((i) => `${x(i)},${y(b.hi[i])}`).join('L')}L${[...idx].reverse().map((i) => `${x(i)},${y(b.lo[i])}`).join('L')}Z"/>`;
    }
    if (spec.bars) {
      const bw = Math.max(1, Math.min(6, (iw / spec.n) * 0.7));
      spec.bars.vals.forEach((v, i) => { if (v) g += `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(1, y(0) - y(v))}" fill="${spec.bars.color}"/>`; });
    }
    for (const s of spec.series || []) {
      let d = '', on = false;
      s.vals.forEach((v, i) => { if (v == null) { on = false; return; } d += `${on ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; on = true; });
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
    }
    const main = (spec.series || [])[0];
    if (main && spec.nowIdx != null && main.vals[spec.nowIdx] != null) {
      const nx = x(spec.nowIdx), ny = y(main.vals[spec.nowIdx]);
      if (spec.nowIdx < spec.n - 1) g += `<line x1="${nx}" x2="${nx}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--color-line)"/>`;
      g += `<circle cx="${nx}" cy="${ny}" r="4" fill="${main.color}" stroke="var(--color-surface)" stroke-width="2"/>`;
    }
    g += `<line class="cross" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--color-muted)" visibility="hidden"/>`;
    if (main) g += `<circle class="dot" r="4" fill="${main.color}" stroke="var(--color-surface)" stroke-width="2" visibility="hidden"/>`;
    plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(spec.label || '')}">${g}<rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/></svg>`;
    const svg = plot.firstChild, cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot');
    let cur = spec.start != null ? spec.start : spec.n - 1;
    const show = (i, mark) => {
      cur = Math.max(0, Math.min(spec.n - 1, i));
      out.innerHTML = spec.readout(cur);
      if (!mark) { cross.setAttribute('visibility', 'hidden'); if (dot) dot.setAttribute('visibility', 'hidden'); return; }
      cross.setAttribute('x1', x(cur)); cross.setAttribute('x2', x(cur)); cross.setAttribute('visibility', 'visible');
      if (dot && main.vals[cur] != null) { dot.setAttribute('cx', x(cur)); dot.setAttribute('cy', y(main.vals[cur])); dot.setAttribute('visibility', 'visible'); }
      else if (dot) dot.setAttribute('visibility', 'hidden');
    };
    const at = (e) => { const r = svg.getBoundingClientRect(); return Math.round((((e.clientX - r.left) * (W / r.width) - pad.l) / iw) * (spec.n - 1)); };
    svg.addEventListener('pointermove', (e) => show(at(e), true));
    svg.addEventListener('pointerdown', (e) => show(at(e), true));
    svg.addEventListener('pointerleave', () => show(spec.start != null ? spec.start : spec.n - 1, false));
    plot.tabIndex = 0;
    plot.onkeydown = (e) => {
      if (e.key === 'ArrowLeft') { show(cur - 1, true); e.preventDefault(); }
      if (e.key === 'ArrowRight') { show(cur + 1, true); e.preventDefault(); }
    };
    show(cur, false);
  }

  const chartBox = (id, extra = '') => `<div class="chart" id="${id}"><div class="readout"></div><div class="plot"></div>${extra}</div>`;
  const legend = (items) => `<div class="legend">${items.map((i) => `<span><i class="${i.swatch ? 'swatch' : ''}" style="background:${i.color}"></i>${esc(i.name)}</span>`).join('')}</div>`;
  const readoutHtml = (title, list) => `<div class="readout-title">${esc(title)}</div><div class="readout-rows">${list.map((r) => `<span>${r.color ? `<i style="background:${r.color}"></i>` : ''}${esc(r.k)}<b>${esc(r.v)}</b></span>`).join('')}</div>`;

  const RANGES = { '3T': 63, '6T': 126, '1N': 252, '3N': 756, '5N': 1300 };
  const RANGE_LABEL = { '3T': '3 tháng', '6T': '6 tháng', '1N': '1 năm', '3N': '3 năm', '5N': '5 năm' };
  const MA_LINES = [['m20', 'MA20', 'var(--color-s1)', 20], ['m50', 'MA50', 'var(--color-s2)', 50], ['m200', 'MA200', 'var(--color-s3)', 200]];

  // Giá kèm MA và vùng dự báo cho kỳ đang chọn.
  function priceSpec(sym, hzKey, label) {
    const S = series.get(sym), fc = forecasts.get(sym);
    const k = Math.min(S.n, RANGES[state.range] || 252);
    const start = S.n - k;
    const f = fc && hzKey ? fc[hzKey] : null, h = f ? f.h : 0;
    const n = k + h;
    const dateOf = (i) => (i < k ? S.d[start + i] : addSessions(S.d[S.n - 1], i - k + 1));
    const closes = Array.from(S.c);
    const ma = (w) => { const a = E.smaSeries(closes, w); return Array.from({ length: n }, (_, i) => (i < k ? a[start + i] : null)); };
    const price = Array.from({ length: n }, (_, i) => (i < k ? S.c[start + i] : null));
    const lo80 = new Array(n).fill(null), hi80 = new Array(n).fill(null), lo50 = new Array(n).fill(null), hi50 = new Array(n).fill(null), mid = new Array(n).fill(null);
    if (f) {
      const P = S.c[S.n - 1], b = f.band;
      lo80[k - 1] = hi80[k - 1] = lo50[k - 1] = hi50[k - 1] = mid[k - 1] = P;
      // Khoảng mở rộng theo căn bậc hai thời gian, nối từ giá hiện tại đến khoảng cuối kỳ.
      for (let i = k; i < n; i++) {
        const w = Math.sqrt((i - k + 1) / h), at = (v) => P * Math.exp(Math.log(v / P) * w);
        lo80[i] = at(b.lo80); hi80[i] = at(b.hi80); lo50[i] = at(b.lo50); hi50[i] = at(b.hi50); mid[i] = at(b.mid);
      }
    }
    const colors = { price: 'var(--color-ink)', m20: 'var(--color-s1)', m50: 'var(--color-s2)', m200: 'var(--color-s3)' };
    const m20 = ma(20), m50 = ma(50), m200 = ma(200);
    return {
      id: label, h: 260, n, dateOf, label: `Giá ${sym} và khoảng dự báo`, start: k - 1, nowIdx: k - 1,
      series: [
        { name: 'Giá', color: colors.price, vals: price },
        ...(state.ma.includes('m20') ? [{ name: 'MA20', color: colors.m20, vals: m20, w: 1.5 }] : []),
        ...(state.ma.includes('m50') ? [{ name: 'MA50', color: colors.m50, vals: m50, w: 1.5 }] : []),
        ...(state.ma.includes('m200') ? [{ name: 'MA200', color: colors.m200, vals: m200, w: 1.5 }] : []),
        ...(f ? [{ name: 'Giữa khoảng', color: 'var(--color-accent)', vals: mid, dash: '4 4' }] : []),
      ],
      bands: f ? [{ lo: lo80, hi: hi80, fill: 'var(--color-band-80)' }, { lo: lo50, hi: hi50, fill: 'var(--color-band-50)' }] : [],
      yFmt: (v) => (v >= 1000 ? num(v, 0) : num(v, v >= 100 ? 0 : 1)),
      readout: (i) => {
        if (i < k) return readoutHtml(dmy(dateOf(i)), [{ k: 'Giá', v: fmtPrice(sym, price[i]), color: colors.price }, ...MA_LINES.filter((l) => state.ma.includes(l[0]) && { m20, m50, m200 }[l[0]][i]).map((l) => ({ k: l[1], v: fmtPrice(sym, { m20, m50, m200 }[l[0]][i]), color: l[2] }))]);
        return readoutHtml(`Dự kiến khoảng ${dmy(dateOf(i))}`, [{ k: 'Giữa khoảng', v: fmtPrice(sym, mid[i]) }, { k: '8/10 lần', v: `${fmtPrice(sym, lo80[i])} – ${fmtPrice(sym, hi80[i])}` }]);
      },
    };
  }

  // ---------- Giải thích ----------

  const HELP = {
    range: ['Khoảng 8 trên 10 lần', ['Nếu lặp lại tình huống này 10 lần, khoảng 8 lần giá cuối kỳ sẽ nằm trong khoảng này. Vẫn còn khoảng 2 lần giá đi ra ngoài, có thể cao hơn hoặc thấp hơn nhiều.', 'Khoảng được tính từ độ dao động gần đây của mã và đã được kiểm tra lại trên dữ liệu quá khứ, xem ở tab Độ tin cậy.']],
    dir: ['Khả năng tăng', ['Là tỷ lệ phần trăm app ước tính giá cuối kỳ cao hơn hiện tại.', 'Kiểm định cho thấy con số này gần như không hơn việc đoán theo tần suất chung. Đừng dùng riêng nó để ra quyết định.']],
    level: ['Mức dao động', ['So sánh khoảng giá dự kiến của mã này với các mã khác trong danh sách. Thấp, vừa, cao tương ứng với một phần ba số mã có khoảng hẹp nhất, ở giữa và rộng nhất.', 'Dao động cao không có nghĩa là tốt hay xấu, chỉ là giá có thể đi xa hơn theo cả hai chiều.']],
    vol: ['Độ dao động cả năm', ['Cho biết giá thường dao động mạnh đến đâu, quy đổi ra một năm từ biến động của 3 tháng gần nhất. Số càng lớn, giá càng hay lên xuống mạnh.']],
    rsi: ['RSI', ['Chỉ báo từ 0 đến 100, so sánh mức tăng và mức giảm trong 14 phiên gần nhất. Trên 70 thường gọi là quá mua, dưới 30 là quá bán.', 'Giá vẫn có thể ở các vùng này khá lâu, nên đây không phải tín hiệu đảo chiều chắc chắn.']],
    ma: ['Đường trung bình MA', ['MA50 là giá trung bình của 50 phiên gần nhất. Giá nằm trên đường này nghĩa là đang cao hơn mức trung bình gần đây, nằm dưới thì ngược lại.', 'MA20 phản ánh ngắn hạn, MA200 phản ánh dài hạn.']],
    liq: ['Thanh khoản', ['So sánh khối lượng giao dịch trung bình 1 tuần qua với 60 phiên trước. Trên 1 lần là đang giao dịch sôi động hơn bình thường.']],
    ref: ['Mức giảm tham chiếu', ['Là khoảng cách từ giá đóng cửa xuống cận dưới của khoảng 8 trên 10 lần trong kỳ đang chọn. App dùng nó để tính số tiền tối đa theo mức lỗ bạn đặt.', 'Khoảng 1 trên 10 lần giá xuống thấp hơn mức này, nên đây không phải mức lỗ tối đa.']],
    breadth: ['Độ rộng thị trường', ['Là tỷ lệ mã đang có giá trên đường trung bình 50 phiên. Chỉ số có thể tăng nhờ vài mã lớn, còn độ rộng cho biết có nhiều mã cùng tăng hay không.', 'App gọi là khỏe khi từ 60% trở lên, yếu khi dưới 40%. Đây là cách mô tả, không phải dự báo.']],
  };
  const helpBtn = (k) => `<button class="help" type="button" data-act="help:${k}" aria-label="Giải thích: ${esc(HELP[k][0])}">?</button>`;
  function openHelp(k) {
    const d = $('help');
    $('help-title').textContent = HELP[k][0];
    $('help-body').innerHTML = HELP[k][1].map((p) => `<p>${esc(p)}</p>`).join('');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('help-title').focus();
  }

  // ---------- Thành phần ----------

  // Màu giá theo bảng điện: trần, sàn, tham chiếu dựa trên biên độ của từng sàn.
  function sessionState(sym, chg) {
    const lim = isIdx(sym) ? null : ({ H: 7, X: 10, U: 15 }[(NAMES[sym] || [])[1]] || 7);
    if (Math.abs(chg) < 0.05) return { c: 'b-ref', t: 'Tham chiếu' };
    if (lim && chg >= lim - 0.4) return { c: 'b-ceil', t: 'Trần' };
    if (lim && chg <= -(lim - 0.4)) return { c: 'b-floor', t: 'Sàn' };
    return chg > 0 ? { c: 'b-up', t: '' } : { c: 'b-down', t: '' };
  }

  const indexTabs = () => `<div class="idx-tabs" role="group" aria-label="Chọn chỉ số">${U.INDICES.map((x) => `<button type="button" data-act="idx:${x.s}" aria-pressed="${state.idx === x.s}">${esc(x.s === 'VNINDEX' ? x.n : x.n.replace('-Index', ''))}</button>`).join('')}</div>`;

  // Một câu mô tả tình trạng hiện tại bằng lời thường, chỉ dựa vào đường trung bình.
  function plainTrend(sym) {
    const S = series.get(sym), t = S.n - 1;
    if (t < 200) return 'Mã này còn ít lịch sử giao dịch nên chưa đánh giá được xu hướng dài hạn.';
    const closes = Array.from(S.c);
    const a50 = S.c[t] > E.smaSeries(closes, 50)[t], a200 = S.c[t] > E.smaSeries(closes, 200)[t];
    if (a50 && a200) return 'Giá đang trên cả đường trung bình 50 và 200 phiên, xu hướng hiện tại đang lên.';
    if (!a50 && !a200) return 'Giá đang dưới cả đường trung bình 50 và 200 phiên, xu hướng hiện tại đang yếu.';
    return a50 ? 'Giá đã hồi lên trên đường trung bình 50 phiên, nhưng vẫn dưới đường 200 phiên.' : 'Giá đã xuống dưới đường trung bình 50 phiên, nhưng vẫn trên đường 200 phiên.';
  }

  function board(sym, extra) {
    const S = series.get(sym), t = S.n - 1;
    const chg = t ? (S.c[t] / S.c[t - 1] - 1) * 100 : 0;
    const diff = t ? S.c[t] - S.c[t - 1] : 0;
    const st = sessionState(sym, chg);
    const name = isIdx(sym) ? idxName(sym) : (NAMES[sym] && NAMES[sym][0]) || sym;
    const vol = S.vol(t, 63) * Math.sqrt(252) * 100;
    let hi = -Infinity; for (let i = Math.max(0, t - 251); i <= t; i++) hi = Math.max(hi, S.c[i]);
    const r5 = ret(S, 5), r21 = ret(S, 21);
    return `<section class="board">
      ${isIdx(sym) ? indexTabs() : ''}
      ${isIdx(sym) ? '' : `<div class="board-top"><div class="board-label"><b>${esc(sym)}</b><br>${esc(name)}</div>${extra || ''}</div>`}
      <div>
        <div class="price ${st.c}">${fmtPrice(sym, S.c[t])}${isIdx(sym) ? '<small>điểm</small>' : '<small>nghìn đồng</small>'}</div>
        <div class="delta ${st.c}">${sPct(chg, 2)} (${diff > 0 ? '+' : ''}${minus(num(diff, 2))})${st.t ? ` · ${st.t}` : ''} <span>phiên ${dm(S.d[t])}</span></div>
        ${live.has(sym) ? `<div class="board-live">Trong phiên: <b>${fmtPrice(sym, live.get(sym).price)}</b> (${sPct(live.get(sym).chg, 2)}). Dự báo tính từ giá đóng cửa.</div>` : ''}
      </div>
      <p class="board-say">${esc(plainTrend(sym))}</p>
      <dl class="board-grid">
        <div><dt>1 tuần qua</dt><dd>${r5 == null ? '–' : sPct(r5)}</dd></div>
        <div><dt>1 tháng qua</dt><dd>${r21 == null ? '–' : sPct(r21)}</dd></div>
        <div><dt>So với đỉnh 52 tuần</dt><dd>${sPct((S.c[t] / hi - 1) * 100)}</dd></div>
        <div><dt>Độ dao động cả năm ${helpBtn('vol')}</dt><dd>${pct(vol, 0)}</dd></div>
      </dl>
    </section>`;
  }

  // Bộ so sánh để biết biến động dự báo của mã này cao hay thấp so với cả danh sách.
  function widthOf(fc, key) { const f = fc[key]; return (f.band.hi80 / f.band.lo80 - 1) * 100; }
  function riskRank(sym, key) {
    const all = U.UNIVERSE.filter((s) => forecasts.get(s)).map((s) => widthOf(forecasts.get(s), key));
    const me = widthOf(forecasts.get(sym), key);
    return Math.round((all.filter((x) => x < me).length / all.length) * 100);
  }

  function riskLevel(rank) {
    if (rank == null) return null;
    return rank >= 67 ? { c: 'weak', t: 'Dao động cao' } : rank >= 33 ? { c: 'mid', t: 'Dao động vừa' } : { c: 'good', t: 'Dao động thấp' };
  }

  function forecastCard(sym, key) {
    const fc = forecasts.get(sym), hz = HZ[key];
    const title = isIdx(sym) ? idxName(sym) : sym;
    if (!fc) return `<section class="block col-7"><h2>${esc(title)} có thể đi đến đâu trong ${hz.label} tới?</h2><p class="note">Mã này chưa đủ 260 phiên giao dịch nên chưa thể dự báo.</p></section>`;
    const f = fc[key], b = f.band, P = fc.price;
    const up = Math.round(f.p * 100), down = 100 - up;
    const bt = M.backtest[key];
    const baseRate = isIdx(sym) ? up : Math.round(bt.all.upRate);
    const target = addSessions(fc.date, f.h);
    const span = Math.max(P, b.hi80) / Math.min(P, b.lo80) - 1;
    const lo = Math.min(P, b.lo80) * (1 - span * 0.06), hi = Math.max(P, b.hi80) * (1 + span * 0.06);
    const pos = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
    const dirNote = isIdx(sym)
      ? `Đây là tần suất ${idxName(sym)} tăng sau ${f.h} phiên trong lịch sử, không phải tín hiệu riêng cho lúc này.`
      : Math.abs(up - baseRate) < 3
        ? `Sát mức chung ${baseRate}% của cả danh sách, nên chưa có cơ sở để nghiêng về phía nào.`
        : `Lệch ${Math.abs(up - baseRate)} điểm so với mức chung ${baseRate}%. Kiểm định cho thấy độ lệch cỡ này chưa dự báo được hướng đi, nên đừng xem đây là tín hiệu.`;
    const rank = isIdx(sym) ? null : riskRank(sym, key);
    const level = riskLevel(rank);
    const tail = (hz.tail * 100).toFixed(0);
    // Khoảng dự kiến không đủ chính xác để ghi đến hàng phần trăm.
    const rp = (v) => num(v, isIdx(sym) ? 0 : 1);
    const riskBlock = key === 'w1' && !isIdx(sym)
      ? `<div class="stat-pair">
          <div><div class="k">Khả năng giảm quá ${tail}%</div><div class="v">${prob(f.pDown)}</div><div class="s">Mức chung ${Math.round(bt.holdout.downRate)}%</div></div>
          <div><div class="k">Khả năng tăng quá ${tail}%</div><div class="v">${prob(f.pUp)}</div><div class="s">Mức chung ${Math.round(bt.holdout.upTailRate)}%</div></div>
        </div>`
      : '';
    return `<section class="block col-7">
      <div class="block-head"><h2>${esc(title)} có thể đi đến đâu trong ${hz.label} tới?</h2>${level ? `<span class="pill ${level.c}">${level.t}</span>` : ''}</div>
      <div>
        <div class="range-big">${rp(b.lo80)} – ${rp(b.hi80)}</div>
        <div class="range-cap"><span>8 trên 10 lần, giá đến khoảng ${dmy(target)} sẽ nằm trong khoảng này</span>${helpBtn('range')}</div>
      </div>
      <div>
        <div class="range-track" aria-hidden="true">
          <i class="r80" style="left:${pos(b.lo80)}%;width:${(pos(b.hi80) - pos(b.lo80)).toFixed(1)}%"></i>
          <i class="r50" style="left:${pos(b.lo50)}%;width:${(pos(b.hi50) - pos(b.lo50)).toFixed(1)}%"></i>
          <i class="now" style="left:${pos(P)}%"></i>
        </div>
        <div class="range-ends"><span class="down">${sPct((b.lo80 / P - 1) * 100)}</span><span>Vạch đứng: giá đóng cửa <b>${fmtPrice(sym, P)}</b></span><span class="up">${sPct((b.hi80 / P - 1) * 100)}</span></div>
      </div>
      <p class="note">Phần đậm là nửa số lần, từ ${rp(b.lo50)} đến ${rp(b.hi50)}.${rank != null ? ` Khoảng này rộng hơn ${rank}% số mã trong danh sách.` : ''}</p>
      ${riskBlock}
      <div class="dir">
        <div class="dir-head"><span>Khả năng tăng <b>${up}%</b>, giảm <b>${down}%</b> ${helpBtn('dir')}</span>${isIdx(sym) ? '<span class="pill mid">Tần suất lịch sử</span>' : '<span class="pill weak">Chưa đáng tin</span>'}</div>
        <div class="split" role="img" aria-label="Khả năng tăng ${up}%, giảm ${down}%"><i class="s-up" style="flex:${up}"></i><i class="s-down" style="flex:${down}"></i></div>
        <p class="note">${esc(dirNote)}</p>
      </div>
    </section>`;
  }

  function chartCard(sym, chartId) {
    const name = isIdx(sym) ? idxName(sym) : sym;
    return `<section class="block">
      <div class="block-head"><h2>Giá ${esc(name)} đã đi thế nào?</h2></div>
      ${rangeChips()}
      ${chartBox(chartId)}
      <div class="ma-chips">
        <span>Đường trung bình ${helpBtn('ma')}</span>
        ${MA_LINES.map((l) => `<button class="ma-chip" type="button" data-act="ma:${l[0]}" aria-pressed="${state.ma.includes(l[0])}"><i${state.ma.includes(l[0]) ? ` style="background:${l[2]}"` : ''}></i>${l[1]}</button>`).join('')}
      </div>
      ${legend([{ name: 'Giá', color: 'var(--color-ink)' }, { name: 'Khoảng dự kiến 5/10 và 8/10 lần', color: 'var(--color-band-50)', swatch: true }])}
    </section>`;
  }

  const rangeChips = () => `<div class="chips" role="group" aria-label="Khoảng thời gian">${Object.keys(RANGES).map((r) => `<button class="chip" type="button" data-act="range:${r}" aria-pressed="${state.range === r}">${RANGE_LABEL[r]}</button>`).join('')}</div>`;

  function hzSeg() {
    return `<div class="seg" role="group" aria-label="Kỳ dự báo">${E.HORIZONS.map((h) => `<button type="button" data-act="hz:${h.key}" aria-pressed="${state.hz === h.key}">${h.label}</button>`).join('')}</div>`;
  }

  // ---------- Thị trường ----------

  function viewMarket() {
    const idx = state.idx, key = state.hz, hz = HZ[key];
    const k = hz.h;
    const list = U.UNIVERSE.filter((s) => series.has(s)).map((s) => ({ s, r: ret(series.get(s), k) })).filter((x) => x.r != null);
    const up = list.filter((x) => x.r > 0).length;
    const m = ctx.get(ctx.lastDate);
    const sectors = Object.entries(U.SECTORS).map(([name, syms]) => {
      const v = syms.filter((s) => series.has(s)).map((s) => ret(series.get(s), k)).filter((x) => x != null);
      return { name, r: E.mean(v) };
    }).sort((a, b) => b.r - a.r);
    const maxR = Math.max(...sectors.map((x) => Math.abs(x.r)), 0.1);
    const sorted = [...list].sort((a, b) => b.r - a.r);
    const row = (x) => `<button class="list-btn" type="button" data-act="open:${x.s}"><b>${x.s}</b><span class="${cls(x.r)}">${sPct(x.r)}</span></button>`;
    pending.push(() => drawChart('ch-idx', priceSpec(idx, key)));
    const pctAbove = Math.round(m.breadth * 100);
    const health = pctAbove >= 60 ? { c: 'good', t: 'Khỏe' } : pctAbove < 40 ? { c: 'weak', t: 'Yếu' } : { c: 'mid', t: 'Trung bình' };
    return `
      ${searchBox(true)}
      ${state.intro ? `<section class="intro">
        <h2>Xem gì ở đây?</h2>
        <ul>
          <li>Giá có thể dao động bao xa trong 1 tuần hoặc 1 tháng tới, tính từ dữ liệu giá và khối lượng.</li>
          <li>Mỗi con số đã được kiểm tra lại trên quá khứ. Kết quả nằm ở tab Độ tin cậy.</li>
          <li>App không chỉ định nên mua hay bán mã nào.</li>
        </ul>
        <button class="btn" type="button" data-act="intro-done">Đã hiểu</button>
      </section>` : ''}
      ${board(idx)}
      ${forecastCard(idx, key)}
      ${chartCard(idx, 'ch-idx')}
      ${watchList(key)}
      <section class="block col-6">
        <div class="block-head"><h2>Thị trường đang khỏe hay yếu?</h2><span class="pill ${health.c}">${health.t}</span></div>
        <div class="meter" role="img" aria-label="${pctAbove}% số mã trên đường MA50"><i style="width:${pctAbove}%"></i></div>
        <p class="lede"><b>${pctAbove}%</b> số mã đang trên đường trung bình 50 phiên ${helpBtn('breadth')}</p>
        <p class="lede"><b>${up}/${list.length}</b> mã tăng trong ${hz.label} qua.</p>
        <p class="note">Tính trên ${list.length} mã thanh khoản lớn trong danh sách của app, không phải toàn thị trường.</p>
      </section>
      <section class="block col-6">
        <div class="block-head"><h2>Mã nào biến động mạnh nhất?</h2></div>
        <div class="mover-grid">
          <div><h3>Tăng nhiều nhất</h3>${sorted.slice(0, 5).map(row).join('')}</div>
          <div><h3>Giảm nhiều nhất</h3>${sorted.slice(-5).reverse().map(row).join('')}</div>
        </div>
        <p class="note">Trong ${hz.label} qua. Đây là kết quả đã xảy ra, không phải dự báo.</p>
      </section>
      <section class="block">
        <div class="block-head"><h2>Ngành nào đang mạnh, ngành nào đang yếu?</h2></div>
        <div>${sectors.map((x) => `<button class="bar-row" type="button" data-act="sector:${esc(x.name)}" aria-label="Xem các mã ngành ${esc(x.name)}"><span class="name">${esc(x.name)}</span><span class="bar-track"><i class="${x.r >= 0 ? 'pos' : 'neg'}" style="width:${((Math.abs(x.r) / maxR) * 50).toFixed(1)}%"></i></span><span class="val ${cls(x.r)}">${sPct(x.r)}</span></button>`).join('')}</div>
        <p class="note">Trung bình các mã trong ngành, ${hz.label} qua. Bấm vào một ngành để xem các mã.</p>
      </section>`;
  }

  function watchList(key) {
    const list = state.watch.filter((s) => series.has(s));
    if (!list.length) return '';
    const hz = HZ[key];
    return `<section class="block">
      <div class="block-head"><h2>Mã bạn đang theo dõi</h2></div>
      <div>${list.map((s) => { const S = series.get(s), r = ret(S, hz.h), fc = forecasts.get(s); return `<button class="list-btn" type="button" data-act="open:${s}"><b>${s}</b><span class="right">${num(S.c[S.n - 1], 2)} <span class="${cls(r ?? 0)}">${r == null ? '' : sPct(r)}</span>${fc ? `<br><small>${hz.label} tới: ${num(fc[key].band.lo80, 1)} – ${num(fc[key].band.hi80, 1)}</small>` : ''}</span></button>`; }).join('')}</div>
    </section>`;
  }

  // ---------- Mã ----------

  function technicalRows(sym) {
    const S = series.get(sym), t = S.n - 1;
    const closes = Array.from(S.c);
    const rsi = E.rsiSeries(closes, 14)[t];
    const pos = (w) => { if (t < w) return null; const a = E.smaSeries(closes, w)[t]; return (S.c[t] / a - 1) * 100; };
    const rsiNote = rsi == null ? '' : rsi >= 70 ? 'Vùng quá mua' : rsi <= 30 ? 'Vùng quá bán' : 'Vùng trung tính';
    const vr = S.avgV(t, 5) / S.avgV(t, 60);
    const idx = series.get('VNINDEX');
    const rel = (k) => { const a = ret(S, k), b = ret(idx, k); return a == null || b == null ? null : a - b; };
    const items = [
      ['RSI 14 phiên', rsi == null ? '–' : num(rsi, 0), rsiNote, 'rsi'],
      ['So với MA50', pos(50) == null ? '–' : sPct(pos(50)), pos(50) == null ? '' : pos(50) >= 0 ? 'Giá trên đường trung bình 50 phiên' : 'Giá dưới đường trung bình 50 phiên', 'ma'],
      ['So với MA200', pos(200) == null ? '–' : sPct(pos(200)), pos(200) == null ? '' : pos(200) >= 0 ? 'Xu hướng dài hạn đang lên' : 'Xu hướng dài hạn đang xuống', 'ma'],
      ['Thanh khoản 1 tuần', isFinite(vr) ? `${num(vr, 2)} lần` : '–', 'So với trung bình 60 phiên', 'liq'],
    ];
    if (!isIdx(sym)) items.push(['Hơn VN-Index 1 tháng', rel(21) == null ? '–' : sPct(rel(21)), 'Chênh lệch lợi suất'], ['Hơn VN-Index 3 tháng', rel(63) == null ? '–' : sPct(rel(63)), 'Chênh lệch lợi suất']);
    return `<dl class="rows">${items.map((x) => `<div><dt>${esc(x[0])}${x[3] ? ' ' + helpBtn(x[3]) : ''}</dt><dd>${esc(x[1])}</dd>${x[2] ? `<span class="sub">${esc(x[2])}</span>` : ''}</div>`).join('')}</dl>`;
  }

  // Những đặc trưng đang đẩy xác suất lệch khỏi mức nền nhiều nhất.
  function factorList(fc, key) {
    const parts = fc[key].parts;
    if (!parts) return '';
    const list = parts.map((v, i) => ({ v, n: E.FEATURES[i][1] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 4);
    return `<ul class="plain">${list.map((x) => `<li>${esc(x.n)}: ${x.v >= 0 ? 'đẩy xác suất tăng lên' : 'kéo xác suất tăng xuống'} ${num(Math.abs(x.v) * 25, 1)} điểm</li>`).join('')}</ul>`;
  }

  function logTable(sym, key) {
    const tr = M.track[key][sym];
    if (!tr) return '<p class="note">Mã này nằm ngoài danh sách đã kiểm định nên chưa có nhật ký dự báo.</p>';
    const rows = tr.log.map((r) => {
      const inside = r[5] >= r[3] && r[5] <= r[4];
      return `<tr><td>${dm(r[0])}/${r[0].slice(2, 4)}</td><td>${Math.round(r[1] * 100)}%</td><td>${num(r[3], 1)} – ${num(r[4], 1)}</td><td class="${cls(r[5] - r[2])}">${num(r[5], 1)}</td><td><span class="pill ${inside ? 'good' : 'weak'}">${inside ? 'Trong' : 'Ngoài'}</span></td></tr>`;
    }).join('');
    return `<p class="note">Trong ${tr.n} lần kiểm định từ 2020, giá thực nằm trong khoảng 8/10 ở ${pct(tr.cover80, 0)} số lần. Giá trong nhật ký là giá đã điều chỉnh.</p>
      <div class="table-scroll"><table><thead><tr><th>Ngày dự báo</th><th>Khả năng tăng</th><th>Khoảng 8/10</th><th>Giá sau kỳ</th><th>Kết quả</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function searchBox(home) {
    const watch = home ? [] : state.watch.filter((s) => s !== state.sym);
    return `<div class="search"><label class="vh-label" for="sym-input">Tìm mã hoặc tên công ty</label><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/></svg><input id="sym-input" type="search" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Tìm mã hoặc tên công ty, ví dụ FPT" enterkeyhint="search"></div>
      <div class="suggest" id="suggest"></div>
      ${watch.length ? `<div class="watch-row" role="group" aria-label="Mã đang theo dõi">${watch.map((s) => `<button class="chip" type="button" data-act="open:${s}">${s}</button>`).join('')}</div>` : ''}`;
  }

  function viewStock() {
    const sym = state.sym;
    if (!series.has(sym)) {
      const msg = state.loading === sym ? `Đang tải dữ liệu ${esc(sym)}…`
        : STANDALONE ? `Không tìm thấy dữ liệu cho ${esc(sym)}. Kiểm tra lại mã hoặc mạng.`
          : `Bản xem nhanh chỉ có ${U.UNIVERSE.length} mã nhúng sẵn. Mã ${esc(sym)} cần bản web đầy đủ để tải trực tiếp.`;
      return `${searchBox()}<section class="block"><p>${msg}</p></section>`;
    }
    const fc = forecasts.get(sym);
    const inList = U.UNIVERSE.includes(sym);
    const S = series.get(sym);
    const watched = state.watch.includes(sym);
    const star = `<button class="star" type="button" data-act="watch:${sym}" aria-pressed="${watched}" aria-label="${watched ? 'Bỏ theo dõi' : 'Theo dõi'} ${sym}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.400 9.800l6-.8z"/></svg>${watched ? 'Đang theo dõi' : 'Theo dõi'}</button>`;
    pending.push(() => drawChart('ch-stock', priceSpec(sym, state.hz)));
    const k = Math.min(S.n, RANGES[state.range]), start = S.n - k;
    pending.push(() => drawChart('ch-vol', {
      h: 96, n: k, dateOf: (i) => S.d[start + i], label: `Khối lượng ${sym}`,
      bars: { vals: Array.from(S.v.slice(start)), color: 'var(--color-muted)' },
      yFmt: (v) => (v >= 1e6 ? num(v / 1e6, 0) + ' tr' : num(v / 1e3, 0) + ' n'),
      readout: (i) => readoutHtml(dmy(S.d[start + i]), [{ k: 'Khối lượng', v: num(S.v[start + i], 0) }]),
    }));
    const rsi = E.rsiSeries(Array.from(S.c), 14).slice(start);
    pending.push(() => drawChart('ch-rsi', {
      h: 96, n: k, dateOf: (i) => S.d[start + i], label: `RSI ${sym}`, yMin: 0, yMax: 100, yStep: 35, refs: [30, 70],
      series: [{ name: 'RSI', color: 'var(--color-s1)', vals: rsi }],
      yFmt: (v) => num(v, 0),
      readout: (i) => readoutHtml(dmy(S.d[start + i]), [{ k: 'RSI 14', v: rsi[i] == null ? '–' : num(rsi[i], 0) }]),
    }));
    return `
      ${searchBox()}
      ${board(sym, star)}
      ${!inList ? `<p class="note">${esc(sym)} không nằm trong ${U.UNIVERSE.length} mã đã kiểm định. Khoảng giá của mã này chưa được kiểm chứng riêng, đặc biệt với mã thanh khoản thấp.</p>` : ''}
      ${forecastCard(sym, state.hz)}
      ${chartCard(sym, 'ch-stock')}
      ${calcBlock(sym, state.hz)}
      <section class="block col-6">
        <div class="block-head"><h2>Các chỉ báo đang nói gì?</h2></div>
        ${technicalRows(sym)}
      </section>
      <section class="block col-6">
        <div class="block-head"><h2>Khối lượng và RSI</h2></div>
        <div>${chartBox('ch-vol')}</div>
        <div>${chartBox('ch-rsi')}</div>
      </section>
      ${inList ? `<section class="block">
        <div class="block-head"><h2>Các dự báo ${HZ[state.hz].label} trước đây cho ${sym} thế nào?</h2></div>
        ${logTable(sym, state.hz)}
      </section>` : ''}
      ${fc && fc[state.hz].parts ? `<section class="block">
        <details class="more"><summary>Vì sao khả năng tăng ${HZ[state.hz].label} lệch khỏi mức chung?</summary><div class="more-body">${factorList(fc, state.hz)}</div></details>
      </section>` : ''}`;
  }

  // ---------- Bảng mã ----------

  // Mặc định xếp theo rủi ro giảm vì đó là phần có kỹ năng. Kỳ 1 tháng không hiện xác suất này nên dùng biên độ.
  const SORTS = {
    risk: { label: (k) => (k === 'w1' ? 'Rủi ro giảm cao nhất' : 'Dao động dự kiến mạnh nhất'), f: (x, k) => (k === 'w1' ? -x.pDown : -x.width) },
    calm: { label: (k) => (k === 'w1' ? 'Rủi ro giảm thấp nhất' : 'Dao động dự kiến ít nhất'), f: (x, k) => (k === 'w1' ? x.pDown : x.width) },
    mom: { label: () => 'Tăng nhiều nhất kỳ qua', f: (x) => -(x.r ?? -999) },
    drop: { label: () => 'Giảm nhiều nhất kỳ qua', f: (x) => x.r ?? 999 },
    prob: { label: () => 'Khả năng tăng cao nhất', f: (x) => -x.p },
    name: { label: () => 'Mã A đến Z', f: (x) => x.s },
  };

  const ciHasZero = (c) => c[0] <= 0 && c[1] >= 0;

  function viewTable() {
    const key = state.hz, hz = HZ[key];
    const all = U.UNIVERSE.filter((s) => forecasts.get(s));
    let list = all.map((s) => {
      const fc = forecasts.get(s), f = fc[key];
      return { s, price: fc.price, r: ret(series.get(s), hz.h), p: f.p, width: widthOf(fc, key), lo: f.band.lo80, hi: f.band.hi80, pDown: f.pDown, sector: U.SECTOR_OF[s] };
    });
    if (state.sector) list = list.filter((x) => x.sector === state.sector);
    if (state.onlyWatch) list = list.filter((x) => state.watch.includes(x.s));
    const f = SORTS[state.sort].f;
    list.sort((p, q) => { const x = f(p, key), y = f(q, key); return typeof x === 'string' ? x.localeCompare(y) : x - y; });
    const hasTail = key === 'w1';
    const tail = (hz.tail * 100).toFixed(0);
    const h = M.backtest[key].holdout;
    const maxW = Math.max(...list.map((x) => x.width), 1);
    const title = hasTail ? `Mã nào có rủi ro giảm mạnh nhất trong ${hz.label} tới?` : `Mã nào có thể dao động mạnh nhất trong ${hz.label} tới?`;
    const dirMsg = ciHasZero(h.dirCI)
      ? 'Đầu bảng không có nghĩa là nên chọn. Thứ tự theo khả năng tăng cũng chưa có bằng chứng hơn ngẫu nhiên.'
      : 'Đầu bảng không có nghĩa là nên chọn. Xem tab Độ tin cậy trước khi dựa vào thứ tự theo khả năng tăng.';
    const sortMsg = hasTail
      ? `Bảng xếp mặc định theo khả năng giảm quá ${tail}%, phần có kỹ năng từ 2024.`
      : 'Kỳ 1 tháng không hiện khả năng giảm mạnh vì chưa chứng minh được kỹ năng, nên bảng xếp mặc định theo mức dao động dự kiến.';
    const body = list.map((x) => `<tr class="tap" data-act="open:${x.s}">
      <td class="c-sym"><button class="sym" type="button" data-act="open:${x.s}">${x.s}</button><span class="sec">${esc(x.sector)}</span></td>
      <td class="c-price">${num(x.price, 2)}</td>
      <td class="c-chg ${cls(x.r)}">${x.r == null ? '–' : sPct(x.r)}</td>
      ${hasTail ? `<td class="c-down" data-l="Khả năng giảm quá ${tail}%:">${prob(x.pDown)}</td>` : ''}
      <td class="c-width" data-l="8/10 lần:"><span class="width-cell"><span>${num(x.lo, 1)} – ${num(x.hi, 1)}</span><span class="mini" aria-hidden="true"><i style="width:${((x.width / maxW) * 100).toFixed(0)}%"></i></span></span></td>
      <td class="c-p" data-l="Khả năng tăng:">${Math.round(x.p * 100)}%</td>
    </tr>`).join('');
    return `
      <section class="block">
        <div class="block-head"><h2>${title}</h2></div>
        <p class="lede">${esc(dirMsg)}</p>
        <p class="note">${esc(sortMsg)} ${all.length} mã, theo giá đóng cửa ${dmy(lastDate)}.</p>
        <div class="filters">
          <select id="sort-select" class="select wide" aria-label="Sắp xếp" data-change="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${state.sort === k ? ' selected' : ''}>${v.label(key)}</option>`).join('')}</select>
          <select id="sector-select" class="select wide" aria-label="Lọc theo ngành" data-change="sector"><option value="">Tất cả ngành</option>${Object.keys(U.SECTORS).map((k) => `<option${state.sector === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select>
        </div>
        <label class="toggle"><input id="watch-only" type="checkbox" data-change="onlyWatch"${state.onlyWatch ? ' checked' : ''}>Chỉ mã đang theo dõi (${state.watch.length})</label>
        ${list.length ? `<div class="rank"><table><thead><tr><th>Mã</th><th>Giá</th><th>${hz.label} qua</th>${hasTail ? `<th>Giảm quá ${tail}%</th>` : ''}<th>Khoảng 8/10 lần</th><th>Khả năng tăng</th></tr></thead><tbody>${body}</tbody></table></div>` : `<p class="note">${state.onlyWatch ? 'Bạn chưa theo dõi mã nào. Mở một mã ở tab Cổ phiếu rồi bấm Theo dõi.' : 'Không có mã nào khớp bộ lọc. Hãy chọn ngành khác.'}</p>`}
        <p class="note">App không có dự báo 1 ngày. Theo chu kỳ thanh toán T+2, cổ phiếu mua hôm nay thường chưa bán được ngay trong ngày, bạn nên tự kiểm tra quy định hiện hành. Bảng này chỉ gồm các mã đã kiểm định, mã khác tra ở tab Cổ phiếu.</p>
      </section>`;
  }

  // ---------- Máy tính rủi ro ----------

  const money = (x) => num(Math.round(x), 0) + ' đ';

  function calcResult(sym, key) {
    const fc = forecasts.get(sym), out = $('calc-out');
    if (!out || !fc) return;
    const capital = parseFloat($('calc-capital').value) * 1e6, riskPct = parseFloat($('calc-risk').value);
    store.set('calc', { capital: $('calc-capital').value, risk: $('calc-risk').value });
    const price = fc.price * 1000, refPrice = fc[key].band.lo80 * 1000;
    const r = E.positionLimit({ capital, riskPct, price, refPrice });
    if (!r.ok) {
      out.innerHTML = `<p class="note">${r.reason === 'noDrop' ? 'Cận dưới khoảng 8/10 lần đang không thấp hơn giá đóng cửa, nên chưa tính được mức giảm tham chiếu.' : 'Nhập vốn và % chấp nhận lỗ lớn hơn 0 để xem kết quả.'}</p>`;
      return;
    }
    const pctCap = (r.totalLoss / capital) * 100;
    out.innerHTML = `<dl class="rows">
        <div><dt>Mức giảm tham chiếu ${helpBtn('ref')}</dt><dd>${pct(r.refDrop * 100)}</dd><span class="sub">Từ ${num(fc.price, 2)} xuống cận dưới khoảng 8/10 lần, ${num(fc[key].band.lo80, 2)}</span></div>
        <div><dt>Số tiền tối đa cho mã này</dt><dd>${money(r.limit)}</dd><span class="sub">${r.capped ? 'Đã chặn ở mức toàn bộ vốn' : `Vốn × ${minus(num(riskPct, 2))}% ÷ mức giảm tham chiếu`}</span></div>
        <div><dt>Làm tròn xuống lô ${E.LOT} cổ</dt><dd>${num(r.shares, 0)} cổ</dd><span class="sub">${r.shares ? `Giá trị ${money(r.value)}` : `Chưa đủ một lô, cần khoảng ${money(r.lotCost)}`}</span></div>
        ${r.shares ? `<div><dt>Phí và thuế ước tính</dt><dd>${money(r.buyFee + r.sellFee)}</dd><span class="sub">Mua ${money(r.buyFee)}, bán ở mức tham chiếu ${money(r.sellFee)}. Giả định phí ${num(E.COSTS.buy * 100, 2)}% mỗi chiều, thuế bán ${num(E.COSTS.tax * 100, 2)}%</span></div>
        <div><dt>Lỗ nếu giá về đúng mức tham chiếu</dt><dd>${money(r.totalLoss)}</dd><span class="sub">Gồm phí và thuế, bằng ${pct(pctCap, 2)} vốn${pctCap > riskPct ? ', cao hơn mức bạn nhập vì có thêm phí' : ''}</span></div>` : ''}
      </dl>`;
  }

  function calcBlock(sym, key) {
    const fc = forecasts.get(sym);
    if (isIdx(sym) || !fc) return '';
    const saved = store.get('calc', { capital: '100', risk: '2' });
    pending.push(() => calcResult(sym, key));
    return `<section class="block" data-calc="${sym}" data-calc-key="${key}">
      <div class="block-head"><h2>Với mức lỗ bạn đặt, tối đa bao nhiêu tiền cho ${esc(sym)}?</h2><span class="note">Kỳ ${HZ[key].label}</span></div>
      <p class="note">Máy tính rủi ro cho riêng mã bạn đang xem. Công cụ này không chọn mã và không chia tỉ lệ giữa các mã. Hai số mặc định chỉ là ví dụ, số bạn nhập chỉ lưu trên máy này.</p>
      <div class="calc-grid">
        <label for="calc-capital">Vốn của bạn (triệu đồng)<input id="calc-capital" type="number" inputmode="decimal" min="0" step="10" value="${esc(saved.capital)}"></label>
        <label for="calc-risk">% vốn chấp nhận lỗ<input id="calc-risk" type="number" inputmode="decimal" min="0" max="100" step="0.5" value="${esc(saved.risk)}"></label>
      </div>
      <div id="calc-out" aria-live="polite"></div>
      <p class="callout">Khoảng 10% trường hợp giá xuống dưới mức tham chiếu này, nên đây không phải mức lỗ tối đa. Bạn vẫn có thể lỗ nhiều hơn.</p>
    </section>`;
  }

  // ---------- Độ tin cậy ----------

  function reliabilityChart(id, bins, title) {
    pending.push(() => {
      const host = $(id); if (!host) return;
      const W = Math.max(260, host.clientWidth), H = Math.min(W, 300), pad = { l: 40, r: 12, t: 8, b: 34 };
      const maxV = Math.ceil(Math.max(...bins.flatMap((b) => [b.pred, b.real])) / 10 + 0.5) * 10, minV = Math.max(0, Math.floor(Math.min(...bins.flatMap((b) => [b.pred, b.real])) / 10 - 0.5) * 10);
      const x = (v) => pad.l + ((v - minV) / (maxV - minV)) * (W - pad.l - pad.r), y = (v) => H - pad.b - ((v - minV) / (maxV - minV)) * (H - pad.t - pad.b);
      let g = '';
      for (let v = minV; v <= maxV; v += 10) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--color-grid)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text><text x="${x(v)}" y="${H - pad.b + 16}" text-anchor="middle">${v}%</text>`;
      g += `<line x1="${x(minV)}" y1="${y(minV)}" x2="${x(maxV)}" y2="${y(maxV)}" stroke="var(--color-muted)" stroke-dasharray="4 4"/>`;
      g += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">App dự báo</text><text x="${pad.l + 2}" y="${pad.t + 10}">Thực tế</text>`;
      bins.forEach((b, i) => { g += `<circle data-i="${i}" cx="${x(b.pred)}" cy="${y(b.real)}" r="${Math.max(5, Math.min(11, Math.sqrt(b.n) / 6))}" fill="var(--color-accent)" stroke="var(--color-surface)" stroke-width="2" tabindex="0"><title>Dự báo ${num(b.pred, 1)}%, thực tế ${num(b.real, 1)}%, ${b.n} lần</title></circle>`; });
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(title)}">${g}</svg>`;
    });
    return `<div class="plot" id="${id}"></div>`;
  }

  function viewTrust() {
    const w = M.backtest.w1, m = M.backtest.m1;
    const hw = w.holdout, hm = m.holdout, dw = w.dev, dm_ = m.dev;
    const ci = (a, d = 2) => `${minus(num(a[0], d))} đến ${minus(num(a[1], d))}`;
    const dirRow = (name, b) => `<tr><td>${name}</td><td>${pct(b.hit)}</td><td>${pct(b.baseHit)}</td><td>${minus(num(b.dirSkill, 2))}%</td><td><small>${ci(b.dirCI)}</small></td></tr>`;
    const covRow = (name, b) => `<tr><td>${name}</td><td>${pct(b.cover80)}</td><td>${pct(b.cover50)}</td><td>±${num(b.width80 / 2, 1)}%</td></tr>`;
    const terc = (b) => b.terciles.map((t, i) => `<tr><td>${['Ít biến động', 'Trung bình', 'Biến động mạnh'][i]}</td><td>${pct(t.cover80)}</td><td>${pct(t.naive80)}</td></tr>`).join('');
    const idxW = M.indexBacktest.VNINDEX.w1, idxM = M.indexBacktest.VNINDEX.m1;
    const quintRow = (name, q) => `<tr><td>${name}</td><td>${sPct(q.topNet, 2)}</td><td>${sPct(q.botNet, 2)}</td><td>${sPct(q.all, 2)}</td></tr>`;
    const quintCI = (name, q) => `<tr><td>${name}</td><td>${sPct(q.spread, 2)}<br><small>${ci(q.spreadCI)}</small></td><td>${sPct(q.vsHold, 2)}<br><small>${ci(q.vsHoldCI)}</small></td></tr>`;
    const holdQ = [hw.quint, hm.quint];
    const noEdge = holdQ.every((q) => q.spreadCI[0] <= 0 && q.vsHoldCI[0] <= 0);
    const quintVerdict = noEdge
      ? { cls: 'weak', pill: 'Không có bằng chứng', text: 'Từ 2024, không có bằng chứng về lợi thế: khoảng tin cậy của cả hai phép so sánh đều chứa 0 hoặc nằm dưới 0, ở cả kỳ 1 tuần và 1 tháng.' }
      : { cls: 'mid', pill: 'Cần thận trọng', text: 'Từ 2024, có ít nhất một phép so sánh có khoảng tin cậy nằm trên 0. Con số này vẫn chịu thiên lệch sống sót và chưa đủ để xem là lợi thế chắc chắn.' };
    return `
      <div class="verdicts">
        <section class="verdict">
          <span class="pill good">Khá đáng tin</span>
          <h2>Giá có thể đi đến đâu?</h2>
          <div class="fig">${pct(hw.cover80, 0)}</div>
          <p>Khoảng ghi 8/10 lần thực tế chứa giá ${pct(hw.cover80)} số lần với kỳ 1 tuần và ${pct(hm.cover80)} với kỳ 1 tháng. Mục tiêu là 80%.</p>
        </section>
        <section class="verdict">
          <span class="pill mid">Có ích vừa phải</span>
          <h2>Mã nào dễ giảm mạnh trong 1 tuần?</h2>
          <div class="fig">+${num(hw.downSkill, 1)}%</div>
          <p>Điểm kỹ năng so với dùng tần suất chung ${pct(hw.downRate)}, tức chỉ tốt hơn một chút. Với kỳ 1 tháng, chưa chứng minh được nên app không hiện xác suất này.</p>
        </section>
        <section class="verdict">
          <span class="pill weak">Chưa đáng tin</span>
          <h2>Giá sẽ tăng hay giảm?</h2>
          <div class="fig">${pct(hw.hit, 0)}</div>
          <p>App đoán đúng hướng ${pct(hw.hit)} với kỳ 1 tuần và ${pct(hm.hit)} với kỳ 1 tháng, không khác biệt đáng tin so với đoán theo tần suất chung.</p>
        </section>
        <section class="verdict">
          <span class="pill ${quintVerdict.cls}">${quintVerdict.pill}</span>
          <h2>Chọn nhóm mã xếp đầu có lợi hơn không?</h2>
          <div class="fig">${sPct(hw.quint.vsHold, 2)}</div>
          <p>Mỗi kỳ 1 tuần, nhóm 20% mã xếp đầu sau phí chênh chừng này so với giữ cả rổ. ${esc(quintVerdict.text)}</p>
        </section>
      </div>
      <p class="note">Các số trên tính trên dữ liệu mô hình chưa từng thấy, từ ${dmy(hw.from)} đến ${dmy(hw.to)}, với ${M.trainedSyms} mã. Mô hình chỉ dùng dữ liệu đã biết tại thời điểm dự báo, và học lại mỗi quý.</p>
      <details class="more card" id="trust-more"${state.trustOpen ? ' open' : ''}><summary data-act="detail">Xem số liệu chi tiết</summary><div class="more-body">
      <section class="block">
        <div class="block-head"><h2>Số liệu dự báo hướng</h2><span class="pill weak">Chưa đáng tin</span></div>
        <p class="note">Mức nền là luôn đoán theo chiều phổ biến trong quá khứ. Cột Nền là tỷ lệ đúng của cách đó. Điểm kỹ năng Brier bằng 0 nghĩa là không hơn mức nền, và khoảng tin cậy 95% chứa số 0 nghĩa là chưa chứng minh được kỹ năng.</p>
        <div class="table-scroll"><table><thead><tr><th>Giai đoạn</th><th>Đúng</th><th>Nền</th><th>Kỹ năng</th><th>Tin cậy 95%</th></tr></thead><tbody>
          ${dirRow('1 tuần, 2024+', hw)}${dirRow('1 tháng, 2024+', hm)}${dirRow('1 tuần, 2020–2023', dw)}${dirRow('1 tháng, 2020–2023', dm_)}
        </tbody></table></div>
        <p class="note">Tương quan giữa thứ hạng dự báo và thứ hạng lợi suất thực từ 2024: ${minus(num(hw.ic, 3))} (1 tuần) và ${minus(num(hm.ic, 3))} (1 tháng). Nên app không có danh sách "mã nên mua".</p>
        <p class="note">VN-Index không dùng mô hình hướng. App hiện tần suất tăng trong lịch sử: chỉ số tăng ${pct(idxW.upRate, 0)} số tuần và ${pct(idxM.upRate, 0)} số tháng từ 2020. Con số này cao hơn mức của từng cổ phiếu vì chỉ số chịu ảnh hưởng lớn từ các mã vốn hóa lớn.</p>
      </section>
      <section class="block">
        <div class="block-head"><h2>Số liệu khoảng giá</h2><span class="pill good">Khá đáng tin</span></div>
        <div class="table-scroll"><table><thead><tr><th>Giai đoạn</th><th>Phủ 80%</th><th>Phủ 50%</th><th>Biên độ TB</th></tr></thead><tbody>
          ${covRow('1 tuần, 2024+', hw)}${covRow('1 tháng, 2024+', hm)}${covRow('1 tuần, 2020–2023', dw)}${covRow('1 tháng, 2020–2023', dm_)}
        </tbody></table></div>
        <p class="note">Năm 2020–2023 thị trường biến động dữ dội hơn nên độ phủ thấp hơn mục tiêu, nhất là kỳ 1 tháng. Khi thị trường đột ngột chuyển trạng thái, khoảng giá thường chậm thích nghi.</p>
        <h3>Theo mức biến động của mã, kỳ 1 tuần, từ 2024</h3>
        <p class="note">So với khoảng cố định dùng chung một mức phần trăm cho mọi mã. Càng gần 80% càng tốt.</p>
        <div class="table-scroll"><table><thead><tr><th>Nhóm mã</th><th>Khoảng của app</th><th>Khoảng cố định</th></tr></thead><tbody>${terc(hw)}</tbody></table></div>
      </section>
      <section class="block">
        <div class="block-head"><h2>Rủi ro giảm quá 5% trong 1 tuần</h2><span class="pill mid">Có ích vừa phải</span></div>
        <p class="note">Mỗi chấm là một nhóm dự báo. Chấm càng gần đường chéo, xác suất càng khớp thực tế. Chấm to hơn là nhóm có nhiều lần dự báo hơn.</p>
        ${reliabilityChart('rel-down', hw.relDown, 'Xác suất giảm quá 5% dự báo so với thực tế')}
        <div class="table-scroll"><table><thead><tr><th>Dự báo</th><th>Thực tế</th><th>Số lần</th></tr></thead><tbody>${hw.relDown.map((b) => `<tr><td>${pct(b.pred)}</td><td>${pct(b.real)}</td><td>${num(b.n, 0)}</td></tr>`).join('')}</tbody></table></div>
        <p class="note">Điểm kỹ năng so với tần suất chung ${pct(hw.downRate)}: ${minus(num(hw.downSkill, 1))}% (khoảng tin cậy 95%: ${ci(hw.downCI, 1)}). Với kỳ 1 tháng, kỹ năng chưa chứng minh được (${ci(hm.downCI, 1)}), nên app không hiện xác suất này. Tần suất giảm quá 10% trong một tháng từ 2024 là ${pct(hm.downRate)}.</p>
      </section>
      <section class="block">
        <div class="block-head"><h2>Nhóm xếp đầu và nhóm xếp cuối</h2><span class="pill ${quintVerdict.cls}">${quintVerdict.pill}</span></div>
        <p class="lede">${esc(quintVerdict.text)}</p>
        <p class="note">Mỗi ngày dự báo, các mã được xếp theo xác suất tăng rồi lấy 20% đầu và 20% cuối. Số dưới đây là lợi suất trung bình mỗi kỳ, đã trừ ${num(E.ROUND_TRIP * 100, 2)}% cho một vòng mua bán, giả định phí ${num(E.COSTS.buy * 100, 2)}% mỗi chiều và thuế bán ${num(E.COSTS.tax * 100, 2)}%.</p>
        <div class="table-scroll"><table><thead><tr><th>Giai đoạn</th><th>Đầu</th><th>Cuối</th><th>Giữ cả rổ, chưa phí</th></tr></thead><tbody>
          ${quintRow('1 tuần, 2024+', hw.quint)}${quintRow('1 tháng, 2024+', hm.quint)}${quintRow('1 tuần, 2020–2023', dw.quint)}${quintRow('1 tháng, 2020–2023', dm_.quint)}
        </tbody></table></div>
        <h3>Chênh lệch và khoảng tin cậy 95%</h3>
        <p class="note">Khoảng tin cậy lấy mẫu lại theo khối quý. Nếu khoảng chứa 0 thì không có bằng chứng về lợi thế. Phí của hai nhóm triệt tiêu nhau khi lấy đầu trừ cuối, nên cột So với giữ cả rổ lấy nhóm đầu sau phí trừ lợi suất giữ cả rổ, vì giữ cả rổ không phải trả phí mỗi kỳ.${dw.quint.spreadCI[0] > 0 && hw.quint.spreadCI[0] <= 0 ? ' Riêng kỳ 1 tuần năm 2020–2023, khoảng đầu trừ cuối nằm sát trên 0, nhưng kết quả này không lặp lại từ 2024.' : ''}</p>
        <div class="table-scroll"><table><thead><tr><th>Giai đoạn</th><th>Đầu trừ cuối</th><th>So với giữ cả rổ</th></tr></thead><tbody>
          ${quintCI('1 tuần, 2024+', hw.quint)}${quintCI('1 tháng, 2024+', hm.quint)}${quintCI('1 tuần, 2020–2023', dw.quint)}${quintCI('1 tháng, 2020–2023', dm_.quint)}
        </tbody></table></div>
        <p class="note">Danh sách mã chỉ gồm các mã còn giao dịch tích cực hiện nay, không có mã đã hủy niêm yết. Thiên lệch sống sót này làm lợi suất của mọi nhóm đẹp hơn thực tế. Thị trường Việt Nam cũng khó bán khống cổ phiếu, nên chênh lệch đầu trừ cuối không phải là khoản lợi nhuận có thể thực hiện.</p>
      </section>
      <section class="block">
        <h2>Từng năm</h2>
        <p class="note">1T là kỳ 1 tuần, 1Th là kỳ 1 tháng. Tăng là tỷ lệ mã tăng, Đúng là tỷ lệ đoán đúng hướng, Phủ là tỷ lệ giá nằm trong khoảng 80%.</p>
        <div class="table-scroll"><table><thead><tr><th>Năm</th><th>Tăng 1T</th><th>Đúng</th><th>Phủ</th><th>Tăng 1Th</th><th>Đúng</th><th>Phủ</th></tr></thead><tbody>
          ${w.years.map((y, i) => { const z = m.years[i]; return `<tr><td>${y.y}</td><td>${pct(y.upRate, 0)}</td><td>${pct(y.hit, 0)}</td><td>${pct(y.cover80, 0)}</td><td>${pct(z.upRate, 0)}</td><td>${pct(z.hit, 0)}</td><td>${pct(z.cover80, 0)}</td></tr>`; }).join('')}
        </tbody></table></div>
      </section>
      </div></details>
      <section class="block">
        <h2>Giới hạn cần biết</h2>
        <ul class="plain">
          <li>Danh sách ${M.trainedSyms} mã là các mã đang được giao dịch tích cực hiện nay, không có mã đã hủy niêm yết. Điều này làm kết quả quá khứ đẹp hơn một chút.</li>
          <li>App chỉ dùng giá và khối lượng. App không đọc báo cáo tài chính, tin tức, giao dịch khối ngoại hay chính sách tiền tệ, nên không biết các sự kiện sắp tới.</li>
          <li>Cấu hình hướng được chọn trên 2020–2023 rồi chấm một lần trên 2024 trở đi. Riêng cách tính biến động được chỉnh một lần sau khi đã xem số 2024 trở đi, vì vậy độ phủ giai đoạn này có thể đẹp hơn thực tế một chút.</li>
          <li>Các con số chưa tính phí, thuế và T+2. Phí và thuế một vòng mua bán thường vào khoảng 0,3%–0,5%.</li>
          <li>Ngày cuối kỳ chỉ trừ cuối tuần, chưa trừ ngày lễ.</li>
        </ul>
        <p class="note">Đây là công cụ thống kê, không phải khuyến nghị đầu tư. Mô hình học đến ${dmy(M.dataEnd)}.</p>
      </section>`;
  }

  // ---------- Điều khiển ----------

  function controls() {
    const c = $('controls');
    const wrap = $('controls-wrap');
    if (state.tab === 'tin-cay') { wrap.hidden = true; c.innerHTML = ''; return; }
    wrap.hidden = false;
    c.innerHTML = `<span class="control-label">Xem cho</span>${hzSeg()}`;
  }

  function render() {
    pending.length = 0;
    const focusAct = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.act : null;
    controls();
    const view = state.tab === 'ma' ? viewStock() : state.tab === 'bang' ? viewTable() : state.tab === 'tin-cay' ? viewTrust() : viewMarket();
    $('view').innerHTML = view;
    for (const t of ['thi-truong', 'ma', 'bang', 'tin-cay']) {
      if (t === state.tab) $('tab-' + t).setAttribute('aria-current', 'page'); else $('tab-' + t).removeAttribute('aria-current');
    }
    pending.forEach((f) => f());
    if (focusAct) { const again = [...document.querySelectorAll('[data-act]')].find((n) => n.dataset.act === focusAct); if (again) again.focus({ preventScroll: true }); }
  }

  function go(tab) {
    state.tab = tab;
    syncHash();
    render();
    window.scrollTo(0, 0);
  }

  function syncHash() {
    const h = state.tab === 'ma' ? `ma-${state.sym}` : state.tab;
    try { if (location.hash !== '#' + h) history.replaceState(null, '', '#' + h); } catch { /* khung nhúng có thể chặn */ }
  }

  async function openSymbol(sym) {
    state.sym = sym;
    state.tab = 'ma';
    syncHash();
    if (!series.has(sym) && STANDALONE) {
      state.loading = sym;
      render();
      try {
        const bars = await getBars(sym, Math.floor(Date.now() / 1000 - FIVE_YEARS));
        const clean = closedOnly(sym, bars);
        if (clean.length) { rows.set(sym, clean); series.set(sym, E.prep(clean)); forecasts.set(sym, forecastOf(sym)); }
      } catch { /* thông báo nằm trong viewStock */ }
      state.loading = null;
    }
    render();
    window.scrollTo(0, 0);
  }

  function suggest(q) {
    const box = $('suggest');
    if (!box) return;
    const raw = q.trim();
    if (!raw) { box.innerHTML = ''; return; }
    const fold = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    const up = raw.toUpperCase(), low = fold(raw);
    const list = Object.entries(NAMES).filter(([s, v]) => s.startsWith(up) || fold(v[0]).includes(low));
    list.sort((a, b) => (b[0].startsWith(up) - a[0].startsWith(up)) || (U.UNIVERSE.includes(b[0]) - U.UNIVERSE.includes(a[0])) || a[0].localeCompare(b[0]));
    box.innerHTML = list.slice(0, 6).map(([s, v]) => `<button class="list-btn" type="button" data-act="open:${s}"><b>${s}</b><span>${esc(v[0])}</span></button>`).join('') || '<p class="note">Không tìm thấy mã nào.</p>';
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const [act, val] = el.dataset.act.split(':');
    if (act === 'tab') go(val);
    else if (act === 'hz') { state.hz = val; store.set('hz', val); render(); }
    else if (act === 'range') { state.range = val; render(); }
    else if (act === 'open') openSymbol(val);
    else if (act === 'refresh') refreshAll();
    else if (act === 'idx') { state.idx = val; render(); }
    else if (act === 'sector') { state.sector = val; state.onlyWatch = false; go('bang'); }
    else if (act === 'intro-done') { state.intro = false; store.set('intro', false); render(); }
    else if (act === 'help') { e.stopPropagation(); openHelp(val); }
    else if (act === 'help-close') $('help').close();
    else if (act === 'ma') {
      state.ma = state.ma.includes(val) ? state.ma.filter((x) => x !== val) : [...state.ma, val];
      store.set('ma', state.ma);
      render();
    }
    else if (act === 'watch') {
      state.watch = state.watch.includes(val) ? state.watch.filter((s) => s !== val) : [...state.watch, val];
      store.set('watch', state.watch);
      render();
    }
  });

  // Biểu đồ trong mục mở rộng cần chiều rộng thật, nên vẽ lại khi mở.
  document.addEventListener('toggle', (e) => {
    if (e.target.id !== 'trust-more' || state.trustOpen === e.target.open) return;
    state.trustOpen = e.target.open;
    if (e.target.open) render();
  }, true);

  // Bấm ra ngoài tấm giải thích để đóng.
  $('help').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  document.addEventListener('change', (e) => {
    const k = e.target.dataset && e.target.dataset.change;
    if (!k) return;
    state[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    render();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'sym-input') suggest(e.target.value);
    if (e.target.id === 'calc-capital' || e.target.id === 'calc-risk') {
      const box = e.target.closest('[data-calc]');
      calcResult(box.dataset.calc, box.dataset.calcKey);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'sym-input' && e.key === 'Enter') {
      const first = $('suggest').querySelector('[data-act]');
      const typed = e.target.value.trim().toUpperCase();
      if (first) openSymbol(first.dataset.act.split(':')[1]);
      else if (/^[A-Z0-9]{3}$/.test(typed)) openSymbol(typed);
    }
  });

  let lastW = window.innerWidth, timer;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  });

  function fromHash() {
    const h = location.hash.replace('#', '');
    if (/^ma-[A-Z0-9]{3,8}$/.test(h)) { state.tab = 'ma'; state.sym = h.slice(3); return; }
    if (['thi-truong', 'ma', 'bang', 'tin-cay'].includes(h)) state.tab = h;
  }

  window.addEventListener('hashchange', () => {
    const before = state.tab + state.sym;
    fromHash();
    if (before !== state.tab + state.sym) { if (state.tab === 'ma') openSymbol(state.sym); else render(); }
  });

  fromHash();
  recompute();
  if (state.tab === 'ma' && !series.has(state.sym)) openSymbol(state.sym); else render();
  updateStatus();
  if (STANDALONE) {
    refreshAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
