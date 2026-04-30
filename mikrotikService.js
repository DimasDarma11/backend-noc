const RouterOSClient = require('node-routeros').RouterOSAPI;

class MikrotikService {
  constructor() {
    this.ip   = '';
    this.user = '';
    this.pass = '';
    this.port = 12123;
  }

  setConfig({ ip, user, pass, port }) {
    this.ip   = ip;
    this.user = user;
    this.pass = pass;
    this.port = parseInt(port) || 12123;
  }

  async _connect() {
    console.log(`[Mikrotik] Connecting to ${this.ip}:${this.port} as ${this.user}`);
    const conn = new RouterOSClient({
      host: this.ip,
      user: this.user,
      password: this.pass,
      port: this.port,
      timeout: 10
    });
    await conn.connect();
    return conn;
  }

  async getStatus() {
    let conn;
    try {
      conn = await this._connect();
      const resource = await conn.write('/system/resource/print');
      const identity = await conn.write('/system/identity/print');
      await conn.close();

      const r = resource[0];
      const i = identity[0];

      return {
        identity: i.name,
        model:    r['board-name'],
        version:  r.version,
        cpu:      r['cpu-load'],
        uptime:   r.uptime,
        memory:   Math.round((parseInt(r['free-memory']) / parseInt(r['total-memory'])) * 100) || 0,
        status:   'online'
      };
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Koneksi Gagal [IP:${this.ip}]: ${err.message}`);
    }
  }

  async getSecrets() {
    let conn;
    try {
      conn = await this._connect();
      const secrets = await conn.write('/ppp/secret/print');
      await conn.close();
      
      return secrets.map(s => ({
        id:       s['.id'],
        name:     s.name,
        password: s.password,
        service:  s.service,
        profile:  s.profile,
        comment:  s.comment || '',
        disabled: s.disabled === 'true'
      }));
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Gagal ambil data PPPoE: ${err.message}`);
    }
  }

  async addSecret({ name, password, profile, service, comment }) {
    let conn;
    try {
      conn = await this._connect();
      const result = await conn.write('/ppp/secret/add', {
        name,
        password,
        profile: profile || 'default',
        service: service || 'pppoe',
        comment: comment || 'Added via Core NOC Dashboard'
      });
      await conn.close();
      return result;
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Gagal membuat PPPoE Secret: ${err.message}`);
    }
  }

  async deleteSecret(id) {
    let conn;
    try {
      conn = await this._connect();
      await conn.write('/ppp/secret/remove', { '.id': id });
      await conn.close();
      return true;
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Gagal menghapus PPPoE Secret: ${err.message}`);
    }
  }

  async getActiveUsers() {
    let conn;
    try {
      conn = await this._connect();
      const active = await conn.write('/ppp/active/print');
      await conn.close();
      
      return active.map(a => ({
        id:       a['.id'],
        name:     a.name,
        address:  a.address,
        uptime:   a.uptime,
        caller:   a['caller-id'] || '',
        service:  a.service
      }));
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Gagal ambil data user aktif: ${err.message}`);
    }
  }

  async disconnectUser(id) {
    let conn;
    try {
      conn = await this._connect();
      await conn.write('/ppp/active/remove', { '.id': id });
      await conn.close();
      return true;
    } catch (err) {
      if (conn) try { await conn.close(); } catch(e) {}
      throw new Error(`Gagal memutus koneksi user: ${err.message}`);
    }
  }
}

module.exports = new MikrotikService();
