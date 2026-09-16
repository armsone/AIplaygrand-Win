const { app, BrowserWindow, ipcMain, dialog, clipboard, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const providers = require('./providers');
const { Vault } = require('./vault');
const { restoreCookies } = require('./session-transfer');
const { createCliManager } = require('./cli-tools');
const { createRelay, DEFAULT_CHAT_STAGES } = require('./relay');
const { createWebAuto } = require('./web-auto');
const { createAutoHandoff, hasAutoContinueConsent } = require('./auto-handoff');
const { SEAT_PROVIDERS } = require('./cli-seats');
const { readJSON, writeJSON, validateTasks, validateNotebook } = require('./storage');
const { createCredentialTransfer } = require('./cli-credentials');

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
let mainLoaded = false;
let savedMainLoaded = false;
let mainResponsive = true;
const isMainReady = () => mainLoaded && mainResponsive && !quitting && !exitRequested && !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed() && !mainWindow.webContents.isLoadingMainFrame();
const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('허용되지 않은 요청입니다.');
  return handler(event, ...args);
});
const browserWindows = new Map();
const sessions = new Set();
let quitting = false;
let exitRequested = false;
let mainRendererGone = false;
let recoveryDialogOpen = false;
let finishingExit = false;
let credentialActionBusy = false;
const profilesPath = () => path.join(dataRoot, 'profiles.json');
const notebookPath = path.join(dataRoot, 'notebook.json');
const vault = new Vault(path.join(dataRoot, 'team.vault'));
const cli = createCliManager(dataRoot, shell, app.getPath('appData'));
const credentialTransfer = createCredentialTransfer({
  appData: app.getPath('appData'),
  vault,
  getProfile: id => readProfiles().find(item => item.id === id)
});

function sanitizeCredentialError(err, appData) {
  if (err?.code) return '로그인 파일을 안전하게 처리하지 못했어요. 저장 위치의 권한·여유 공간과 열린 CLI 창을 확인하세요. 기존 로그인은 덮어쓰지 않았습니다.';
  if (!err) return '알 수 없는 오류가 발생했습니다.';
  let msg = typeof err === 'string' ? err : (err.message || String(err));
  if (appData) msg = msg.split(appData).join('<AppData>');
  msg = msg.replace(/[a-zA-Z]:\\[^:<>"|?*]+|\/(?:Users|home|private|var|etc|usr|AppData|Program Files)[^\s:;'"]*/gi, '<경로>');
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <토큰>');
  msg = msg.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<JWT 토큰>');
  msg = msg.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '<API 키>');
  return msg;
}

