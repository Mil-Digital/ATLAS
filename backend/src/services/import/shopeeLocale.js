import XLSX from 'xlsx';
import { readWorkbook } from './parsers.js';

// Shopee Seller Centre exports the same Performance Overview / Product
// Performance workbook in whichever language the seller account is set to.
// The layout is identical — same sheets, same column order, same section
// blocks — only the labels change. Every reader in ATLAS (the importers and
// monthlyShopStats) is written against the Indonesian labels, so an English
// export used to import "successfully" with zero rows: no "Tanggal", no
// "Kode Produk", nothing matched.
//
// Rather than teach each reader two vocabularies, the workbook is translated
// to the Indonesian labels right after it is read. Indonesian workbooks pass
// through untouched (none of the English keys occur in them).
//
// Labels are context-dependent — "Sales (IDR)" is "Total Penjualan (IDR)" in
// the daily stage sheets but "Penjualan (IDR)" inside a traffic-source block —
// so each header row is translated with the dictionary for its kind, chosen
// by its first cell. Mapping taken column-by-column from an Indonesian and an
// English export of the same store.

// Daily stage sheets ("Pesanan Dibuat" / "Siap Dikirim" / "Dibayar").
const STAGE_HEADER = {
  Date: 'Tanggal',
  'Sales (IDR)': 'Total Penjualan (IDR)',
  Orders: 'Total Pesanan',
  'Sales per Order': 'Penjualan per Pesanan',
  'Product Clicks': 'Produk Diklik',
  Visitors: 'Total Pengunjung',
  'Order Conversion Rate': 'Tingkat Konversi Pesanan',
  'Cancelled Orders': 'Pesanan Dibatalkan',
  'Cancelled Sales': 'Penjualan Dibatalkan',
  'Returned/Refunded Orders': 'Pesanan Dikembalikan',
  'Returned/Refunded Sales': 'Penjualan Dikembalikan',
  '# of buyers': 'Pembeli',
  '# of new buyers': 'Total Pembeli Baru',
  '# of existing buyers': 'Total Pembeli Saat Ini',
  '# of potential buyers': 'Total Potensi Pembeli',
  'Repeat Purchase Rate': 'Tingkat Pembelian Berulang',
};

// Headline row of the traffic-source / contribution sheets.
const HEADLINE_HEADER = {
  Date: 'Tanggal',
  'Order Type': 'Status Pesanan',
  'Sales (IDR)': 'Penjualan (IDR)',
  'Sales from Product Card': 'Penjualan dari halaman produk',
  'Sales from Seller Live': 'Penjualan dari Live Penjual',
  'Sales from Seller Video': 'Penjualan dari Video Penjual',
  'Sales from Affiliate': 'Penjualan dari Affiliate',
  'Sales from Shopee Ads': 'Penjualan dari Iklan Shopee',
};

const ORDER_TYPE = {
  'Placed Order': 'Pesanan Dibuat',
  'Confirmed Order': 'Pesanan Siap Dikirim',
  'Paid Order': 'Pesanan Dibayar',
};

// Header row inside a channel block ("Traffic Source" ↔ "Sumber Kunjungan").
const CHANNEL_HEADER = {
  'Traffic Source': 'Sumber Kunjungan',
  'Sales Ratio': 'Rasio Penjualan',
  'Sales (IDR)': 'Penjualan (IDR)',
  'Product Impressions': 'Jumlah Produk Dilihat',
  'Live Views': 'Live Ditonton',
  'Video Views': 'Video Ditonton',
  'Content Views': 'Konten Ditonton',
  'Product Clicks': 'Produk Diklik',
  Orders: 'Total Pesanan',
  Units: 'Produk',
  CTR: 'Persentase Klik',
  'Order Conversion Rate': 'Tingkat Konversi Pesanan',
  'Sales per Order': 'Penjualan per Pesanan',
  Buyers: 'Total Pembeli',
  'Unique Product Impressions': 'Produk Unik Dilihat',
  'Live Viewers': 'Penonton Live',
  'Video Viewers': 'Penonton Video',
  'Content Viewers': 'Penonton Konten',
  'Unique Product Clicks': 'Produk Unik Diklik',
  Conversion: 'Konversi',
  'Ads Expense': 'Pengeluaran Iklan',
  'Ads ROAS': 'ROAS Iklan',
};

// Section titles: a row with only its first cell filled.
const SECTION_TITLE = {
  'Product Card': 'Halaman Produk',
  'Seller Live': 'Live Penjual',
  'Seller Video': 'Video Penjual',
  'Shopee Affiliate': 'Affiliate',
  'Shopee Ads': 'Iklan Shopee',
};

