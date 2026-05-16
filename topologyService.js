const { Pool } = require('pg');
const format = require('pg-format');
require('dotenv').config();

const dbConfig = {
  connectionString: process.env.DATABASE_URL,
};

if (process.env.DB_SSL === 'true') {
  dbConfig.ssl = { rejectUnauthorized: false };
} else {
  dbConfig.ssl = false;
}

console.log(`[DB] Connecting to ${process.env.DATABASE_URL?.split('@')[1] || 'database'} (SSL: ${dbConfig.ssl ? 'YES' : 'NO'})`);

const pool = new Pool(dbConfig);

const topologyService = {
  // ─── Core Queries ──────────────────────────────────────────────────────────
  
  async getNodes() {
    const res = await pool.query(`
      SELECT id, name, type, ST_AsGeoJSON(location)::json as location, 
             parent_id, signal_status, last_seen, metadata
      FROM nodes
    `);
    return res.rows;
  },

  async getCables() {
    const res = await pool.query(`
      SELECT id, name, source_id, destination_id, ST_AsGeoJSON(path)::json as path,
             cores, fiber_type, length_meters, estimated_loss_db, status, metadata
      FROM cables
    `);
    return res.rows;
  },

  async upsertNode(node) {
    const { id, name, type, lat, lng, parent_id, signal_status, metadata } = node;
    const query = `
      INSERT INTO nodes (id, name, type, location, parent_id, signal_status, metadata)
      VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326), $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        location = EXCLUDED.location,
        parent_id = EXCLUDED.parent_id,
        signal_status = EXCLUDED.signal_status,
        metadata = nodes.metadata || EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const res = await pool.query(query, [id, name, type, lat, lng, parent_id, signal_status, JSON.stringify(metadata || {})]);
    return res.rows[0];
  },

  async upsertCable(cable) {
    const { segment_id, name, type, source_id, destination_id, path, cores, fiber_type, length_meters, estimated_loss_db, status, metadata } = cable;
    // path is expected to be an array of [lat, lng]
    const lineString = `LINESTRING(${path.map(p => `${p[1]} ${p[0]}`).join(', ')})`;
    const query = `
      INSERT INTO cables (segment_id, name, type, source_id, destination_id, path, cores, fiber_type, length_meters, estimated_loss_db, status, metadata)
      VALUES ($1, $2, $3, $4, $5, ST_GeomFromText($6, 4326), $7, $8, $9, $10, $11, $12)
      ON CONFLICT (segment_id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        source_id = EXCLUDED.source_id,
        destination_id = EXCLUDED.destination_id,
        path = EXCLUDED.path,
        cores = EXCLUDED.cores,
        fiber_type = EXCLUDED.fiber_type,
        length_meters = EXCLUDED.length_meters,
        estimated_loss_db = EXCLUDED.estimated_loss_db,
        status = EXCLUDED.status,
        metadata = cables.metadata || EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const res = await pool.query(query, [
      segment_id || `seg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, 
      name, type || 'DISTRIBUTION', source_id, destination_id, lineString, 
      cores || 1, fiber_type, length_meters, estimated_loss_db, status || 'active', 
      JSON.stringify(metadata || {})
    ]);
    return res.rows[0];
  },

  // ─── Topology Logic ────────────────────────────────────────────────────────

  async tracePath(nodeId) {
    // Recursive query to trace path back to OLT
    const query = `
      WITH RECURSIVE path_trace AS (
        -- Base case: the starting node
        SELECT id, name, type, parent_id, 1 as depth
        FROM nodes
        WHERE id = $1
        
        UNION ALL
        
        -- Recursive step: find parent
        SELECT n.id, n.name, n.type, n.parent_id, pt.depth + 1
        FROM nodes n
        JOIN path_trace pt ON n.id = pt.parent_id
      )
      SELECT * FROM path_trace ORDER BY depth DESC;
    `;
    const res = await pool.query(query, [nodeId]);
    return res.rows;
  },

  async getImpactedNodes(failedNodeId) {
    // Find all nodes downstream from a failed node
    const query = `
      WITH RECURSIVE downstream AS (
        SELECT id, name, type, parent_id
        FROM nodes
        WHERE id = $1
        
        UNION ALL
        
        SELECT n.id, n.name, n.type, n.parent_id
        FROM nodes n
        JOIN downstream d ON n.parent_id = d.id
      )
      SELECT * FROM downstream;
    `;
    const res = await pool.query(query, [failedNodeId]);
    return res.rows;
  },

  async addAuditLog(log) {
    const { user_id, action, target_id, severity, message, result, metadata } = log;
    const query = `
      INSERT INTO audit_logs (user_id, action, target_id, severity, message, result, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const res = await pool.query(query, [user_id, action, target_id, severity, message, result, JSON.stringify(metadata || {})]);
    return res.rows[0];
  },

  async getAuditLogs(limit = 500) {
    const res = await pool.query(`
      SELECT id, timestamp, severity, message, user_id as user, action, result, metadata
      FROM audit_logs
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);
    return res.rows;
  },

  async clearAuditLogs() {
    await pool.query('DELETE FROM audit_logs');
  }
};

module.exports = topologyService;
