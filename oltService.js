const snmp    = require('net-snmp');
const { Telnet } = require('telnet-client');
const pino = require('pino');
const PQueue = require('p-queue').default;

const logger = pino();

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
  try {
    const cards = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const raw = line.trim();
      if (!raw || raw.startsWith('Rack') || raw.startsWith('---')) continue;
      const match = raw.match(/^(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+).*?(\S+)$/);
      if (!match) continue;
      const slot     = parseInt(match[2]);
      const cfgType  = match[3];
      const realType = match[4];
      const ports    = parseInt(match[5]) || 0;
      const status   = match[6];
      const desc     = CARD_DESC[cfgType] || CARD_DESC.default;
      cards.push({ slot, type: cfgType, realType, ports, status, desc, cpu: null, memory: null, temp: 0 });
    }
    return cards;
  } catch (e) { return []; }
}

function parseShowProcessor(output) {
  try {
    const stats = {};
    const lines = output.split('\n');
    for (const line of lines) {
      const raw = line.trim();
      // ZTE show processor format varies, use robust regex tolerating optional % signs
      const match = raw.match(/^(\d+)\s+\d+\s+(\d+)\s+(\d+)%?.*?(\d+)%?$/);
      if (!match) continue;
      const slot = parseInt(match[2]);
      stats[slot] = { cpu: parseInt(match[3]) || 0, memory: parseInt(match[4]) || 0 };
    }
    return stats;
  } catch (e) { return {}; }
}

function parseShowTemperature(output) {
  try {
    const temps = {};
    const lines = output.split('\n');

    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;

      const nums = raw.match(/\d+/g);
      if (!nums || nums.length < 3) continue;

      const slot = parseInt(nums[2]);
      // Smart temp extraction: find realistic temp values (11 to 119 C)
      const tempNum = nums.find(n => parseInt(n) > 10 && parseInt(n) < 120);
      const temp = parseInt(tempNum) || 0;

      if (!isNaN(slot) && temp > 0) {
        temps[slot] = temp;
      }
    }

    return temps;
  } catch (e) { return {}; }
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
    // Pattern: 1/1/3:1    -20.123 (dBm) or without space
    const match = raw.match(/(\d+)\/(\d+)\/(\d+):(\d+)\s+([-.\d]+)\s*\(?dBm/i);
    if (match) {
      const key = `${match[1]}/${match[2]}/${match[3]}:${match[4]}`;
      powers[key] = parseFloat(match[5]).toFixed(2);
    }
  }
  return powers;
}

class OltService {
  _validateNumber(value, name) {
    if (!/^\d+$/.test(String(value))) {
      throw new Error(`Invalid ${name}`);
    }
  }

  constructor() {
    this.ip = '';
    this.community = 'public';
    this.snmpPort = 161;
    this.telnetUser = '';
    this.telnetPass = '';
    this.enablePass = '';
    this.gponPath = '1/1';
    this.uplinkIndex = '1';
    this.snmpSession = null;
    this.snmpCreatedAt = 0;
    this.pendingStatusPromise = null;
    this.history = [];
    this.maxHistory = 20;
    this.lastTraffic = { rx: 0n, tx: 0n, time: 0 };
    this.cache = { statusObj: null, timestamp: 0 };
    this.onuDetailCache = {};
    this.onuListCache = {};
    
    this.snmpFail = 0;
    this.telnetFail = 0;
    this.blockPollingUntil = 0;

    this.telnetQueue = new PQueue({ concurrency: 1 });

    // Cache cleanup daemon running every 60s
    this.cacheCleaner = setInterval(() => {
      const now = Date.now();
      for (const key in this.onuDetailCache) {
        if (now - this.onuDetailCache[key].timestamp > 60000) delete this.onuDetailCache[key];
      }
      for (const key in this.onuListCache) {
        if (now - this.onuListCache[key].timestamp > 15000) delete this.onuListCache[key];
      }
    }, 60000);

    // Memory Usage Guard
    this.memGuard = setInterval(() => {
      const mem = process.memoryUsage().heapUsed / 1024 / 1024;
      if (mem > 500) {
        logger.error('[CRITICAL] Memory Leak Suspected (Heap > 500MB)');
      }
    }, 60000);

    process.on('SIGTERM', () => this.destroy());
  }

