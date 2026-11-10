// "Fitur baru" — a short guide that points at a feature the first time it is
// on an account's screen after it ships (FeatureSpotlight.jsx).
//
// EVERY NEW FEATURE GETS AN ENTRY HERE, on any page or tab. Who sees it:
//   • every account except superadmin (the people who ship the features);
//   • only accounts created BEFORE `released` — a newer account learns the
//     page from its page tour (tours.js) instead;
//   • only for SHOW_FOR_DAYS after `released`, so someone back from a long
//     leave is not met by a queue of old news;
//   • only once its `target` is actually on screen. A feature in a closed
//     tab, or one a role cannot open, waits — it is not marked seen until
//     it has been shown.
// Features on screen at the same moment are shown together, one step each.
//
// Fields:
//   id        unique and permanent (lowercase, digits, dashes) — it is what
//             each account's "seen" list stores, so never rename or reuse one
//   released  'YYYY-MM-DD', the day it ships
//   path      optional route prefix the guide is limited to
//   target    CSS selector of the element to point at — prefer a stable
//             data-* hook (PageBand tabs carry data-tab, Brand Tracking
//             views data-view) over a styling class
//   title, body   what changed and where to find it, in a sentence or two

export const SHOW_FOR_DAYS = 60;

export const WHATS_NEW = [
  {
    id: 'meta-pull-progress',
    released: '2026-11-10',
    path: '/data-brand',
    target: '[data-feature="meta-pull-now"]',
    title: 'Progres tarik data Meta Ads yang jelas',
    body: 'Setelah menekan Tarik Meta Ads, kartu progres menunjukkan tahapnya (antre, tarik dari Meta, simpan, selesai), persentase, hari dan baris yang masuk, serta perkiraan selesai. Semua anggota tim melihat progres yang sama, dan bulan yang selesai langsung terisi di grid.',
  },
  {
    id: 'annual-plan-compare',
    released: '2026-11-05',
    path: '/brand-tracking',
    target: '[data-feature="plan-adjustment"]',
    title: 'Rencana tahunan: adjustment, realisasi, target awal',
    body: 'Target & Budget kini berbentuk lembar per bulan seperti spreadsheet: target adjustment, realisasi (achievement, gap, to be chased, CPR riil), dan target awal. Pembagian diatur langsung di tabel dengan % atau nominal, dan budget bisa mengikuti target lewat % alokasi.',
  },
  {
    id: 'shopee-sales-contribution',
    released: '2026-11-05',
    path: '/report-generator',
    target: '.panel.active [data-feature="sales-contribution"]',
    title: 'Kontribusi Penjualan: iklan vs non-iklan',
    body: 'Laporan Shopee kini menunjukkan berapa persen penjualan toko dari iklan dan non-iklan per bulan, cancel & return rate dari Performa Toko, serta Iklan Produk yang dipisah Individu dan Otomatis.',
  },
  {
    id: 'brand-switch-logo',
    released: '2026-11-05',
    path: '/data-brand',
    target: '[data-feature="brand-switch"]',
    title: 'Brand yang sedang dibuka kini lebih jelas',
    body: 'Logo dan nama brand tampil besar di Data Collection Hub. Klik Ganti brand untuk pindah brand langsung dari sini, tanpa kembali ke langkah 01.',
  },
  {
    id: 'restore-last-report',
    released: '2026-11-01',
    path: '/report-generator',
    target: '.panel.active [data-feature="restore-last-report"]',
    title: 'Laporan terakhir dibuka saat Anda minta',
    body: 'Report Generator kini tidak lagi memuat laporan terakhir dengan sendirinya, supaya halaman lebih ringan. Klik Buka laporan terakhir untuk menampilkannya lagi.',
  },
  {
    id: 'section-png-parts',
    released: '2026-11-01',
    path: '/report-generator',
    target: '.panel.active [data-feature="section-png-parts"]',
    title: 'Unduh tabel atau Root Cause saja',
    body: 'Di section yang menampilkan tabel dan Root Cause berdampingan, tombol PNG kini punya pilihan: seluruh section, tabel saja, atau Root Cause saja. Gambarnya sama dengan tampilan di layar.',
  },
  {
    id: 'meta-cost-lens',
    released: '2026-11-01',
    path: '/report-generator/meta',
    target: '.panel.active [data-feature="meta-cost-lens"]',
    title: 'Biaya di Traffic dan Conversion Analysis Meta',
    body: 'Pilih metrik di toggle, misalnya Conversion Rate. Grafik dan tabel lalu menampilkan biayanya di sebelahnya, seperti Cost per Purchase dan Cost per Content View, lengkap dengan periode lalu. Grafik menyorot 5 teratas, tabel memuat semuanya.',
  },
  {
    id: 'shopee-cost-lens',
    released: '2026-11-01',
    path: '/report-generator/shopee',
    target: '[data-feature="shopee-cost-lens"]',
    title: 'Biaya di Traffic dan Conversion Analysis',
    body: 'Pilih metrik di toggle, misalnya Conversion Rate. Grafik dan tabel lalu menampilkan biayanya di sebelahnya, seperti Cost per Conversion dan CPC, lengkap dengan periode lalu. Grafik menyorot 5 teratas, tabel memuat semuanya.',
  },
  {
    id: 'archive-run-cards',
    released: '2026-11-01',
    path: '/report-generator',
    target: '.panel.active .saved-src-card',
    title: 'Satu klik untuk dua periode dari Arsip',
    body: 'Di Arsip Laporan, klik satu kartu analisa untuk mengisi Periode Lalu dan Periode Ini sekaligus. Kartu juga bisa diberi nama, misalnya "Week 2 report", supaya mudah ditemukan lagi.',
  },
  {
    id: 'meta-ad-preview-link',
    released: '2026-10-29',
    path: '/report-generator',
    target: '.panel.active [data-feature="meta-ad-preview-link"]',
    title: 'Link preview iklan di tabel materi iklan',
    body: 'Tabel per materi iklan di Meta Ads kini punya kolom Preview. Klik Lihat untuk membuka preview iklannya di Meta. Kolom ini muncul untuk data hasil tarikan otomatis ATLAS.',
  },
  {
    id: 'meta-bars-periode-lalu',
    released: '2026-10-28',
    path: '/report-generator',
    target: '.panel.active [data-feature="meta-bars-periode-lalu"]',
    title: 'Periode lalu di setiap grafik batang',
    body: 'Grafik batang Meta Ads kini menampilkan periode lalu di samping periode ini: batang pudar untuk periode lalu, batang penuh untuk periode ini. Arahkan kursor ke batang untuk melihat angkanya.',
  },
  {
    id: 'shopee-shopplus-keyword-charts',
    released: '2026-10-28',
    path: '/report-generator/shopee',
    target: '[data-feature="shopee-keyword-charts"]',
    title: 'Shop+ Ads per campaign dan per keyword',
    body: 'Traffic dan Conversion Analysis Shop+ Ads kini punya dua grafik: per campaign dan per keyword dari file Iklan Toko - Keyword. Grafik keyword bisa difilter ke satu campaign, dan Pareto Shop+ kini menghitung per keyword.',
  },
  {
    id: 'shopee-tren-harian-grafik',
    released: '2026-10-28',
    path: '/report-generator/shopee',
    target: '[data-feature="shopee-daily-trend-chart"]',
    title: 'Grafik Tren Harian Toko',
    body: 'Tren Harian Toko kini dibuka dengan grafik per tanggal yang membandingkan dua periode. Pilihan metriknya mengikuti metrik di tabel di bawahnya.',
  },
  {
    id: 'meta-overview-audiens',
    released: '2026-10-28',
    path: '/report-generator',
    target: '.panel.active [data-feature="meta-overview-audience"]',
    title: 'Filter Audiens di Performance Overview',
    body: 'Performance Overview Boost Post dan Non-Boost Post kini punya filter Audiens seperti CPAS Shopee: Gabungan NV + RM, NV, atau RM. Tabel dan Root Cause Analysis di sebelahnya ikut membaca audiens yang dipilih.',
  },
  {
    id: 'meta-tab-per-channel',
    released: '2026-10-27',
    path: '/report-generator',
    target: '.panel.active [data-page="v2-boost"]',
    title: 'Tab per channel di laporan Meta Ads',
    body: 'Laporan Meta Ads kini punya tab Boost Post, Non-Boost Post (Retail), Non-Boost Post (Non Retail), dan CPAS Shopee. Tiap tab dibuka dengan ringkasan channel-nya, lalu Traffic, Conversion, dan Top Content Analysis — Boost Post membaca Consideration Analysis per materi iklan. Setiap grafik diikuti tabel perubahan dibanding periode lalu.',
  },
  {
    id: 'shopee-report-channel-tabs',
    released: '2026-10-26',
    path: '/report-generator/shopee',
    target: '[data-feature="shopee-roi-root"]',
    title: 'Report Shopee per channel',
    body: 'Report Shopee kini dibagi per tab Overall, Product Ads, Shop+ Ads, Live Ads, dan Banner Ads, masing-masing dengan Traffic, Conversion, Pareto, dan Potential. Overall dibuka dengan ROI yang dipecah ke Revenue dan Spend per channel, Shop+ Ads membandingkan tiap grup iklan, dan Potential Product kini hanya menampilkan produk laku yang belum diiklankan.',
  },
  {
    id: 'brand-ikut-antar-halaman',
    released: '2026-10-26',
    target: '[data-nav="/brand-tracking"]',
    title: 'Brand ikut saat pindah halaman',
    body: 'Brand yang Anda pilih di satu halaman kini langsung terbuka di halaman lain — Brand Overview, Brand Tracking, Brand Setting, Report Generator, dan Business Insight.',
  },
  {
    id: 'laporan-terakhir-tetap-tampil',
    released: '2026-10-26',
    path: '/report-generator',
    target: '.panel.active .report-top',
    title: 'Laporan tidak hilang saat pindah halaman',
    body: 'Laporan yang sudah di-Generate tetap tampil setelah Anda pindah halaman atau me-refresh, jadi tidak perlu generate ulang. Tekan Ganti Sumber Data untuk mulai dari awal.',
  },
  {
    id: 'sumber-data-shopee-seperti-meta',
    released: '2026-10-26',
    path: '/report-generator',
    target: '.panel.active .src-switch',
    title: 'Sumber data yang seragam di semua channel',
    body: 'Shopee, TikTok, dan Google Ads kini memilih sumber data per periode dengan cara yang sama seperti Meta Ads. Google Ads memakai kalender Rentang tanggal dari data yang ditarik otomatis.',
  },
  {
    id: 'logo-brand-report-generator',
    released: '2026-10-26',
    path: '/report-generator',
    target: '.client-bar-avatar',
    title: 'Logo brand di Report Generator',
    body: 'Logo brand yang dipilih kini tampil di samping pilihan brand, jadi mudah memastikan laporan dibuat untuk brand yang benar.',
  },
  {
    id: 'shortcut-report-generator',
    released: '2026-10-26',
    path: '/data-brand',
    target: '[data-feature="shortcut-report-generator"]',
    title: 'Pintasan ke Report Generator',
    body: 'Dari setiap channel di Data Collection Hub, buka Report Generator untuk channel dan brand yang sama dengan satu klik.',
  },
  {
    id: 'meta-boost-instagram-follows',
    released: '2026-10-21',
    path: '/data-brand',
    target: '[data-feature="meta-kolom-ditarik"]',
    title: 'Instagram follows di Boost Post',
    body: 'Tarikan Meta Ads untuk Boost Post kini memuat Instagram follows dan Cost per Instagram follow (Amount spent ÷ follows). Keduanya juga bisa dipilih di alert mingguan dan muncul di Report Generator.',
  },
  {
    id: 'hapus-channel-revenue',
    released: '2026-10-21',
    path: '/brand-tracking',
    target: '[data-feature="hapus-channel"]',
    title: 'Hapus channel yang tidak dipakai',
    body: 'Channel di Revenue Stream, termasuk channel bawaan seperti Shopee atau Tokopedia, kini bisa dihapus bila brand tidak memakainya. Semua datanya ikut terhapus; tambahkan lagi lewat Tambah channel kapan saja.',
  },
  {
    id: 'sidebar-brand-overview-business-insight',
    released: '2026-10-20',
    target: '[data-nav="/dashboard"]',
    title: 'Nama dan urutan menu baru',
    body: 'Business Overview kini bernama Brand Overview, dan Internal Dashboard kini Business Insight. Keduanya bersama Beranda ada paling atas sidebar; grup Operasional menjadi Integration.',
  },
  {
    id: 'pintasan-executive-snapshot',
    released: '2026-10-20',
    path: '/dashboard',
    target: '[data-feature="snapshot-shortcuts"]',
    title: 'Pintasan di Executive Snapshot',
    body: 'Langsung lompat ke Minutes of Meeting di bawah, atau buka Target & Budget brand ini di Brand Tracking.',
  },
  {
    id: 'halaman-extensions',
    released: '2026-10-20',
    target: '[data-nav="/extensions"]',
    title: 'Halaman Extensions',
    body: 'Unduh Chrome extension ATLAS Google Reviews Exporter di sini, lengkap dengan cara memasang dan memakainya.',
  },
  {
    id: 'google-reviews-import-csv',
    released: '2026-10-20',
    path: '/google-reviews',
    target: '[data-feature="gr-csv-import"]',
    title: 'Import CSV Google Reviews',
    body: 'Kumpulkan ulasan dari Google Maps dengan Chrome extension ATLAS Google Reviews Exporter, lalu unggah CSV-nya di sini. ATLAS menampilkan preview dulu, baru menyimpan dan menganalisisnya.',
  },
  {
    id: 'google-reviews-analytics',
    released: '2026-10-19',
    target: '[data-nav="/google-reviews"]',
    title: 'Google Reviews Analytics',
    body: 'Cari bisnis di Google Maps, kumpulkan ulasannya, lalu lihat sentimen, kata yang paling sering dipakai pelanggan, tren, dan ringkasan AI dalam satu halaman.',
  },
  {
    id: 'panduan-google-ads-script',
    released: '2026-10-15',
    path: '/data-brand',
    target: '[data-feature="google-ads-script-guide"]',
    title: 'Panduan setup Google Ads Script',
    body: 'Langkah memasang script di akun Google Ads klien kini ada di sini, lengkap dengan kode yang tinggal disalin. INGEST_KEY tetap diminta ke superadmin via Slack.',
  },
  {
    id: 'mom-di-brand-tracking',
    released: '2026-10-14',
    path: '/brand-tracking',
    target: '.bt-views [data-view="mom"]',
    title: 'Minutes of Meeting sekarang di Brand Tracking',
    body: 'Recap meeting dan to do list tiap brand kini ada di tab ini, berdampingan dengan angka harian brand. Sebelumnya ada di Data Collection Hub.',
  },
  {
    id: 'mom-pindah-dari-data-hub',
    released: '2026-10-14',
    path: '/data-brand',
    target: '[data-nav="/brand-tracking"]',
    title: 'Minutes of Meeting sudah pindah',
    body: 'Minutes of Meeting tidak lagi ada di Data Collection Hub. Buka Brand Tracking di sidebar, lalu pilih tab Minutes of Meeting.',
  },
  {
    id: 'brand-tracking-di-sidebar',
    released: '2026-10-15',
    target: '[data-nav="/brand-tracking"]',
    title: 'Brand Tracking sekarang menu sendiri',
    body: 'Brand Tracking keluar dari Brand Setting dan kini punya menu sendiri di sidebar: angka harian, target, dan Minutes of Meeting tiap brand.',
  },
  {
    id: 'target-tahunan',
    released: '2026-10-15',
    path: '/pengaturan-brand',
    target: '[data-feature="target-tahunan"]',
    title: 'Target tahunan brand',
    body: 'Isi target sales dan budget iklan setahun di sini. Brand Tracking membaginya otomatis ke 12 bulan, setiap update tersimpan tanpa menghapus target awal, dan target awal yang salah input bisa dikoreksi.',
  },
  {
    id: 'rencana-tahunan',
    released: '2026-10-15',
    path: '/brand-tracking',
    target: '[data-feature="rencana-tahunan"]',
    title: 'Rencana tahunan per bulan',
    body: 'Target tahunan dari Brand Setting dibagi ke 12 bulan di sini. Atur pembagiannya sendiri bila perlu — totalnya harus tetap 100%.',
  },
  {
    id: 'akses-beberapa-brand',
    released: '2026-10-14',
    path: '/pengaturan-akses',
    target: '[data-feature="akses-brand"]',
    title: 'Satu akun, beberapa brand',
    body: 'Akun User (Internal) kini bisa diberi lebih dari satu brand: centang semua brand yang ditanganinya. Akun client tetap dibatasi ke satu brand.',
  },
  {
    id: 'meta-kelola-akun',
    released: '2026-10-29',
    path: '/data-brand',
    target: '[data-feature="meta-kelola-akun"]',
    title: 'Edit & hapus ad account Meta',
    body: 'Ikon pensil kini juga mengubah ID Ad Account, dan ikon tempat sampah menghapus akun. Satu brand boleh punya lebih dari satu akun MAIN atau CPAS, dan akun MAIN bisa ditandai khusus Boost Post atau Non Boost Post tanpa kata kunci.',
  },
  {
    id: 'target-roas-cost-per-revenue',
    released: '2026-10-29',
    path: '/pengaturan-brand',
    target: '[data-feature="target-tahunan"]',
    title: 'Target lewat Blended ROAS',
    body: 'Saat mengisi atau meng-update target tahunan, isi Blended ROAS atau Cost per Revenue — yang satu terhitung otomatis dari yang lain, dan budget iklan dihitung dari target sales.',
  },
  {
    id: 'brand-tracking-leads-data',
    released: '2026-10-29',
    path: '/brand-tracking',
    target: '#dt-tab-leads',
    title: 'Leads Data',
    body: 'Untuk brand non-retail: isi Cold Leads, Deal, dan nilai deal per hari (atau impor dari file Daily Tracking). Root Cause Analysis Meta Non-Boost Post (Non Retail) membacanya sebagai Orders, Message Started, dan GMV.',
  },
];
