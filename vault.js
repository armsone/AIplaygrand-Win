const crypto = require('node:crypto');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { readJSON, writeJSON } = require('./storage');
const derive = promisify(crypto.scrypt);
const AAD = Buffer.from('AIplaygrand-vault-v1|scrypt-32768-8-1|aes-256-gcm');
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class Vault {
  constructor(file) { this.file = file; this.key = null; this.data = null; this.salt = null; }
  exists() { return fs.existsSync(this.file) || fs.existsSync(`${this.file}.bak`); }
  requireOpen() { if (!this.key || !this.data) throw new Error('보관함 비밀번호를 먼저 입력하세요.'); }
  async unlock(password, initial) {
    if (this.key) throw new Error('이미 열린 보관함입니다.');
    if (typeof password !== 'string') throw new Error('보관함 비밀번호 형식을 확인하세요.');
    let salt, envelope;
    const existing = this.exists();
    if (existing) {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 40 * 1024 * 1024) throw new Error('보관함 파일이 너무 큽니다.');
      envelope = readJSON(this.file);
      if (!envelope || envelope.version !== 1 || envelope.kdf !== 'scrypt-32768-8-1' || !/^[a-f0-9]{32}$/.test(envelope.salt) || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag) || typeof envelope.body !== 'string') throw new Error('보관함 형식이 올바르지 않습니다. 원본을 보존하세요.');
      salt = Buffer.from(envelope.salt, 'hex');
    } else salt = crypto.randomBytes(16);
    const key = await derive(password, salt, 32, options);
    try {
      let data;
      if (existing) {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
        decipher.setAAD(AAD);
        decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
        const plain = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]);
        try { data = JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
      } else data = initial;
      if (!data || !Array.isArray(data.profiles) || !data.notebook || !data.cookies || typeof data.cookies !== 'object') throw new Error('Invalid payload');
      this.key = key; this.salt = salt; this.data = data;
      if (!existing) this.save(data);
    } catch {
      key.fill(0); this.key = null; this.data = null; this.salt = null;
      throw new Error(existing ? '비밀번호가 다르거나 보관함이 손상되었습니다. 기존 파일은 바꾸지 않았어요.' : '보관함을 만들지 못했어요. USB의 쓰기 권한과 여유 공간을 확인하세요.');
    }
  }
  save(data) {
    this.requireOpen();
    const plain = Buffer.from(JSON.stringify(data));
    if (plain.length > 25 * 1024 * 1024) { plain.fill(0); throw new Error('보관함이 25MB를 넘었어요. 기록을 정리해 주세요.'); }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    let body;
    try { body = Buffer.concat([cipher.update(plain), cipher.final()]); } finally { plain.fill(0); }
    writeJSON(this.file, { version: 1, kdf: 'scrypt-32768-8-1', salt: this.salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), body: body.toString('base64') });
    this.data = structuredClone(data);
  }
  lock() { this.key?.fill(0); this.key = null; this.salt = null; this.data = null; }
}
module.exports = { Vault };
