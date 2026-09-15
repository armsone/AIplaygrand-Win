// Synthetic local-only cookie fixture. No network or real accounts involved.
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Vault } = require('../vault');
const { restoreCookies } = require('../session-transfer');
const [phase, root] = process.argv.slice(2);
if (!['write', 'read'].includes(phase) || !root || !path.isAbsolute(root)) throw new Error('Use write/read and an absolute fixture directory');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, `runtime-${phase}`));
app.whenReady().then(async () => {
  const vault = new Vault(path.join(root, 'fixture.vault'));
  const current = session.fromPartition(`fixture-${phase}`, { cache: false });
  const password = 'synthetic-test-passphrase-only';
  if (phase === 'write') {
    await current.cookies.set({ url: 'https://example.test/', name: 'fixture', value: 'synthetic-cookie-only', secure: true, httpOnly: true, sameSite: 'strict' });
    await vault.unlock(password, { profiles: [], notebook: { version: 1, tasks: [], draft: 'fixture' }, cookies: { seat: await current.cookies.get({}) } });
  } else {
    assert.equal((await current.cookies.get({})).length, 0);
    await vault.unlock(password);
    assert.deepEqual(await restoreCookies(current, vault.data.cookies.seat), { restored: 1, skipped: 0 });
    const cookies = await current.cookies.get({});
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, 'synthetic-cookie-only');
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].sameSite, 'strict');
  }
  vault.lock();
  console.log(`PASS native cookie ${phase}`);
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
