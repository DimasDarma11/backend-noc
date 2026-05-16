const fs = require('fs');
const path = require('path');
const topologyService = require('./topologyService');

const DATA_DIR = path.join(__dirname, 'data');
const COORDS_FILE = path.join(DATA_DIR, 'coordinates.json');
const INFRA_FILE = path.join(DATA_DIR, 'infrastructure.json');

async function migrate() {
  console.log('🚀 Starting migration...');

  try {
    // 1. Migrate Coordinates (mostly ONTs)
    if (fs.existsSync(COORDS_FILE)) {
      const coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
      for (const [id, [lat, lng]] of Object.entries(coords)) {
        console.log(`Migrating node: ${id}`);
        await topologyService.upsertNode({
          id,
          name: id,
          type: id.includes('F6') || id.includes('HG') ? 'ONT' : 'ODP',
          lat,
          lng,
          signal_status: 'unknown',
          metadata: { migrated: true }
        });
      }
    }

    // 2. Migrate Infrastructure (ODPs, ODCs, etc.)
    if (fs.existsSync(INFRA_FILE)) {
      const infra = JSON.parse(fs.readFileSync(INFRA_FILE, 'utf8'));
      for (const item of infra) {
        console.log(`Migrating infrastructure: ${item.name || item.id}`);
        await topologyService.upsertNode({
          id: item.id,
          name: item.name || item.id,
          type: item.type || 'ODP',
          lat: item.coordinates?.[0] || 0,
          lng: item.coordinates?.[1] || 0,
          parent_id: item.parentId || null,
          metadata: item
        });
        
        // If it's a cable/line, migrate to cables table
        if (item.type === 'LINE' && item.path) {
           await topologyService.upsertCable({
             name: item.name,
             source_id: item.sourceId,
             destination_id: item.destId,
             path: item.path,
             status: 'normal'
           });
        }
      }
    }

    console.log('✅ Migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    process.exit();
  }
}

migrate();
