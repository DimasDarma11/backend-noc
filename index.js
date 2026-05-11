const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { exec } = require('child_process');
const oltService = require('./oltService');
const mikrotikService = require('./mikrotikService');
const multer = require('multer');
const { XMLParser } = require('fast-xml-parser');
const AdmZip = require('adm-zip');
require('dotenv').config();

// Multer: simpan file upload di memory (tidak perlu ke disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
  allowEIO3: true
});

const PORT = process.env.PORT || 3001;

let globalVpnLog = '[SYSTEM] Terminal Active. Listening for real-time events...\n';
let oltPushStatus = {}; // Global store untuk data dari Mikrotik

// ─── Persistence Directory Setup ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// --- MIDDLEWARE & SECURITY ---
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Set-Cookie']
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

function addVpnLog(msg) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}`;
  globalVpnLog = `${entry}\n${globalVpnLog}`.substring(0, 5000);
  try {
    // Gunakan inisialisasi yang sudah pasti aman
    if (typeof io !== 'undefined' && io) io.emit('vpnLogUpdate', globalVpnLog);
  } catch (e) {}
  
  try {
    const config = loadConfig();
    if (!config.vpn) config.vpn = {};
    config.vpn.log = globalVpnLog;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[VPN_LOG] ${msg}`);
  } catch (err) {
    console.error(`[DISK_ERROR] ${err.message}`);
  }
}

app.get('/api/system/status', async (req, res) => {
  let config = { vpn: {}, mikrotiks: [] };
  try { config = loadConfig(); } catch (e) {}
  
  // 1. ACS Check
  let acsStatus = 'offline';
  if (config.url) {
    try {
      const testUrl = config.url.endsWith('/') ? config.url : `${config.url}/`;
      const acsRes = await axios.get(testUrl, { timeout: 3000 }).catch(() => null);
      if (acsRes && (acsRes.status === 200 || acsRes.status === 401)) acsStatus = 'online';
    } catch (e) {}
  }

  // 2. OLT Status
  let oltStatus = 'offline';
  const oltKeys = Object.keys(oltPushStatus);
  if (oltKeys.length > 0) {
    oltStatus = oltKeys.some(ip => oltPushStatus[ip].status === 'online') ? 'online' : 'offline';
  }

  // 3. Mikrotik Status
  const mikrotikStatus = config.mikrotiks?.length > 0 ? 'online' : 'offline';

  // 4. VPN Status
  const vpnStatus = config.vpn?.status || (config.vpn?.enabled ? 'dialing' : 'offline');

  res.json({
    acsStatus,
    oltStatus,
    vpnStatus,
    mikrotikStatus,
    oltDetail: oltPushStatus || {}, 
    vpnLog: globalVpnLog || ''
  });
});

app.post('/api/vpn/start', async (req, res) => {
  console.log('🔥🔥 VPN START TRIGGERED 🔥🔥');
  const config = loadConfig();
  // Auto-VPN disabled to prevent spamming Mikrotik logs
  //  // DISABLED: vpnService.start(config.vpn);
  if (!config.vpn?.enabled) return res.status(400).json({ message: 'VPN Disabled' });
  
  // 1. Emit Status Instan (Anti-Delay)
  config.vpn.status = 'dialing';
  if (io) io.emit('vpnStatus', 'dialing');
  
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  addVpnLog(`[DIAL] Memulai proses tunneling ke ${config.vpn.server}...`);
  
  console.log('[VPN] Status set to dialing, log added');
  
  // Kirim response
  res.json({ success: true, status: 'dialing' });

  // Proses Background
  (async () => {
    try {
      const vpnType = config.vpn.type || 'l2tp';
      const isRailway = process.env.RAILWAY_ENVIRONMENT;
      
      addVpnLog(`[DIAL] Menyiapkan konfigurasi tunneling ${vpnType.toUpperCase()}...`);
    
      if (vpnType === 'wireguard' && !isRailway) {
        // --- REAL WIREGUARD EXECUTION (VPS ONLY) ---
        const wgConfig = `[Interface]
PrivateKey = ${config.vpn.privateKey}
Address = ${config.vpn.address}
DNS = 1.1.1.1

[Peer]
PublicKey = ${config.vpn.peerPublicKey}
Endpoint = ${config.vpn.endpoint}
AllowedIPs = ${config.vpn.allowedIPs}
PersistentKeepalive = 25
`;
        
        const confPath = '/etc/wireguard/wg0.conf';
        addVpnLog(`[SYSTEM] Menulis konfigurasi ke ${confPath}...`);
        
        // Memerlukan akses sudo/root
        exec(`echo "${wgConfig}" | sudo tee ${confPath} && sudo wg-quick down wg0; sudo wg-quick up wg0`, (error, stdout, stderr) => {
          if (error) {
            addVpnLog(`[ERROR] Gagal menjalankan WireGuard: ${error.message}`);
            config.vpn.status = 'disconnected';
          } else {
            addVpnLog(`[SUCCESS] WireGuard Berhasil Terhubung!`);
            addVpnLog(`[INFO] OLT sekarang dapat dijangkau via jalur VPN.`);
            config.vpn.status = 'connected';
          }
          saveConfig(config);
        });
      } else if (isRailway) {
        // --- SIMULATION MODE (RAILWAY/VERCEL) ---
        setTimeout(() => {
          addVpnLog(`[ERROR] Terdeteksi environment restricted (Railway/Vercel).`);
          addVpnLog(`[INFO] Gunakan VPS (Ubuntu/Debian) untuk menjalankan WireGuard secara nyata.`);
          config.vpn.status = 'disconnected';
          saveConfig(config);
        }, 2000);
      } else {
        // L2TP Simulation for now
        setTimeout(() => {
          addVpnLog(`[INFO] Tunnel L2TP Terbentuk (Simulation Mode)`);
          config.vpn.status = 'connected';
          saveConfig(config);
        }, 2000);
      }

    } catch (err) {
      addVpnLog(`[CRITICAL] Gagal menjalankan service VPN: ${err.message}`);
      config.vpn.status = 'disconnected';
      saveConfig(config);
    }
  })();
});

app.post('/api/vpn/stop', async (req, res) => {
  const config = loadConfig();
  config.vpn.status = 'disconnected';
  saveConfig(config);
  addVpnLog('Memutuskan koneksi VPN... Terowongan ditutup.');
  res.json({ success: true });
});

