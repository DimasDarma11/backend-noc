-- FTTH Topology Schema
-- Required: PostgreSQL with PostGIS extension

CREATE EXTENSION IF NOT EXISTS postgis;

-- Nodes Table (OLT, ODC, ODP, Splitter, Pole, ONT)
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'OLT', 'ODC', 'ODP', 'SPLITTER', 'POLE', 'ONT'
    location GEOMETRY(Point, 4326),
    parent_id VARCHAR(255) REFERENCES nodes(id) ON DELETE SET NULL,
    signal_status VARCHAR(50) DEFAULT 'unknown', -- 'online', 'critical', 'warning', 'unknown'
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Cables Table (Path between nodes)
CREATE TABLE IF NOT EXISTS cables (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    source_id VARCHAR(255) REFERENCES nodes(id) ON DELETE CASCADE,
    destination_id VARCHAR(255) REFERENCES nodes(id) ON DELETE CASCADE,
    path GEOMETRY(LineString, 4326),
    cores INTEGER DEFAULT 1,
    fiber_type VARCHAR(100), -- 'G.652D', 'G.657A1', etc.
    capacity_used INTEGER DEFAULT 0,
    length_meters FLOAT,
    estimated_loss_db FLOAT,
    status VARCHAR(50) DEFAULT 'normal', -- 'normal', 'warning', 'broken'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_nodes_location ON nodes USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_cables_path ON cables USING GIST(path);
CREATE INDEX IF NOT EXISTS idx_cables_relation ON cables(source_id, destination_id);

-- Function to update timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_nodes_updated_at BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_cables_updated_at BEFORE UPDATE ON cables FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
