const { Pool } = require('pg');
const format = require('pg-format');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
             cores, fiber_type, capacity_used, length_meters, estimated_loss_db, status, metadata
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
    const { name, source_id, destination_id, path, cores, fiber_type, length_meters, estimated_loss_db, status } = cable;
    // path is expected to be an array of [lat, lng]
    const lineString = `LINESTRING(${path.map(p => `${p[1]} ${p[0]}`).join(', ')})`;
    const query = `
      INSERT INTO cables (name, source_id, destination_id, path, cores, fiber_type, length_meters, estimated_loss_db, status)
      VALUES ($1, $2, $3, ST_GeomFromText($4, 4326), $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const res = await pool.query(query, [name, source_id, destination_id, lineString, cores, fiber_type, length_meters, estimated_loss_db, status]);
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
  }
};

module.exports = topologyService;