function checkCredentialPreconditions() {
  vault.requireOpen();
  if (quitting || exitRequested) throw new Error('앱을 종료하는 중이라 자격 증명 작업을 진행할 수 없어요.');
  if (relay.isActive()) throw new Error('팀 릴레이가 진행 중이라 자격 증명 작업을 진행할 수 없어요. 먼저 릴레이를 중지하세요.');
  if (chat.isActive()) throw new Error('CLI 대화가 진행 중이라 자격 증명 작업을 진행할 수 없어요. 먼저 대화를 중지하세요.');
  if (relay.hasUnsaved() || chat.hasUnsaved() || webAuto.hasUnsaved()) throw new Error('받은 결과를 먼저 저장한 뒤 로그인 보관·복원을 진행하세요.');
  if (webAuto.isActive()) throw new Error('웹 자동 전송이 진행 중이라 자격 증명 작업을 진행할 수 없어요. 먼저 전송을 마치거나 취소하세요.');
  const handoffSnap = handoff.snapshot();
  if (handoffSnap && ['counting', 'paused', 'choosing', 'executing', 'waiting_save'].includes(handoffSnap.status)) {
    throw new Error('팀원 자동 이어받기가 진행 중이라 자격 증명 작업을 진행할 수 없어요.');
  }
  const relayHandoffSnap = relayHandoff.snapshot();
  if (relayHandoffSnap && ['counting', 'paused', 'choosing', 'executing', 'waiting_save'].includes(relayHandoffSnap.status)) {
    throw new Error('팀 릴레이 자동 이어받기가 진행 중이라 자격 증명 작업을 진행할 수 없어요.');
  }
}
let packageInfo = {};
try { packageInfo = require('./package.json'); } catch {}
handle('app:info', () => ({
  version: app.getVersion(),
  buildStamp: ['string', 'number'].includes(typeof packageInfo.buildStamp) ? String(packageInfo.buildStamp) : '',
  platform: process.platform,
  arch: process.arch
}));
handle('main:ready', () => {
  vault.requireOpen();
  if (quitting || exitRequested) return false;
  mainLoaded = true;
  savedMainLoaded = false;
  mainRendererGone = false;
  mainResponsive = true;
  return true;
});
handle('cli:check', () => cli.check());
handle('cli:help', (_event, id) => cli.help(id));
handle('cli:install', (_event, id) => { vault.requireOpen(); return cli.install(id); });
handle('cli:launch', async (_event, { provider, prompt }) => {
  vault.requireOpen();
  if (isHandoffBusy(relayHandoff)) throw new Error('릴레이 자동 인계를 먼저 취소하거나 마쳐 주세요.');
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 CLI를 실행할 수 없어요.');
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
const PROFILE_ID = /^[a-zA-Z0-9-]{1,100}$/;
const validProfile = p => p && typeof p === 'object' && typeof p.id === 'string' && PROFILE_ID.test(p.id) && typeof p.name === 'string' && p.name.length <= 120 && Object.hasOwn(providers, p.provider) && (p.kind === undefined || p.kind === 'web' || p.kind === 'cli');
// Isolated CLI seat lookup used by the relay engines: only a persisted profile of kind 'cli' with
// the requested provider is accepted; arbitrary ids or paths never reach the CLI environment.
function resolveSeat(seatId, provider) {
  const seat = readProfiles().find(item => item.id === seatId && item.kind === 'cli');
  if (!seat) throw new Error('독립 CLI 자리를 찾을 수 없어요. 팀원 목록을 확인하세요.');
  if (seat.provider !== provider) throw new Error(`이 CLI 자리는 ${SEAT_PROVIDERS[seat.provider].label} 전용이에요.`);
  return seat;
}
const safeEmit = (channel, event) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
      mainWindow.webContents.send(channel, event);
    }
  } catch {}
};
const relay = createRelay({
  dataRoot,
  cli,
  resolveSeat,
  store: {
    read: () => (vault.requireOpen(), vault.data.relay),
    write: value => { vault.requireOpen(); vault.save({ ...vault.data, relay: value }); },
    bytes: () => (vault.requireOpen(), Buffer.byteLength(JSON.stringify(vault.data))),
    capacity: VAULT_CAPACITY
  },
  emit: event => { safeEmit('relay:event', event); if (event.type === 'save-error') relayHandoff?.saveFailed(event.runId); },
  onFinish: handleRelayFinish
});
handle('relay:state', () => relay.state());
handle('relay:load', (_event, id) => relay.load(id));
handle('relay:delete', (_event, id) => { vault.requireOpen(); return relay.remove(id); });
handle('relay:start', (_event, input) => {
  vault.requireOpen();
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 릴레이를 시작할 수 없어요.');
  if (exitRequested) throw new Error('앱을 닫는 중이라 새 릴레이를 시작할 수 없어요.');
  if (chat.isActive()) throw new Error('CLI 대화가 이미 진행 중이에요. 먼저 대화를 중지하세요.');
  if (isHandoffBusy(handoff) || webAuto.isActive()) throw new Error('다른 자동 실행을 먼저 마치거나 취소하세요.');
  if (isHandoffBusy(relayHandoff)) throw new Error('팀 릴레이 자동 이어받기가 진행 중이에요. 먼저 취소하거나 끝내세요.');
  return relay.start(input);
});
handle('relay:stop', () => { const pending = isHandoffBusy(relayHandoff); safeRelayHandoffCancel(); return relay.stop() || pending; });
handle('relay:resume', (_event, input) => {
  vault.requireOpen();
  if (isHandoffBusy(handoff) || webAuto.isActive()) throw new Error('다른 자동 실행을 먼저 마치거나 취소하세요.');
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 릴레이를 이어받을 수 없어요.');
  if (exitRequested) throw new Error('앱을 닫는 중이라 릴레이를 이어갈 수 없어요.');
  if (chat.isActive()) throw new Error('CLI 대화가 이미 진행 중이에요. 먼저 대화를 중지하세요.');
  if (isHandoffBusy(relayHandoff)) throw new Error('팀 릴레이 자동 이어받기가 진행 중이에요. 먼저 취소하거나 끝내세요.');
  const runId = input?.runId;
  const seatId = input?.seatId;
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('릴레이 기록을 확인하세요.');
  if (typeof seatId !== 'string' || !PROFILE_ID.test(seatId)) throw new Error('이어받을 독립 CLI 자리를 선택해 주세요.');
  const seat = readProfiles().find(item => item.id === seatId && item.kind === 'cli');
  if (!seat) throw new Error('독립 CLI 자리를 찾을 수 없어요. 팀원 목록을 확인하세요.');
  if (!hasAutoContinueConsent(seat)) throw new Error('이 팀원의 자동 인계 설정에서 전송과 이전 답변 공유에 먼저 동의해 주세요.');
  return relay.resume({ runId, seatId, shareConfirmed: input?.shareConfirmed === true }, {
    guard: () => {
      if (exitRequested || chat.isActive() || webAuto.isActive() || isHandoffBusy(handoff)) return false;
      const fresh = readProfiles().find(item => item.id === seatId && item.kind === 'cli');
      return !!fresh && fresh.provider === seat.provider && hasAutoContinueConsent(fresh) && !credentialActionBusy;
    }
  });
});
handle('relay:retry-save', () => { vault.requireOpen(); return relay.retrySave(); });

