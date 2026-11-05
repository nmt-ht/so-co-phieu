// Ghép mã nguồn và dữ liệu thành: dist/so-co-phieu.html (bản xem nhanh) và app tại thư mục gốc (GitHub Pages phục vụ từ đây).
// Chạy: node scripts/build.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('src/tokens.css') + read('src/app.css');
const body = read('src/body.html');
const universe = read('src/universe.js');
const engine = read('src/engine.js');
const app = read('src/app.js');
const FONT = 'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=Bitter:wght@600;700&display=swap&subset=vietnamese';

// Dữ liệu nhúng: 5 năm gần nhất, ngày lưu theo chỉ số để gọn. Bản đầy đủ dùng khi huấn luyện.
const KEEP = 1300;
const hist = JSON.parse(read('data/history.json'));
const model = JSON.parse(read('data/model.json'));
const names = JSON.parse(read('data/names.json'));
const dateSet = new Set();
const cut = {};
for (const [s, r] of Object.entries(hist.series)) { cut[s] = r.slice(-KEEP); cut[s].forEach((x) => dateSet.add(x[0])); }
const dates = [...dateSet].sort();
const at = new Map(dates.map((d, i) => [d, i]));
const series = {};
for (const [s, r] of Object.entries(cut)) series[s] = r.map((x) => [at.get(x[0]), x[1], x[2], x[3], x[4], x[5]]);
const snapshot = JSON.stringify({ generatedAt: hist.generatedAt, dates, series, model, names }).replace(/<\//g, '<\\/');

const scripts = (standalone) => `<script>window.__STANDALONE__=${standalone};window.__SNAPSHOT__=${snapshot};</script>
<script>${universe}</script>
<script>${engine}</script>
<script>${app}</script>`;

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(root, '.nojekyll'), '');

// Bản xem nhanh: nơi xuất bản tự bọc khung tài liệu, không tự cập nhật giá.
fs.writeFileSync(path.join(dist, 'so-co-phieu.html'), `<title>Sổ Cổ Phiếu</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${FONT}">
<style>${css}</style>
${body}
${scripts(false)}
`);

// Bản web app độc lập, cài được lên điện thoại.
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sổ Cổ Phiếu</title>
<meta name="description" content="Phân tích cổ phiếu Việt Nam, xác suất và khoảng giá cho 1 tuần, 1 tháng tới, kèm kiểm định công khai">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Sổ Cổ Phiếu">
<meta name="theme-color" content="#f4f6f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1420" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="stylesheet" href="${FONT}">
<style>:root{padding-top:env(safe-area-inset-top,0px)}[hidden]{display:none!important}${css}</style>
</head>
<body>
${body}
${scripts(true)}
</body>
</html>
`);

fs.writeFileSync(path.join(root, 'manifest.webmanifest'), JSON.stringify({
  name: 'Sổ Cổ Phiếu', short_name: 'Sổ Cổ Phiếu', lang: 'vi', start_url: './', scope: './', display: 'standalone',
  background_color: '#16233a', theme_color: '#16233a',
  icons: [{ src: 'icon-180.png', sizes: '180x180', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
}, null, 2));

// Phiên bản cache đổi theo nội dung để điện thoại nhận bản mới.
const version = crypto.createHash('sha1').update(css + body + universe + engine + app + snapshot).digest('hex').slice(0, 10);
fs.writeFileSync(path.join(root, 'sw.js'), `const CACHE = 'socophieu-${version}';
const SHELL = ['./', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // API giá do app tự xử lý và tự lưu; ở đây chỉ phục vụ phần vỏ app và phông chữ khi offline.
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
  } else if (u.hostname.endsWith('googleapis.com') || u.hostname.endsWith('gstatic.com')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((n) => { const c = n.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return n; })));
  }
});
`);

// Biểu tượng: hai nến trên nền mực xanh, vẽ trực tiếp ra PNG để không cần thư viện ngoài.
function png(size) {
  const SS = 3;
  const px = Buffer.alloc((size * 4 + 1) * size);
  const shapes = [
    [0.33, 0.2, 0.35, 0.72, [120, 224, 170]], [0.26, 0.34, 0.42, 0.62, [120, 224, 170]],
    [0.65, 0.3, 0.67, 0.84, [240, 150, 130]], [0.58, 0.42, 0.74, 0.72, [240, 150, 130]],
  ];
  const shade = (x, y) => {
    for (const [a, b, c, d, col] of shapes) if (x >= a && x <= c && y >= b && y <= d) return col;
    return [22, 35, 58];
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    px[row] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
        const c = shade((x + (i + 0.5) / SS) / size, (y + (j + 0.5) / SS) / size);
        r += c[0]; g += c[1]; b += c[2];
      }
      const k = SS * SS, o = row + 1 + x * 4;
      px[o] = r / k; px[o + 1] = g / k; px[o + 2] = b / k; px[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(root, 'icon-180.png'), png(180));
fs.writeFileSync(path.join(root, 'icon-512.png'), png(512));

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0) + ' KB';
console.log('dist/so-co-phieu.html', kb(path.join(dist, 'so-co-phieu.html')));
for (const f of ['index.html', 'sw.js', 'icon-180.png']) console.log(f, kb(path.join(root, f)));
console.log('cache version', version);
