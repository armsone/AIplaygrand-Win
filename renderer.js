const $ = id => document.getElementById(id);
let profiles = [];
let tasks = [];
let loaded = false;
let saveChain = Promise.resolve();
let saveTimer;
let revision = 0;

function reportSaveError(error) {
  $('saveState').textContent = '저장하지 못함';
  $('storageError').hidden = false;
  $('errorMessage').textContent = error.message;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function saveTasks() {
  renderTasks();
  await persistTasks();
}

function persistTasks() {
  clearTimeout(saveTimer);
  if (!loaded) return Promise.reject(new Error('기록을 먼저 불러와야 저장할 수 있어요.'));
  const currentRevision = ++revision;
  const snapshot = { version: 1, tasks: structuredClone(tasks), draft: $('prompt').value };
  $('saveState').textContent = '저장 중…';
  saveChain = saveChain.catch(() => {}).then(() => window.playground.saveNotebook(snapshot));
  return saveChain.then(savedAt => {
    if (currentRevision !== revision) return;
    $('saveState').textContent = `저장됨 · ${new Date(savedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    $('storageError').hidden = true;
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  revision++;
  $('saveState').textContent = '작성 중 · 곧 저장';
  saveTimer = setTimeout(() => persistTasks().catch(reportSaveError), 500);
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

async function loadProfiles() {
  profiles = await window.playground.listProfiles();
  $('profiles').innerHTML = profiles.length
    ? profiles.map((profile, index) => `<div class="profile-chip ${profile.provider}"><span class="avatar">${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(profile.name)}</strong><small>${providers[profile.provider].name} · 개별 로그인</small></div><button data-login-profile="${profile.id}" class="profile-login" title="서비스 로그인 창">열기</button><button data-delete-profile="${profile.id}" title="팀원 제거" aria-label="${escapeHtml(profile.name)} 제거">×</button></div>`).join('')
    : '<div class="empty">팀원을 추가해 첫 미션을 시작하세요.</div>';
  $('profileSelect').innerHTML = profiles.map(profile => `<option value="${profile.id}">${escapeHtml(profile.name)} — ${providers[profile.provider].name}</option>`).join('');
  $('queueBtn').disabled = profiles.length === 0;
  renderTasks();
}

function renderTasks() {
  $('teamCount').textContent = profiles.length;
  $('missionCount').textContent = tasks.length;
  $('doneCount').textContent = tasks.filter(task => task.status === 'done').length;
  const query = $('search').value.trim().toLocaleLowerCase();
  const filter = $('statusFilter').value;
  const visible = tasks.filter(task => (filter === 'all' || task.status === filter) && `${task.prompt} ${task.result} ${task.profileName}`.toLocaleLowerCase().includes(query));
  $('tasks').innerHTML = visible.length
    ? visible.slice().reverse().map(task => {
      const statusLabel = task.status === 'done' ? '기록 완료' : task.status === 'paused' ? '잠시 쉬는 중' : task.status === 'opened' ? '실습 중' : '시작 전';
      const statusClass = task.status === 'done' ? 'done' : task.status === 'paused' ? 'error' : task.status === 'opened' ? 'running' : '';
      const hasProfile = profiles.some(profile => profile.id === task.profileId && profile.provider === task.provider);
      const availableProfiles = profiles.filter(profile => profile.provider === task.provider);
      const openAction = task.status === 'paused'
        ? `<button data-resume-task="${task.id}">서비스 한도가 풀렸는지 확인한 뒤 다시 시작</button>`
        : !hasProfile
        ? `<label>이 PC에서 이어갈 팀원<select id="reassign-${task.id}">${availableProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('')}</select></label><button data-reassign-task="${task.id}" ${availableProfiles.length ? '' : 'disabled'}>이 팀원으로 연결</button><span>${availableProfiles.length ? '기록의 팀원 자리가 이 PC에 없어요.' : '우리 팀에 같은 서비스를 쓰는 팀원을 추가하세요.'}</span>`
        : `<button data-open-task="${task.id}">질문 복사하고 ${providers[task.provider].name} ${$('executionMode').value === 'cli' ? 'CLI' : '웹'} 열기</button><button data-pause-task="${task.id}">사용량 제한으로 잠시 멈추기</button>`;
      return `<article class="task"><div class="task-head"><div class="task-meta"><span class="status ${statusClass}">${statusLabel}</span><span>${escapeHtml(task.profileName)} · ${new Date(task.created).toLocaleString()}</span></div><button class="icon" data-remove-task="${task.id}" title="미션 삭제" aria-label="미션 삭제">×</button></div><div class="task-prompt">${escapeHtml(task.prompt)}</div><div class="task-actions">${openAction}</div><label class="result-label">답변과 우리 팀이 배운 점<textarea id="result-${task.id}" placeholder="답변을 붙여 넣고, 새로 알게 된 점을 적어보세요.">${escapeHtml(task.result || '')}</textarea></label><div class="task-actions"><button data-save-task="${task.id}">실습 기록 저장</button></div></article>`;
    }).join('')
    : `<div class="empty"><span class="empty-symbol">✦</span><strong>${tasks.length ? '조건에 맞는 기록이 없어요' : '첫 번째 발견을 기다리고 있어요'}</strong><p>${tasks.length ? '검색어나 상태를 바꿔보세요.' : '위에서 질문을 적고 미션을 추가해 보세요. 우리 팀의 배움이 여기에 쌓입니다.'}</p></div>`;
}

$('addProfile').addEventListener('click', () => {
  $('profileForm').reset();
  $('profileDialog').showModal();
});
$('closeDialog').addEventListener('click', () => $('profileDialog').close());
$('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await window.playground.addProfile({ name: $('profileName').value, provider: $('provider').value });
    $('profileDialog').close();
    await loadProfiles();
    showToast('팀원을 추가했어요. 이제 자기 서비스 창에서 로그인하면 됩니다.');
  } catch (error) {
    showToast(error.message);
  }
});

$('profiles').addEventListener('click', async event => {
  const loginId = event.target.dataset.loginProfile;
  if (loginId) {
    try {
      const result = await window.playground.openTask({ profileId: loginId, prompt: '' });
      showToast(result.restored ? '저장된 쿠키 복원을 시도했어요. 로그인 여부는 서비스 화면에서 확인하세요.' : '서비스 창에서 직접 로그인하세요.');
    } catch (error) { showToast(error.message); }
    return;
  }
  const id = event.target.dataset.deleteProfile;
  if (!id) return;
  if (!confirm('팀원 자리를 목록에서 제거할까요? 미션과 로그인 데이터는 Data 폴더에 남습니다.')) return;
  try {
    await window.playground.deleteProfile(id);
    await loadProfiles();
    showToast('팀원 자리를 목록에서 제거했어요.');
  } catch (error) { reportSaveError(error); }
});

$('queueBtn').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  const profile = profiles.find(item => item.id === $('profileSelect').value);
  if (!prompt || !profile) return showToast('미션과 이번 차례를 확인해 주세요.');
  tasks.push({ id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name, provider: profile.provider, prompt, result: '', status: 'queued', created: new Date().toISOString() });
  $('prompt').value = '';
  try { await saveTasks(); } catch (error) { reportSaveError(error); }
});

$('tasks').addEventListener('click', async event => {
  const button = event.target;
  const task = tasks.find(item => item.id === (button.dataset.openTask || button.dataset.pauseTask || button.dataset.resumeTask || button.dataset.saveTask || button.dataset.removeTask || button.dataset.reassignTask));
  if (!task) return;

  try {
  if (button.dataset.removeTask) {
    if (!confirm('이 미션을 삭제할까요? 필요한 답변은 먼저 기록 내보내기로 보관하세요.')) return;
    tasks = tasks.filter(item => item.id !== task.id);
    await saveTasks();
  } else if (button.dataset.reassignTask) {
    const profile = profiles.find(item => item.id === $(`reassign-${task.id}`).value && item.provider === task.provider);
    if (!profile) return showToast('같은 서비스를 쓰는 팀원을 선택해 주세요.');
    task.profileId = profile.id;
    task.profileName = profile.name;
    await saveTasks();
    showToast('이 PC의 팀원 자리로 연결했어요.');
  } else if (button.dataset.openTask) {
    try {
      if ($('executionMode').value === 'cli') await window.playground.launchCli({ provider: task.provider, prompt: task.prompt });
      else await window.playground.openTask({ profileId: task.profileId, prompt: task.prompt });
      task.status = 'opened';
      await saveTasks();
      showToast('질문을 복사했어요. 열린 웹 또는 CLI 창에서 로그인 후 붙여 넣어 직접 전송하세요.');
    } catch (error) {
      showToast(error.message);
    }
  } else if (button.dataset.pauseTask) {
    task.status = 'paused';
    await saveTasks();
    showToast('미션을 잠시 멈췄어요. 사용량 제한이 풀린 뒤 이어가세요.');
  } else if (button.dataset.resumeTask) {
    task.status = 'queued';
    await saveTasks();
    showToast('서비스 사용이 다시 가능해졌다면 미션을 열어 계속하세요.');
  } else if (button.dataset.saveTask) {
    task.result = $(`result-${task.id}`).value;
    task.status = 'done';
    await saveTasks();
    showToast('우리 팀 실습 기록을 저장했어요.');
  }
  } catch (error) { reportSaveError(error); }
});

$('tasks').addEventListener('input', event => {
  const id = event.target.id;
  if (!id?.startsWith('result-')) return;
  const task = tasks.find(item => item.id === id.slice(7));
  if (!task) return;
  task.result = event.target.value;
  scheduleSave();
});

$('exportBtn').addEventListener('click', async () => {
  try {
    if (await window.playground.exportNotes(tasks)) showToast('실습 기록을 내보냈어요.');
  } catch (error) {
    showToast(error.message);
  }
});
$('importBtn').addEventListener('click', async () => {
  try {
    const imported = await window.playground.importNotes();
    if (!imported) return;
    tasks.push(...imported.map(task => ({ ...task, id: crypto.randomUUID(), status: task.status === 'paused' ? 'paused' : task.status === 'done' ? 'done' : 'queued' })));
    await saveTasks();
    showToast('미션과 기록을 가져왔어요.');
  } catch (error) {
    showToast(error.message);
  }
});

$('prompt').addEventListener('input', scheduleSave);
$('search').addEventListener('input', renderTasks);
$('statusFilter').addEventListener('change', renderTasks);
$('executionMode').addEventListener('change', renderTasks);
$('openFolder').addEventListener('click', async () => {
  const error = await window.playground.openDataFolder();
  if (error) showToast(error);
});
$('exitBtn').addEventListener('click', () => window.playground.requestExit());
$('retrySave').addEventListener('click', () => {
  if (!loaded) initialize();
  else persistTasks().catch(reportSaveError);
});

window.playground.onPrepareExit(async () => {
  $('workspace').inert = true;
  $('exitBtn').disabled = true;
  $('importBtn').disabled = true;
  $('exportBtn').disabled = true;
  try {
    if (loaded) await persistTasks();
    await window.playground.finishExit();
  } catch (error) {
    reportSaveError(error);
    $('workspace').inert = !loaded;
    $('exitBtn').disabled = false;
    $('importBtn').disabled = !loaded;
    $('exportBtn').disabled = !loaded;
    await window.playground.cancelExit();
  }
});

async function initialize() {
  try {
    const data = await window.playground.readNotebook();
    tasks = data.notebook.tasks;
    $('prompt').value = data.notebook.draft;
    $('dataPath').textContent = data.path;
    $('storageMode').textContent = data.mode;
    await loadProfiles();
    loaded = true;
    $('workspace').inert = false;
    $('importBtn').disabled = false;
    $('exportBtn').disabled = false;
    $('saveState').textContent = '기록 불러옴';
    $('storageError').hidden = true;
    refreshResources();
  } catch (error) { reportSaveError(error); }
}
let creatingVault = false;
$('vaultDialog').addEventListener('cancel', event => event.preventDefault());
$('vaultExit').addEventListener('click', () => window.playground.requestExit());
$('vaultForm').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('vaultPassword').value;
  if (creatingVault && password !== $('vaultConfirm').value) {
    $('vaultError').textContent = '비밀번호 확인이 일치하지 않아요.'; return;
  }
  $('vaultSubmit').disabled = true;
  $('vaultError').textContent = '';
  try {
    await window.playground.unlockVault(password);
    $('vaultPassword').value = '';
    $('vaultConfirm').value = '';
    $('vaultDialog').close();
    await initialize();
  } catch {
    $('vaultError').textContent = '보관함을 열지 못했어요. 비밀번호와 USB 연결을 확인하세요. 기존 파일은 보존됩니다.';
    $('vaultPassword').value = '';
    $('vaultConfirm').value = '';
  } finally { $('vaultSubmit').disabled = false; }
});
window.playground.onVaultSaveError(() => reportSaveError(new Error('로그인 세션을 USB에 저장하지 못했어요. 연결과 공간을 확인하고 저장하고 종료를 다시 시도하세요.')));
async function start() {
  try {
    const state = await window.playground.vaultStatus();
    if (state.unlocked) return initialize();
    creatingVault = !state.exists;
    $('vaultTitle').textContent = creatingVault ? '우리 팀 보관함 만들기' : '보관함 잠금 해제';
    $('vaultSubmit').textContent = creatingVault ? '비밀번호로 보관함 만들기' : '잠금 해제';
    $('confirmLabel').hidden = !creatingVault;
    $('vaultConfirm').required = creatingVault;
    $('legacyWarning').hidden = !state.legacy;
    $('vaultDialog').showModal();
  } catch (error) { reportSaveError(error); }
}
async function refreshResources() {
  $('checkResources').disabled = true;
  $('resourceSummary').textContent = '설치와 버전을 점검하고 있어요…';
  try {
    const result = await window.playground.checkResources();
    const labels = { ready: '실행 확인됨', missing: '설치 필요', outdated: '업데이트 필요', error: '실행 확인 실패' };
    $('resourceSummary').textContent = `${result.platform} · ${result.arch} · 메모리 ${result.ramGB}GB · 저장 공간 ${result.freeGB === null ? '확인 안 됨' : result.freeGB + 'GB 남음'} · 인터넷과 로그인은 서비스 접속 시 확인합니다.`;
    const canInstall = result.tools.filter(t => ['node', 'npm'].includes(t.id)).every(t => t.status === 'ready');
    $('resources').innerHTML = result.tools.map(tool => `<div class="resource-card ${tool.status}"><strong>${escapeHtml(tool.label)}</strong><small>${labels[tool.status]} ${escapeHtml(tool.version)}</small><button class="secondary" data-help="${tool.id}">공식 설치 안내</button>${['claude', 'gemini', 'codex'].includes(tool.id) ? tool.status === 'ready' ? `<button class="secondary" data-launch-cli="${tool.id}">CLI 열기</button>` : `<button class="secondary" data-install="${tool.id}" ${canInstall ? '' : 'disabled'}>USB에 설치</button>` : ''}</div>`).join('');
  } catch { $('resourceSummary').textContent = '환경 점검을 마치지 못했어요. 다시 점검을 눌러 주세요.'; }
  finally { $('checkResources').disabled = false; }
}
$('checkResources').addEventListener('click', refreshResources);
$('resources').addEventListener('click', async event => {
  const { help, install, launchCli } = event.target.dataset;
  try {
    if (help) await window.playground.toolHelp(help);
    if (install) {
      if (!confirm('공식 npm 패키지를 이 USB의 Tools 폴더에 설치할까요? 인터넷이 필요하며 설치 프로그램이 실행됩니다. 설치 후 다시 점검을 눌러 주세요.')) return;
      await window.playground.installTool(install);
      showToast('설치 터미널을 열었어요. 설치 결과를 확인한 뒤 다시 점검하세요.');
    }
    if (launchCli) {
      await window.playground.launchCli({ provider: launchCli, prompt: '' });
      showToast('CLI 터미널을 열었어요. 공식 계정으로 직접 로그인하세요.');
    }
  } catch (error) { showToast(error.message); }
});
start();
