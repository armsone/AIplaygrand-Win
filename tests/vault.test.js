const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Vault } = require('../vault');
const { restoreCookies } = require('../session-transfer');
const { psQuote, shQuote } = require('../cli-tools');
const providers = require('../providers');
const { validateTasks } = require('../storage');
fs.mkdirSync(path.join(__dirname, '..', 'work'), { recursive: true });
const root = fs.mkdtempSync(path.join(__dirname, '..', 'work', 'vault-test-'));
const payload = { profiles: [], notebook: { version: 1, tasks: [], draft: 'private-fixture-draft' }, cookies: { seat: [{ name: 'fixture', value: 'synthetic-cookie-only' }] } };
const password = 'synthetic-test-passphrase-only';

test('encrypted archive survives new instance and folder move, without plaintext or password on disk', async () => {
  const file = path.join(root, 'first.vault');
  const first = new Vault(file);
  await first.unlock(password, payload);
  first.save({ ...payload, notebook: { ...payload.notebook, draft: 'second-fixture-draft' } });
  for (const filename of [file, `${file}.bak`]) {
    const disk = fs.readFileSync(filename, 'utf8');
    for (const secret of [password, 'private-fixture-draft', 'second-fixture-draft', 'synthetic-cookie-only']) assert(!disk.includes(secret));
  }
  first.lock(); assert.throws(() => first.requireOpen());
  const destination = path.join(root, 'moved.vault'); fs.copyFileSync(file, destination);
  const second = new Vault(destination); await second.unlock(password);
  assert.equal(second.data.notebook.draft, 'second-fixture-draft'); second.lock();
});

test('wrong password and modified ciphertext do not change the original', async () => {
  const file = path.join(root, 'tamper.vault');
  const vault = new Vault(file); await vault.unlock(password, payload); vault.lock();
  const original = fs.readFileSync(file);
  await assert.rejects(vault.unlock('wrong-fixture-passphrase'));
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(vault.key, null);
  const envelope = JSON.parse(original); const bytes = Buffer.from(envelope.body, 'base64'); bytes[0] ^= 1; envelope.body = bytes.toString('base64'); fs.writeFileSync(file, JSON.stringify(envelope));
  await assert.rejects(vault.unlock(password)); assert.equal(vault.data, null);
});

test('cookie restore preserves scope and security flags, skips expired and malformed data', async () => {
  const received = [];
  const result = await restoreCookies({ cookies: { set: async value => received.push(value) } }, [
    { name: 'fixture', value: 'fixture', domain: 'example.test', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'strict' },
    { name: 'expired', value: 'fixture', domain: '.example.test', expirationDate: 1 },
    { name: 'bad', value: 'fixture', domain: 'bad/path' }
  ]);
  assert.deepEqual(result, { restored: 1, skipped: 2 });
  assert.equal(received[0].url, 'https://example.test/'); assert.equal(received[0].httpOnly, true);
  assert.equal(received[0].sameSite, 'strict'); assert.equal(received[0].domain, undefined);
});

test('three providers and Codex records retain their identity; command quoting protects literals', () => {
  assert.deepEqual(Object.keys(providers), ['claude', 'gemini', 'codex']);
  assert.equal(providers.codex.url, 'https://chatgpt.com/codex');
  const task = { id: 'codex-1', profileId: 'seat-1', profileName: '팀원', provider: 'codex', prompt: '질문', result: '', status: 'queued', created: new Date().toISOString() };
  assert.equal(validateTasks([task])[0].provider, 'codex');
  assert.equal(psQuote("E:\\team's USB\\$x"), "'E:\\team''s USB\\$x'");
  assert.equal(shQuote("a'b"), "'a'\\''b'");
});
