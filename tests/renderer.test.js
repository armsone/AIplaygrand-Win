const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

async function boot() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, events: {}, classList: { add() {}, remove() {} }, addEventListener(name, fn) { this.events[name] = fn; } });
    return elements.get(id);
  };
  element('statusFilter').value = 'all';
  const task = { id: 'task-1', profileId: 'starter-claude-1', profileName: '팀원', provider: 'claude', prompt: '첫 질문', result: '', status: 'queued', created: '2026-09-15T00:00:00Z' };
  const state = { saved: [], finished: false, canceled: false, fail: false };
  const api = {
    vaultStatus: async () => ({ unlocked: true }),
    onVaultSaveError() {},
    checkResources: async () => ({ tools: [], platform: 'test', arch: 'test', ramGB: 8, freeGB: 8 }),
    readNotebook: async () => ({ notebook: { version: 1, tasks: [task], draft: '' }, path: '/USB/Data', mode: 'USB' }),
    listProfiles: async () => [{ id: 'starter-claude-1', name: '팀원', provider: 'claude' }],
    saveNotebook: async value => { if (state.fail) throw new Error('USB write failed'); state.saved.push(structuredClone(value)); return new Date().toISOString(); },
    onPrepareExit: fn => { state.exit = fn; },
    finishExit: async () => { state.finished = true; },
    cancelExit: async () => { state.canceled = true; }
  };
  const context = vm.createContext({ document: { getElementById: element }, window: { playground: api }, providers: require('../providers'), structuredClone, crypto: require('node:crypto').webcrypto, setTimeout: () => 0, clearTimeout() {}, confirm: () => true });
  vm.runInContext(code, context);
  await new Promise(setImmediate);
  return { element, state };
}

test('exit immediately after input saves pending answer and question drafts', async () => {
  const { element, state } = await boot();
  element('prompt').value = '종료 직전의 한글 질문';
  element('prompt').events.input();
  element('tasks').events.input({ target: { id: 'result-task-1', value: '마지막 한글 답변' } });
  await state.exit();
  assert.equal(state.saved.at(-1).draft, '종료 직전의 한글 질문');
  assert.equal(state.saved.at(-1).tasks[0].result, '마지막 한글 답변');
  assert.equal(state.finished, true);
});

test('save failure blocks exit, preserves input, and supports retry', async () => {
  const { element, state } = await boot();
  state.fail = true;
  element('prompt').value = 'USB 재연결 후 저장할 질문';
  await state.exit();
  assert.equal(state.finished, false);
  assert.equal(state.canceled, true);
  assert.equal(element('workspace').inert, false);
  assert.equal(element('storageError').hidden, false);
  assert.equal(element('prompt').value, 'USB 재연결 후 저장할 질문');
  state.fail = false;
  await state.exit();
  assert.equal(state.finished, true);
  assert.equal(state.saved.at(-1).draft, 'USB 재연결 후 저장할 질문');
});

test('search rerender retains unsaved answer and filters actual result text', async () => {
  const { element, state } = await boot();
  element('tasks').events.input({ target: { id: 'result-task-1', value: '찾아볼 답변 키워드' } });
  element('search').value = '없는말';
  element('search').events.input();
  assert.match(element('tasks').innerHTML, /조건에 맞는 기록이 없어요/);
  element('search').value = '키워드';
  element('search').events.input();
  assert.match(element('tasks').innerHTML, /찾아볼 답변 키워드/);
  await state.exit();
  assert.equal(state.saved.at(-1).tasks[0].result, '찾아볼 답변 키워드');
});
