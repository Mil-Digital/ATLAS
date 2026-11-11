import { buildBulkInsert } from '../../utils/sqlHelpers.js';

// Satu statement untuk beberapa ratus baris, bukan satu statement per baris.
//
// Importer ini berjalan dari serverless function ke Postgres di region lain:
// biayanya bukan kerja database, tapi latensi bolak-balik, dan itu dibayar
// sekali per statement. Satu file Product Performance dengan ~340 produk
// menghabiskan lebih dari seribu perjalanan bolak-balik dan menabrak batas
// 60 detik milik Vercel — 504, dengan file yang bahkan tidak besar.
//
// Postgres membatasi satu statement pada 65535 parameter; ukuran chunk di
// pemanggil selalu dijaga jauh di bawah itu.
export async function insertChunked(client, table, columns, rows, conflictSql, chunkSize) {
  let affected = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const statement = buildBulkInsert(table, columns, rows.slice(i, i + chunkSize));
    if (!statement) continue;
    const result = await client.query(`${statement.text} ${conflictSql}`, statement.values);
    affected += result.rowCount;
  }
  return affected;
}

// "ON CONFLICT (keys) DO UPDATE SET <every other column> = EXCLUDED.…".
//
// For the per-day / per-period fact tables the newest import of a key must
// win and take ownership (upload_id). With DO NOTHING, rows written by an
// import that committed but never got linked to its library file — the
// request died on Vercel's time limit after COMMIT — stayed owned by an
// upload nobody can delete; every "Impor ulang" then collided on all of them,
// inserted 0 rows and reported success, and the month never recovered.
export function upsertSql(columns, keys, returning = 'id') {
  const sets = columns
    .filter((c) => !keys.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  return `ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${sets} RETURNING ${returning}`;
}

// Same as dedupeBy, keyed on several columns (by index).
export function dedupeByKeys(rows, keyIndexes) {
  const seen = new Map();
  for (const row of rows) seen.set(keyIndexes.map((i) => String(row[i])).join('\u0000'), row);
  return [...seen.values()];
}

// ON CONFLICT DO UPDATE menolak menyentuh baris yang sama dua kali dalam satu
// statement ("cannot affect row a second time"), sedangkan satu file ekspor
// wajar memuat kunci yang sama lebih dari sekali (produk dengan beberapa
// varian mengulang baris induknya). Ambil yang terakhir, seperti perilaku
// loop per-baris sebelumnya.
export function dedupeBy(rows, keyIndex) {
  const seen = new Map();
  for (const row of rows) seen.set(row[keyIndex], row);
  return [...seen.values()];
}