const chat = createRelay({
  dataRoot,
  cli,
  stageCount: 1,
  workspaceDir: path.join(dataRoot, 'Chat', 'workspace'),
  label: 'CLI 대화',
  defaultStages: [{ provider: 'claude', role: '대화를 이어가는 친절한 학습 도우미. 텍스트로만 답하세요.' }],
  resolveSeat,
  store: {
    read: () => (vault.requireOpen(), vault.data.cliChat),
    write: value => { vault.requireOpen(); vault.save({ ...vault.data, cliChat: value }); },
    bytes: () => (vault.requireOpen(), Buffer.byteLength(JSON.stringify(vault.data))),
    capacity: VAULT_CAPACITY
  },
  emit: event => safeEmit('chat:event', event),
  onFinish: run => {
    // Called only after the run was persisted (relay.js fails closed on save errors). A finished
    // one-stage chat becomes an AUTOMATIC handoff source only on a confirmed quota event AND when
    // the source participant opted in: an isolated seat needs its own v2 consent (share context +
    // auto continue), the shared PC login needs the separate explicit setting. Without that the
    // session is shown paused and needs a click. The shared identity is shown as '공용 CLI'.
    const stage = run.stages[0];
    const summary = { runId: run.id, kind: 'cli', status: run.status, profileId: stage.seatId || null, profileName: stage.seatId ? stage.seatName : '공용 CLI (이 PC 로그인 계정)', provider: stage.provider, prompt: run.task, partial: stage.output || '', failure: run.failure };
    try {
      if (handoff.onRunFinished(summary)) return;
      if (run.status === 'error' && summary.failure && summary.failure.kind === 'quota') {
        const seat = stage.seatId ? readProfiles().find(item => item.id === stage.seatId && item.kind === 'cli') : null;
        let consented = stage.seatId ? hasAutoContinueConsent(seat) : readSettings().autoContinueFromSharedCli === true;
        let pausedMsg = '';
        if (isHandoffBusy(relayHandoff)) {
          consented = false;
          pausedMsg = '팀 릴레이 자동 이어받기가 진행 중이라 자동으로 시작하지 않았어요. 릴레이 인계를 마친 뒤 ‘지금 이어받기’를 누르세요.';
        } else if (!consented) {
          pausedMsg = stage.seatId ? '이 독립 CLI 자리는 자동 이어받기(자동 전송 + 부분 답변 공유)에 동의하지 않아 자동으로 시작하지 않았어요. 부분 답변을 다른 팀원에게 넘기려면 ‘지금 이어받기’를 누르세요.' : '공용 CLI의 자동 이어받기 설정이 꺼져 있어 자동으로 시작하지 않았어요. 부분 답변을 다른 팀원에게 넘기려면 ‘지금 이어받기’를 누르세요.';
        }
        handoff.begin({ kind: 'cli', profileId: summary.profileId, profileName: summary.profileName, provider: summary.provider, prompt: summary.prompt, partial: summary.partial, reason: 'quota' }, { automatic: consented, pausedMessage: pausedMsg });
      }
    } catch (error) { safeEmit('handoff:event', { type: 'error', message: error.message }); }
  }
});
handle('chat:retry-save', () => { vault.requireOpen(); return chat.retrySave(); });
// ---------- 웹 자동 전송 · 통합 자동 인계 ----------
const readSettings = () => { vault.requireOpen(); const value = vault.data.settings || {}; return { autoContinueFromSharedCli: value.autoContinueFromSharedCli === true, autoContinueRelay: value.autoContinueRelay === true }; };
const webAuto = createWebAuto({
  getWindow: async profileId => {
    const profile = readProfiles().find(item => item.id === profileId && item.kind !== 'cli');
    if (!profile) throw new Error('웹 팀원 자리를 찾을 수 없어요.');
    const { browser } = await openProfileWindow(profile, { navigate: false });
    return browser;
  },
  store: {
    read: () => (vault.requireOpen(), vault.data.webRuns),
    write: value => { vault.requireOpen(); vault.save({ ...vault.data, webRuns: value }); },
    bytes: () => (vault.requireOpen(), Buffer.byteLength(JSON.stringify(vault.data))),
    capacity: VAULT_CAPACITY
  },
  emit: event => safeEmit('web:event', event),
  onFinish: run => {
    // Called only after the run was persisted (web-auto.js fails closed on save errors).
    const summary = { runId: run.id, kind: 'web', status: run.status, profileId: run.profileId, profileName: run.profileName, provider: run.provider, prompt: run.prompt, partial: run.output || '', failure: run.failure, taskId: run.taskId || null };
    try {
      if (handoff.onRunFinished(summary)) return;
      if (run.status === 'error' && summary.failure && summary.failure.kind === 'quota') {
        // Automatic only when the SOURCE web teammate holds the v2 opt-in (their partial answer
        // is shared); otherwise the session waits for an explicit click.
        let consented = hasAutoContinueConsent(readProfiles().find(item => item.id === run.profileId));
        let pausedMsg = '';
        if (isHandoffBusy(relayHandoff)) {
          consented = false;
          pausedMsg = '팀 릴레이 자동 이어받기가 진행 중이라 자동으로 시작하지 않았어요. 릴레이 인계를 마친 뒤 ‘지금 이어받기’를 누르세요.';
        } else if (!consented) {
          pausedMsg = '원래 담당 팀원이 자동 이어받기(자동 전송 + 부분 답변 공유)에 동의하지 않아 자동으로 시작하지 않았어요. 부분 답변을 다른 팀원에게 넘기려면 ‘지금 이어받기’를 누르세요.';
        }
        handoff.begin({ ...summary, reason: 'quota' }, { automatic: consented, pausedMessage: pausedMsg });
      }
    } catch (error) { safeEmit('handoff:event', { type: 'error', message: error.message }); }
  }
});
let handoff, relayHandoff;
const syncedQuotaSessions = new Set();
const safeHandoffEmit = event => {
  const source = event.session?.source;
  if (source?.profileId && source.reason === 'quota' && !syncedQuotaSessions.has(event.session.id)) { syncedQuotaSessions.add(event.session.id); relayHandoff?.markExhausted(source.profileId, 'quota'); }
  safeEmit('handoff:event', event);
};
function safeHandoffCancel() {
  try { if (typeof handoff?.cancel === 'function') handoff.cancel(); } catch {}
}
const isHandoffBusy = inst => {
  const s = inst?.snapshot?.();
  return !!s && ['counting', 'paused', 'choosing', 'executing', 'waiting_save'].includes(s.status);
};
let currentRelayQuotaContext = null;
const safeRelayHandoffEmit = event => {
  const source = event.session?.source;
  if (source?.profileId && source.reason === 'quota' && !syncedQuotaSessions.has(event.session.id)) { syncedQuotaSessions.add(event.session.id); handoff?.markExhausted(source.profileId, 'quota'); }
  safeEmit('relay-handoff:event', { ...event, context: currentRelayQuotaContext });
};
function safeRelayHandoffCancel() {
  try { if (typeof relayHandoff?.cancel === 'function') relayHandoff.cancel(); } catch {}
}
relayHandoff = createAutoHandoff({
  automaticAllowed: () => readSettings().autoContinueRelay && !isHandoffBusy(handoff),
  readProfiles: () => {
    const all = readProfiles();
    const provider = currentRelayQuotaContext?.provider;
    return all.filter(p => p.kind === 'cli' && (p.provider === provider || p.id === currentRelayQuotaContext?.sourceProfileId));
  },
  readSettings: () => ({ autoContinueFromSharedCli: readSettings().autoContinueRelay }),
  emit: safeRelayHandoffEmit,
  hostVisible: () => isMainReady() && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized(),
  appForeground: () => !!BrowserWindow.getFocusedWindow(),
  bringHostForward: () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
  providerLabel: (provider, kind) => `${SEAT_PROVIDERS[provider]?.label || provider} 독립 자리`,
  webSupported: () => false,
  runWeb: () => { throw new Error('팀 릴레이는 CLI 자리로만 이어받을 수 있어요.'); },
  runCli: async ({ profile, guard }) => {
    if (isHandoffBusy(handoff) || webAuto.isActive()) throw new Error('다른 자동 실행을 먼저 마치거나 취소하세요.');
    if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.');
    if (exitRequested) throw new Error('앱을 닫는 중이에요.');
    if (chat.isActive()) throw new Error('CLI 대화가 진행 중이라 릴레이를 이어갈 수 없어요.');
    if (!currentRelayQuotaContext) throw new Error('이어갈 릴레이 작업 정보가 없어요.');
    const runId = currentRelayQuotaContext.runId;
    const stageIdx = currentRelayQuotaContext.stageIndex;
    const run = await relay.resume({ runId, seatId: profile.id, shareConfirmed: true }, {
      guard: () => !credentialActionBusy && !exitRequested && !chat.isActive() && !isHandoffBusy(handoff) && !webAuto.isActive() && (readSettings().autoContinueRelay || relayHandoff.snapshot()?.source.manualConsent === true) && guard()
    });
    const failedStage = Number.isInteger(stageIdx) && run.stages?.[stageIdx]
      ? run.stages[stageIdx]
      : (Number.isInteger(run.currentStage) && run.stages?.[run.currentStage]
        ? run.stages[run.currentStage]
        : (Number.isInteger(run.resumedStage) && run.stages?.[run.resumedStage]
          ? run.stages[run.resumedStage]
          : run.stages?.[0]));
    return { ...run, output: failedStage?.output || failedStage?.partial || run.output || '' };
  },
  cancelRun: ({ runId }) => (runId ? relay.stop(runId) : false)
});
function handleRelayFinish(run) {
  if (exitRequested || quitting) return;
  const failedIndex = Number.isInteger(run.currentStage) && run.stages?.[run.currentStage]?.status === 'error'
    ? run.currentStage
    : run.stages?.findIndex(s => s.status === 'error');
  const failedStage = failedIndex >= 0 ? run.stages[failedIndex] : null;
  if (run.status === 'error' && run.failure?.kind === 'quota' && failedStage) {
    currentRelayQuotaContext = {
      runId: run.id,
      provider: failedStage.provider,
      stageIndex: failedIndex,
      sourceProfileId: failedStage.seatId || null
    };
    const summary = {
      runId: run.id,
      kind: 'cli',
      status: run.status,
      profileId: failedStage.seatId || null,
      profileName: failedStage.seatId ? failedStage.seatName : '공용 CLI (이 PC 로그인 계정)',
      provider: failedStage.provider,
      prompt: run.task,
      partial: [failedStage.partial, failedStage.output].filter(Boolean).join('\n\n') || failedStage.output || '',
      failure: run.failure
    };
    try {
      if (relayHandoff.onRunFinished(summary)) { if (!readSettings().autoContinueRelay || isHandoffBusy(handoff)) relayHandoff.pause(); return; }
      const seat = failedStage.seatId ? readProfiles().find(item => item.id === failedStage.seatId && item.kind === 'cli') : null;
      let consented = readSettings().autoContinueRelay && (!failedStage.seatId || hasAutoContinueConsent(seat));
      let pausedMsg = '';
      if (isHandoffBusy(handoff)) {
        consented = false;
        pausedMsg = '다른 자동 이어받기가 진행 중이라 릴레이 이어받기를 자동으로 시작하지 않았어요. 이전 이어받기를 마친 뒤 ‘지금 이어받기’를 누르세요.';
      } else if (!consented) {
        pausedMsg = failedStage.seatId
          ? '이 독립 CLI 자리는 자동 이어받기(자동 전송 + 부분 답변 공유)에 동의하지 않아 자동으로 시작하지 않았어요. 다른 팀원에게 넘기려면 ‘지금 이어받기’를 누르세요.'
          : '공용 CLI의 자동 이어받기 설정이 꺼져 있어 자동으로 시작하지 않았어요. 다른 팀원에게 넘기려면 ‘지금 이어받기’를 누르세요.';
      }
      relayHandoff.begin({
        kind: 'cli',
        profileId: summary.profileId,
        profileName: summary.profileName,
        provider: summary.provider,
        prompt: summary.prompt,
        partial: summary.partial,
        reason: 'quota'
      }, { automatic: consented, pausedMessage: pausedMsg });
    } catch (error) { safeEmit('relay-handoff:event', { type: 'error', message: error.message }); }
  } else {
    const stageForSummary = failedStage || run.stages?.[run.stages.length - 1];
    if (stageForSummary) {
      const summary = {
        runId: run.id,
        kind: 'cli',
        status: run.status,
        profileId: stageForSummary.seatId || null,
        profileName: stageForSummary.seatId ? stageForSummary.seatName : '공용 CLI (이 PC 로그인 계정)',
        provider: stageForSummary.provider,
        prompt: run.task,
        partial: stageForSummary.output || '',
        failure: run.failure
      };
      relayHandoff.onRunFinished(summary);
    }
  }
}
handle('relay-handoff:state', () => ({ session: relayHandoff.snapshot(), context: currentRelayQuotaContext, exhausted: relayHandoff.exhaustedList(), seconds: relayHandoff.HANDOFF_SECONDS, settings: readSettings() }));
handle('relay-handoff:choose', (_event, id) => { if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('팀원을 확인하세요.'); return relayHandoff.choose(id); });
handle('relay-handoff:skip', () => relayHandoff.skip());
handle('relay-handoff:proceed', () => { vault.requireOpen(); if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.'); if (exitRequested) throw new Error('앱을 닫는 중이에요.'); return relayHandoff.proceed(); });
handle('relay-handoff:restart-timer', () => { if (credentialActionBusy || isHandoffBusy(handoff) || !readSettings().autoContinueRelay) throw new Error('다른 인계를 종료하고 릴레이 자동 인계 동의를 먼저 켜 주세요.'); return relayHandoff.restartTimer(); });
handle('relay-handoff:pause', () => relayHandoff.pause());
handle('relay-handoff:cancel', () => relayHandoff.cancel());
handoff = createAutoHandoff({
  readProfiles: () => readProfiles(),
  readSettings: () => readSettings(),
  emit: safeHandoffEmit,
  hostVisible: () => isMainReady() && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized(),
  // True when any window of THIS app (main or a provider web window) is in the foreground.
  appForeground: () => !!BrowserWindow.getFocusedWindow(),
  // Brings the main handoff panel forward; the engine calls it only while appForeground() holds.
  bringHostForward: () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
  providerLabel: (provider, kind) => kind === 'cli' ? `${SEAT_PROVIDERS[provider]?.label || provider} 독립 자리` : `${providers[provider]?.name || provider} 웹`,
  webSupported: provider => webAuto.supports(provider),
  runWeb: ({ profile, prompt, sessionId, guard }) => {
    if (relay.isActive() || chat.isActive()) throw new Error('진행 중인 CLI 작업을 먼저 마치세요.');
    if (isHandoffBusy(relayHandoff)) throw new Error('릴레이 자동 인계를 먼저 마치거나 취소하세요.');
    if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.');
    if (exitRequested) throw new Error('앱을 닫는 중이에요.');
    return webAuto.start({ profile, prompt, taskId: handoff.taskIdOf(sessionId), guard: () => !credentialActionBusy && !relay.isActive() && !chat.isActive() && !isHandoffBusy(relayHandoff) && guard() });
  },
  runCli: ({ profile, prompt, guard }) => {
    if (isHandoffBusy(relayHandoff)) throw new Error('릴레이 자동 인계를 먼저 마치거나 취소하세요.');
    if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.');
    if (exitRequested) throw new Error('앱을 닫는 중이에요.');
    if (relay.isActive()) throw new Error('팀 릴레이가 진행 중이라 CLI 자리로 이어받을 수 없어요.');
    return chat.start({ task: prompt, stages: [{ provider: profile.provider, role: DEFAULT_CHAT_STAGES[0].role, seatId: profile.id }] }, { guard: () => !credentialActionBusy && !relay.isActive() && !webAuto.isActive() && !isHandoffBusy(relayHandoff) && guard() });
  },
  // Stops only the run owned by the handoff session (by run id, or by the handoff task id while
  // the web start is still pending). A manual run is never touched.
  cancelRun: ({ kind, runId, sessionId }) => kind === 'web'
    ? webAuto.stop(runId ? { runId } : { taskId: handoff.taskIdOf(sessionId) })
    : (runId ? chat.stop(runId) : false)
});
handle('web:state', () => webAuto.state());
handle('web:load', (_event, id) => webAuto.load(id));
handle('web:delete', (_event, id) => { vault.requireOpen(); return webAuto.remove(id); });
// User-initiated automatic web mission: explicit per-click confirmation happens in the renderer,
// the profile must be a web seat whose provider supports automatic send.
handle('web:start', (_event, input) => {
  vault.requireOpen();
  if (relay.isActive() || chat.isActive() || isHandoffBusy(handoff)) throw new Error('진행 중인 작업이나 자동 인계를 먼저 마치세요.');
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 시작할 수 없어요.');
  if (exitRequested) throw new Error('앱을 닫는 중이라 시작할 수 없어요.');
  if (isHandoffBusy(relayHandoff)) throw new Error('팀 릴레이 자동 이어받기가 진행 중이라 웹 자동 전송을 시작할 수 없어요.');
  const profileId = input?.profileId, prompt = input?.prompt, taskId = input?.taskId;
  if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId) || typeof prompt !== 'string' || (taskId !== undefined && taskId !== null && (typeof taskId !== 'string' || !PROFILE_ID.test(taskId)))) throw new Error('자동 전송 입력을 확인하세요.');
  const profile = readProfiles().find(item => item.id === profileId && item.kind !== 'cli');
  if (!profile) throw new Error('웹 팀원 자리를 찾을 수 없어요.');
  return webAuto.start({ profile, prompt, taskId: taskId || null, guard: () => !credentialActionBusy && !exitRequested && !relay.isActive() && !chat.isActive() && !isHandoffBusy(handoff) && !isHandoffBusy(relayHandoff) });
});
handle('web:stop', () => webAuto.stop());
handle('web:retry-save', () => { vault.requireOpen(); return webAuto.retrySave(); });
handle('handoff:state', () => ({ session: handoff.snapshot(), exhausted: handoff.exhaustedList(), seconds: handoff.HANDOFF_SECONDS, settings: readSettings() }));
handle('handoff:begin', (_event, input) => {
  if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.');
  vault.requireOpen();
  if (exitRequested) throw new Error('앱을 닫는 중이에요.');
  if (isHandoffBusy(relayHandoff)) throw new Error('팀 릴레이 자동 이어받기가 진행 중이라 시작할 수 없어요.');
  const { profileId, prompt, partial } = input || {};
  if ((profileId !== null && (typeof profileId !== 'string' || !PROFILE_ID.test(profileId))) || typeof prompt !== 'string' || typeof partial !== 'string' || prompt.length > 200000 || partial.length > 1000000) throw new Error('인계 입력을 확인하세요.');
  const profile = profileId ? readProfiles().find(item => item.id === profileId) : null;
  const provider = profile ? profile.provider : input?.provider;
  if (!Object.hasOwn(providers, provider)) throw new Error('인계 입력을 확인하세요.');
  return handoff.begin({ kind: profile?.kind === 'cli' ? 'cli' : 'web', profileId: profile ? profile.id : null, profileName: profile ? profile.name : String(input?.profileName || '').slice(0, 120), provider, prompt, partial, reason: 'manual', manualConsent: true }, { automatic: true });
});
handle('handoff:choose', (_event, id) => { if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('팀원을 확인하세요.'); return handoff.choose(id); });
handle('handoff:skip', () => handoff.skip());
handle('handoff:proceed', () => { vault.requireOpen(); if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.'); if (exitRequested) throw new Error('앱을 닫는 중이에요.'); return handoff.proceed(); });
handle('handoff:restart-timer', () => { if (credentialActionBusy) throw new Error('로그인 보관·복원 확인을 먼저 마쳐 주세요.'); return handoff.restartTimer(); });
handle('handoff:pause', () => handoff.pause());
handle('handoff:cancel', () => handoff.cancel());
handle('handoff:mark-exhausted', (_event, id) => { if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('팀원을 확인하세요.'); handoff.markExhausted(id, 'manual'); relayHandoff.markExhausted(id, 'manual'); return [...new Map([...handoff.exhaustedList(), ...relayHandoff.exhaustedList()].map(item => [item.id, item])).values()]; });
handle('handoff:rejoin', (_event, id) => { if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('팀원을 확인하세요.'); handoff.rejoin(id); relayHandoff.rejoin(id); return [...new Map([...handoff.exhaustedList(), ...relayHandoff.exhaustedList()].map(item => [item.id, item])).values()]; });
handle('settings:set', (_event, input) => {
  vault.requireOpen();
  if (typeof input?.autoContinueFromSharedCli !== 'boolean') throw new Error('설정 값을 확인하세요.');
  vault.save({ ...vault.data, settings: { ...readSettings(), autoContinueFromSharedCli: input.autoContinueFromSharedCli } });
  return readSettings();
});
handle('settings:relay-auto', (_event, value) => {
  vault.requireOpen();
  if (typeof value !== 'boolean') throw new Error('릴레이 자동 인계 동의를 확인하세요.');
  vault.save({ ...vault.data, settings: { ...readSettings(), autoContinueRelay: value } });
  if (!value) relayHandoff.pause();
  return readSettings();
});
// Isolated CLI seat: official login in a terminal carrying the seat env; status via the official
// status command only. Credential transfer below is separate and requires explicit confirmation.
handle('seat:login', async (_event, id) => {
  vault.requireOpen();
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 로그인 터미널을 열 수 없어요.');
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('CLI 자리를 확인하세요.');
  const seat = readProfiles().find(item => item.id === id && item.kind === 'cli');
  if (!seat) throw new Error('독립 CLI 자리를 찾을 수 없어요.');
  await cli.seatLogin(seat);
  return true;
});
handle('seat:status', async (_event, id) => {
  vault.requireOpen();
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('CLI 자리를 확인하세요.');
  const seat = readProfiles().find(item => item.id === id && item.kind === 'cli');
  if (!seat) throw new Error('독립 CLI 자리를 찾을 수 없어요.');
  return { ...(await cli.seatStatus(seat)), isolation: SEAT_PROVIDERS[seat.provider].isolation };
});
handle('chat:state', () => chat.state());
handle('chat:load', (_event, id) => chat.load(id));
handle('chat:delete', (_event, id) => { vault.requireOpen(); return chat.remove(id); });
handle('seat:credential-status', (_event, id) => {
  vault.requireOpen();
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('CLI 자리를 확인하세요.');
  try {
    return credentialTransfer.status(id);
  } catch (error) {
    throw new Error(sanitizeCredentialError(error, app.getPath('appData')));
  }
});
handle('seat:credential-action', async (_event, input) => {
  const id = typeof input === 'object' ? input?.id : input;
  const action = typeof input === 'object' ? input?.action : null;
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('CLI 자리를 확인하세요.');
  if (!['capture', 'restore', 'forget'].includes(action)) throw new Error('올바르지 않은 자격 증명 작업입니다.');
  if (credentialActionBusy) throw new Error('다른 자격 증명 작업 확인이 진행 중입니다. 먼저 열린 확인 창을 마쳐 주세요.');
  credentialActionBusy = true;
  try {
    checkCredentialPreconditions();
    const initialProfile = readProfiles().find(item => item.id === id && item.kind === 'cli');
    if (!initialProfile) throw new Error('독립 CLI 자리를 찾을 수 없어요.');
    if (action !== 'forget' && initialProfile.provider === 'claude' && process.platform === 'darwin') {
      throw new Error('macOS의 Claude Code 자격 증명은 키체인에 저장되므로 보관함 이전이 지원되지 않습니다.');
    }
    const providerLabel = SEAT_PROVIDERS[initialProfile.provider]?.label || initialProfile.provider;
    let dialogOptions;
    if (action === 'capture') {
      dialogOptions = {
        type: 'question',
        buttons: ['취소', '확인 후 보관'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: `${providerLabel} 자리 로그인 보관`,
        message: `${initialProfile.name} 자리의 CLI 로그인을 암호화 보관함에 보관할까요?`,
        detail: [
          '• 앱은 외부 로그인 터미널을 완전히 감지할 수 없으므로, 해당 자리의 모든 CLI 창 및 로그인 터미널이 닫혀 있고 현재 아무도 이 자리를 사용하고 있지 않은지 직접 확인해야 합니다.',
          '• 이 PC 로컬에 저장된 해당 CLI 자리의 공식 로그인 자격 증명을 읽어 암호화 보관함(team.vault)에 저장합니다.',
          '• 보관함에 저장된 토큰은 만료나 갱신 주기, 서비스 정책에 따라 무효화될 수 있으며 단일 PC 사용을 권장합니다.',
          '• 이 자리에 보관된 이전 로그인 정보가 있다면 덮어씁니다.'
        ].join('\n')
      };
    } else if (action === 'restore') {
      dialogOptions = {
        type: 'question',
        buttons: ['취소', '확인 후 복원'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: `${providerLabel} 자리 로그인 복원`,
        message: `보관함에 저장된 로그인을 이 PC의 ${initialProfile.name} 자리에 복원할까요?`,
        detail: [
          '• 대상 자리에 이미 로그인 자격 증명 파일이 존재하면 안전을 위해 덮어쓰지 않고 작업을 중단합니다.',
          '• 앱은 외부 로그인 터미널을 완전히 감지할 수 없으므로, 해당 자리의 모든 CLI 창 및 로그인 터미널이 닫혀 있고 현재 아무도 이 자리를 사용하고 있지 않은지 직접 확인해야 합니다.',
          '• 복원된 자격 증명은 이 PC의 로컬 설정 폴더에 평문 파일로 기록되며 OS 계정 권한으로 관리됩니다.'
        ].join('\n')
      };
    } else {
      dialogOptions = {
        type: 'warning',
        buttons: ['취소', '확인 후 삭제'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: `${providerLabel} 자리 보관된 로그인 삭제`,
        message: `보관함에 저장된 ${initialProfile.name} 자리의 CLI 로그인을 삭제할까요?`,
        detail: [
          '• 암호화 보관함(team.vault)에서 이 자리의 백업 항목을 삭제합니다.',
          '• 이 작업은 이 PC 로컬에 이미 존재하는 CLI 로그인 파일은 삭제하지 않습니다.',
          '• 보관함 저장 시 생성된 이전 백업 파일(.bak)에는 이전 기록이 남아 있을 수 있습니다.'
        ].join('\n')
      };
    }
    const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const choice = parentWindow ? await dialog.showMessageBox(parentWindow, dialogOptions) : await dialog.showMessageBox(dialogOptions);
    if (choice.response !== 1) {
      return { canceled: true };
    }
    checkCredentialPreconditions();
    const freshProfile = readProfiles().find(item => item.id === id && item.kind === 'cli');
    if (!freshProfile) {
      throw new Error('확인 중에 팀원 자리가 삭제되어 작업을 진행할 수 없어요.');
    }
    if (freshProfile.provider !== initialProfile.provider) {
      throw new Error('확인 중에 팀원 자리 정보가 변경되었습니다.');
    }
    let moduleResult;
    try {
      if (action === 'capture') moduleResult = credentialTransfer.capture(id);
      else if (action === 'restore') moduleResult = credentialTransfer.restore(id);
      else moduleResult = credentialTransfer.forget(id);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        throw new Error('대상 경로에 이미 파일이 존재합니다. 기존 자격 증명은 덮어쓰지 않습니다.');
      }
      throw new Error(sanitizeCredentialError(err, app.getPath('appData')));
    }
    return {
      ok: true,
      action,
      profileId: id,
      provider: freshProfile.provider,
      createdAt: moduleResult?.createdAt,
      message: moduleResult?.message
    };
  } finally {
    credentialActionBusy = false;
  }
});
handle('chat:start', (_event, input) => {
  vault.requireOpen();
  if (webAuto.isActive() || isHandoffBusy(handoff)) throw new Error('진행 중인 웹 작업이나 자동 인계를 먼저 마치세요.');
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 새 대화를 시작할 수 없어요.');
  if (exitRequested) throw new Error('앱을 닫는 중이라 새 대화를 시작할 수 없어요.');
  if (relay.isActive()) throw new Error('팀 릴레이가 이미 진행 중이에요. 먼저 릴레이를 중지하세요.');
  if (isHandoffBusy(relayHandoff)) throw new Error('팀 릴레이 자동 이어받기가 진행 중이라 새 대화를 시작할 수 없어요.');
  return chat.start(input);
});
handle('chat:stop', () => { const pending = isHandoffBusy(handoff); safeHandoffCancel(); return chat.stop() || pending; });
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
  if (!Array.isArray(profiles) || profiles.some(p => !validProfile(p)) || new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('팀원 목록 파일을 읽을 수 없습니다. 파일을 보존하고 지원을 요청해 주세요.');
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
    if (vault.data.profiles.some(p => !validProfile(p))) throw new Error('팀원 목록을 읽지 못했습니다.');
    // Runs left "running" by a crash or forced exit become interrupted; nothing restarts automatically.
    try { relay.markInterrupted(); } catch (error) { mainWindow?.webContents.send('relay:event', { type: 'save-error', message: error.message }); }
    try { chat.markInterrupted(); } catch (error) { mainWindow?.webContents.send('chat:event', { type: 'save-error', message: error.message }); }
    try { webAuto.markInterrupted(); } catch (error) { mainWindow?.webContents.send('web:event', { type: 'save-error', message: error.message }); }
    return true;
  } catch (error) { vault.lock(); throw error; }
  finally { password = ''; unlockBusy = false; }
});

function createMainWindow() {
  mainLoaded = false;
  savedMainLoaded = false;
  mainResponsive = true;
  mainRendererGone = false;
  recoveryDialogOpen = false;
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
    safeHandoffCancel();
    safeRelayHandoffCancel();
    if (!quitting) { event.preventDefault(); requestExit(); }
  });
  mainWindow.on('unresponsive', () => {
    mainResponsive = false;
    safeHandoffCancel();
    safeRelayHandoffCancel();
  });
  mainWindow.on('responsive', () => {
    mainResponsive = true;
  });
  mainWindow.webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    const main = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : (typeof isMainFrame === 'boolean' ? isMainFrame : true);
    const sameDoc = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : !!isInPlace;
    if (main && !sameDoc) {
      if (mainLoaded) savedMainLoaded = true;
      mainLoaded = false;
      safeHandoffCancel();
      safeRelayHandoffCancel();
    }
  });
  mainWindow.webContents.on('will-prevent-unload', () => {
    if (savedMainLoaded && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
      mainLoaded = true;
      savedMainLoaded = false;
    }
  });
  mainWindow.webContents.on('did-navigate', () => {
    mainLoaded = false;
    savedMainLoaded = false;
  });
  mainWindow.webContents.on('render-process-gone', () => {
    mainRendererGone = true;
    mainLoaded = false;
    savedMainLoaded = false;
    safeHandoffCancel();
    safeRelayHandoffCancel();
    offerRendererRecovery();
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

function isRendererGone() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return true;
  return mainRendererGone || wc.isCrashed();
}

async function offerRendererRecovery() {
  if (quitting || finishingExit || recoveryDialogOpen) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const recoveryWindow = mainWindow;
  recoveryDialogOpen = true;
  try {
    const result = await dialog.showMessageBox(recoveryWindow, {
      type: 'warning',
      buttons: ['화면 다시 불러오기', '그대로 두기'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '화면 복구',
      message: '화면 프로세스가 예기치 않게 종료되었습니다.',
      detail: '보관함에 저장된 기록은 유지됩니다. 비정상 종료된 화면에서 아직 저장되지 않은 입력 내용은 사라졌을 수 있습니다. 화면을 다시 불러와 복구하시겠습니까?'
    });
    if (result.response === 0) {
      if (quitting || finishingExit || mainWindow !== recoveryWindow || recoveryWindow.isDestroyed() || !isRendererGone()) return;
      mainLoaded = false;
      savedMainLoaded = false;
      if (exitRequested) {
        exitRequested = false;
        relay.cancelShutdown();
        chat.cancelShutdown();
      }
      try {
        await recoveryWindow.loadFile('index.html');
        mainRendererGone = false;
      } catch (loadError) {
        if (!quitting && !recoveryWindow.isDestroyed()) {
          dialog.showErrorBox('화면 복구 실패', `화면을 다시 불러오지 못했어요. 기록을 지우거나 앱을 강제 종료하지 않았습니다. 창의 닫기 버튼을 누르면 복구를 다시 시도할 수 있어요.\n${loadError?.message || loadError}`);
        }
      }
    }
  } catch (error) {
    if (!quitting && !recoveryWindow.isDestroyed()) dialog.showErrorBox('복구 안내를 열지 못했어요', `창의 닫기 버튼을 눌러 다시 시도해 주세요. 기록은 삭제하지 않았습니다.\n${error?.message || error}`);
  } finally {
    recoveryDialogOpen = false;
  }
}

function requestExit() {
  if (quitting) return;
  if (isRendererGone()) {
    offerRendererRecovery();
    return;
  }
  if (exitRequested) return;
  exitRequested = true;
  safeHandoffCancel();
  safeRelayHandoffCancel();
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
  finishingExit = true;
  try {
  // Stop the owned CLI children first. If either cannot be settled, keep the app open with explanatory error;
  // nothing is locked or marked finished.
  try {
    relayHandoff.shutdown();
    handoff.shutdown();
    webAuto.stop();
    await Promise.all([relay.shutdown(), chat.shutdown()]);
  } catch (error) {
    exitRequested = false;
    relay.cancelShutdown();
    chat.cancelShutdown();
    throw error;
  }
  if (webAuto.hasUnsaved() || chat.hasUnsaved() || relay.hasUnsaved()) {
    exitRequested = false;
    relay.cancelShutdown();
    chat.cancelShutdown();
    const unsavedList = [];
    if (webAuto.hasUnsaved()) unsavedList.push('웹 자동 전송');
    if (chat.hasUnsaved()) unsavedList.push('CLI 대화');
    if (relay.hasUnsaved()) unsavedList.push('팀 릴레이');
    throw new Error(`저장하지 못한 ${unsavedList.join(', ')} 결과가 화면에 남아 있어 앱을 닫지 않았어요. 화면에서 답변을 복사하거나 ‘저장 다시 시도’로 보관함 저장을 마친 뒤 다시 종료하세요.`);
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
  } finally {
    finishingExit = false;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The listing normalises the optional opt-ins to explicit booleans for display only. Nothing is
// written back here, so profiles that never opted in keep no field in the vault (absent = false).
// autoHandoffConsent (v1: copy + open) and autoContinueConsent (v2: automatic send + context
// sharing) are separate; v1 never counts as v2.
handle('profiles:list', () => readProfiles().map(profile => ({ ...profile, kind: profile.kind === 'cli' ? 'cli' : 'web', autoHandoffConsent: profile.autoHandoffConsent === true, autoContinueConsent: hasAutoContinueConsent(profile), autoContinueAt: hasAutoContinueConsent(profile) ? profile.autoContinueConsent.at : null })));

handle('profiles:add', (_event, input) => {
  const name = input?.name?.trim();
  const provider = input?.provider;
  const kind = input?.kind === 'cli' ? 'cli' : 'web';
  if (!name || name.length > 120 || !Object.hasOwn(providers, provider)) {
    throw new Error('팀원 이름과 사용할 서비스를 확인해 주세요.');
  }
  const profile = kind === 'cli' ? { id: crypto.randomUUID(), name, provider, kind } : { id: crypto.randomUUID(), name, provider };
  const profiles = readProfiles();
  profiles.push(profile);
  writeProfiles(profiles);
  return profile;
});

handle('profiles:delete', (_event, id) => {
  if (credentialActionBusy) throw new Error('자격 증명 작업 확인이 진행 중이라 팀원을 삭제할 수 없어요.');
  vault.requireOpen();
  if (Object.hasOwn(vault.data.cliCredentials || {}, id)) throw new Error('이 자리의 ‘보관된 로그인 삭제’를 먼저 완료한 뒤 팀원을 제거하세요. PC의 로그인 파일은 그대로 남습니다.');
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

// Versioned consent for AUTOMATIC continuation: the teammate agrees that, on their turn, the app
// may send the composed question into their own window/seat without a click (after the visible
// 5-second countdown) AND that previous teammates' partial answers are included. Both parts must
// be true; anything else removes the v2 field. The v1 flag is left untouched either way.
handle('profiles:set-auto-continue-consent', (_event, input) => {
  const id = input?.id;
  if (typeof id !== 'string' || !PROFILE_ID.test(id) || typeof input?.autoSend !== 'boolean' || typeof input?.shareContext !== 'boolean') throw new Error('자동 이어받기 설정 값을 확인해 주세요.');
  const profiles = readProfiles();
  const profile = profiles.find(item => item.id === id);
  if (!profile) throw new Error('팀원 자리를 찾을 수 없습니다.');
  if (input.autoSend && input.shareContext) profile.autoContinueConsent = { version: 2, autoSend: true, shareContext: true, at: new Date().toISOString() };
  else delete profile.autoContinueConsent;
  writeProfiles(profiles);
  return { id: profile.id, autoContinueConsent: hasAutoContinueConsent(profile) };
});

handle('task:open', async (_event, { profileId, prompt }) => {
  const profile = readProfiles().find(item => item.id === profileId);
  if (!profile) throw new Error('팀원 자리를 찾을 수 없습니다.');
  if (profile.kind === 'cli') throw new Error('독립 CLI 자리는 웹창 대신 ‘로그인 터미널’과 CLI 대화를 사용해요.');

  if (typeof prompt !== 'string') throw new Error('질문 내용을 확인하세요.');
  if (prompt) clipboard.writeText(prompt);
  const existing = browserWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { copied: true };
  }
  const { transfer } = await openProfileWindow(profile, { navigate: true });
  return { copied: !!prompt, ...transfer };
});

// Opens (or focuses) the isolated window of a web profile. navigate=false leaves the current page
// untouched so the automatic engine can inspect the composer before loading a new chat.
async function openProfileWindow(profile, { navigate }) {
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
  if (alreadyOpen && !alreadyOpen.isDestroyed()) { alreadyOpen.focus(); return { browser: alreadyOpen, transfer }; }
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
  if (navigate) await browser.loadURL(serviceUrl);
  return { browser, transfer };
}

handle('file:export', async (_event, data) => {
  const tasks = validateTasks(data);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '실습 기록 내보내기 — 암호화되지 않은 JSON',
    defaultPath: 'aiplaygrand-notes.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return false;
  writeJSON(result.filePath, tasks);
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
