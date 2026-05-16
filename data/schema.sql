-- Enable PostGIS extension if not already enabled
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. NODES TABLE (Points: OLT, ODC, ODP, Poles, Customer Points)
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- OLT, ODC, ODP, POLE, CUSTOMER, ONT
    location GEOMETRY(Point, 4326) NOT NULL,
    parent_id VARCHAR(255) REFERENCES nodes(id) ON DELETE SET NULL,
    signal_status VARCHAR(50) DEFAULT 'unknown',
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_location ON nodes USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

-- 2. CABLES TABLE (LineStrings)
CREATE TABLE IF NOT EXISTS cables (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    segment_id VARCHAR(255) UNIQUE, -- For standard topology reference
    type VARCHAR(50) DEFAULT 'DISTRIBUTION', -- BACKBONE, FEEDER, DISTRIBUTION, DROP
    source_id VARCHAR(255) REFERENCES nodes(id) ON DELETE SET NULL,
    destination_id VARCHAR(255) REFERENCES nodes(id) ON DELETE SET NULL,
    path GEOMETRY(LineString, 4326) NOT NULL,
    cores INTEGER DEFAULT 1,
    fiber_type VARCHAR(50),
    length_meters FLOAT,
    estimated_loss_db FLOAT,
    status VARCHAR(50) DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cables_path ON cables USING GIST(path);
CREATE INDEX IF NOT EXISTS idx_cables_segment ON cables(segment_id);

-- 3. AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL, -- REBOOT, CONFIG_CHANGE, DELETE, CREATE
    target_id VARCHAR(255),
    severity VARCHAR(50) DEFAULT 'info',
    message TEXT,
    result VARCHAR(50), -- SUCCESS, FAILED
    metadata JSONB DEFAULT '{}',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_nodes_updated_at BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_cables_updated_at BEFORE UPDATE ON cables FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
