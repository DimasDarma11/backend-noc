const snmp    = require('net-snmp');
const { Telnet } = require('telnet-client');

// ─── Card Type Descriptions ──────────────────────────────────────────────────
const CARD_DESC = {
  PRWH: 'Power Board',
  PRWG: 'Power Board',
  GTGO: 'GPON Card (8-Port)',
  GTGH: 'GPON Card (16-Port)',
  SCTM: 'Control Board',
  SCXN: 'Control Board',
  default: 'Unknown Card',
};

function parseShowCard(output) {
  const cards = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('Rack') || raw.startsWith('---')) continue;
    const cols = raw.split(/\s+/);
    if (cols.length < 5 || isNaN(parseInt(cols[0]))) continue;
    const slot     = parseInt(cols[2]);
    const cfgType  = cols[3];
    const realType = cols[4] || cfgType;
    const ports    = parseInt(cols[5]) || 0;
    const status   = cols[cols.length - 1];
    const desc     = CARD_DESC[cfgType] || CARD_DESC.default;
    cards.push({ slot, type: cfgType, realType, ports, status, desc, cpu: null, memory: null, usedPorts: 0 });
  }
  return cards;
}

function parseShowProcessor(output) {
  const stats = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('Rack') || raw.startsWith('---')) continue;
    const cols = raw.split(/\s+/);
    if (cols.length < 7 || isNaN(parseInt(cols[0]))) continue;
    const slot = parseInt(cols[2]);
    stats[slot] = { cpu: parseInt(cols[3]) || 0, memory: parseInt(cols[7]) || 0 };
  }
  return stats;
}

function parseShowTemperature(output) {
  const temps = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('Rack') || raw.startsWith('---')) continue;
    const cols = raw.split(/\s+/);
    if (cols.length < 6 || isNaN(parseInt(cols[0]))) continue;
    const slot = parseInt(cols[2]);
    temps[slot] = parseInt(cols[5]) || 0;
  }
  return temps;
}

function parseShowOnu(output, targetSlot) {
  const onus = [];
  const lines = output.split('\n');
  
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith('---') || raw.toLowerCase().includes('onuindex')) continue;

    const cols = raw.split(/\s+/);
    if (cols.length < 4) continue;

    const fullId = cols[0]; 
    
    // Pattern ZTE: gpon-onu_Rack/Shelf/Slot:OnuIndex
    // Contoh: gpon-onu_1/3/3:1
    const match = fullId.match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
    if (match) {
      const rack = match[1];
      const shelf = match[2];
      const slot = match[3];
      const onuIdx = match[4];

      // Saring hanya untuk slot yang dipilih
      if (parseInt(slot) === parseInt(targetSlot)) {
        let status = 'offline';
        // Cari status di seluruh kolom (biasanya "working" atau "online")
        const rowText = raw.toLowerCase();
        if (rowText.includes('working') || rowText.includes('online')) {
          status = 'online';
        }

        onus.push({ 
          onuId: onuIdx, 
          status: status, 
          name: `ONU ${onuIdx}`,
          interface: `${rack}/${shelf}/${slot}:${onuIdx}`,
          rxPower: 'Loading...' 
        });
      }
    }
  }
  return onus;
}

function parseOpticalPower(output) {
  const powers = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const raw = line.trim();
    const match = raw.match(/(\d+)\/(\d+)\/(\d+):(\d+)\s+([-.\d]+)/);
    if (match) {
      const key = `${match[1]}/${match[2]}/${match[3]}:${match[4]}`;
      powers[key] = match[5] + ' dBm';
    }
  }
  return powers;
}

class OltService {
  constructor() {
    this.ip = '';
    this.community = 'public';
    this.snmpPort = 161;
    this.telnetPort = 23;
    this.telnetUser = '';
    this.telnetPass = '';
    this.snmpSession = null;
    this.history = [];
    this.maxHistory = 20;
  }

  setConfig({ ip, community, snmpPort, telnetPort, telnetUser, telnetPass }) {
    this.ip = ip;
    this.community = community || 'public';
    this.snmpPort = parseInt(snmpPort) || 161;
    this.telnetPort = parseInt(telnetPort) || 23;
    this.telnetUser = telnetUser || '';
    this.telnetPass = telnetPass || '';
    if (this.snmpSession) {
      this.snmpSession.close();
      this.snmpSession = null;
    }
  }

  _getSnmpSession() {
    if (!this.snmpSession) {
      this.snmpSession = snmp.createSession(this.ip, this.community, {
        port: this.snmpPort,
        timeout: 5000,
        retries: 1,
        version: snmp.Version2c,
      });
    }
    return this.snmpSession;
  }

  async _snmpGet(oids) {
    return new Promise((resolve, reject) => {
      const session = this._getSnmpSession();
      session.get(oids, (error, varbinds) => {
        if (error) {
          this.snmpSession = null;
          return reject(error);
        }
        const results = {};
        for (const vb of varbinds) {
          results[vb.oid] = snmp.isVarbindError(vb) ? null : vb.value;
        }
        resolve(results);
      });
    });
  }

