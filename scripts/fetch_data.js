// Tải lịch sử giá ngày từ VNDirect và ghi data/history.json (đầy đủ, dùng để huấn luyện).
// Chạy: node scripts/fetch_data.js
const fs = require('fs');
const path = require('path');
const { INDICES, UNIVERSE } = require('../src/universe.js');

const YEARS = 12;
const API = 'https://dchart-api.vndirect.com.vn/dchart/history';
const UA = { 'User-Agent': 'Mozilla/5.0 (stock-analysis personal app)' };

async function bars(symbol) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - YEARS * 365 * 86400;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.s !== 'ok' || !j.t || !j.t.length) throw new Error('rỗng: ' + j.s);
      const out = [];
      for (let i = 0; i < j.t.length; i++) {
        if (!(j.c[i] > 0)) continue;
        out.push([new Date(j.t[i] * 1000).toISOString().slice(0, 10), j.o[i], j.h[i], j.l[i], j.c[i], j.v[i]]);
      }
      // Phiên chưa đóng cửa không được đưa vào dữ liệu huấn luyện và dữ liệu nhúng.
      const vn = new Date(Date.now() + 7 * 3600e3);
      const open = (r) => !r[5] || (r[0] === vn.toISOString().slice(0, 10) && vn.getUTCHours() * 60 + vn.getUTCMinutes() < 15 * 60 + 5);
      while (out.length && open(out.at(-1))) out.pop();
      return out;
    } catch (e) {
      if (attempt === 2) throw new Error(`${symbol}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

(async () => {
  const series = {};
  const failed = [];
  const all = [...INDICES.map((x) => x.s), ...UNIVERSE];
  for (let i = 0; i < all.length; i += 6) {
    await Promise.all(all.slice(i, i + 6).map(async (s) => {
      try { series[s] = await bars(s); } catch (e) { failed.push(e.message); }
    }));
  }
  const out = path.join(__dirname, '..', 'data', 'history.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), series }));
  const names = {};
  for (const [ex, code] of [['hose', 'H'], ['hnx', 'X'], ['upcom', 'U']]) {
    try {
      const res = await fetch(`https://iboard-query.ssi.com.vn/stock/exchange/${ex}`, { headers: UA, signal: AbortSignal.timeout(30000) });
      for (const x of (await res.json()).data) {
        if (x.stockType === 's' && /^[A-Z0-9]{3}$/.test(x.stockSymbol)) names[x.stockSymbol] = [(x.companyNameVi || '').replace(/^Cổ phiếu\s+/i, '').trim(), code];
      }
    } catch (e) { failed.push(`danh sách ${ex}: ${e.message}`); }
  }
  fs.writeFileSync(path.join(path.dirname(out), 'names.json'), JSON.stringify(names));
  console.log('tên mã:', Object.keys(names).length);
  console.log('wrote', out, (fs.statSync(out).size / 1048576).toFixed(1) + ' MB', Object.keys(series).length, 'mã');
  if (failed.length) console.log('LỖI:', failed);
})().catch((e) => { console.error(e); process.exit(1); });