  destroy() {
    try {
      if (this.cacheCleaner) {
        clearInterval(this.cacheCleaner);
        this.cacheCleaner = null;
      }
      if (this.memGuard) {
        clearInterval(this.memGuard);
        this.memGuard = null;
      }
      if (this.snmpSession) {
        this.snmpSession.close();
        this.snmpSession = null;
      }
      if (this.telnetQueue) {
        this.telnetQueue.clear();
      }
      logger.info('[OLT] Service Destroyed Gracefully.');
    } catch (e) {
      logger.error('[OLT] Destroy Error: ' + e.message);
    }
  }

  setConfig(config) {
    this.ip = config.ip;
    this.community = config.community || 'public';
    this.snmpPort = parseInt(config.snmpPort) || 161;
    this.telnetUser = config.telnetUser || '';
    this.telnetPass = config.telnetPass || '';
    this.enablePass = config.enablePass || config.telnetPass || '';
    this.gponPath = config.gponPath || '1/1';
    this.uplinkIndex = config.uplinkIndex || '1';
    
    // Protection against path injection!
    if (!/^\d+\/\d+$/.test(this.gponPath)) {
      throw new Error('Invalid GPON path configuration. Must be format Rack/Shelf.');
    }

    if (this.snmpSession) { this.snmpSession.close(); this.snmpSession = null; }
  }

  _getSnmpSession() {
    const now = Date.now();
    // Auto-recreate UDP SNMP session if it's a zombie (>5 mins old)
    if (this.snmpSession && (now - this.snmpCreatedAt > 300000)) {
      this.snmpSession.close();
      this.snmpSession = null;
    }
    if (!this.snmpSession) {
      this.snmpCreatedAt = now;
      this.snmpSession = snmp.createSession(this.ip, this.community, {
        port: this.snmpPort, 
        timeout: 10000,
        retries: 3,
        version: snmp.Version2c
      });
    }
    return this.snmpSession;
  }

