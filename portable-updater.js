// AIplaygrand-Win 휴대용 동의형 자체 업데이트 (Windows x64 전용)
//
// 흐름: 확인(checkUpdate) → 동의(offerUpdate) → 다운로드(스트리밍, 크기·SHA-256 검증)
//   → 준비(PowerShell 도우미가 ZIP 검사·압축 해제 후 helper-ready.json 작성)
//   → 정상 '저장하고 종료'가 모두 성공한 뒤에만 apply-authorized.json 작성 → 앱 종료
//   → 도우미가 승인 마커와 실제 부모 프로세스 종료를 모두 확인한 뒤 프로그램 파일만 교체하고 재시작.
//
// 원칙: 렌더러가 URL·경로를 정하지 않는다. 다운로드 주소는 공식 GitHub 릴리스 주소로 고정하고,
// 해시는 GitHub API가 자산(asset)에 붙이는 digest만 신뢰한다. 실제 Windows 실행은 검증되지 않았다.

const { app, dialog } = require('electron');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const child_process = require('node:child_process');

const REPO_OWNER = 'armsone';
const REPO_NAME = 'AIplaygrand-Win';
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`;
const USER_AGENT = 'AIplaygrand-Win-Updater';
const UPDATE_DIR_NAME = '.aiplaygrand-update';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MIN_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 64 * 1024;
const METADATA_TIMEOUT_MS = 20000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTHORIZE_READY_WAIT_MS = 60 * 1000;
const POLICY_CHECK_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const ALLOWED_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_STATUSES = new Set(['success', 'rolled_back', 'rollback_failed', 'mixed', 'prepare_failed', 'aborted', 'cancelled']);
const BLOCKING_POLICIES = new Set(['restricted', 'allsigned']);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const formatMB = bytes => `${(bytes / 1048576).toFixed(1)}MB`;

class UpdaterError extends Error {}

class PortableUpdater {
  constructor(portableRoot, options = {}) {
    this.portableRoot = portableRoot;
    this.getMainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow : () => null;
    this.canShowDialog = typeof options.canShowDialog === 'function' ? options.canShowDialog : () => true;
    this.isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
    this.requestExit = typeof options.requestExit === 'function' ? options.requestExit : () => {};
    this.helperSourcePath = options.helperSourcePath || path.join(__dirname, 'scripts', 'apply-update.ps1');
    // idle | checking | available | downloading | preparing | ready | applying
    this.state = 'idle';
    this.statusMessage = '';
    this.lastError = '';
    this.availableUpdate = null;
    this.stagedUpdate = null;
    this.pendingApply = false;
    this.startupCheckDone = false;
    this.dialogOpen = false;
    this.pipelineActive = false;
    // 진행 중인 다운로드·준비 실행 1건: { info, cancelled, reason }. 취소는 이 플래그로 명시하고 비동기 경계마다 확인한다.
    this.activeRun = null;
    this.download = null;
    this.helper = null;
    this.startupResult = undefined;
  }

  // ---------- 플랫폼 ----------
  getPlatformSupportInfo() {
    if (!app.isPackaged) return { supported: false, reason: '개발 실행에서는 자체 업데이트를 사용하지 않아요.' };
    if (process.platform !== 'win32') return { supported: false, reason: '자체 업데이트는 Windows x64 휴대용 패키지에서만 지원해요.' };
    if (process.arch !== 'x64') return { supported: false, reason: '자체 업데이트는 x64 Windows에서만 지원해요.' };
    return { supported: true, reason: '' };
  }

  // ---------- 상태 ----------
  getStatus() {
    return {
      state: this.state,
      statusMessage: this.statusMessage,
      lastError: this.lastError,
      currentVersion: app.getVersion(),
      availableUpdate: this.availableUpdate ? { version: this.availableUpdate.version, isPrerelease: this.availableUpdate.isPrerelease, sizeBytes: this.availableUpdate.size } : null,
      stagedUpdate: this.stagedUpdate ? { version: this.stagedUpdate.version } : null,
      pendingApply: this.isPendingApply(),
      busy: this.isBusy(),
      platformSupport: this.getPlatformSupportInfo()
    };
  }

  setState(state, message, extra = {}) {
    this.state = state;
    if (typeof message === 'string') this.statusMessage = message;
    this.lastError = typeof extra.error === 'string' ? extra.error : '';
    this.sendProgress({ state, message: this.statusMessage, version: this.stagedUpdate?.version || this.availableUpdate?.version || null, ...extra });
  }

  sendProgress(payload) {
    try {
      const win = this.getMainWindow();
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed() && !win.webContents.isCrashed()) {
        win.webContents.send('updater:progress', payload);
      }
    } catch {}
  }

  // ---------- 버전 ----------
  parseSemver(tag) {
    if (typeof tag !== 'string') return null;
    const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(tag.trim());
    if (!match) return null;
    const tuple = [Number(match[1]), Number(match[2]), Number(match[3])];
    return tuple.every(Number.isSafeInteger) ? tuple : null;
  }

  compareSemver(a, b) {
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  }

  // ---------- 경로 검사 ----------
  assertNoReparse(target, label) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) {
      throw new UpdaterError(`${label} 경로를 확인할 수 없어요: ${error.code || error.message}`);
    }
    if (stat.isSymbolicLink()) throw new UpdaterError(`${label} 경로에 심볼릭 링크·정션(reparse point)이 있어 업데이트하지 않아요.`);
    return stat;
  }

  validateAppDirectory() {
    const raw = this.portableRoot;
    if (!raw || typeof raw !== 'string') throw new UpdaterError('앱 실행 폴더를 알 수 없어요.');
    const resolved = path.resolve(raw);
    if (process.platform === 'win32') {
      if (/^\\\\/.test(resolved)) throw new UpdaterError('네트워크 경로(UNC)에서는 자체 업데이트를 지원하지 않아요.');
      if (!/^[A-Za-z]:\\/.test(resolved)) throw new UpdaterError('드라이브 문자로 시작하는 경로에서만 업데이트할 수 있어요.');
    }
    const { root } = path.parse(resolved);
    if (resolved.toLowerCase() === root.toLowerCase() || resolved.toLowerCase() === root.toLowerCase().replace(/[\\/]+$/, '')) {
      throw new UpdaterError('드라이브 최상위 폴더에 풀린 앱은 업데이트할 수 없어요. 전용 폴더에 풀어 주세요.');
    }
    let current = resolved;
    while (true) {
      const stat = this.assertNoReparse(current, '앱 폴더');
      if (!stat.isDirectory()) throw new UpdaterError(`앱 폴더 경로가 폴더가 아니에요: ${current}`);
      const parent = path.dirname(current);
      if (parent === current || parent.toLowerCase() === root.toLowerCase()) break;
      current = parent;
    }
    const probe = path.join(resolved, `.update-probe-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(probe, 'ok', { flag: 'wx' });
      fs.unlinkSync(probe);
    } catch (error) {
      throw new UpdaterError(`앱 폴더에 쓸 수 없어 업데이트할 수 없어요 (${error.code || error.message}).`);
    }
    return resolved;
  }

  checkAvailableDiskSpace(targetPath, requiredBytes) {
    if (typeof fs.statfsSync !== 'function') throw new UpdaterError('디스크 여유 공간을 확인할 수 없는 환경이라 업데이트를 시작하지 않아요.');
    let stats;
    try { stats = fs.statfsSync(targetPath); } catch (error) {
      throw new UpdaterError(`디스크 여유 공간을 확인하지 못해 업데이트를 시작하지 않아요 (${error.code || error.message}).`);
    }
    const free = BigInt(stats.bavail) * BigInt(stats.bsize);
    if (free < BigInt(requiredBytes)) {
      throw new UpdaterError(`USB 여유 공간이 부족해요. 필요 약 ${formatMB(requiredBytes)}, 남은 공간 약 ${formatMB(Number(free))}. 백업 보관 공간까지 포함한 값이에요.`);
    }
  }

  prepareStageDirectory(appDir) {
    const baseDir = path.join(appDir, UPDATE_DIR_NAME);
    if (this.lstatQuiet(baseDir)) {
      const stat = this.assertNoReparse(baseDir, '업데이트 폴더');
      if (!stat.isDirectory()) throw new UpdaterError(`${UPDATE_DIR_NAME} 이름의 파일이 이미 있어 업데이트 폴더를 만들 수 없어요.`);
    } else {
      fs.mkdirSync(baseDir);
    }
    const updateId = crypto.randomUUID();
    const stageDir = path.join(baseDir, updateId);
    fs.mkdirSync(stageDir); // 비재귀·배타 생성: 이미 있으면 실패
    return { baseDir, updateId, stageDir };
  }

  lstatQuiet(target) {
    try { return fs.lstatSync(target); } catch { return null; }
  }

  readSmallJson(filePath, maxBytes = MAX_SMALL_FILE_BYTES) {
    const stat = this.lstatQuiet(filePath);
    if (!stat || !stat.isFile()) return null;
    if (stat.size > maxBytes) throw new UpdaterError(`파일이 너무 커서 읽지 않아요: ${path.basename(filePath)}`);
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UpdaterError('JSON 형식이 올바르지 않아요.');
    return data;
  }

  writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
  }

  // ---------- 네트워크 ----------
  validateHttpsUrl(target, allowedHosts) {
    let parsed;
    try { parsed = new URL(target); } catch { throw new UpdaterError('잘못된 주소 형식이에요.'); }
    if (parsed.protocol !== 'https:') throw new UpdaterError('HTTPS 주소만 사용해요.');
    if (parsed.username || parsed.password) throw new UpdaterError('자격 증명이 포함된 주소는 사용하지 않아요.');
    if (!allowedHosts.has(parsed.hostname)) throw new UpdaterError(`허용되지 않은 호스트예요: ${parsed.hostname}`);
    return parsed;
  }

  openResponse(target, { signal, allowedHosts, accept, idleTimeoutMs }, redirects = 0) {
    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = this.validateHttpsUrl(target, allowedHosts); } catch (error) { return reject(error); }
      const req = https.request(parsed, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal, timeout: idleTimeoutMs }, res => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new UpdaterError('리디렉션이 너무 많아 중단했어요.'));
          const location = res.headers.location;
          if (typeof location !== 'string' || !location) return reject(new UpdaterError('리디렉션 주소가 없어요.'));
          let next;
          try { next = new URL(location, parsed).href; } catch { return reject(new UpdaterError('리디렉션 주소를 해석하지 못했어요.')); }
          resolve(this.openResponse(next, { signal, allowedHosts, accept, idleTimeoutMs }, redirects + 1));
          return;
        }
        if (status === 403 && parsed.hostname === 'api.github.com') { res.resume(); return reject(new UpdaterError('GitHub 요청 한도에 걸렸어요. 잠시 후 다시 확인하세요.')); }
        if (status !== 200) { res.resume(); return reject(new UpdaterError(`서버 응답이 올바르지 않아요 (HTTP ${status}).`)); }
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new UpdaterError('연결이 오래 응답하지 않아 중단했어요.')));
      req.on('error', error => reject(error instanceof UpdaterError ? error : new UpdaterError(`연결 오류: ${error?.code || error?.name || error?.message || error}`)));
      req.end();
    });
  }

  async fetchJson(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
    try {
      const res = await this.openResponse(target, { signal: controller.signal, allowedHosts: new Set(['api.github.com']), accept: 'application/vnd.github+json', idleTimeoutMs: METADATA_TIMEOUT_MS });
      const chunks = [];
      let total = 0;
      for await (const chunk of res) {
        total += chunk.length;
        if (total > MAX_METADATA_BYTES) throw new UpdaterError('릴리스 정보가 너무 커서 읽지 않아요.');
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UpdaterError('릴리스 정보(JSON)를 해석하지 못했어요.'); }
    } catch (error) {
      if (controller.signal.aborted) throw new UpdaterError('GitHub 연결 시간이 초과되었어요.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  // ---------- 확인 ----------
  selectCandidate(releases, currentSemver) {
    let best = null;
    for (const release of releases) {
      if (!release || typeof release !== 'object' || release.draft === true) continue;
      if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) continue;
      const semver = this.parseSemver(release.tag_name);
      if (!semver || this.compareSemver(semver, currentSemver) <= 0) continue;
      if (best && this.compareSemver(semver, best.semver) <= 0) continue;
      const version = semver.join('.');
      const assetName = `AIplaygrand-Win-${version}-x64.zip`;
      const asset = Array.isArray(release.assets) ? release.assets.find(item => item && typeof item === 'object' && item.name === assetName && item.state === 'uploaded') : null;
      if (!asset) continue;
      if (!Number.isSafeInteger(asset.size) || asset.size < MIN_ASSET_BYTES || asset.size > MAX_DOWNLOAD_BYTES) continue;
      const digest = typeof asset.digest === 'string' ? SHA256_DIGEST.exec(asset.digest.trim().toLowerCase()) : null;
      best = {
        semver,
        version,
        assetName,
        size: asset.size,
        sha256: digest ? digest[1] : null,
        downloadUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}/${assetName}`,
        isPrerelease: release.prerelease === true
      };
    }
    return best;
  }

  async checkUpdate({ startup = false } = {}) {
    const support = this.getPlatformSupportInfo();
    if (!support.supported) return { supported: false, status: 'unsupported', updateAvailable: false, message: support.reason };
    if (startup) {
      if (this.startupCheckDone) return { supported: true, status: 'skipped', updateAvailable: false, message: '' };
      this.startupCheckDone = true;
    }
    if (this.state !== 'idle' && this.state !== 'available') {
      return { supported: true, status: this.state, updateAvailable: this.state !== 'checking', version: this.stagedUpdate?.version || this.availableUpdate?.version || null, message: this.statusMessage || '업데이트 작업이 진행 중이에요.' };
    }
    const currentVersion = app.getVersion();
    const currentSemver = this.parseSemver(currentVersion);
    if (!currentSemver) return { supported: true, status: 'error', updateAvailable: false, message: `현재 버전(${currentVersion}) 형식을 판별할 수 없어 확인하지 않아요.` };
    this.setState('checking', '새 버전을 확인하는 중…');
    try {
      const releases = await this.fetchJson(RELEASES_API_URL);
      if (!Array.isArray(releases)) throw new UpdaterError('릴리스 목록 형식이 올바르지 않아요.');
      const candidate = this.selectCandidate(releases, currentSemver);
      if (!candidate) {
        this.availableUpdate = null;
        this.setState('idle', `현재 최신 버전(v${currentVersion})을 사용 중이에요.`);
        return { supported: true, status: 'up_to_date', updateAvailable: false, currentVersion, message: this.statusMessage };
      }
      if (!candidate.sha256) {
        this.availableUpdate = null;
        this.setState('idle', `새 버전(v${candidate.version})이 있지만 GitHub 자산에 SHA-256 digest가 없어 설치하지 않아요.`);
        return { supported: true, status: 'missing_digest', updateAvailable: false, version: candidate.version, message: this.statusMessage };
      }
      this.availableUpdate = candidate;
      this.setState('available', `새 버전(v${candidate.version})이 있어요.${candidate.isPrerelease ? ' (시험 배포 표시)' : ''}`);
      return { supported: true, status: 'available', updateAvailable: true, version: candidate.version, isPrerelease: candidate.isPrerelease, sizeBytes: candidate.size, message: this.statusMessage };
    } catch (error) {
      const message = error instanceof UpdaterError ? error.message : `업데이트 확인 실패: ${error?.message || error}`;
      this.setState(this.availableUpdate ? 'available' : 'idle', message, { error: message });
      return { supported: true, status: 'error', updateAvailable: false, message };
    }
  }

  // ---------- 동의 ----------
  async offerUpdate() {
    if (this.state !== 'available' || !this.availableUpdate) return { consented: false, status: this.state, message: this.statusMessage };
    if (this.dialogOpen) return { consented: false, status: 'dialog_open', message: '업데이트 안내 창이 이미 열려 있어요.' };
    if (!this.canShowDialog()) return { consented: false, status: 'blocked', message: '지금은 업데이트 안내를 열 수 없어요.' };
    const info = this.availableUpdate;
    this.dialogOpen = true;
    let consented = false;
    try {
      const win = this.getMainWindow();
      const detail = [
        info.isPrerelease ? '※ 이 릴리스는 GitHub에서 시험 배포(prerelease)로 표시되어 있어요. 안정 버전이 아닐 수 있습니다.\n' : '',
        `‘지금 업데이트’를 누르면 다음 순서로 진행돼요.`,
        `• 공식 GitHub 릴리스에서 ZIP(약 ${formatMB(info.size)})을 내려받아 크기와 SHA-256을 검증하고, 실행 폴더의 ${UPDATE_DIR_NAME} 폴더에 준비합니다.`,
        `• 준비가 끝났을 때 진행 중인 작업(CLI 대화·릴레이·웹 자동 전송·자동 이어받기·미저장 결과)이 없으면 평소의 ‘저장하고 종료’를 자동으로 실행한 뒤 프로그램 파일만 교체하고 다시 시작합니다.`,
        `• 작업 중이면 작업을 끊지 않고, 끝난 뒤 ‘업데이트 적용’ 버튼을 눌러 직접 적용합니다.`,
        `• Data 폴더(보관함·로그인·기록), Tools 폴더, 사용자 파일은 건드리지 않습니다. 교체 전 원본은 백업 폴더에 남습니다.`,
        `• 업데이트가 끝나 앱이 다시 열릴 때까지 USB를 빼지 마세요.`
      ].filter(Boolean).join('\n');
      const result = await dialog.showMessageBox(win && !win.isDestroyed() ? win : null, {
        type: 'question',
        buttons: ['나중에', '지금 업데이트'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'AIplaygrand-Win 새 버전',
        message: `새 버전 v${info.version}이 있어요. (현재 v${app.getVersion()})`,
        detail
      });
      consented = result.response === 1;
    } finally { this.dialogOpen = false; }
    if (!consented || this.availableUpdate !== info || this.state !== 'available') {
      if (this.state === 'available') this.setState('available', `새 버전(v${info.version}) 업데이트를 보류했어요. 상단 ‘지금 업데이트’로 다시 시작할 수 있어요.`);
      return { consented: false, status: 'deferred', version: info.version, message: this.statusMessage };
    }
    if (!this.runPipeline(info)) {
      const message = '이전 업데이트 작업을 아직 정리하는 중이에요. 잠시 후 ‘지금 업데이트’를 다시 눌러 주세요.';
      this.setState('available', message);
      return { consented: false, status: 'deferred', version: info.version, message };
    }
    return { consented: true, status: 'downloading', version: info.version, message: '새 버전 다운로드를 시작해요…' };
  }

  // ---------- 다운로드 + 준비 파이프라인 ----------
  // 반환: 실행을 시작했으면 true. 이전 실행이 아직 정리 중이면 false.
  runPipeline(info) {
    if (this.pipelineActive) return false;
    this.pipelineActive = true;
    const run = { info, cancelled: false, reason: '' };
    this.activeRun = run;
    this.downloadAndPrepare(info, run)
      .then(() => {
        if (run.cancelled) throw new UpdaterError(run.reason || '업데이트를 취소했어요.');
        this.afterPrepared();
      })
      .catch(error => {
        const message = error instanceof UpdaterError ? error.message : `업데이트 준비 실패: ${error?.message || error}`;
        // 다운로드 파일 핸들은 downloadToFile 의 finally 에서 이미 닫혔으므로 여기서 정리해도 경합하지 않는다.
        this.discardStage();
        if (run.cancelled) {
          // cancelUpdate() 가 이미 'available' 로 안내했으면 그대로 둔다. 아직 진행 상태로 남아 있으면 여기서 벗어난다.
          if (this.state === 'downloading' || this.state === 'preparing') this.setState('available', run.reason || '업데이트를 취소했어요.');
          return;
        }
        // 스테이지 생성 전(앱 폴더 검사·여유 공간·폴더 생성) 실패도 사용자 취소로 오인하지 않고 그대로 보고한다.
        this.setState('available', message, { error: message });
      })
      .finally(() => {
        if (this.activeRun === run) this.activeRun = null;
        this.pipelineActive = false;
      });
    return true;
  }

  assertNotCancelled(run) {
    if (run && run.cancelled) throw new UpdaterError(run.reason || '업데이트를 취소했어요.');
  }

  async downloadAndPrepare(info, run) {
    const appDir = this.validateAppDirectory();
    this.checkAvailableDiskSpace(appDir, Math.max(info.size * 5, 256 * 1024 * 1024));
    const { updateId, stageDir } = this.prepareStageDirectory(appDir);
    const staged = { updateId, stageDir, appDir, version: info.version, zipPath: path.join(stageDir, info.assetName), ready: false };
    this.stagedUpdate = staged;
    this.setState('downloading', `새 버전 v${info.version} 다운로드 중… 0%`, { percent: 0, downloadedBytes: 0, totalBytes: info.size });
    const partPath = path.join(stageDir, 'download.part');
    await this.downloadToFile(info, partPath, run);
    this.assertNotCancelled(run);
    if (this.stagedUpdate !== staged) throw new UpdaterError('업데이트 준비를 취소했어요.');
    fs.renameSync(partPath, staged.zipPath);
    this.setState('preparing', `다운로드 검증 완료. 업데이트 도우미가 ZIP을 검사하고 준비하는 중…`);
    this.writeHelperScript(stageDir);
    this.writeJsonAtomic(path.join(stageDir, 'update-meta.json'), {
      updateId,
      version: info.version,
      zipFileName: info.assetName,
      expectedSha256: info.sha256,
      assetSize: info.size,
      appDir,
      parentPid: process.pid,
      stagedAt: new Date().toISOString()
    });
    await this.checkExecutionPolicy();
    this.assertNotCancelled(run);
    if (this.stagedUpdate !== staged) throw new UpdaterError('업데이트 준비를 취소했어요.');
    await this.startHelper(stageDir, appDir);
    await this.waitHelperReady(PREPARE_TIMEOUT_MS, run);
    this.assertNotCancelled(run);
    if (this.stagedUpdate !== staged) throw new UpdaterError('업데이트 준비를 취소했어요.');
    staged.ready = true;
  }

  async downloadToFile(info, destPath, run) {
    const controller = new AbortController();
    let abortReason = '';
    const abort = reason => { abortReason = abortReason || reason; controller.abort(); };
    // 파일 핸들을 열기 전에 취소 훅을 먼저 등록한다. 핸들을 여는 사이에 취소가 오면 곧바로 중단할 수 있다.
    this.download = { abort: () => abort('다운로드를 취소했어요.') };
    if (run && run.cancelled) abort(run.reason || '다운로드를 취소했어요.');
    const totalTimer = setTimeout(() => abort('다운로드 총 시간(30분)을 넘겨 중단했어요.'), DOWNLOAD_TOTAL_TIMEOUT_MS);
    const hasher = crypto.createHash('sha256');
    let handle = null;
    let res = null;
    let received = 0;
    let lastReport = 0;
    try {
      handle = await fsp.open(destPath, 'wx');
      if (controller.signal.aborted) throw new UpdaterError(abortReason);
      res = await this.openResponse(info.downloadUrl, { signal: controller.signal, allowedHosts: ALLOWED_DOWNLOAD_HOSTS, accept: 'application/octet-stream', idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS });
      const declared = res.headers['content-length'];
      if (declared !== undefined && Number(declared) !== info.size) throw new UpdaterError(`서버가 알린 파일 크기(${declared})가 릴리스 정보(${info.size})와 달라요.`);
      for await (const chunk of res) {
        if (controller.signal.aborted) throw new UpdaterError(abortReason);
        received += chunk.length;
        if (received > info.size) throw new UpdaterError('받은 데이터가 릴리스 정보의 크기를 넘어 중단했어요.');
        hasher.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new UpdaterError('USB에 파일을 쓰지 못했어요.');
          offset += bytesWritten;
        }
        const now = Date.now();
        if (now - lastReport >= 300 || received === info.size) {
          lastReport = now;
          const percent = Math.min(100, Math.floor((received / info.size) * 100));
          this.setState('downloading', `새 버전 v${info.version} 다운로드 중… ${percent}% (${formatMB(received)} / ${formatMB(info.size)})`, { percent, downloadedBytes: received, totalBytes: info.size });
        }
      }
      // 마지막 조각 뒤에 취소가 와도 검증·동기화로 넘어가지 않는다.
      if (controller.signal.aborted || (run && run.cancelled)) throw new UpdaterError(abortReason || run?.reason || '다운로드를 취소했어요.');
      if (received !== info.size) throw new UpdaterError(`받은 크기(${received})가 릴리스 정보(${info.size})와 달라요.`);
      const actual = hasher.digest('hex');
      if (actual !== info.sha256) throw new UpdaterError('SHA-256 검증에 실패해 파일을 버렸어요.');
      await handle.sync();
    } catch (error) {
      if (controller.signal.aborted) throw new UpdaterError(abortReason || '다운로드가 중단되었어요.');
      if (error instanceof UpdaterError) throw error;
      throw new UpdaterError(`다운로드 오류: ${error?.code || error?.name || error?.message || error}`);
    } finally {
      clearTimeout(totalTimer);
      this.download = null;
      // 크기 불일치·검증 실패 등 어떤 경로로 나가든 응답 소켓을 닫는다(정상 완료 뒤에는 이미 끝난 스트림이라 무해).
      if (res) { try { res.destroy(); } catch {} }
      if (handle) await handle.close().catch(() => {});
    }
  }

  abortActiveDownload() {
    if (this.download) { try { this.download.abort(); } catch {} }
  }

  // ---------- 도우미(PowerShell) ----------
  powershellPath() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  writeHelperScript(stageDir) {
    let content;
    try { content = fs.readFileSync(this.helperSourcePath); } catch (error) {
      throw new UpdaterError(`업데이트 도우미 스크립트를 읽지 못했어요 (${error.code || error.message}).`);
    }
    if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) content = content.subarray(3);
    // Windows PowerShell 5.1은 BOM 없는 UTF-8 스크립트를 ANSI로 읽어 한글이 깨지므로 BOM을 붙여 복사한다.
    fs.writeFileSync(path.join(stageDir, 'apply-update.ps1'), Buffer.concat([UTF8_BOM, content]), { flag: 'wx' });
  }

  checkExecutionPolicy() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = fn => { if (!settled) { settled = true; fn(); } };
      let child;
      try {
        child = child_process.execFile(this.powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', '(Get-ExecutionPolicy).ToString()'], { windowsHide: true, timeout: POLICY_CHECK_TIMEOUT_MS, maxBuffer: 4096 }, (error, stdout) => {
          if (error) return done(() => reject(new UpdaterError(`Windows PowerShell을 실행하지 못했어요 (${error.code || error.message}). PowerShell 5.1이 필요해요.`)));
          const policy = String(stdout || '').trim().toLowerCase();
          if (BLOCKING_POLICIES.has(policy)) {
            return done(() => reject(new UpdaterError(`이 PC의 PowerShell 실행 정책(${policy})이 스크립트 실행을 막고 있어 자체 업데이트를 할 수 없어요. 앱은 정책을 우회하거나 바꾸지 않으니, ZIP을 직접 내려받아 풀거나 PC 관리자에게 문의하세요.`)));
          }
          done(resolve);
        });
      } catch (error) {
        return done(() => reject(new UpdaterError(`PowerShell 실행 실패: ${error.message}`)));
      }
      child.on('error', error => done(() => reject(new UpdaterError(`PowerShell 실행 실패: ${error.code || error.message}`))));
    });
  }

  startHelper(stageDir, appDir) {
    return new Promise((resolve, reject) => {
      const args = ['-NoProfile', '-NonInteractive', '-File', path.join(stageDir, 'apply-update.ps1'), '-Action', 'Apply', '-StageDir', stageDir, '-AppDir', appDir, '-ParentPid', String(process.pid)];
      let child;
      try {
        child = child_process.spawn(this.powershellPath(), args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      } catch (error) {
        return reject(new UpdaterError(`업데이트 도우미를 시작하지 못했어요 (${error.code || error.message}).`));
      }
      const helper = { child, pid: child.pid, exited: false, exitCode: null, spawnError: null, stageDir };
      this.helper = helper;
      let spawned = false;
      child.once('spawn', () => { spawned = true; resolve(); });
      child.once('error', error => {
        helper.spawnError = error;
        helper.exited = true;
        if (!spawned) reject(new UpdaterError(`업데이트 도우미를 시작하지 못했어요 (${error.code || error.message}).`));
      });
      child.once('exit', (code, signal) => {
        helper.exited = true;
        helper.exitCode = code === null ? `signal:${signal}` : code;
      });
      child.unref();
    });
  }

  async waitHelperReady(timeoutMs, run = null) {
    const helper = this.helper;
    const staged = this.stagedUpdate;
    if (!helper || !staged) throw new UpdaterError('업데이트 도우미가 없어요.');
    const readyPath = path.join(staged.stageDir, 'helper-ready.json');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertNotCancelled(run);
      if (this.stagedUpdate !== staged) throw new UpdaterError('업데이트 준비를 취소했어요.');
      if (helper.exited) throw new UpdaterError(this.describeHelperFailure(helper, staged));
      let ready = null;
      try { ready = this.readSmallJson(readyPath); } catch { ready = null; }
      if (ready && ready.ready === true && ready.updateId === staged.updateId && ready.helperPid === helper.pid) return;
      await sleep(500);
    }
    throw new UpdaterError('업데이트 도우미가 제한 시간 안에 준비를 마치지 못했어요. USB 속도나 여유 공간을 확인한 뒤 다시 시도하세요.');
  }

  describeHelperFailure(helper, staged) {
    let detail = '';
    try {
      const result = this.readSmallJson(path.join(staged.stageDir, 'result.json'));
      if (result && typeof result.error === 'string') detail = result.error.slice(0, 400);
      this.acknowledgeResult(staged.stageDir);
    } catch {}
    if (detail) return `업데이트 도우미 사전 검사 실패: ${detail}`;
    if (helper.spawnError) return `업데이트 도우미를 시작하지 못했어요 (${helper.spawnError.code || helper.spawnError.message}).`;
    return `업데이트 도우미가 준비를 마치기 전에 종료됐어요 (코드 ${helper.exitCode}). PowerShell 실행 정책이 스크립트를 막았거나 사전 검사에 실패했을 수 있어요. 자세한 내용은 ${UPDATE_DIR_NAME}\\${staged.updateId}\\update.log를 확인하세요.`;
  }

  writeCancelMarker(stageDir, reason) {
    try { this.writeJsonAtomic(path.join(stageDir, 'apply-cancelled.json'), { cancelled: true, reason, at: new Date().toISOString() }); } catch {}
  }

  // 도우미가 승인 마커를 받기 전까지는 아무것도 바꾸지 않으므로 취소는 마커 + (예비) 종료로 충분하다.
  stopHelper(reason) {
    const helper = this.helper;
    const staged = this.stagedUpdate;
    if (staged) this.writeCancelMarker(staged.stageDir, reason);
    if (helper && !helper.exited) {
      setTimeout(() => { if (!helper.exited) { try { helper.child.kill(); } catch {} } }, 5000).unref();
    }
    this.helper = null;
  }

  // 취소된 스테이지 정리: 이 세션에서 만든 UUID 스테이지의 알려진 파일만 지운다. 도우미가 아직 살아 있거나
  // 저널이 '준비' 단계를 넘어섰다면(교체가 시작됐을 수 있음) 그대로 둔다.
  discardStage() {
    const staged = this.stagedUpdate;
    const helper = this.helper;
    this.pendingApply = false;
    if (!staged) { this.stagedUpdate = null; this.helper = null; return; }
    this.stopHelper('discard');
    this.stagedUpdate = null;
    const cleanup = () => {
      try {
        const journal = this.readSmallJson(path.join(staged.stageDir, 'update-journal.json'));
        if (journal && journal.status !== 'prepared') return;
      } catch { return; }
      const stat = this.lstatQuiet(staged.stageDir);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
      const extracted = path.join(staged.stageDir, 'extracted');
      const extractedStat = this.lstatQuiet(extracted);
      if (extractedStat && extractedStat.isDirectory() && !extractedStat.isSymbolicLink()) { try { fs.rmSync(extracted, { recursive: true, force: false }); } catch {} }
      for (const name of ['download.part', path.basename(staged.zipPath), 'apply-update.ps1', 'update-meta.json', 'helper-ready.json', 'apply-cancelled.json', 'apply-authorized.json', 'update-journal.json', 'update-journal.prev.json', 'result.json', 'result-seen.json', 'update.log']) {
        const target = path.join(staged.stageDir, name);
        const s = this.lstatQuiet(target);
        if (s && s.isFile()) { try { fs.unlinkSync(target); } catch {} }
      }
      try { fs.rmdirSync(staged.stageDir); } catch {}
    };
    if (helper && !helper.exited) {
      const started = Date.now();
      const poll = () => {
        if (helper.exited || Date.now() - started > 15000) { if (helper.exited) cleanup(); return; }
        setTimeout(poll, 500).unref();
      };
      setTimeout(poll, 500).unref();
    } else cleanup();
  }

  // ---------- 준비 완료 이후 ----------
  afterPrepared() {
    const staged = this.stagedUpdate;
    if (!staged || !staged.ready) return;
    if (!this.isBusy() && this.canShowDialog()) {
      this.setState('applying', `새 버전 v${staged.version} 준비 완료. 저장하고 종료한 뒤 교체·재시작해요…`);
      this.pendingApply = true;
      this.requestExit();
      return;
    }
    this.setState('ready', `새 버전 v${staged.version} 준비 완료. 진행 중인 작업이 끝나면 ‘업데이트 적용’을 눌러 저장·종료 후 교체해요.`);
  }

  requestApply() {
    if (this.state !== 'ready' || !this.stagedUpdate?.ready) throw new Error('적용할 준비된 업데이트가 없어요. 먼저 새 버전을 내려받아 준비해 주세요.');
    if (this.helper?.exited) {
      const message = this.describeHelperFailure(this.helper, this.stagedUpdate);
      this.discardStage();
      this.setState('available', message, { error: message });
      throw new Error(message);
    }
    if (this.isBusy()) throw new Error('작업이 진행 중이거나 저장되지 않은 결과가 있어 지금은 적용할 수 없어요. 작업을 마친 뒤 다시 시도하세요.');
    this.pendingApply = true;
    this.setState('applying', `새 버전 v${this.stagedUpdate.version} 적용을 위해 저장하고 종료해요…`);
    this.requestExit();
    return { requested: true, version: this.stagedUpdate.version };
  }

  isPendingApply() {
    return this.pendingApply && Boolean(this.stagedUpdate?.ready);
  }

  // 종료가 취소되거나 저장이 실패하면 이번 스테이지는 폐기한다. 이후의 평범한 종료에서 자동 적용되지 않는다.
  cancelPendingApply(reason = 'exit-cancelled') {
    if (!this.pendingApply && this.state !== 'applying') return;
    const version = this.stagedUpdate?.version;
    this.discardStage();
    this.setState('available', version ? `업데이트 적용을 취소했어요(${reason === 'save-failed' ? '저장 실패' : '종료 취소'}). 다시 적용하려면 ‘지금 업데이트’로 새로 내려받으세요.` : '업데이트 적용을 취소했어요.');
  }

  // 사용자가 다운로드·준비 중 취소했거나, 준비된 업데이트를 버리고 싶을 때.
  // 취소는 실행(run) 플래그로 명시한다. 파이프라인은 비동기 경계마다 이 플래그를 확인하고 UpdaterError 로 끝난다.
  cancelUpdate() {
    const run = this.activeRun;
    const version = this.stagedUpdate?.version || run?.info?.version;
    if (this.state === 'downloading') {
      if (run) { run.cancelled = true; run.reason = '다운로드를 취소했어요.'; }
      // 열린 파일 핸들과 경합하지 않도록 스테이지 정리는 파이프라인의 catch(핸들이 닫힌 뒤)에 맡긴다.
      this.abortActiveDownload();
      this.setState('available', version ? `v${version} 다운로드를 취소했어요.` : '다운로드를 취소했어요.');
      return { cancelled: true };
    }
    if (this.state === 'preparing' || this.state === 'ready') {
      if (run) { run.cancelled = true; run.reason = '업데이트 준비를 취소했어요.'; }
      this.discardStage();
      this.setState('available', version ? `v${version} 업데이트 준비를 취소했어요.` : '업데이트 준비를 취소했어요.');
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  // 정상 종료 파이프라인 마지막 단계에서 호출된다: 저장·플러시가 모두 끝난 뒤에만 승인 마커를 쓴다.
  async authorizeApply() {
    if (!this.isPendingApply()) return false;
    const staged = this.stagedUpdate;
    const helper = this.helper;
    if (!helper || helper.exited) throw new Error(helper ? this.describeHelperFailure(helper, staged) : '업데이트 도우미가 실행 중이 아니에요.');
    await this.waitHelperReady(AUTHORIZE_READY_WAIT_MS);
    if (this.lstatQuiet(path.join(staged.stageDir, 'apply-cancelled.json'))) throw new Error('업데이트가 취소된 상태라 적용하지 않아요.');
    this.writeJsonAtomic(path.join(staged.stageDir, 'apply-authorized.json'), {
      authorized: true,
      updateId: staged.updateId,
      appDir: staged.appDir,
      version: staged.version,
      parentPid: process.pid,
      helperPid: helper.pid,
      authorizedAt: new Date().toISOString()
    });
    this.pendingApply = false;
    this.state = 'applying';
    return true;
  }

  // 업데이트 적용 없이 종료할 때 대기 중인 도우미를 정리한다(도우미는 부모 종료만으로도 스스로 끝난다).
  cancelHelperOnQuit() {
    if (this.stagedUpdate && !this.isPendingApply() && this.state !== 'applying') this.stopHelper('quit-without-apply');
  }

  // ---------- 이전 실행 결과 ----------
  acknowledgeResult(stageDir) {
    try { fs.writeFileSync(path.join(stageDir, 'result-seen.json'), JSON.stringify({ seenAt: new Date().toISOString() }), { flag: 'wx' }); } catch {}
  }

  checkStartupResult() {
    if (this.startupResult !== undefined) return this.startupResult;
    this.startupResult = null;
    try {
      const baseDir = path.join(path.resolve(this.portableRoot), UPDATE_DIR_NAME);
      const baseStat = this.lstatQuiet(baseDir);
      if (!baseStat || !baseStat.isDirectory() || baseStat.isSymbolicLink()) return null;
      const found = [];
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_RE.test(entry.name)) continue;
        const stageDir = path.join(baseDir, entry.name);
        if (this.lstatQuiet(path.join(stageDir, 'result-seen.json'))) continue;
        const resultPath = path.join(stageDir, 'result.json');
        const resultStat = this.lstatQuiet(resultPath);
        let item = null;
        if (resultStat && resultStat.isFile()) {
          try {
            const data = this.readSmallJson(resultPath);
            if (data && RESULT_STATUSES.has(data.status) && data.updateId === entry.name) {
              item = { status: data.status, version: this.parseSemver(data.version) ? this.parseSemver(data.version).join('.') : '', error: typeof data.error === 'string' ? data.error.slice(0, 400) : '', mtime: resultStat.mtimeMs, stageDir };
            }
          } catch {}
        } else {
          try {
            const journal = this.readSmallJson(path.join(stageDir, 'update-journal.json'));
            if (journal && journal.status === 'applying') item = { status: 'interrupted', version: this.parseSemver(journal.targetVersion) ? this.parseSemver(journal.targetVersion).join('.') : '', error: '', mtime: 0, stageDir };
          } catch {}
        }
        if (item) found.push(item);
      }
      if (!found.length) return null;
      found.sort((a, b) => b.mtime - a.mtime);
      for (const item of found) if (item.status !== 'interrupted') this.acknowledgeResult(item.stageDir);
      const latest = found[0];
      this.startupResult = { status: latest.status, version: latest.version, error: latest.error, stageFolder: `${UPDATE_DIR_NAME}\\${path.basename(latest.stageDir)}` };
    } catch { this.startupResult = null; }
    return this.startupResult;
  }
}

module.exports = { PortableUpdater };