// Traffic sub-sources (first cell of a block's data rows). Kept in Indonesian
// so the same source is one traffic_sub_sources row whichever language the
// month was exported in. Ad product names are left as Shopee wrote them.
const SUB_SOURCE = {
  ...SECTION_TITLE,
  Shop: 'Toko',
  Search: 'Pencarian',
  Recommendation: 'Rekomendasi',
  'Shopping Cart': 'Keranjang',
  'My Purchase': 'Pesanan Saya',
  Promotion: 'Promosi',
  Others: 'Lainnya',
  'Live Tab': 'Tab Live',
  'Video Tab': 'Tab Video',
  'Homepage Shopee Live': 'Halaman Utama Shopee Live',
  'Homepage Shopee Video': 'Halaman Utama Shopee Video',
  'Creator Profile': 'Profil Kreator',
  'Affiliate Video': 'Video Affiliate',
  'Affiliate Live': 'Live Affiliate',
};

// Product rows: Product Performance sheets and the "Product Contribution"
// blocks of Performance Overview. "SKU" is deliberately absent — the
// Indonesian export calls that column "Kode Variasi" too, and translating it
// would shadow the real variation ID column.
const PRODUCT_HEADER = {
  'Item ID': 'Kode Produk',
  Product: 'Produk',
  'Current Item Status': 'Status Produk Saat Ini',
  'Variation ID': 'Kode Variasi',
  'Variation Name': 'Nama Variasi',
  'Current Variation Status': 'Status Variasi Saat Ini',
  'Parent SKU': 'SKU Induk',
  'Created Date': 'Tanggal Dibuat',
  'Days Created': 'Hari Dibuat',
  'Current Price': 'Harga Saat Ini',
  'Uncompetitive Variations': 'Variasi Belum Kompetitif',
  'Competitive Variations': 'Variasi Terbaik',
  'Sales (Placed Order) (IDR)': 'Total Penjualan (Pesanan Dibuat) (IDR)',
  'Sales (Confirmed Order) (IDR)': 'Penjualan (Pesanan Siap Dikirim) (IDR)',
  'Product Impression': 'Jumlah Produk Dilihat',
  'Product Clicks': 'Produk Diklik',
  CTR: 'Persentase Klik',
  'Order Conversion Rate (Placed Order)': 'Tingkat Konversi Pesanan (Pesanan Dibuat)',
  'Order Conversion Rate (Confirmed Order)': 'Tingkat Konversi Pesanan (Pesanan Siap Dikirim)',
  'Placed Order': 'Pesanan Dibuat',
  'Confirmed Order': 'Pesanan Siap Dikirim',
  'Units (Placed Order)': 'Produk (Pesanan Dibuat)',
  'Units (Confirmed Order)': 'Produk (Pesanan Siap Dikirim)',
  'Buyers (Placed Order)': 'Total Pembeli (Pesanan Dibuat)',
  'Buyers (Confirmed Order)': 'Total Pembeli (Pesanan Siap Dikirim)',
  'Conversion Rate (Placed Order)': 'Tingkat Konversi (Pesanan yang Dibuat)',
  'Conversion Rate (Confirmed Order)': 'Tingkat Konversi (Pesanan Siap Dikirim)',
  'Sales per Order (Placed Order) (IDR)': 'Penjualan per Pesanan (Pesanan Dibuat) (IDR)',
  'Sales per Order (Confirmed Order) (IDR)': 'Penjualan per Pesanan (Pesanan Siap Dikirim) (IDR)',
  'Unique Product Impressions': 'Produk Unik Dilihat',
  'Unique Product Clicks': 'Produk Unik Diklik',
  'Product Visitors (Visit)': 'Pengunjung Produk (Kunjungan)',
  'Product Page Views': 'Halaman Produk Dilihat',
  'Product Bounce Visitors': 'Pengunjung Melihat Tanpa Membeli',
  'Product Bounce Rate': 'Tingkat Pengunjung Melihat Tanpa Membeli',
  'Search Clicks': 'Klik Pencarian',
  Likes: 'Suka',
  'Product Visitors (Add to Cart)': 'Pengunjung Produk (Menambahkan Produk ke Keranjang)',
  'Units (Add to Cart)': 'Dimasukkan ke Keranjang (Produk)',
  'Conversion Rate (Add to Cart)': 'Tingkat Konversi Produk Dimasukkan ke Keranjang',
  'Repeat Order Rate (Placed Order)': 'Tingkat Pesanan Berulang (Pesanan Dibuat)',
  'Repeat Order Rate (Confirmed Order)': '% Pembelian Ulang (Pesanan Siap Dikirim)',
  'Average Days to Repeat Order (Placed Order)': 'Rata-rata hari Pesanan Berulang (Pesanan Dibuat)',
  'Average Days to Repeat Order (Confirmed Order)': 'Rata-rata Hari Pembelian Terulang (Pesanan Siap Dikirim)',
  // Product Contribution blocks use the channel vocabulary for the rest.
  'Sales Ratio': 'Rasio Penjualan',
  'Sales (IDR)': 'Penjualan (IDR)',
  'Product Impressions': 'Jumlah Produk Dilihat',
  Orders: 'Total Pesanan',
  Units: 'Produk',
  'Order Conversion Rate': 'Tingkat Konversi Pesanan',
  'Sales per Order': 'Penjualan per Pesanan',
  Buyers: 'Total Pembeli',
};

