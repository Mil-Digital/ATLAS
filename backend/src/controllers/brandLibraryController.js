import { v4 as uuidv4 } from 'uuid';
import { AppError, asyncHandler } from '../utils/errors.js';
import * as uploadService from '../services/uploadService.js';
import { processUpload } from '../services/import/importService.js';
import * as brandService from '../services/brandService.js';
import * as library from '../services/brandLibraryService.js';
import * as ai from '../services/aiSummaryService.js';
import { splitMetaExport } from '../services/metaUploadSplit.js';

async function requireBrand(brandId) {
  const brand = await brandService.getBrandById(brandId);
  if (!brand) throw new AppError('Brand tidak ditemukan', 404);
  return brand;
}

function parseBrandId(req) {
  const brandId = Number(req.params.brandId);
  if (!Number.isInteger(brandId) || brandId <= 0) throw new AppError('brandId tidak valid', 400);
  return brandId;
}

export const getProfile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);
  res.json({ profile: await library.getProfile(brandId) });
});

export const saveProfile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);
  const industry = req.body?.industry;
  if (industry != null && industry !== '' && !library.INDUSTRY_OPTIONS.includes(industry)) {
    throw new AppError('Kategori industri tidak valid', 400);
  }
  const profile = await library.saveProfile(brandId, req.body ?? {}, req.user?.userId);
  res.json({ profile });
});

const MOM_TYPES = new Set(['regular', 'non_regular', 'whatsapp_quick_call']);

function parseMinute(req) {
  const body = req.body ?? {};
  const date = typeof body.meeting_date === 'string' ? body.meeting_date : '';
  // The shape check alone accepted 2026-02-31, which Postgres then rejects as
  // a 500. Round-tripping through Date catches impossible calendar days here.
  const parsed = new Date(`${date}T00:00:00Z`);
  // Month 13 makes an Invalid Date, whose toISOString() throws — check the
  // timestamp first so a bad date is a 400, not an unhandled 500.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new AppError('Tanggal meeting wajib diisi dengan tanggal yang valid', 400);
  }
  if (!MOM_TYPES.has(body.meeting_type)) throw new AppError('Tipe meeting tidak valid', 400);
  const minute = {
    meeting_date: date,
    meeting_type: body.meeting_type,
    meeting_recap: String(body.meeting_recap ?? '').trim(),
    todo_client: String(body.todo_client ?? '').trim(),
    todo_mil: String(body.todo_mil ?? '').trim(),
  };
  // A record with a date and nothing else has nothing for Brand Overview to
  // read or summarise; the editor blocks it too, this is the server's copy.
  if (!minute.meeting_recap && !minute.todo_client && !minute.todo_mil) {
    throw new AppError('Isi recap atau minimal satu to do list', 400);
  }
  if ([minute.meeting_recap, minute.todo_client, minute.todo_mil].some((text) => text.length > 20000)) {
    throw new AppError('Isi MOM terlalu panjang (maksimal 20.000 karakter per bagian)', 400);
  }
  return minute;
}

export const listMinutes = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);
  res.json({ minutes: await library.listMinutes(brandId, { startDate: req.query.startDate, endDate: req.query.endDate }) });
});

export const createMinute = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);
  res.status(201).json({ minute: await library.createMinute(brandId, parseMinute(req), req.user?.userId) });
});

export const updateMinute = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const minuteId = Number(req.params.minuteId);
  if (!Number.isInteger(minuteId) || minuteId <= 0) throw new AppError('ID MOM tidak valid', 400);
  await requireBrand(brandId);
  const minute = await library.updateMinute(brandId, minuteId, parseMinute(req), req.user?.userId);
  if (!minute) throw new AppError('MOM tidak ditemukan', 404);
  res.json({ minute });
});

export const deleteMinute = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const minuteId = Number(req.params.minuteId);
  if (!Number.isInteger(minuteId) || minuteId <= 0) throw new AppError('ID MOM tidak valid', 400);
  await requireBrand(brandId);
  if (!await library.deleteMinute(brandId, minuteId)) throw new AppError('MOM tidak ditemukan', 404);
  res.status(204).end();
});

