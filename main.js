const { app, BrowserWindow, ipcMain, dialog, clipboard, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const providers = require('./providers');
const { Vault } = require('./vault');
const { restoreCookies } = require('./session-transfer');
const { createCliManager } = require('./cli-tools');
const { createRelay } = require('./relay');
const { readJSON, writeJSON, validateTasks, validateNotebook } = require('./storage');

const portableRoot = app.isPackaged
  ? (process.platform === 'darwin' ? path.resolve(app.getPath('exe'), '../../../..') : path.dirname(app.getPath('exe')))
  : __dirname;
const dataRoot = path.join(portableRoot, 'Data');
const deviceKey = crypto.createHash('sha256').update(`${process.platform}|${os.hostname()}|${os.userInfo().username}`).digest('hex').slice(0, 20);
let startupError;
try {
  fs.mkdirSync(dataRoot, { recursive: true });
  const probe = path.join(dataRoot, `.write-check-${crypto.randomUUID()}`);
  fs.writeFileSync(probe, '', { flag: 'wx' }); fs.unlinkSync(probe);
  const runtime = path.join(dataRoot, 'Browser', deviceKey);
  for (const folder of [runtime, path.join(dataRoot, 'Downloads'), path.join(dataRoot, 'Logs'), path.join(dataRoot, 'Crashes')]) fs.mkdirSync(folder, { recursive: true });
  app.setPath('userData', runtime);
  app.setPath('sessionData', runtime);
  app.setPath('logs', path.join(dataRoot, 'Logs'));
  app.setPath('crashDumps', path.join(dataRoot, 'Crashes'));
  app.setPath('downloads', path.join(dataRoot, 'Downloads'));
} catch (error) { startupError = error; }

let mainWindow;
const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('허용되지 않은 요청입니다.');
  return handler(event, ...args);
});
const browserWindows = new Map();
const sessions = new Set();
let quitting = false;
let exitRequested = false;
const profilesPath = () => path.join(dataRoot, 'profiles.json');
const notebookPath = path.join(dataRoot, 'notebook.json');
const vault = new Vault(path.join(dataRoot, 'team.vault'));
const cli = createCliManager(dataRoot, shell, app.getPath('appData'));
handle('cli:check', () => cli.check());
handle('cli:help', (_event, id) => cli.help(id));
handle('cli:install', (_event, id) => { vault.requireOpen(); return cli.install(id); });
handle('cli:launch', async (_event, { provider, prompt }) => {
  vault.requireOpen();
  if (typeof prompt !== 'string') throw new Error('질문 내용을 확인하세요.');
  if (prompt) clipboard.writeText(prompt);
  await cli.launch(provider);
  return true;
});
// Relay data lives in its own vault field; every write re-reads vault.data so notebook,
// cookie and relay saves never overwrite each other (all saves are synchronous).
// VAULT_CAPACITY mirrors the hard limit in vault.js so the relay can refuse to start before
// a run could push the vault over it (it never deletes history to make room).
const VAULT_CAPACITY = 25 * 1024 * 1024;
const relay = createRelay({
  dataRoot,
  cli,
  store: {
    read: () => (vault.requireOpen(), vault.data.relay),
    write: value => { vault.requireOpen(); vault.save({ ...vault.data, relay: value }); },
    bytes: () => (vault.requireOpen(), Buffer.byteLength(JSON.stringify(vault.data))),
    capacity: VAULT_CAPACITY
  },
  emit: event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('relay:event', event); }
});
handle('relay:state', () => relay.state());
handle('relay:load', (_event, id) => relay.load(id));
handle('relay:delete', (_event, id) => { vault.requireOpen(); return relay.remove(id); });
handle('relay:start', (_event, input) => {
  vault.requireOpen();
  if (exitRequested) throw new Error('앱을 닫는 중이라 새 릴레이를 시작할 수 없어요.');
  if (chat.isActive()) throw new Error('CLI 대화가 이미 진행 중이에요. 먼저 대화를 중지하세요.');
  return relay.start(input);
});
handle('relay:stop', () => relay.stop());