  async _telnetExec(commands) {
    const client = new Telnet();
    const results = [];
    try {
      await client.connect({
        host: this.ip,
        port: this.telnetPort,
        loginPrompt: /(Username|Login):/i,
        passwordPrompt: /(Password|Passwrd):/i,
        shellPrompt: /[>#]\s*$/,
        username: this.telnetUser,
        password: this.telnetPass,
        timeout: 60000,
        execTimeout: 30000,
        sendTimeout: 15000,
      });
      
      // Masuk ke mode enable jika prompt masih >
      await client.exec('enable').catch(() => {});
      await client.exec(this.telnetPass).catch(() => {}); // Biasanya password enable sama dengan telnet
      await client.exec('terminal length 0').catch(() => {});

      for (const cmd of commands) {
        console.log(`[OLT_EXEC] Sending: ${cmd}`);
        const out = await client.exec(cmd);
        console.log(`[OLT_EXEC] Received ${out.length} bytes for ${cmd}`);
        results.push({ cmd, output: out });
      }
      await client.end();
    } catch (err) {
      console.error(`[OLT_TELNET_ERROR] ${err.message}`);
      await client.end().catch(() => {});
      throw err;
    }
    return results;
  }

  async getChassisStatus() {
    if (!this.ip) throw new Error('IP OLT belum dikonfigurasi.');

    let uptimeStr = 'N/A';
    let modelName = 'ZTE ZXA10 C300';
    let snmpOnline = false;

    try {
      const snmpData = await this._snmpGet(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.3.0']);
      snmpOnline = true;
      if (snmpData['1.3.6.1.2.1.1.5.0']) modelName = snmpData['1.3.6.1.2.1.1.5.0'].toString();
      if (snmpData['1.3.6.1.2.1.1.3.0'] !== null) {
        const ticks = parseInt(snmpData['1.3.6.1.2.1.1.3.0']);
        const d = Math.floor(ticks / (100 * 86400));
        const h = Math.floor((ticks / (100 * 3600)) % 24);
        const m = Math.floor((ticks / (100 * 60)) % 60);
        uptimeStr = `${d}d ${h}h ${m}m`;
      }
    } catch (e) { console.warn('[OLT] SNMP Failed:', e.message); }

    let cards = [];
    let cpuSummary = 0, memSummary = 0, tempSummary = 0;

    try {
      const results = await this._telnetExec(['show card', 'show processor', 'show temperature']);
      cards = parseShowCard(results[0]?.output || '');
      const procStats = parseShowProcessor(results[1]?.output || '');
      const tempStats = parseShowTemperature(results[2]?.output || '');
      for (const card of cards) {
        if (procStats[card.slot]) { card.cpu = procStats[card.slot].cpu; card.memory = procStats[card.slot].memory; }
        if (tempStats[card.slot]) card.temp = tempStats[card.slot];
      }
      const controlBoard = cards.find(c => c.type === 'SCTM' && c.status === 'INSERVICE');
      cpuSummary = controlBoard?.cpu || 0;
      memSummary = controlBoard?.memory || 0;
      tempSummary = controlBoard?.temp || (cards.length > 0 ? Math.max(...cards.map(c => c.temp || 0)) : 0);
    } catch (e) {
      console.warn('[OLT] Telnet failed.');
      if (!snmpOnline) throw new Error(`Koneksi OLT Gagal: SNMP & Telnet keduanya tidak merespon.`);
    }

    const statusObj = { model: modelName, ip: this.ip, uptime: uptimeStr, cpu: cpuSummary, memory: memSummary, temperature: tempSummary, status: snmpOnline ? 'online' : 'offline', cards, uplink: { rx: 0, tx: 0 }, timestamp: new Date().toLocaleTimeString() };
    this.history.push({ time: statusObj.timestamp, cpu: cpuSummary, temp: tempSummary, rx: 0, tx: 0 });
    if (this.history.length > this.maxHistory) this.history.shift();
    statusObj.history = this.history;
    return statusObj;
  }

  async getOnuList(slot) {
    console.log(`[OLT] Fetching ONU list & Optical Power for slot ${slot}...`);
    let stateOutput = '';
    let powerOutput = '';
    
    try {
      // 1. Ambil status ONU secara massal
      const resState = await this._telnetExec(['show gpon onu state']);
      stateOutput = resState[0].output;

      // 2. Ambil redaman (power) secara massal untuk slot tersebut
      // Kita coba variasi Rack/Shelf yang paling umum
      const resPower = await this._telnetExec([
        `show pon power gpon-olt_1/1/${slot}`,
        `show pon power gpon-olt_0/1/${slot}`,
        `show pon power gpon-olt_1/3/${slot}`
      ]);
      powerOutput = resPower.map(r => r.output).join('\n');
    } catch (e) {
      console.error(`[OLT] Failed to fetch ONU data:`, e.message);
    }

    const list = parseShowOnu(stateOutput, slot);
    const powers = parseOpticalPower(powerOutput);

    // Gabungkan data status dengan data sinyal
    for (const onu of list) {
      if (powers[onu.interface]) {
        onu.rxPower = powers[onu.interface];
      } else {
        onu.rxPower = 'N/A';
      }
    }

    console.log(`[OLT] Found ${list.length} ONUs in slot ${slot}`);
    return list;
  }

  async getOnuDetail(slot, onuId) {
    const commands = [
      `show onu running-config gpon-onu_1/1/${slot}:${onuId}`,
      `show onu running-config gpon-onu_0/1/${slot}:${onuId}`
    ];
    for (const cmd of commands) {
      try {
        const res = await this._telnetExec([cmd]);
        if (res[0].output && !res[0].output.includes('Error')) {
          return { output: res[0].output };
        }
      } catch (e) {}
    }
    return { output: 'Data detail tidak ditemukan.' };
  }
}

module.exports = new OltService();