export const saveMinuteTaskState = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const minuteId = Number(req.params.minuteId);
  const keys = req.body?.completed_task_keys;
  if (!Number.isInteger(minuteId) || minuteId <= 0) throw new AppError('ID MOM tidak valid', 400);
  if (!Array.isArray(keys) || keys.length > 500 || keys.some((key) => typeof key !== 'string' || key.length > 500)) throw new AppError('Status checklist tidak valid', 400);
  await requireBrand(brandId);
  const minute = await library.saveMinuteTaskState(brandId, minuteId, [...new Set(keys)], req.user?.userId);
  if (!minute) throw new AppError('MOM tidak ditemukan', 404);
  res.json({ minute });
});

export const generateMinutesSummary = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const minuteIds = req.body?.minute_ids;
  if (!Array.isArray(minuteIds) || !minuteIds.length || minuteIds.length > 20 || minuteIds.some((id) => !Number.isInteger(Number(id)))) throw new AppError('Pilih 1–20 recap untuk diringkas', 400);
  const brand = await requireBrand(brandId);
  const all = await library.listMinutes(brandId);
  const wanted = new Set(minuteIds.map(Number));
  const chosen = all.filter((minute) => wanted.has(minute.id));
  if (chosen.length !== wanted.size) throw new AppError('Salah satu recap tidak ditemukan pada brand ini', 404);
  const typeLabel = { regular: 'Meeting reguler', non_regular: 'Meeting non reguler', whatsapp_quick_call: 'WhatsApp (quick call)' };
  const source = chosen.map((m) => `Tanggal: ${m.meeting_date}\nJenis: ${typeLabel[m.meeting_type] ?? m.meeting_type}\nRecap: ${m.meeting_recap || '—'}\nTugas Client: ${m.todo_client || '—'}\nTugas MIL: ${m.todo_mil || '—'}`).join('\n\n---\n\n');
  const prompt = `Ringkas beberapa minutes of meeting untuk brand ${brand.brand_name}. Gunakan Bahasa Indonesia profesional. Jangan mengarang fakta. Diagnosis harus menjadi executive summary lintas meeting; objective_alignment menjelaskan keputusan/kesepakatan; winning berisi poin utama; challenge berisi isu terbuka; strategic_direction berisi langkah berikutnya; action_items berisi tindak lanjut spesifik; risks dan data_gaps hanya jika relevan.\n\nSUMBER:\n${source}`;
  try {
    res.json({ summary: await ai.callGemini(prompt), model: ai.MODEL, brand_name: brand.brand_name });
  } catch (err) {
    if (err instanceof ai.AiSummaryError) throw new AppError(err.message, err.statusCode);
    throw err;
  }
});

export const listLibrary = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);
  res.json({ files: await library.listLibrary(brandId), channels: library.LIBRARY_CHANNELS });
});

export const uploadLibraryFile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  await requireBrand(brandId);

  const { platform, channel } = req.body;
  const reject = (message) => {
    console.warn('[brand-library] upload ditolak', { brandId, platform, channel, month: req.body.month, message });
    return new AppError(message, 400);
  };
  if (!library.isValidScope(platform, channel)) {
    throw reject(`Kombinasi platform "${platform}" dan channel "${channel}" tidak dikenal`);
  }
  if (library.isAutoOnly(platform, channel)) {
    throw reject('Slot ini terisi otomatis dari Google Ads Script setiap bulan dan tidak menerima unggahan');
  }

  // multer .array: one slot can receive several files at once, which is how
  // a split export ("part 1 of 2") is filed in a single action.
  const files = req.files ?? [];
  if (!files.length) throw reject('File wajib diunggah');

  const month = typeof req.body.month === 'string' && /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : null;
  const replaceFileId = req.body.replaceFileId == null || req.body.replaceFileId === '' ? null : Number(req.body.replaceFileId);
  const isReference = library.REFERENCE_CHANNELS.has(channel);
  if (!isReference && !month) throw reject('Bulan periode wajib dipilih untuk dataset ini');
  if (isReference && files.length > 1) throw reject('Dataset referensi hanya menerima satu file');
  if (replaceFileId != null && (!Number.isInteger(replaceFileId) || replaceFileId <= 0)) throw reject('File yang akan diganti tidak valid');
  if (replaceFileId != null && files.length !== 1) throw reject('Penggantian file hanya menerima satu file baru');
  for (const file of files) {
    const mismatch = library.shopeeChannelMismatch(platform, channel, file.originalname);
    if (mismatch) throw reject(mismatch);
  }

  // A Meta Ads export lands in Boost Post and Non Boost Post at once.
  if (platform === 'meta' && channel === 'meta') {
    if (!month) throw reject('Bulan periode wajib dipilih untuk dataset ini');
    res.status(201).json(await storeSplitMetaExport({ req, brandId, month, files }));
    return;
  }

  const saved = [];
  const warnings = [];
  let imported = null;

  for (const file of files) {
    const result = await storeOnePart({ req, brandId, platform, channel, month, isReference, file, replaceFileId });
    saved.push(result.file);
    if (result.warning) warnings.push(result.warning);
    if (result.imported) {
      imported = imported ?? { rowsInserted: 0, files: 0, errors: [] };
      if (result.imported.error) imported.errors.push(`${file.originalname}: ${result.imported.error}`);
      else {
        imported.rowsInserted += result.imported.rowsInserted;
        imported.files += 1;
      }
    }
  }

  res.status(201).json({ files: saved, file: saved[0], warning: warnings[0] ?? null, warnings, imported });
});