  async _snmpGet(oids) {
    logger.info(`[OLT] SNMP Get from ${this.ip}:${this.snmpPort} (Community: *****)...`);
    return Promise.race([
      new Promise((resolve, reject) => {
        this._getSnmpSession().get(oids, (err, vbs) => {
          if (err) { 
            logger.error(`[OLT] SNMP Request Failed: ${err.message}`);
            if (this.snmpSession) {
              this.snmpSession.close();
              this.snmpSession = null;
            }
            return reject(err); 
          }
          const res = {};
          vbs.forEach(vb => res[vb.oid] = snmp.isVarbindError(vb) ? null : vb.value);
          resolve(res);
        });
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          try {
            if (this.snmpSession) {
              this.snmpSession.close();
              this.snmpSession = null;
            }
          } catch (e) {}
          reject(new Error('SNMP timeout (Hard Kill)'));
        }, 12000);
      })
    ]);
  }

  async _telnetExec(commands) {
    try {
      await client.connect({
        host: this.ip, port: 23,
        loginPrompt: /(Username|Login):/i, passwordPrompt: /(Password|Passwrd):/i,
        shellPrompt: /[>#]\s*$/, username: this.telnetUser, password: this.telnetPass,
        timeout: 10000, 
        execTimeout: 10000 
      });
      console.log(`[OLT_DEBUG] Telnet connected to ${this.ip}. Running commands...`);
      await execWithTimeout('enable').catch(() => {});
      await execWithTimeout(this.enablePass).catch(() => {});
      await execWithTimeout('terminal length 0').catch(() => {});
      for (const cmd of commands) {
        const out = await execWithTimeout(cmd);
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
    
    // Command Injection Protection!
    const net = require('net');
    if (!net.isIP(this.ip)) throw new Error('Invalid IP Address Format');

    // Mutex Polling Lock to prevent Cache Race Conditions
    if (this.pendingStatusPromise) {
      return await this.pendingStatusPromise;
    }

    this.pendingStatusPromise = Promise.race([
      (async () => {
        try {
          if (Date.now() < this.blockPollingUntil) {
            throw new Error('OLT temporarily unavailable (Fail Backoff Active)');
          }

          const now = Date.now();
        // Use Cache if under 5 seconds to prevent polling DoS on OLT CPU
        if (this.cache.statusObj && (now - this.cache.timestamp < 5000)) {
          return this.cache.statusObj;
        }

        // Diagnostic Ping (Async with hard timeout)
        const isWin = process.platform === 'win32';
        const { exec } = require('child_process');
        const pingCmd = isWin ? `ping -n 1 -w 1000 ${this.ip}` : `ping -c 1 -W 1 ${this.ip}`;
        let isReachable = await new Promise(resolve => exec(pingCmd, { timeout: 3000 }, err => resolve(!err)));

        let uptime = 'N/A', model = 'ZTE ZXA10 C300', snmpOnline = false, telnetOnline = false;
        let rxRate = 0, txRate = 0;
        let cards = [], cpu = 0, mem = 0, temp = 0;

        const inOid = `1.3.6.1.2.1.31.1.1.1.6.${this.uplinkIndex}`; // ifHCInOctets (64-bit)
        const outOid = `1.3.6.1.2.1.31.1.1.1.10.${this.uplinkIndex}`; // ifHCOutOctets (64-bit)

        // Promise.allSettled ensures maximal concurrency: cuts latency in half!
        const [snmpResult, telnetResult] = await Promise.allSettled([
          this._snmpGet([
            '1.3.6.1.2.1.1.5.0', // SysName
            '1.3.6.1.2.1.1.3.0', // Uptime
            inOid,
            outOid 
          ]),
          this._telnetExec(['show card', 'show processor', 'show temperature'])
        ]);

        if (snmpResult.status === 'fulfilled') {
          const snmpData = snmpResult.value;
          snmpOnline = true;
          if (snmpData['1.3.6.1.2.1.1.5.0']) model = snmpData['1.3.6.1.2.1.1.5.0'].toString();
          
          const ticks = parseInt(snmpData['1.3.6.1.2.1.1.3.0']);
          if (!isNaN(ticks)) {
            const d = Math.floor(ticks / 8640000), h = Math.floor((ticks / 360000) % 24), m = Math.floor((ticks / 6000) % 60);
            uptime = `${d}d ${h}h ${m}m`;
          }

          // Calculate Traffic Rate (Mbps) using BigInt to prevent precision loss
          let currentRx = 0n, currentTx = 0n;
          if (snmpData[inOid]) currentRx = BigInt(snmpData[inOid].toString());
          if (snmpData[outOid]) currentTx = BigInt(snmpData[outOid].toString());

          if (this.lastTraffic.time > 0) {
            const dt = (now - this.lastTraffic.time) / 1000;
            
            const rxDiff = currentRx - this.lastTraffic.rx;
            const txDiff = currentTx - this.lastTraffic.tx;

            if (rxDiff >= 0n && dt <= 300) {
              rxRate = Number(rxDiff * 8n) / (1024 * 1024 * dt);
            }

            if (txDiff >= 0n && dt <= 300) {
              txRate = Number(txDiff * 8n) / (1024 * 1024 * dt);
            }
          }
          this.lastTraffic = { rx: currentRx, tx: currentTx, time: now };
        } else {
          logger.warn('[OLT] SNMP Error: ' + snmpResult.reason.message);
          this.snmpFail++;
        }

        if (telnetResult.status === 'fulfilled') {
          this.telnetFail = 0;
          telnetOnline = true;
          const tel = telnetResult.value;
          cards = parseShowCard(tel[0]?.output || '');
          const proc = parseShowProcessor(tel[1]?.output || '');
          const tmp = parseShowTemperature(tel[2]?.output || '');
          cards.forEach(c => {
            if (proc[c.slot]) { c.cpu = proc[c.slot].cpu; c.memory = proc[c.slot].memory; }
            if (tmp[c.slot]) c.temp = tmp[c.slot];
          });
          const ctrl = cards.find(c => c.type.includes('SCT') || c.type.includes('SCX')) || cards[0];
          cpu = ctrl?.cpu || 0; mem = ctrl?.memory || 0; temp = ctrl?.temp || 0;
        } else {
          logger.warn('[OLT] Telnet Error: ' + telnetResult.reason.message);
          this.telnetFail++;
        }

        if (this.snmpFail >= 5 || this.telnetFail >= 5) {
          this.blockPollingUntil = Date.now() + 30000; // Trigger Circuit Breaker
          this.snmpFail = 0;
          this.telnetFail = 0;
        }

        if (!Array.isArray(this.history)) {
          this.history = [];
        }

        const statusObj = {
          model, ip: this.ip, uptime, cpu, memory: mem, temperature: temp,
          status: (snmpOnline || telnetOnline) ? 'online' : 'offline',
          connection: { snmp: snmpOnline, telnet: telnetOnline, reachable: isReachable },
          cards,
          uplink: { rx: rxRate.toFixed(2), tx: txRate.toFixed(2) },
          timestamp: new Date().toLocaleTimeString()
        };

        this.history.push({ time: statusObj.timestamp, cpu, temp, rx: rxRate, tx: txRate });
        
        // Defensive hard limit over history
        if (this.history.length > 1000) this.history = this.history.slice(-this.maxHistory);
        else if (this.history.length > this.maxHistory) this.history.shift();

        statusObj.history = this.history;

        this.cache.statusObj = statusObj;
        this.cache.timestamp = Date.now(); // Cache timer starts AFTER polling completes!

        return statusObj;
      } catch (e) {
        throw e;
      } finally {
        this.pendingStatusPromise = null;
      }
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Whole Polling timeout (Deadlock Guard)')), 15000))
  ]);
    
    return this.pendingStatusPromise;
  }

  async getOnuList(slot) {
    this._validateNumber(slot, 'slot');

    // 15s TTL Cache to save massive OLT CPU cycles on page refresh
    const cacheKey = `list-${slot}`;
    const now = Date.now();
    if (this.onuListCache[cacheKey] && (now - this.onuListCache[cacheKey].timestamp < 15000)) {
      return this.onuListCache[cacheKey].data;
    }

    // Optical power split to a different endpoint for massive CLI speed gain
    const res = await this._telnetExec([
      `show gpon onu state gpon-olt_${this.gponPath}/${slot}`
    ]);
    const list = parseShowOnu(res[0].output, slot);
    
    this.onuListCache[cacheKey] = { timestamp: now, data: list };
    return list;
  }

  async getOnuOptical(slot) {
    this._validateNumber(slot, 'slot');
    const res = await this._telnetExec([
      `show pon power gpon-olt_${this.gponPath}/${slot}`
    ]);
    return parseOpticalPower(res[0].output);
  }

  async getOnuDetail(slot, onuId) {
    this._validateNumber(slot, 'slot');
    this._validateNumber(onuId, 'onuId');

    const cacheKey = `${slot}-${onuId}`;
    const now = Date.now();

    // 30 Seconds Safe TTL Cache to prevent Frontend Spam Click DoS on OLT CPU
    if (this.onuDetailCache[cacheKey] && (now - this.onuDetailCache[cacheKey].timestamp < 30000)) {
      return this.onuDetailCache[cacheKey].data;
    }

    const res = await this._telnetExec([`show onu running-config gpon-onu_${this.gponPath}/${slot}:${onuId}`]);
    const data = { output: res[0]?.output || 'Detail not found' };
    
    this.onuDetailCache[cacheKey] = { timestamp: now, data };
    return data;
  }
}

module.exports = new OltService();

process.on('unhandledRejection', (err) => {
  console.error('[CRITICAL] Unhandled Promise Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