app.post('/api/vpn/clear-log', (req, res) => {
  const config = loadConfig();
  globalVpnLog = '[SYSTEM] Terminal Cleared.\n';
  if (config.vpn) {
    config.vpn.log = '';
    saveConfig(config);
  }
  res.json({ success: true });
});

// ─── OLT PUSH STATUS (Penerima data dari Mikrotik) ──────────────────────────

const OLT_PUSH_FILE = path.join(DATA_DIR, 'olt-push.json');
if (fs.existsSync(OLT_PUSH_FILE)) {
  try {
    oltPushStatus = JSON.parse(fs.readFileSync(OLT_PUSH_FILE, 'utf8'));
  } catch (e) {
    oltPushStatus = {};
  }
}

app.get('/api/olt/update-status', (req, res) => {
  const { ip, status } = req.query;
  if (!ip || !status) {
    console.error(`[PUSH ERROR] Missing data from Mikrotik. Query: ${JSON.stringify(req.query)}`);
    return res.status(400).send('Missing IP or Status');
  }
  
  const normalizedStatus = status.toLowerCase();
  oltPushStatus[ip] = { status: normalizedStatus, lastUpdate: new Date().toISOString() };
  
  // Catat ke Terminal Log
  addVpnLog(`[PUSH] Data received from Mikrotik: OLT ${ip} is ${normalizedStatus.toUpperCase()}`);
  
  // Simpan ke file agar permanen
  fs.writeFileSync(OLT_PUSH_FILE, JSON.stringify(oltPushStatus, null, 2));
  
  console.log(`[PUSH SUCCESS] OLT ${ip} is now ${normalizedStatus.toUpperCase()} (Saved to disk)`);
  res.send('OK');
});
// Secret dari Environment Variable — WAJIB diset di Railway Dashboard
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  // Fallback hanya untuk development lokal — di Railway harus pakai env var!
  console.warn('[Security] SESSION_SECRET tidak diset! Gunakan env var di Railway Dashboard.');
  return 'dev-fallback-secret-change-in-production-' + Math.random().toString(36);
})();

// Simpan session ke file (bukan RAM) — aman untuk single-instance Railway
const sessionDir = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

app.use(session({
  store: new FileStore({
    path: sessionDir,
    ttl: 86400,          // Session expired setelah 24 jam
    retries: 1,
    reapInterval: 3600,  // Bersihkan session expired setiap 1 jam
    logFn: () => {},     // Silent — jangan flooding console
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // Required for Railway/Heroku
  cookie: {
    secure: true,   // HTTPS only
    sameSite: 'none',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));


// Middleware moved to top

// Persistence directory already initialized at top

const CONFIG_FILE = path.join(DATA_DIR, 'acs-config.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const COORDS_FILE = path.join(DATA_DIR, 'coordinates.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit-logs.json');
const HISTORY_FILE = path.join(DATA_DIR, 'signal-history.json');
const INFRA_FILE = path.join(DATA_DIR, 'infrastructure.json');

// Initialize Auth
if (!fs.existsSync(AUTH_FILE)) {
  const salt = bcrypt.genSaltSync(10);
  const hashedPassword = bcrypt.hashSync('admin123', salt);
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ username: 'admin', password: hashedPassword }, null, 2));
  console.log('\n--- SECURITY INITIALIZED ---');
  console.log('Username: admin');
  console.log('Password: admin123');
  console.log('Please change this on first login.');
  console.log('----------------------------\n');
}

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
};

// ─── Auth Endpoints ─────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  try {
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (username === authData.username && bcrypt.compareSync(password, authData.password)) {
      req.session.userId = 'admin';
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Authentication system error' });
  }
});