// The upload replaces the month's Meta Ads files outright — Boost Post, Non
// Boost Post, and the combined file of before the split, whether uploaded or
// auto-fetched: the new export is the whole month, so anything left beside it
// would count the month twice.
async function storeSplitMetaExport({ req, brandId, month, files }) {
  const halves = splitMetaExport(files);
  if (!halves.some((h) => h.rowCount)) throw new AppError('File tidak berisi baris campaign', 400);

  for (const ch of ['boost', 'nonboost', 'meta']) {
    for (const part of await library.listSlotParts(brandId, 'meta', ch, `${month}-01`)) {
      await library.deleteLibraryFile(brandId, part.id);
    }
  }

  const saved = [];
  const warnings = [];
  for (const half of halves) {
    if (!half.file) {
      warnings.push(`Tidak ada campaign ${half.label} di file ini.`);
      continue;
    }
    const result = await storeOnePart({
      req, brandId, platform: 'meta', channel: half.channel, month, isReference: false, file: half.file, replaceFileId: null,
    });
    saved.push(result.file);
    if (result.warning) warnings.push(result.warning);
  }
  return {
    files: saved, file: saved[0], warning: warnings[0] ?? null, warnings, imported: null,
    split: Object.fromEntries(halves.map((h) => [h.channel, h.rowCount])),
  };
}

