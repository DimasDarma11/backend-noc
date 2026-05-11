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

// ─── Parsing Helper Functions ───────────────────────────────────────────────

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
    cards.push({ slot, type: cfgType, realType, ports, status, desc, cpu: null, memory: null, temp: 0 });
  }
  return cards;
}

function parseShowProcessor(output) {
  const stats = {};
  const lines = output.split('\n');
  for (const line of lines) {
    const raw = line.trim();
    const cols = raw.split(/\s+/);
    if (cols.length < 7 || isNaN(parseInt(cols[2]))) continue;
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
    const cols = raw.split(/\s+/);
    if (cols.length < 6 || isNaN(parseInt(cols[2]))) continue;
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
    const match = fullId.match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
    if (match) {
      const rack = match[1], shelf = match[2], slot = match[3], onuIdx = match[4];
      if (parseInt(slot) === parseInt(targetSlot)) {
        let status = 'offline';
        if (raw.toLowerCase().includes('working') || raw.toLowerCase().includes('online')) status = 'online';
        onus.push({ 
          onuId: onuIdx, 
          status, 
          name: `ONU ${onuIdx}`,
          interface: `${rack}/${shelf}/${slot}:${onuIdx}`,
          rxPower: 'N/A',
          txPower: 'N/A'
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
    // Pattern: 1/1/3:1    -20.123 (dBm)
    const match = raw.match(/(\d+)\/(\d+)\/(\d+):(\d+)\s+([-.\d]+)/);
    if (match) {
      const key = `${match[1]}/${match[2]}/${match[3]}:${match[4]}`;
      powers[key] = parseFloat(match[5]).toFixed(2);
    }
  }
  return powers;
}

class OltService {
  constructor() {
    this.ip = '';
    this.community = 'public';
    this.snmpPort = 161;
    this.telnetUser = '';
    this.telnetPass = '';
    this.snmpSession = null;
    this.history = [];
    this.maxHistory = 20;
    this.lastTraffic = { rx: 0, tx: 0, time: 0 };
  }

  setConfig(config) {
    this.ip = config.ip;
    this.community = config.community || 'public';
    this.snmpPort = parseInt(config.snmpPort) || 161;
    this.telnetUser = config.telnetUser || '';
    this.telnetPass = config.telnetPass || '';
    if (this.snmpSession) { this.snmpSession.close(); this.snmpSession = null; }
  }

  _getSnmpSession() {
    if (!this.snmpSession) {
      this.snmpSession = snmp.createSession(this.ip, this.community, {
        port: this.snmpPort, 
        timeout: 10000, // Increased to 10s for VPN stability
        retries: 3,     // Added retries
        version: snmp.Version2c
      });
    }
    return this.snmpSession;
  }

  async _snmpGet(oids) {
    console.log(`[OLT_DEBUG] SNMP Get from ${this.ip}:${this.snmpPort} (Community: ${this.community})...`);
    return new Promise((resolve, reject) => {
      this._getSnmpSession().get(oids, (err, vbs) => {
        if (err) { 
          console.error(`[OLT_DEBUG] SNMP Request Failed: ${err.message}`);
          this.snmpSession = null; 
          return reject(err); 
        }
        const res = {};
        vbs.forEach(vb => res[vb.oid] = snmp.isVarbindError(vb) ? null : vb.value);
        resolve(res);
      });
    });
  }

  async _telnetExec(commands) {
    console.log(`[OLT_DEBUG] Telnet connecting to ${this.ip}:23...`);
    const client = new Telnet();
    const results = [];
    try {
      await client.connect({
        host: this.ip, port: 23,
        loginPrompt: /(Username|Login):/i, passwordPrompt: /(Password|Passwrd):/i,
        shellPrompt: /[>#]\s*$/, username: this.telnetUser, password: this.telnetPass,
        timeout: 30000, // Increased to 30s
        execTimeout: 30000
      });
      console.log(`[OLT_DEBUG] Telnet connected to ${this.ip}. Running commands...`);
      await client.exec('enable').catch(() => {});
      await client.exec(this.telnetPass).catch(() => {});
      await client.exec('terminal length 0').catch(() => {});
      for (const cmd of commands) {
        const out = await client.exec(cmd);
        results.push({ cmd, output: out });
      }
      await client.end();
    } catch (err) { 
      console.error(`[OLT_DEBUG] Telnet Connection Failed: ${err.message}`);
      await client.end().catch(() => {}); throw err; 
    }
    return results;
  }

  async getChassisStatus() {
    if (!this.ip) throw new Error('OLT IP not configured');
    
    // Diagnostic Ping
    const isWin = process.platform === 'win32';
    const { execSync } = require('child_process');
    const pingCmd = isWin ? `ping -n 1 -w 1000 ${this.ip}` : `ping -c 1 -W 1 ${this.ip}`;
    try {
      execSync(pingCmd, { stdio: 'ignore' });
      console.log(`[OLT_DEBUG] [PING_SUCCESS] OLT ${this.ip} is reachable via ICMP.`);
    } catch (e) {
      console.warn(`[OLT_DEBUG] [PING_FAILED] OLT ${this.ip} is NOT reachable via ICMP. Route might be broken.`);
    }

    let uptime = 'N/A', model = 'ZTE ZXA10 C300', snmpOnline = false;
    let rxRate = 0, txRate = 0;

    try {
      // 1. Get Basic SNMP Info & Traffic
      // OID 1.3.6.1.2.1.2.2.1.10.1 & 16 are standard for first interface traffic
      const snmpData = await this._snmpGet([
        '1.3.6.1.2.1.1.5.0', // SysName
        '1.3.6.1.2.1.1.3.0', // Uptime
        '1.3.6.1.2.1.2.2.1.10.1', // InOctets (Uplink example)
        '1.3.6.1.2.1.2.2.1.16.1'  // OutOctets (Uplink example)
      ]);
      snmpOnline = true;
      if (snmpData['1.3.6.1.2.1.1.5.0']) model = snmpData['1.3.6.1.2.1.1.5.0'].toString();
      
      const ticks = parseInt(snmpData['1.3.6.1.2.1.1.3.0']);
      if (!isNaN(ticks)) {
        const d = Math.floor(ticks / 8640000), h = Math.floor((ticks / 360000) % 24), m = Math.floor((ticks / 6000) % 60);
        uptime = `${d}d ${h}h ${m}m`;
      }

      // Calculate Traffic Rate (Mbps)
      const now = Date.now();
      const currentRx = parseInt(snmpData['1.3.6.1.2.1.2.2.1.10.1']) || 0;
      const currentTx = parseInt(snmpData['1.3.6.1.2.1.2.2.1.16.1']) || 0;
      if (this.lastTraffic.time > 0) {
        const dt = (now - this.lastTraffic.time) / 1000;
        rxRate = Math.max(0, ((currentRx - this.lastTraffic.rx) * 8) / (1024 * 1024 * dt));
        txRate = Math.max(0, ((currentTx - this.lastTraffic.tx) * 8) / (1024 * 1024 * dt));
      }
      this.lastTraffic = { rx: currentRx, tx: currentTx, time: now };
    } catch (e) { console.warn('[OLT] SNMP Error:', e.message); }

    // 2. Get Telnet Info (Cards, CPU, Temp)
    let cards = [], cpu = 0, mem = 0, temp = 0;
    try {
      const tel = await this._telnetExec(['show card', 'show processor', 'show temperature']);
      cards = parseShowCard(tel[0].output);
      const proc = parseShowProcessor(tel[1].output);
      const tmp = parseShowTemperature(tel[2].output);
      cards.forEach(c => {
        if (proc[c.slot]) { c.cpu = proc[c.slot].cpu; c.memory = proc[c.slot].memory; }
        if (tmp[c.slot]) c.temp = tmp[c.slot];
      });
      const ctrl = cards.find(c => c.type.includes('SCT') || c.type.includes('SCX')) || cards[0];
      cpu = ctrl?.cpu || 0; mem = ctrl?.memory || 0; temp = ctrl?.temp || 0;
    } catch (e) { console.warn('[OLT] Telnet Error:', e.message); }

    const statusObj = {
      model, ip: this.ip, uptime, cpu, memory: mem, temperature: temp,
      status: snmpOnline ? 'online' : 'offline', cards,
      uplink: { rx: rxRate.toFixed(2), tx: txRate.toFixed(2) },
      timestamp: new Date().toLocaleTimeString()
    };

    this.history.push({ time: statusObj.timestamp, cpu, temp, rx: rxRate, tx: txRate });
    if (this.history.length > this.maxHistory) this.history.shift();
    statusObj.history = this.history;

    return statusObj;
  }

  async getOnuList(slot) {
    const res = await this._telnetExec([
      'show gpon onu state',
      `show pon power gpon-olt_1/1/${slot}`,
      `show pon power gpon-olt_0/1/${slot}`
    ]);
    const list = parseShowOnu(res[0].output, slot);
    const powers = parseOpticalPower(res[1].output + '\n' + res[2].output);
    list.forEach(onu => {
      onu.rxPower = powers[onu.interface] ? `${powers[onu.interface]} dBm` : 'N/A';
    });
    return list;
  }

  async getOnuDetail(slot, onuId) {
    const res = await this._telnetExec([`show onu running-config gpon-onu_1/1/${slot}:${onuId}`]).catch(() => 
                this._telnetExec([`show onu running-config gpon-onu_0/1/${slot}:${onuId}`]));
    return { output: res[0]?.output || 'Detail not found' };
  }
}

module.exports = new OltService();