app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: !!req.session.userId });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.clearCookie('connect.sid');
  res.json({ success: true });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    
    if (bcrypt.compareSync(oldPassword, authData.password)) {
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(newPassword, salt);
      
      authData.password = hashedPassword;
      fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
      
      res.json({ success: true, message: 'Password updated successfully' });
    } else {
      res.status(400).json({ success: false, message: 'Password lama salah' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// ─── ACS Config Persistence ─────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    url: process.env.ACS_URL || 'http://localhost:7557',
    username: process.env.ACS_USER || '',
    password: process.env.ACS_PASS || '',
    syncInterval: 300,
    orgName: 'CORE NOC',
    timezone: 'WIB',
    maintenance: false,
    mikrotiks: [],
    vpn: {
      type: 'l2tp', // Default type
      enabled: false,
      server: '',
      username: '',
      password: '',
      secret: '', // L2TP IPsec Secret
      // WireGuard Specific
      privateKey: '',
      address: '',
      peerPublicKey: '',
      endpoint: '',
      allowedIPs: '0.0.0.0/0',
      status: 'disconnected'
    }
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadJSON(file, defaultVal = []) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultVal;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// let acsConfig = loadConfig(); 
const getAcsConfig = () => loadConfig(); // Dynamic Getter: Selalu ambil data fresh dari disk

let auditLogs = loadJSON(AUDIT_FILE, []);
let signalHistory = loadJSON(HISTORY_FILE, {});
let infraData = loadJSON(INFRA_FILE, []);
let coordsStore = loadJSON(COORDS_FILE, {});
let deviceStatusStore = {}; // Tracks online/offline status for logging

function addAuditLog(category, severity, message, user = 'System') {
  const log = {
    id: Date.now() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    category,
    severity,
    message,
    user
  };
  auditLogs.unshift(log);
  if (auditLogs.length > 500) auditLogs = auditLogs.slice(0, 500);
  saveJSON(AUDIT_FILE, auditLogs);
  io.emit('newLog', log);
}

function recordHistory(devices) {
  const now = new Date().toISOString();
  const currentTime = Date.now();
  
  devices.forEach(d => {
    const id = d._id;
    // 1. Record Signal History
    if (!signalHistory[id]) signalHistory[id] = [];
    const rx = normalizePower(getParam(d, 'VirtualParameters.RXPower', 'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower'));
    if (!isNaN(rx)) {
      signalHistory[id].push({ t: now, v: rx });
      if (signalHistory[id].length > 200) signalHistory[id].shift();
    }

    // 2. Monitor Online/Offline status for Activity Logs
    const isOnline = d._lastInform ? (currentTime - new Date(d._lastInform).getTime()) < 5 * 60 * 1000 : false;
    const prevStatus = deviceStatusStore[id];
    const currentStatus = isOnline ? 'online' : 'offline';

    if (prevStatus && prevStatus !== currentStatus) {
      const sn = getParam(d, 'InternetGatewayDevice.DeviceInfo.SerialNumber', 'Device.DeviceInfo.SerialNumber') || id;
      const severity = isOnline ? 'success' : 'critical';
      const message = isOnline ? `Device ${sn} is back ONLINE` : `Device ${sn} went OFFLINE`;
      addAuditLog('Device', severity, message);
    }
    deviceStatusStore[id] = currentStatus;
  });
  
  saveJSON(HISTORY_FILE, signalHistory);
}

function getAcsClient() {
  const config = getAcsConfig();
  return axios.create({
    baseURL: config.url,
    auth: config.username
      ? { username: config.username, password: config.password }
      : undefined,
    timeout: 10000,
  });
}

// ─── Config endpoints ────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  const config = getAcsConfig();
  // Mask semua field password sebelum dikirim ke frontend
  const maskedConfig = { 
    ...config, 
    password: '***', 
    telnetPass: '***'
  };

  // Mask VPN sensitive fields
  if (maskedConfig.vpn) {
    maskedConfig.vpn = {
      ...maskedConfig.vpn,
      password: maskedConfig.vpn.password ? '***' : '',
      secret: maskedConfig.vpn.secret ? '***' : '',
      privateKey: maskedConfig.vpn.privateKey ? '***' : ''
    };
  }

  // Mask passwords for all mikrotiks
  if (maskedConfig.mikrotiks) {
    maskedConfig.mikrotiks = maskedConfig.mikrotiks.map(m => ({ ...m, mkPass: '***' }));
  }

  res.json(maskedConfig);
});

function normalizeUrl(url) {
  if (!url) return url;
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  return url.replace(/\/+$/, '');
}

app.post('/api/config', requireAuth, (req, res) => {
  const updates = req.body;
  let currentConfig = loadConfig();

  // Security: Jangan simpan password jika isinya mask '***' atau kosong
  if (!updates.password || updates.password === '***') delete updates.password;
  if (!updates.telnetPass || updates.telnetPass === '***') delete updates.telnetPass;
  
  // Handle VPN masking
  if (updates.vpn) {
    const oldVpn = currentConfig.vpn || {};
    if (updates.vpn.password === '***' || !updates.vpn.password) updates.vpn.password = oldVpn.password;
    if (updates.vpn.secret === '***' || !updates.vpn.secret) updates.vpn.secret = oldVpn.secret;
    if (updates.vpn.privateKey === '***' || !updates.vpn.privateKey) updates.vpn.privateKey = oldVpn.privateKey;
  }

  // Perbaikan khusus untuk daftar Mikrotik agar password tidak tertimpa '***'
  if (updates.mikrotiks && Array.isArray(updates.mikrotiks)) {
    updates.mikrotiks = updates.mikrotiks.map(newMk => {
      const oldMk = currentConfig.mikrotiks ? currentConfig.mikrotiks.find(m => m.id === newMk.id) : null;
      // Jika password di form adalah '***' atau kosong, gunakan password lama
      if (newMk.mkPass === '***' || !newMk.mkPass) {
        return { ...newMk, mkPass: oldMk ? oldMk.mkPass : '' };
      }
      return newMk;
    });
  }

  const newConfig = { ...currentConfig, ...updates };
  if (updates.url) newConfig.url = normalizeUrl(updates.url);
  if (updates.syncInterval) newConfig.syncInterval = parseInt(updates.syncInterval) || 300;
  if (updates.snmpPort) newConfig.snmpPort = parseInt(updates.snmpPort) || 161;

  saveConfig(newConfig);
  res.json({ success: true, message: 'Configuration saved successfully' });
});

app.post('/api/config/test', requireAuth, async (req, res) => {
  // Hanya pakai data yang dikirim dari form (jangan fallback ke data lama)
  const testUrl = normalizeUrl(req.body?.url);
  const testUser = req.body?.username;
  const testPass = req.body?.password;

  if (!testUrl) {
    return res.status(400).json({ success: false, message: 'URL ACS wajib diisi untuk tes.' });
  }

  const client = axios.create({
    baseURL: testUrl,
    auth: (testUser || testPass) ? { username: testUser, password: testPass } : undefined,
    timeout: 8000,
  });

  try {
    const r = await client.get('/devices?limit=1');
    const count = Array.isArray(r.data) ? r.data.length : '?';
    res.json({ success: true, message: `✅ Connected to ${testUrl} — found ${count} device(s)` });
  } catch (e) {
    console.error(`[ACS Error] Gagal fetch devices: ${e.message}`);
    if (e.response) {
      console.error(`[ACS Error] Status: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── TR-069 Parameter Helpers ────────────────────────────────────────────────
function getParam(device, ...paths) {
  for (const p of paths) {
    const keys = p.split('.');
    let node = device;
    for (const k of keys) {
      if (node && typeof node === 'object') {
        node = node[k];
      } else {
        node = undefined;
        break;
      }
    }
    if (node !== undefined && node !== null) {
      let val = node._value !== undefined ? node._value : node;
      if (typeof val === 'object' && val !== null) {
        val = val._value !== undefined ? val._value : '';
        if (typeof val === 'object') val = '';
      }
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
  }
  return '';
}

function normalizePower(powerStr) {
  if (!powerStr) return NaN;
  let val = parseFloat(powerStr);
  if (isNaN(val)) return NaN;
  if (val < -100 || val > 100) val = val / 1000;
  return val;
}

function getPowerStatus(rx) {
  const val = normalizePower(rx);
  if (isNaN(val)) return 'bad';
  if (val >= -20) return 'good';
  if (val >= -26) return 'medium';
  return 'bad';
}

function formatUptime(seconds) {
  if (!seconds) return '0h 0m';
  const s = parseInt(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${m}m`;
}

// ─── Map raw GenieACS device → ONTData ──────────────────────────────────────
function mapDevice(device, isRebooting = false) {
  let id = device._id || device.id || 'unknown';
  if (typeof id === 'object') id = Object.values(id).filter(Boolean).join('-');
  id = String(id);

  // Serial Number
  const sn = getParam(device,
    'InternetGatewayDevice.DeviceInfo.SerialNumber',
    'Device.DeviceInfo.SerialNumber'
  );

  // Model
  const model = getParam(device,
    'InternetGatewayDevice.DeviceInfo.ModelName',
    'Device.DeviceInfo.ModelName',
    'InternetGatewayDevice.DeviceInfo.HardwareVersion'
  );

  // IP — F609/Huawei often uses WANConnectionDevice index 4 or 5 for PPPoE/INTERNET service
  const ip = getParam(device,
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.6.WANPPPConnection.1.ExternalIPAddress',
    'Device.IP.Interface.1.IPv4Address.1.IPAddress'
  );

  // MAC
  const mac = getParam(device,
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress',
    'Device.Ethernet.Interface.1.MACAddress'
  );

  // PPPoE — F609 Huawei biasanya di index WANConnectionDevice 4 atau 5
  const pppoeUser = getParam(device,
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Username',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.6.WANPPPConnection.1.Username',  // F609
    'Device.PPP.Interface.1.Username'
  );
  const pppoePass = getParam(device,
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Password',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Password',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Password',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Password',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.Password',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.6.WANPPPConnection.1.Password',  // F609
    'Device.PPP.Interface.1.Password'
  );

  // VLAN — F609 uses X_HW_VlanID
  const vlan = getParam(device,
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_HW_VlanID',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.X_HW_VlanID',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.5.WANPPPConnection.1.X_HW_VlanID',  // F609
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_CMCC_VLanID',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.VLANID',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_ZTE-COM_VLANID',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.X_ZTE-COM_VLANID',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_ZTE-COM_VLANID'
  ) || '—';

  // WiFi 2.4G — F609 uses KeyPassphrase (not PreSharedKey)
  const ssid = getParam(device,
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    'Device.WiFi.SSID.1.SSID'
  );
  const wifiPass = getParam(device,
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',         // F609/Huawei
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
    'Device.WiFi.AccessPoint.1.Security.KeyPassphrase'
  );

  // WiFi 5G — F609 uses index 5 for 5GHz radio
  const ssid5G = getParam(device,
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
    'Device.WiFi.SSID.2.SSID'
  );
  const wifiPass5G = getParam(device,
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',         // F609/Huawei
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',         // F609/Huawei alt
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.PreSharedKey',
    'Device.WiFi.AccessPoint.2.Security.KeyPassphrase'
  );

  // Optical Power — Huawei F609 specific path
  const rxPower = getParam(device,
    'VirtualParameters.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_HUAWEI_GponInterfaceConfig.RxPower',      // F609 Huawei
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GPON.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterafceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_OpticalStatus.RxPower',
    'InternetGatewayDevice.WANDevice.1.PhyInterface.1.RxPower',
    'Device.Optical.Interface.1.OpticalSignalLevel'
  );
  const txPower = getParam(device,
    'VirtualParameters.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_HUAWEI_GponInterfaceConfig.TxPower',      // F609 Huawei
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GPON.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.TXPower',
    'Device.Optical.Interface.1.TransmitOpticalLevel'
  );

  // Uptime
  const uptimeRaw = getParam(device,
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  );

  const lastInform = device._lastInform;
  const isOnline = lastInform ? (Date.now() - new Date(lastInform).getTime()) < 5 * 60 * 1000 : false;
  
  // 1. SMART NAME SYNC: ACS Tag -> PPPoE Username -> SN
  let customerName = getParam(device, 'InternetGatewayDevice.DeviceInfo.X_CustomerName') || (device._tags ? device._tags.join(', ') : '');
  if (!customerName || customerName === sn) {
    // If name is empty, try to use the PPPoE Username as the name
    customerName = pppoeUser || sn;
  }

  const stored = coordsStore[id] || coordsStore[sn];
  let coords = [0, 0];
  let parentOdpId = null;

  if (stored) {
    if (Array.isArray(stored)) {
      coords = stored;
    } else {
      coords = stored.coords || [0, 0];
      parentOdpId = stored.parentOdpId || null;
    }
  }

  // 2. AUTO-PLACEMENT: If no coords but has ODP, place near ODP
  if (coords[0] === 0 && parentOdpId) {
    const odp = infraData.find(o => o.id === parentOdpId);
    if (odp && odp.coordinates) {
      // Add small random jitter (approx 10-30 meters) so they don't stack perfectly
      const jitterLat = (Math.random() - 0.5) * 0.0004;
      const jitterLng = (Math.random() - 0.5) * 0.0004;
      coords = [odp.coordinates[0] + jitterLat, odp.coordinates[1] + jitterLng];
    }
  }

  // Traffic Stats
  const bytesRx = getParam(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats.EthernetBytesReceived') || '0';
  const bytesTx = getParam(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Stats.EthernetBytesSent') || '0';

  const rxNormalized = normalizePower(rxPower);
  const txNormalized = normalizePower(txPower);

  return {
    id,
    name: pppoeUser ? pppoeUser.split('@')[0] : (sn || id.slice(-8)),
    serialNumber: sn || id,
    model: model || 'Unknown',
    status: isRebooting ? 'rebooting' : (isOnline ? 'online' : 'offline'),
    ipAddress: ip,
    macAddress: mac,
    pppoeUser,
    pppoePass,
    vlan,
    ssid,
    wifiPass,
    ssid5G,
    wifiPass5G,
    rxPower: !isNaN(rxNormalized) ? `${rxNormalized.toFixed(2)} dBm` : '—',
    txPower: !isNaN(txNormalized) ? `${txNormalized.toFixed(2)} dBm` : '—',
    powerStatus: getPowerStatus(rxPower),
    uptime: formatUptime(uptimeRaw),
    customerName,
    lastInform: lastInform || null,
    history: signalHistory[id] || [],
    coordinates: coords,
    parentOdpId: parentOdpId,
    traffic: {
      rx: parseInt(bytesRx),
      tx: parseInt(bytesTx)
    }
  };
}

// ─── GET /api/devices ────────────────────────────────────────────────────────
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const client = getAcsClient();
    // Projection includes VirtualParameters (RXPower/TXPower) and Huawei-specific X_HUAWEI_GponInterfaceConfig
    const projection = [
      '_id', '_lastInform', '_tags',
      'VirtualParameters',                                              // RXPower/TXPower virtual params
      'InternetGatewayDevice.DeviceInfo',
      'InternetGatewayDevice.WANDevice.1.X_HUAWEI_GponInterfaceConfig', // F609 optical power
      'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig',        // Generic GPON
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',           // PPPoE / IP (all indices)
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration',            // WiFi
      'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig',   // MAC
      'Device.DeviceInfo',
      'Device.IP.Interface',
      'Device.PPP.Interface',
      'Device.Optical.Interface',
      'Device.WiFi'
    ].join(',');
    const response = await client.get(`/devices?projection=${projection}`);
    const devices = response.data.map(d => mapDevice(d));
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/devices/:id/config ──────────────────────────────────────────
app.post('/api/devices/:id/config', requireAuth, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  try {
    const client = getAcsClient();
    if (updates.coordinates || updates.parentOdpId !== undefined) {
      if (!coordsStore[id]) coordsStore[id] = {};
      if (updates.coordinates) coordsStore[id].coords = updates.coordinates;
      if (updates.parentOdpId !== undefined) coordsStore[id].parentOdpId = updates.parentOdpId;
      saveJSON(COORDS_FILE, coordsStore);
    }
    res.json({ success: true });
    io.emit('deviceUpdated', { id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update Device Config (WiFi, etc) ──────────────────────────────────────
app.patch('/api/devices/:id/config', async (req, res) => {
  const { id } = req.params;
  const { ssid, wifiPass, coordinates } = req.body;
  
  try {
    const devices = await readDb('devices.json');
    const deviceIndex = devices.findIndex(d => d.id === id);
    
    if (deviceIndex === -1) return res.status(404).json({ error: 'Device tidak ditemukan' });
    
    // 1. Update in Local DB
    if (ssid) devices[deviceIndex].ssid = ssid;
    if (wifiPass) devices[deviceIndex].wifiPass = wifiPass;
    if (coordinates) devices[deviceIndex].coordinates = coordinates;
    
    await writeDb('devices.json', devices);
    
    // 2. Execute on OLT (Async)
    const ont = devices[deviceIndex];
    console.log(`[ACS] Config updated for ${ont.serialNumber}`);

    res.json({ success: true, message: 'Konfigurasi berhasil diperbarui!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stats ────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const client = getAcsClient();
    const response = await client.get('/devices?projection=_id,_lastInform');
    const now = Date.now();
    const online = response.data.filter(d => d._lastInform && (now - new Date(d._lastInform).getTime()) < 5 * 60 * 1000).length;
    res.json({ total: response.data.length, online, offline: response.data.length - online });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/infrastructure', requireAuth, (req, res) => res.json(infraData));
app.post('/api/infrastructure', requireAuth, (req, res) => {
  const { id, name, coordinates, maxPorts } = req.body;
  if (!id) {
    const newOdp = { id: 'odp_' + Math.random().toString(36).substr(2, 9), name, coordinates, maxPorts };
    infraData.push(newOdp);
    addAuditLog('Infrastructure', 'info', `Added new ODP: ${name}`, req.session.user);
  } else {
    const idx = infraData.findIndex(i => i.id === id);
    if (idx !== -1) {
      infraData[idx] = { ...infraData[idx], name, coordinates, maxPorts };
      addAuditLog('Infrastructure', 'info', `Updated ODP: ${name}`, req.session.user);
    }
  }
  saveJSON(INFRA_FILE, infraData);
  io.emit('infraUpdated');
  res.json({ success: true });
});

app.delete('/api/infrastructure/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const odp = infraData.find(i => i.id === id);
  infraData = infraData.filter(i => i.id !== id);
  saveJSON(INFRA_FILE, infraData);
  addAuditLog('Infrastructure', 'warning', `Deleted ODP: ${odp?.name || id}`, req.session.user);
  io.emit('infraUpdated');
  res.json({ success: true });
});

// ─── POST /api/infrastructure/import-kml ─────────────────────────────────────
app.post('/api/infrastructure/import-kml', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diupload.' });

    let kmlBuffer = req.file.buffer;
    const originalName = req.file.originalname.toLowerCase();

    // 1. Jika KMZ (ZIP) → ekstrak file .kml di dalamnya
    if (originalName.endsWith('.kmz')) {
      const zip = new AdmZip(kmlBuffer);
      const kmlEntry = zip.getEntries().find(e => e.entryName.endsWith('.kml'));
      if (!kmlEntry) return res.status(400).json({ error: 'KMZ tidak berisi file .kml.' });
      kmlBuffer = kmlEntry.getData();
    }

    // 2. Parse KML XML
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '_', isArray: (name) => ['Placemark', 'Folder'].includes(name) });
    const kmlObj = parser.parse(kmlBuffer.toString('utf8'));
    const doc = kmlObj?.kml?.Document || kmlObj?.kml;

    // 3. Flatten semua Placemark dengan info folder parentnya
    function extractPlacemarks(node, parentFolder = '') {
      const results = [];
      const folders = Array.isArray(node?.Folder) ? node.Folder : (node?.Folder ? [node.Folder] : []);
      const placemarks = Array.isArray(node?.Placemark) ? node.Placemark : (node?.Placemark ? [node.Placemark] : []);

      placemarks.forEach(pm => results.push({ ...pm, _parentFolder: parentFolder }));
      folders.forEach(f => {
        const fname = f?.name || '';
        results.push(...extractPlacemarks(f, fname));
      });
      return results;
    }

    const allPlacemarks = extractPlacemarks(doc);
    console.log(`[KML Import] Total placemarks ditemukan: ${allPlacemarks.length}`);

    let imported = 0;
    let skipped = 0;
    const items = [];

    allPlacemarks.forEach(pm => {
      const name = String(pm?.name || '').trim();
      const folder = String(pm?._parentFolder || '').trim().toLowerCase();
      const coordStr = pm?.Point?.coordinates || pm?.coordinates;

      if (!coordStr || !name) { skipped++; return; }

      // KML koordinat: lng,lat,alt → kita butuh [lat, lng]
      const parts = String(coordStr).trim().split(',');
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);

      if (isNaN(lat) || isNaN(lng)) { skipped++; return; }
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { skipped++; return; }

      // 4. Deteksi tipe berdasarkan folder atau nama
      const nameLower = name.toLowerCase();
      let type = 'POINT';
      if (folder.includes('odp') || nameLower.startsWith('odp') || nameLower.includes('-odp')) type = 'ODP';
      else if (folder.includes('odc') || nameLower.startsWith('odc')) type = 'ODC';
      else if (folder.includes('olt') || nameLower.startsWith('olt')) type = 'OLT';
      else if (folder.includes('ont') || folder.includes('onu') || folder.includes('pelanggan')) type = 'ONT';

      // 5. Simpan sesuai tipe (Sekarang semua masuk ke infraData supaya muncul di peta)
      const existing = infraData.find(i => i.name === name);
      if (!existing) {
        const newItem = {
          id: (type === 'ODP' ? 'odp_' : 'pt_') + Math.random().toString(36).substr(2, 9),
          name,
          coordinates: [lat, lng],
          maxPorts: (type === 'ODC' || type === 'ODP') ? 8 : 0,
          type: type // ODP, ODC, ONT, or POINT
        };
        infraData.push(newItem);
        imported++;
        items.push({ name, type, lat, lng });
      } else {
        existing.coordinates = [lat, lng];
        existing.type = type;
        imported++;
        items.push({ name, type, lat, lng, updated: true });
      }
    });

    // 6. Simpan ke disk
    saveJSON(INFRA_FILE, infraData);
    saveJSON(COORDS_FILE, coordsStore);

    addAuditLog('System', 'info', `KML Import: ${imported} items berhasil diimpor dari ${req.file.originalname}`, req.session?.userId || 'admin');
    io.emit('infraUpdated');

    console.log(`[KML Import] ✅ Imported: ${imported}, Skipped: ${skipped}`);
    res.json({ success: true, imported, skipped, total: allPlacemarks.length, items: items.slice(0, 50) });

  } catch (err) {
    console.error('[KML Import Error]', err.message);
    res.status(500).json({ error: 'Gagal memproses file KML: ' + err.message });
  }
});

// ─── GET /api/olt/status  (SNMP Polling) ─────────────────────────────────────
app.get('/api/olt/status', requireAuth, async (req, res) => {
  try {
    const cfg = loadConfig();
    const ip          = process.env.OLT_IP        || cfg.oltIp;
    const community   = process.env.OLT_COMMUNITY || cfg.snmpCommunity;
    const snmpPort    = process.env.OLT_SNMP_PORT || cfg.snmpPort;
    const telnetUser  = process.env.OLT_USER      || cfg.telnetUser;
    const telnetPass  = process.env.OLT_PASS      || cfg.telnetPass;

    if (!ip) {
      return res.status(400).json({ error: 'IP OLT belum dikonfigurasi. Silakan atur di Settings → OLT Connection.' });
    }

    oltService.setConfig({ ip, community, snmpPort, telnetUser, telnetPass });
    const statusData = await oltService.getChassisStatus();
    res.json(statusData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/olt/provision  (Telnet / OMCI Provisioning) ──────────────────
app.post('/api/olt/provision', requireAuth, async (req, res) => {
  try {
    const cfg = loadConfig();
    const ip         = process.env.OLT_IP   || cfg.oltIp;
    const telnetUser = process.env.OLT_USER || cfg.telnetUser;
    const telnetPass = process.env.OLT_PASS || cfg.telnetPass;

    if (!ip || !telnetUser || !telnetPass) {
      return res.status(400).json({ error: 'Konfigurasi Telnet OLT belum lengkap. Silakan atur di Settings → OLT Connection.' });
    }

    const { commands } = req.body;
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Daftar perintah tidak boleh kosong.' });
    }

    oltService.setConfig({ ip, community: cfg.snmpCommunity, snmpPort: cfg.snmpPort, telnetUser, telnetPass });
    const output = await oltService.executeOmciCommand(commands);
    addAuditLog('OLT', 'info', `OMCI Provision executed: ${commands.length} command(s)`, req.session.user);
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/olt/onus  (ONU List per PON slot) ──────────────────────────────
app.get('/api/olt/onus', requireAuth, async (req, res) => {
  try {
    const cfg = loadConfig();
    const ip         = process.env.OLT_IP   || cfg.oltIp;
    const telnetUser = process.env.OLT_USER || cfg.telnetUser;
    const telnetPass = process.env.OLT_PASS || cfg.telnetPass;
    const slot       = parseInt(req.query.slot) || 3;

    if (!ip) return res.status(400).json({ error: 'IP OLT belum dikonfigurasi.' });

    oltService.setConfig({ ip, community: cfg.snmpCommunity, snmpPort: cfg.snmpPort, telnetUser, telnetPass });
    const onus = await oltService.getOnuList(slot);
    res.json(onus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/olt/onu  (Single ONU Detail) ───────────────────────────────────
app.get('/api/olt/onu', requireAuth, async (req, res) => {
  try {
    const cfg = loadConfig();
    const ip         = process.env.OLT_IP   || cfg.oltIp;
    const telnetUser = process.env.OLT_USER || cfg.telnetUser;
    const telnetPass = process.env.OLT_PASS || cfg.telnetPass;
    const slot       = parseInt(req.query.slot)  || 3;
    const onuId      = parseInt(req.query.onuId) || 1;

    if (!ip) return res.status(400).json({ error: 'IP OLT belum dikonfigurasi.' });

    oltService.setConfig({ ip, community: cfg.snmpCommunity, snmpPort: cfg.snmpPort, telnetUser, telnetPass });
    const detail = await oltService.getOnuDetail(slot, onuId);
    res.json(detail);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── MIKROTIK ROUTES (Multi-Router) ─────────────────────────────────────────
function getMkConfig(id) {
  const cfg = loadConfig();
  if (!cfg.mikrotiks) return null;
  const router = cfg.mikrotiks.find(m => m.id === id);
  if (!router) {
    console.error(`[Mikrotik] Router ID ${id} tidak ditemukan di Inventory.`);
    return null;
  }
  
  // Pastikan IP tidak kosong
  if (!router.mkIp) {
    console.error(`[Mikrotik] Router ${router.name} tidak memiliki IP Address.`);
    return null;
  }

  return {
    ip:   router.mkIp,
    user: router.mkUser,
    pass: router.mkPass,
    port: parseInt(router.mkPort) || 8728
  };
}

// ─── Mikrotik File-Based Persistence ────────────────────────────────────────
const MIKROTIK_DATA_FILE = path.join(DATA_DIR, 'mikrotik-data.json');

// Helper to load/save Mikrotik Data
function getPersistentMkData() {
  if (fs.existsSync(MIKROTIK_DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(MIKROTIK_DATA_FILE, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}

function savePersistentMkData(data) {
  const current = getPersistentMkData();
  const updated = { ...current, ...data };
  fs.writeFileSync(MIKROTIK_DATA_FILE, JSON.stringify(updated, null, 2));
}

app.get('/api/mikrotik/status', requireAuth, async (req, res) => {
  const { id, refresh } = req.query;
  const allData = getPersistentMkData();
  
  // Jika tidak minta refresh dan ada data lama, kirim langsung
  if (refresh !== 'true' && allData[`status_${id}`]) {
    return res.json(allData[`status_${id}`]);
  }

  try {
    const config = getMkConfig(id);
    if (!config) throw new Error('Router tidak ditemukan.');
    mikrotikService.setConfig(config);
    const status = await mikrotikService.getStatus();
    savePersistentMkData({ [`status_${id}`]: status });
    res.json(status);
  } catch (error) {
    // Jika gagal refresh tapi ada data lama, kirim data lama saja daripada error
    if (allData[`status_${id}`]) return res.json(allData[`status_${id}`]);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mikrotik/secrets', requireAuth, async (req, res) => {
  const { id, refresh } = req.query;
  const allData = getPersistentMkData();
  
  if (refresh !== 'true' && allData[`secrets_${id}`]) {
    return res.json(allData[`secrets_${id}`]);
  }

  try {
    const config = getMkConfig(id);
    if (!config) throw new Error('Router tidak ditemukan.');
    mikrotikService.setConfig(config);
    const secrets = await mikrotikService.getSecrets();
    savePersistentMkData({ [`secrets_${id}`]: secrets });
    res.json(secrets);
  } catch (error) {
    if (allData[`secrets_${id}`]) return res.json(allData[`secrets_${id}`]);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mikrotik/active', requireAuth, async (req, res) => {
  const { id, refresh } = req.query;
  const allData = getPersistentMkData();
  
  if (refresh !== 'true' && allData[`active_${id}`]) {
    return res.json(allData[`active_${id}`]);
  }

  try {
    const config = getMkConfig(id);
    if (!config) throw new Error('Router tidak ditemukan.');
    mikrotikService.setConfig(config);
    const active = await mikrotikService.getActiveUsers();
    savePersistentMkData({ [`active_${id}`]: active });
    res.json(active);
  } catch (error) {
    if (allData[`active_${id}`]) return res.json(allData[`active_${id}`]);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mikrotik/secrets', requireAuth, async (req, res) => {
  try {
    const { id } = req.query;
    const config = getMkConfig(id);
    mikrotikService.setConfig(config);
    await mikrotikService.addSecret(req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/mikrotik/secrets/:id', requireAuth, async (req, res) => {
  try {
    const { routerId } = req.query;
    const config = getMkConfig(routerId);
    mikrotikService.setConfig(config);
    await mikrotikService.deleteSecret(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/mikrotik/active/:id', requireAuth, async (req, res) => {
  try {
    const { routerId } = req.query;
    const config = getMkConfig(routerId);
    mikrotikService.setConfig(config);
    await mikrotikService.disconnectUser(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



app.post('/api/devices/:id/config', requireAuth, async (req, res) => {
  const { id } = req.params;
  const config = req.body;
  try {
    const acsCfg = loadConfig();
    const client = axios.create({
      baseURL: acsCfg.url,
      auth: { username: acsCfg.username, password: acsCfg.password },
      timeout: 10000
    });

    const tasks = [];

    // 1. Metadata: Customer Name (Tags)
    if (config.customerName) {
      await client.post(`/devices/${encodeURIComponent(id)}/tags`, { name: `CUSTOMER:${config.customerName}` });
    }

    // 2. PPPOE Username & Password (Universal for ZTE/Huawei)
    if (config.pppoeUser) {
      tasks.push({ 
        name: 'setParameterValues', 
        parameterValues: [
          ["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username", config.pppoeUser],
          ["Device.PPP.Interface.1.Username", config.pppoeUser] // TR-181
        ] 
      });
    }

    // 3. WiFi 2.4G Settings
    if (config.ssid) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", config.ssid],
          ["Device.WiFi.SSID.1.SSID", config.ssid]
        ]
      });
    }
    if (config.wifiPassword) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey", config.wifiPassword],
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", config.wifiPassword],
          ["Device.WiFi.AccessPoint.1.Security.KeyPassphrase", config.wifiPassword]
        ]
      });
    }

    // 4. WiFi 5G Settings (Index 5 for ZTE, 9 for Huawei, or 2 for TR-181)
    if (config.ssid5g) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID", config.ssid5g],
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.9.SSID", config.ssid5g],
          ["Device.WiFi.SSID.2.SSID", config.ssid5g]
        ]
      });
    }
    if (config.wifiPassword5g) {
      tasks.push({
        name: 'setParameterValues',
        parameterValues: [
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey", config.wifiPassword5g],
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase", config.wifiPassword5g],
          ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.9.PreSharedKey.1.PreSharedKey", config.wifiPassword5g],
          ["Device.WiFi.AccessPoint.2.Security.KeyPassphrase", config.wifiPassword5g]
        ]
      });
    }

    // 5. Submit all tasks to GenieACS
    for (const task of tasks) {
      await client.post(`/devices/${encodeURIComponent(id)}/tasks?connection_request`, task);
    }

    addAuditLog('Device', 'info', `Config updated for device: ${id} (WiFi 2.4/5G & PPPOE)`, req.session.user);
    res.json({ success: true, message: 'Configuration tasks queued' });
  } catch (error) {
    console.error(`[Config Error] ${error.message}`);
    res.status(500).json({ error: 'Failed to update configuration: ' + error.message });
  }
});

app.post('/api/devices/:id/reboot', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const acsCfg = loadConfig();
    const client = axios.create({
      baseURL: acsCfg.url,
      auth: { username: acsCfg.username, password: acsCfg.password },
      timeout: 10000
    });
    // GenieACS Reboot Command
    await client.post(`/devices/${encodeURIComponent(id)}/tasks?connection_request`, { name: 'reboot' });
    addAuditLog('Device', 'warning', `Reboot command sent to device: ${id}`, req.session.user);
    res.json({ success: true, message: 'Reboot command queued' });
  } catch (error) {
    console.error(`[Reboot Error] ${error.message}`);
    res.status(500).json({ error: 'Failed to send reboot command: ' + error.message });
  }
});

app.get('/api/logs', requireAuth, async (req, res) => {
  res.json(auditLogs.slice(0, 100));
});

// ─── GET /api/devices/:id (Single Device) ────────────────────────────────────
app.get('/api/devices/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const client = getAcsClient();
    const projection = [
      '_id', '_lastInform', '_tags',
      'VirtualParameters',
      'InternetGatewayDevice.DeviceInfo',
      'InternetGatewayDevice.WANDevice.1.X_HUAWEI_GponInterfaceConfig',
      'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
      'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig',
      'Device.DeviceInfo', 'Device.IP.Interface',
      'Device.PPP.Interface', 'Device.Optical.Interface', 'Device.WiFi'
    ].join(',');
    const response = await client.get(`/devices/${encodeURIComponent(id)}?projection=${projection}`);
    res.json(mapDevice(response.data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/debug/device/:id (Raw GenieACS data — for F609 diagnosis) ──────
app.get('/api/debug/device/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const client = getAcsClient();
    const response = await client.get(`/devices/${encodeURIComponent(id)}`);
    const raw = response.data;

    // Extract useful diagnostic info: list all top-level keys and WANDevice sub-keys
    const topKeys = Object.keys(raw);
    const wanDevice = raw?.InternetGatewayDevice?.WANDevice?.['1'] || {};
    const wanConnDevice = wanDevice?.WANConnectionDevice || {};
    const wanConnIndices = Object.keys(wanConnDevice);
    
    // For each WANConnectionDevice index, show PPP/IP connections
    const wanConnSummary = wanConnIndices.map(idx => {
      const conn = wanConnDevice[idx];
      const ppp = conn?.WANPPPConnection || {};
      const ip = conn?.WANIPConnection || {};
      return {
        index: idx,
        pppIndices: Object.keys(ppp),
        ipIndices: Object.keys(ip),
        pppUser: Object.values(ppp)[0]?.Username?._value || null,
        pppIp: Object.values(ppp)[0]?.ExternalIPAddress?._value || null,
      };
    });

    const huaweiGpon = wanDevice?.X_HUAWEI_GponInterfaceConfig || {};
    const virtualParams = raw?.VirtualParameters || {};
    const wlanConfig = raw?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};

    res.json({
      id,
      topLevelKeys: topKeys,
      model: raw?.InternetGatewayDevice?.DeviceInfo?.ModelName?._value || '?',
      serialNumber: raw?.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value || '?',
      lastInform: raw?._lastInform,
      wanConnectionDeviceIndices: wanConnIndices,
      wanConnectionSummary: wanConnSummary,
      huaweiGponKeys: Object.keys(huaweiGpon),
      rxPowerRaw: huaweiGpon?.RxPower?._value || null,
      txPowerRaw: huaweiGpon?.TxPower?._value || null,
      virtualParameterKeys: Object.keys(virtualParams),
      rxPowerVirtual: virtualParams?.RXPower?._value || null,
      wlanConfigIndices: Object.keys(wlanConfig),
      ssid_1: wlanConfig?.['1']?.SSID?._value || null,
      wifiPass_1_psk: wlanConfig?.['1']?.PreSharedKey?.['1']?.PreSharedKey?._value || null,
      wifiPass_1_kp: wlanConfig?.['1']?.KeyPassphrase?._value || null,
      ssid_5: wlanConfig?.['5']?.SSID?._value || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


async function fetchDevices() {
  try {
    const acsCfg = loadConfig();
    const client = axios.create({
      baseURL: acsCfg.url,
      auth: { username: acsCfg.username, password: acsCfg.password },
      timeout: 10000
    });
    // Same complete projection as /api/devices — includes VirtualParameters & Huawei paths
    const projection = [
      '_id', '_lastInform', '_tags',
      'VirtualParameters',
      'InternetGatewayDevice.DeviceInfo',
      'InternetGatewayDevice.WANDevice.1.X_HUAWEI_GponInterfaceConfig',
      'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
      'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig',
      'Device.DeviceInfo',
      'Device.IP.Interface',
      'Device.PPP.Interface',
      'Device.Optical.Interface',
      'Device.WiFi'
    ].join(',');
    const response = await client.get(`/devices?projection=${projection}`);
    return response.data;
  } catch (error) {
    console.error(`[Sync Error] ${error.message}`);
    return [];
  }
}

// Background sync loop
let syncInterval;
function startSync() {
  if (syncInterval) clearInterval(syncInterval);
  
  // Initial sync
  fetchDevices().then(recordHistory);

  syncInterval = setInterval(async () => {
    // 1. Fetch data dari ACS (Internal Internet - Aman)
    const devices = await fetchDevices();
    recordHistory(devices);
    
    // 2. SEMUA KONEKSI KE MIKROTIK & OLT DIMATIKAN TOTAL (SAFETY FIRST)
    // Kita hanya mengandalkan PUSH dari Mikrotik (Pasif)
    
    io.emit('deviceUpdated');
  }, (loadConfig().syncInterval || 60) * 1000);
}

// ─── Serve Frontend (Production) ─────────────────────────────────────────────
const DIST_PATH = path.join(__dirname, '..', 'dist');

// Serve static files from the React app
app.use(express.static(DIST_PATH));

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('*', (req, res, next) => {
  // If it's an API request, let it fail or handle it above
  if (req.path.startsWith('/api')) return next();
  
  const indexPath = path.join(DIST_PATH, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run npm run build first.');
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 NOC Backend Secure running on port ${PORT}`);
  addVpnLog('[SYSTEM] Backend NOC berhasil dimuat & Terminal siap.');
  startSync();
});