const chat = createRelay({
  dataRoot,
  cli,
  stageCount: 1,
  workspaceDir: path.join(dataRoot, 'Chat', 'workspace'),
  label: 'CLI 대화',
  defaultStages: [{ provider: 'claude', role: '대화를 이어가는 친절한 학습 도우미. 텍스트로만 답하세요.' }],
  store: {
    read: () => (vault.requireOpen(), vault.data.cliChat),
    write: value => { vault.requireOpen(); vault.save({ ...vault.data, cliChat: value }); },
    bytes: () => (vault.requireOpen(), Buffer.byteLength(JSON.stringify(vault.data))),
    capacity: VAULT_CAPACITY
  },
  emit: event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:event', event); }
});
handle('chat:state', () => chat.state());
handle('chat:load', (_event, id) => chat.load(id));
handle('chat:delete', (_event, id) => { vault.requireOpen(); return chat.remove(id); });
handle('chat:start', (_event, input) => {
  vault.requireOpen();
  if (exitRequested) throw new Error('앱을 닫는 중이라 새 대화를 시작할 수 없어요.');
  if (relay.isActive()) throw new Error('팀 릴레이가 이미 진행 중이에요. 먼저 릴레이를 중지하세요.');
  return chat.start(input);
});
handle('chat:stop', () => chat.stop());
const browserSessions = new Map();
const sessionReady = new Map();
const runId = crypto.randomUUID();
let unlockBusy = false;
let cookieTimer;
let cookieSaveChain = Promise.resolve();

function writeProfiles(items) {
  vault.requireOpen();
  vault.save({ ...vault.data, profiles: items });
}

