// Danh sách mã dùng để huấn luyện và nhúng sẵn. Mã ngoài danh sách vẫn tra được trực tuyến trong app.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StockUniverse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const INDICES = [
    { s: 'VNINDEX', n: 'VN-Index' },
    { s: 'VN30', n: 'VN30' },
    { s: 'HNX', n: 'HNX-Index' },
    { s: 'UPCOM', n: 'UPCoM-Index' },
  ];
  const SECTORS = {
    'Ngân hàng': ['ACB', 'BID', 'CTG', 'EIB', 'HDB', 'LPB', 'MBB', 'MSB', 'SHB', 'SSB', 'STB', 'TCB', 'TPB', 'VCB', 'VIB', 'VPB'],
    'Bất động sản': ['BCM', 'DIG', 'DXG', 'KBC', 'KDH', 'NLG', 'NVL', 'PDR', 'SZC', 'VHM', 'VIC', 'VRE'],
    'Chứng khoán': ['HCM', 'SHS', 'SSI', 'VCI', 'VND'],
    'Thép, vật liệu': ['HPG', 'HSG', 'NKG', 'VGC', 'BMP', 'HT1'],
    'Năng lượng': ['GAS', 'PLX', 'POW', 'PVD', 'PVS', 'BSR'],
    'Hóa chất, phân bón': ['DCM', 'DGC', 'DPM', 'GVR'],
    'Bán lẻ, tiêu dùng': ['FRT', 'MSN', 'MWG', 'PNJ', 'SAB', 'VNM', 'KDC', 'DBC', 'HAG', 'VHC'],
    'Công nghệ, viễn thông': ['FPT', 'CTR', 'VGI'],
    'Vận tải, công nghiệp': ['GMD', 'HAH', 'VJC', 'VTP', 'REE', 'CTD', 'HDG', 'BVH'],
  };
  const SECTOR_OF = {};
  for (const [k, list] of Object.entries(SECTORS)) for (const s of list) SECTOR_OF[s] = k;
  const UNIVERSE = Object.keys(SECTOR_OF).sort();
  return { INDICES, SECTORS, SECTOR_OF, UNIVERSE };
});
