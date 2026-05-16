require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/noc_pro_db',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function fixNames() {
  try {
    const res = await pool.query(`
      UPDATE nodes 
      SET name = 'KML Node ' || substring(id from 5) 
      WHERE name LIKE '%°%' OR name LIKE '%"%' OR name LIKE '%''%';
    `);
    console.log(`Berhasil mengubah nama ${res.rowCount} titik yang namanya berupa angka derajat.`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}
fixNames();