// One part: read it, file it under the right part number, and — for the three
// Dashboard datasets — parse it into the fact tables Brand Overview reads.
async function storeOnePart({ req, brandId, platform, channel, month, isReference, file, replaceFileId }) {
  let summary = { periodMonth: null, periodStart: null, periodEnd: null, coveredDays: 0, dayBitmap: null };
  let rowCount = null;
  let periodSource = null;
  let warning = null;

  if (!isReference) {
    // Reading the file is a bonus, never a gate. The library's job is to HOLD
    // the file for the month the user chose; coverage is derived from it when
    // it can be, and the month shows as a snapshot when it cannot.
    try {
      const analysis = library.analyseFile({ buffer: file.buffer, filename: file.originalname, month });
      summary = analysis;
      rowCount = analysis.rowCount;
      periodSource = analysis.source;

      // File yang periodenya jelas-jelas di luar bulan pilihan diberi tanda
      // permanen, bukan hanya peringatan sekali lewat. Tanpa itu keadaannya
      // hanya tampil sebagai "snapshot" — sama seperti file yang tanggalnya
      // memang tidak terbaca — dan pengguna tidak punya cara tahu bahwa
      // sebenarnya filenya salah slot bulan.
      if (analysis.declaredRange && !analysis.coveredDays) periodSource = 'mismatch';

      if (analysis.declaredRange && !analysis.coveredDays) {
        warning = `${file.originalname}: file menyatakan periode ${analysis.declaredRange.start} – ${analysis.declaredRange.end}, di luar bulan yang dipilih. Tersimpan sebagai snapshot — periksa apakah slot bulannya sudah benar.`;
      } else if (!analysis.coveredDays) {
        warning = `${file.originalname}: tanggal tidak terbaca dari isi file — disimpan sebagai snapshot bulanan.`;
      }
    } catch (err) {
      summary = library.summarisePeriod([], month);
      warning = `${file.originalname}: isinya tidak dapat dibaca sebagai spreadsheet, jadi periodenya mengikuti bulan yang dipilih.`;
      console.warn('[brand-library] parse failed', { brandId, platform, channel, month, file: file.originalname, reason: err.message });
    }
  }

  const parts = await library.listSlotParts(brandId, platform, channel, summary.periodMonth ?? null);
  const sameName = parts.some((part) => part.original_filename === file.originalname);
  const explicitlySplit = /(?:^|[\s_.-])part[\s_.-]*\d+(?:[\s_.-]*(?:of|dari)[\s_.-]*\d+)?/i.test(file.originalname);
  if (replaceFileId == null && !sameName && !explicitlySplit && library.hasCoverageOverlap(parts, summary.dayBitmap)) {
    throw new AppError('Tanggal file bertumpang tindih dengan file yang sudah ada. Gunakan Ganti untuk file pembaruan, atau unggah file dengan penanda part jika ekspornya memang terpecah.', 409);
  }
  const placement = library.placePart(parts, file.originalname, replaceFileId);
  if (!placement) throw new AppError('File yang akan diganti tidak ditemukan pada brand, dataset, dan bulan ini', 400);
  const { partIndex, previousUploadId } = placement;

  const saved = await library.upsertLibraryFile({
    brandId,
    platform,
    channel,
    periodMonth: summary.periodMonth,
    periodStart: summary.periodStart,
    periodEnd: summary.periodEnd,
    coveredDays: summary.coveredDays,
    dayBitmap: summary.dayBitmap,
    rowCount,
    periodSource,
    partIndex,
    filename: file.originalname,
    buffer: file.buffer,
    userId: req.user?.userId,
  });

  // Storing the bytes is the whole job for Report Generator channels. For the
  // three the Dashboard is built on it is only half: Brand Overview reads
  // shopee.* fact tables, so the file has to go through the same importer the
  // old Upload Data tab used. Parts merge safely there — every loader
  // de-duplicates on a natural key — so part 2 continues part 1 rather than
  // doubling the days they share.
  let imported = null;
  const fileType = library.DASHBOARD_FILE_TYPES[channel];
  if (fileType) {
    if (previousUploadId) {
      try {
        await uploadService.deleteUpload(previousUploadId);
      } catch (err) {
        console.warn('[brand-library] gagal menghapus import lama', { previousUploadId, reason: err.message });
      }
    }

    const uploadId = uuidv4();
    try {
      await uploadService.createUploadRecord({
        uploadId,
        userId: req.user?.userId,
        brandId,
        fileType,
        filename: file.originalname,
        // The library row holds these bytes; no second copy (monthlyShopStats
        // reads them through dashboard_upload_id).
        rawFile: null,
      });
      const result = await processUpload({
        uploadId, fileType, filepath: file.buffer, brandId, filename: file.originalname, month,
      });
      await library.setDashboardUpload(saved.id, uploadId);
      await library.setImportResult(saved.id, { status: 'success', rows: result.rowsInserted, uploadId });
      Object.assign(saved, { import_status: 'success', import_error: null, import_rows: result.rowsInserted, dashboard_upload_id: uploadId });
      imported = { rowsInserted: result.rowsInserted };

      // The imported rows outrank whatever the filename claimed: a name is
      // the range that was requested, the rows are what arrived.
      const synced = await library.syncCoverageFromImport(saved.id, result.period, month);
      if (synced) {
        Object.assign(saved, {
          period_start: synced.periodStart,
          period_end: synced.periodEnd,
          covered_days: synced.coveredDays,
          day_bitmap: synced.dayBitmap,
          period_source: synced.source,
        });
      }
    } catch (err) {
      // Filenya tetap tersimpan — byte-nya berguna untuk impor ulang — tapi
      // barisnya ditandai gagal supaya UI tidak menampilkan "Lengkap" untuk
      // periode yang tabel faktanya kosong.
      await library.setImportResult(saved.id, { status: 'failed', error: err.message });
      Object.assign(saved, { import_status: 'failed', import_error: err.message, import_rows: null, dashboard_upload_id: null });
      imported = { error: err.message };
      console.warn('[brand-library] import ke dashboard gagal', { brandId, channel, month, file: file.originalname, reason: err.message });
    }
  } else {
    await library.setImportResult(saved.id, { status: 'not_applicable' });
    Object.assign(saved, { import_status: 'not_applicable' });
  }

  return { file: saved, warning, imported };
}

