require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/noc_pro_db',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function deduplicateNodes() {
  try {
    console.log('Menghapus data duplikat berdasarkan koordinat lokasi yang sama...');
    const res = await pool.query(`
      DELETE FROM nodes
      WHERE id IN (
          SELECT id
          FROM (
              SELECT id,
              ROW_NUMBER() OVER(PARTITION BY location ORDER BY created_at ASC) as row_num
              FROM nodes
          ) t
          WHERE t.row_num > 1
      );
    `);
    console.log(`Pembersihan Selesai! Berhasil menghapus ${res.rowCount} titik duplikat.`);
  } catch (err) {
    console.error('Error saat deduplikasi:', err.message);
  } finally {
    await pool.end();
  }
}

deduplicateNodes();
