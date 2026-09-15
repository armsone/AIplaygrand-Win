const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, writeJSON, validateNotebook, validateTasks } = require('../storage');
const scratch = path.join(__dirname, '..', 'work');
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'portable-storage-'));
const notebook = draft => ({ version: 1, tasks: [], draft });

test('new notebook writes and preserves previous valid generation', () => {
  const file = path.join(root, 'notebook.json');
  writeJSON(file, notebook('첫 질문'));
  writeJSON(file, notebook('이어 쓴 질문'));
  assert.equal(readJSON(file).draft, '이어 쓴 질문');
  assert.equal(readJSON(`${file}.bak`).draft, '첫 질문');
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});

test('moving complete data folder retains notebook and team identifiers', () => {
  const origin = path.join(root, 'drive-E');
  fs.mkdirSync(origin);
  writeJSON(path.join(origin, 'profiles.json'), [{ id: 'starter-claude-1', name: '우리 팀원', provider: 'claude' }]);
  writeJSON(path.join(origin, 'notebook.json'), notebook('USB 이동 확인'));
  const moved = path.join(root, 'drive-F');
  fs.renameSync(origin, moved);
  assert.equal(readJSON(path.join(moved, 'notebook.json')).draft, 'USB 이동 확인');
  assert.equal(readJSON(path.join(moved, 'profiles.json'))[0].id, 'starter-claude-1');
  assert.equal(fs.existsSync(origin), false);
});

test('disconnected directory is not recreated and original survives', () => {
  const online = path.join(root, 'online');
  fs.mkdirSync(online);
  const file = path.join(online, 'notebook.json');
  writeJSON(file, notebook('기존 기록'));
  const offline = path.join(root, 'offline');
  fs.renameSync(online, offline);
  assert.throws(() => writeJSON(file, notebook('저장 실패')));
  assert.equal(fs.existsSync(online), false);
  assert.equal(readJSON(path.join(offline, 'notebook.json')).draft, '기존 기록');
});

test('failed final replacement preserves original and backup', () => {
  const file = path.join(root, 'failure.json');
  writeJSON(file, notebook('이전 기록'));
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('simulated device I/O failure'), { code: 'EIO' }); };
  try { assert.throws(() => writeJSON(file, notebook('새 기록'))); }
  finally { fs.renameSync = rename; }
  assert.equal(readJSON(file).draft, '이전 기록');
  assert.equal(readJSON(`${file}.bak`).draft, '이전 기록');
});

test('damaged source and missing source with backup never become an empty notebook', () => {
  const file = path.join(root, 'damaged.json');
  writeJSON(file, notebook('복구용'));
  writeJSON(file, notebook('최신'));
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readJSON(file, notebook('')));
  assert.throws(() => writeJSON(file, notebook('덮어쓰기 금지')));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(readJSON(`${file}.bak`).draft, '복구용');
  fs.renameSync(file, `${file}.damaged`);
  assert.throws(() => readJSON(file, notebook('')));
});

test('validation preserves paused state and rejects invalid and duplicate task IDs', () => {
  const item = { id: 'test-1', profileId: 'starter-claude-1', profileName: '팀원', provider: 'claude', prompt: '질문', result: '답변', status: 'paused', created: '2026-09-15T00:00:00Z' };
  assert.equal(validateTasks([item], false)[0].status, 'paused');
  assert.notEqual(validateTasks([item], false)[0].id, item.id);
  assert.throws(() => validateTasks([item, item]));
  assert.throws(() => validateTasks([{ ...item, id: '\" onclick=bad' }]));
  assert.throws(() => validateTasks([null]));
  assert.throws(() => validateNotebook({ version: 2, tasks: [], draft: '' }));
  assert.deepEqual(validateNotebook(notebook('한글 초안')), notebook('한글 초안'));
});