function readLegacyProfiles() {
  let contents;
  try {
    contents = fs.readFileSync(profilesPath(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const starter = [
      { id: 'starter-claude-1', name: 'Claude 팀원 1', provider: 'claude' },
      { id: 'starter-claude-2', name: 'Claude 팀원 2', provider: 'claude' },
      { id: 'starter-gemini-1', name: 'Gemini 팀원 1', provider: 'gemini' }
    ];
    return starter;
  }
  const profiles = JSON.parse(contents);
  if (!Array.isArray(profiles) || profiles.some(p => !p || !/^[a-zA-Z0-9-]{1,100}$/.test(p.id) || typeof p.name !== 'string' || p.name.length > 120 || !Object.hasOwn(providers, p.provider)) || new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('팀원 목록 파일을 읽을 수 없습니다. 파일을 보존하고 지원을 요청해 주세요.');
  return profiles;
}

function readProfiles() {
  vault.requireOpen();
  return structuredClone(vault.data.profiles);
}

function saveSessions() {
  clearTimeout(cookieTimer);
  cookieSaveChain = cookieSaveChain.catch(() => {}).then(async () => {
    vault.requireOpen();
    const snapshots = await Promise.all([...browserSessions].map(async ([id, current]) => [id, await current.cookies.get({})]));
    const cookies = { ...vault.data.cookies };
    for (const [id, values] of snapshots) cookies[id] = values;
    vault.save({ ...vault.data, cookies });
  });
  return cookieSaveChain;
}

function scheduleSessionSave() {
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(() => saveSessions().catch(() => {
    mainWindow?.webContents.send('vault:save-error');
  }), 1000);
}

handle('vault:status', () => ({
  exists: vault.exists(),
  legacy: fs.existsSync(profilesPath()) || fs.existsSync(notebookPath),
  unlocked: !!vault.key
}));
handle('vault:unlock', async (_event, password) => {
  if (unlockBusy) throw new Error('비밀번호 확인 중입니다.');
  unlockBusy = true;
  try {
    const initial = vault.exists() ? undefined : {
      profiles: readLegacyProfiles(),
      notebook: validateNotebook(readJSON(notebookPath, { version: 1, tasks: [], draft: '' })),
      cookies: {}
    };
    await vault.unlock(password, initial);
    validateNotebook(vault.data.notebook);
    if (vault.data.profiles.some(p => !p || typeof p.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(p.id) || typeof p.name !== 'string' || !Object.hasOwn(providers, p.provider))) throw new Error('팀원 목록을 읽지 못했습니다.');
    // Runs left "running" by a crash or forced exit become interrupted; nothing restarts automatically.
    try { relay.markInterrupted(); } catch (error) { mainWindow?.webContents.send('relay:event', { type: 'save-error', message: error.message }); }
    try { chat.markInterrupted(); } catch (error) { mainWindow?.webContents.send('chat:event', { type: 'save-error', message: error.message }); }
    return true;
  } catch (error) { vault.lock(); throw error; }
  finally { password = ''; unlockBusy = false; }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 780,
    minHeight: 620,
    backgroundColor: '#f4f5ef',
    title: 'AIplaygrand-Win',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('close', event => {
    if (!quitting) { event.preventDefault(); requestExit(); }
  });
}

app.whenReady().then(() => {
  if (startupError) {
    dialog.showErrorBox('USB 저장 폴더를 열 수 없어요', `실행 파일 옆 Data 폴더에 쓸 수 있어야 합니다. ZIP 전체를 쓰기 가능한 USB에 풀고 다시 실행하세요.\n${dataRoot}\n${startupError.message}`);
    app.exit(1); return;
  }
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  sessions.add(session.defaultSession);
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

function requestExit() {
  if (exitRequested) return;
  exitRequested = true;
  mainWindow?.webContents.send('storage:prepare-exit');
}

app.on('before-quit', event => {
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) { event.preventDefault(); requestExit(); }
});

handle('storage:read', () => ({
  notebook: (vault.requireOpen(), validateNotebook(vault.data.notebook)),
  path: dataRoot,
  mode: app.isPackaged ? 'USB · 실행 폴더 저장' : '개발 폴더 저장'
}));
handle('storage:save', (_event, value) => {
  vault.requireOpen();
  vault.save({ ...vault.data, notebook: validateNotebook(value) });
  return new Date().toISOString();
});
handle('storage:folder', () => shell.openPath(dataRoot));
handle('storage:request-exit', () => requestExit());
handle('storage:cancel-exit', () => {
  exitRequested = false;
  relay.cancelShutdown();
  chat.cancelShutdown();
});
handle('storage:finish-exit', async () => {
  // Stop the owned CLI children first. If either cannot be settled, keep the app open with explanatory error;
  // nothing is locked or marked finished.
  try {
    await Promise.all([relay.shutdown(), chat.shutdown()]);
  } catch (error) {
    exitRequested = false;
    relay.cancelShutdown();
    chat.cancelShutdown();
    throw error;
  }
  try {
    if (vault.key) {
      for (const window of BrowserWindow.getAllWindows()) if (window !== mainWindow) window.destroy();
      await saveSessions();
    }
    // Finish browser disk writes before releasing file handles. Windows eject is still needed.
    for (const current of sessions) {
      current.flushStorageData();
      await current.cookies.flushStore();
    }
    vault.lock();
    quitting = true;
    app.quit();
  } catch {
    exitRequested = false;
    relay.cancelShutdown();
    chat.cancelShutdown();
    throw new Error('브라우저 저장을 마치지 못했어요. USB 연결을 확인하고 다시 종료하세요.');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The listing normalises the optional opt-in to an explicit boolean for display only. Nothing is
// written back here, so profiles that never opted in keep no field in the vault (absent = false).
handle('profiles:list', () => readProfiles().map(profile => ({ ...profile, autoHandoffConsent: profile.autoHandoffConsent === true })));

handle('profiles:add', (_event, input) => {
  const name = input?.name?.trim();
  const provider = input?.provider;
  if (!name || name.length > 120 || !Object.hasOwn(providers, provider)) {
    throw new Error('팀원 이름과 사용할 서비스를 확인해 주세요.');
  }
  const profile = { id: crypto.randomUUID(), name, provider };
  const profiles = readProfiles();
  profiles.push(profile);
  writeProfiles(profiles);
  return profile;
});

handle('profiles:delete', (_event, id) => {
  writeProfiles(readProfiles().filter(profile => profile.id !== id));
  return true;
});

// Per-profile opt-in for the web handoff timer ("my turn: copy the question and open my web
// window after 5 seconds"). Only an explicit boolean for a known profile is accepted; every other
// profile and field is preserved and the whole list is written through the atomic vault save.
// The flag never authorises sending a prompt or using CLI credentials.
handle('profiles:set-handoff-consent', (_event, input) => {
  const id = input?.id;
  const consent = input?.consent;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || typeof consent !== 'boolean') throw new Error('자동 인계 설정 값을 확인해 주세요.');
  const profiles = readProfiles();
  const profile = profiles.find(item => item.id === id);
  if (!profile) throw new Error('팀원 자리를 찾을 수 없습니다.');
  profile.autoHandoffConsent = consent;
  writeProfiles(profiles);
  return { ...profile };
});

handle('task:open', async (_event, { profileId, prompt }) => {
  const profile = readProfiles().find(item => item.id === profileId);
  if (!profile) throw new Error('팀원 자리를 찾을 수 없습니다.');

  if (typeof prompt !== 'string') throw new Error('질문 내용을 확인하세요.');
  if (prompt) clipboard.writeText(prompt);
  const existing = browserWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { copied: true };
  }

  const partition = `aiplaygrand-${runId}-${profile.id}`;
  if (!sessionReady.has(profile.id)) {
    const current = session.fromPartition(partition, { cache: false });
    // Electron otherwise grants website permission requests by default. This text-learning
    // browser does not grant camera, microphone, location, notifications or clipboard API access.
    // Native keyboard copy/paste and explicit file selection remain under the user's control.
    current.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    current.setPermissionCheckHandler(() => false);
    browserSessions.set(profile.id, current);
    sessionReady.set(profile.id, restoreCookies(current, vault.data.cookies[profile.id] || []).then(result => {
      current.cookies.on('changed', scheduleSessionSave);
      return result;
    }));
  }
  const transfer = await sessionReady.get(profile.id);
  const alreadyOpen = browserWindows.get(profile.id);
  if (alreadyOpen && !alreadyOpen.isDestroyed()) { alreadyOpen.focus(); return { copied: !!prompt, ...transfer }; }
  const browser = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `${profile.name} · ${providers[profile.provider].name}`,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  browserWindows.set(profile.id, browser);
  const browserSession = browser.webContents.session;
  if (!sessions.has(browserSession)) {
    sessions.add(browserSession);
    browserSession.on('will-download', (_event, item) => {
      item.setSavePath(path.join(dataRoot, 'Downloads', `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(item.getFilename())}`));
    });
  }
  browser.on('closed', () => browserWindows.delete(profile.id));
  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    return { action: 'deny' };
  });

  const serviceUrl = providers[profile.provider].url;
  await browser.loadURL(serviceUrl);
  return { copied: !!prompt, ...transfer };
});

handle('file:export', async (_event, data) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '실습 기록 내보내기 — 암호화되지 않은 JSON',
    defaultPath: 'aiplaygrand-notes.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(validateTasks(data), null, 2), 'utf8');
  return true;
});

handle('file:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '실습 기록 가져오기',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  if (fs.statSync(result.filePaths[0]).size > 10 * 1024 * 1024) {
    throw new Error('기록 파일은 10MB 이하로 가져올 수 있어요.');
  }
  const value = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  return validateTasks(value, false);
});