// Impor ulang satu file yang sudah ada di perpustakaan. Dipakai saat impor
// pertamanya gagal (paling sering: function serverless kehabisan waktu), dan
// menghindari kewajiban mengunggah ulang file yang byte-nya sudah tersimpan.
export const reimportLibraryFile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId)) throw new AppError('fileId tidak valid', 400);

  const file = await library.getFileForImport(brandId, fileId);
  if (!file) throw new AppError('File tidak ditemukan', 404);

  const fileType = library.DASHBOARD_FILE_TYPES[file.channel];
  if (!fileType) throw new AppError('Dataset ini tidak dibaca Dashboard, jadi tidak perlu diimpor', 400);
  if (!file.raw_file) throw new AppError('Byte file tidak tersimpan, unggah ulang filenya', 400);

  // Impor sebelumnya (kalau ada) dihapus dulu supaya tabel fakta tidak
  // menggandakan periode yang sama.
  if (file.dashboard_upload_id) {
    try {
      await uploadService.deleteUpload(file.dashboard_upload_id);
    } catch (err) {
      console.warn('[brand-library] gagal menghapus import lama', { id: file.dashboard_upload_id, reason: err.message });
    }
  }

  const uploadId = uuidv4();
  try {
    await uploadService.createUploadRecord({
      uploadId,
      userId: req.user?.userId ?? file.uploaded_by,
      brandId,
      fileType,
      filename: file.original_filename,
      rawFile: null, // already in the library row
    });
    const result = await processUpload({
      uploadId, fileType, filepath: file.raw_file, brandId,
      filename: file.original_filename, month: file.period_month?.slice(0, 7) ?? null,
    });
    await library.setDashboardUpload(fileId, uploadId);
    await library.setImportResult(fileId, { status: 'success', rows: result.rowsInserted, uploadId });
    const synced = await library.syncCoverageFromImport(fileId, result.period, file.period_month?.slice(0, 7));
    res.json({ imported: { rowsInserted: result.rowsInserted, period: result.period, coverage: synced } });
  } catch (err) {
    await library.setImportResult(fileId, { status: 'failed', error: err.message });
    console.warn('[brand-library] impor ulang gagal', { brandId, fileId, reason: err.message });
    throw new AppError(`Impor ulang gagal: ${err.message}`, 422);
  }
});

export const deleteLibraryFile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId)) throw new AppError('fileId tidak valid', 400);
  const deleted = await library.deleteLibraryFile(brandId, fileId);
  if (!deleted) throw new AppError('File tidak ditemukan', 404);
  // Whatever this file put into the dashboard's fact tables goes with it,
  // otherwise removing a file from the library silently leaves its numbers
  // behind on the dashboard.
  if (deleted.dashboard_upload_id) {
    try {
      await uploadService.deleteUpload(deleted.dashboard_upload_id);
    } catch (err) {
      console.warn('[brand-library] gagal menghapus import terkait', { uploadId: deleted.dashboard_upload_id, reason: err.message });
    }
  }
  res.json({ deleted: true });
});

export const downloadLibraryFile = asyncHandler(async (req, res) => {
  const brandId = parseBrandId(req);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId)) throw new AppError('fileId tidak valid', 400);
  // Brand Overview's Meta tabs fetch the month's files on every open. The
  // ETag (a replaced file gets a new object key and updated_at) lets the
  // browser keep its copy: an unchanged file is answered 304 without the
  // bytes being read from storage at all.
  const head = await library.getLibraryFileHead(brandId, fileId);
  if (!head?.has_bytes) throw new AppError('File tidak ditemukan di server', 404);
  const etag = `"lib-${fileId}-${new Date(head.updated_at).getTime()}-${(head.storage_key ?? 'db').slice(-12)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const file = await library.getLibraryFileBytes(brandId, fileId);
  if (!file?.raw_file) throw new AppError('File tidak ditemukan di server', 404);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_filename)}"`);
  res.send(file.raw_file);
});