// Sheet names. Shopee truncates long names to 31 characters with "...", so
// these match on the English prefix. The importer finds the daily
// traffic-source sheets by the "(pesanan …)Asal" prefix.
const STAGE_KEY = { placed: 'pesanan dibuat', confirmed: 'pesanan siap dikirim', paid: 'pesanan dibayar' };
const SHEET_RULES = [
  [/^Source Contribution \((placed|confirmed|paid)/i, (s) => `(${STAGE_KEY[s]})Asal Penjualan`],
  [/^Product Contribution \((placed|confirmed|paid)/i, (s) => `(${STAGE_KEY[s]})Kontribusi Produk`],
  [/^Placed Order$/i, () => 'Pesanan Dibuat'],
  [/^Confirmed Order$/i, () => 'Pesanan Siap Dikirim'],
  [/^Paid Order$/i, () => 'Pesanan Dibayar'],
  [/^Newly Listed Products/i, () => 'Produk yang Baru Ditambahkan'],
  [/^Uncompetitive price/i, () => 'Harga Belum Kompetitif'],
  [/^Competitive Price/i, () => 'Harga Sudah Kompetitif'],
  [/^Boost With Ads/i, () => 'Tingkatkan dengan Iklan'],
  [/^Optimize Your Ads/i, () => 'Iklankan'],
  [/^Track Ads Performance/i, () => 'Cek Performa Iklan'],
];

function renameSheets(wb) {
  wb.SheetNames.forEach((name, i) => {
    for (const [re, to] of SHEET_RULES) {
      const m = name.match(re);
      if (!m) continue;
      const next = to(m[1]?.toLowerCase());
      if (next === name || wb.Sheets[next]) break;
      wb.Sheets[next] = wb.Sheets[name];
      delete wb.Sheets[name];
      wb.SheetNames[i] = next;
      if (wb.Workbook?.Sheets?.[i]) wb.Workbook.Sheets[i].name = next;
      break;
    }
  });
}

const text = (cell) => (cell == null || cell.v == null ? '' : String(cell.w ?? cell.v).trim());

function setText(cell, value) {
  cell.t = 's';
  cell.v = value;
  cell.w = value;
  delete cell.h;
  delete cell.r;
}

function headerDict(first, second) {
  if (first === 'Date') return second === 'Order Type' ? HEADLINE_HEADER : STAGE_HEADER;
  if (first === 'Traffic Source') return CHANNEL_HEADER;
  if (first === 'Item ID') return PRODUCT_HEADER;
  return null;
}

function translateSheet(sheet) {
  if (!sheet?.['!ref']) return false;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const at = (r, c) => sheet[XLSX.utils.encode_cell({ r, c })];
  let changed = false;
  let inChannelBlock = false;
  let orderTypeCol = -1;

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const first = text(at(r, range.s.c));
    if (!first) continue;
    const rest = [];
    for (let c = range.s.c + 1; c <= range.e.c; c += 1) rest.push(text(at(r, c)));
    const onlyFirst = rest.every((v) => v === '');

    const dict = headerDict(first, rest[0]);
    if (dict) {
      orderTypeCol = -1;
      inChannelBlock = dict === CHANNEL_HEADER;
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const cell = at(r, c);
        const to = dict[text(cell)];
        if (cell && to) { setText(cell, to); changed = true; }
        if (dict === HEADLINE_HEADER && text(cell) === 'Status Pesanan') orderTypeCol = c;
      }
      continue;
    }

    if (onlyFirst && SECTION_TITLE[first]) {
      setText(at(r, range.s.c), SECTION_TITLE[first]);
      inChannelBlock = false;
      changed = true;
      continue;
    }

    if (orderTypeCol >= 0) {
      const cell = at(r, orderTypeCol);
      const to = ORDER_TYPE[text(cell)];
      if (cell && to) { setText(cell, to); changed = true; }
    }

    if (inChannelBlock && SUB_SOURCE[first]) {
      setText(at(r, range.s.c), SUB_SOURCE[first]);
      changed = true;
    }
  }
  return changed;
}

// Translates an English Shopee workbook to the Indonesian labels in place and
// returns it. Safe to call on an Indonesian workbook, and safe to call twice.
export function localizeShopeeWorkbook(wb) {
  renameSheets(wb);
  for (const name of wb.SheetNames) translateSheet(wb.Sheets[name]);
  return wb;
}

// readWorkbook + localizeShopeeWorkbook, for the Shopee shop-stats readers.
export function readShopeeWorkbook(src) {
  return localizeShopeeWorkbook(readWorkbook(src));
}
