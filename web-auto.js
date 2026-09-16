'use strict';
// Automatic web send + response observation inside the app-owned, per-profile isolated browser
// window (visible spectator window; no hidden mode). Main process owns the state machine:
//   opening → checking → injecting → submitting → observing → stabilizing → saving → done
// Terminal outcomes: completed | needsUser (login, challenge, non-empty composer, unverified
// account, unverified submission) | error (failure.kind quota|unknown) | cancelled.
// Scripts run only on exact allow-listed origins and outside auth/payment paths (checked in main
// before every executeJavaScript and again inside the evaluated script). One send dispatch per
// run, no Enter/form fallback, no retry after dispatch. Prompt and answer are never logged.
// Selector families are reused from the AIBI browser runtime (read-only reference) for Claude and
// Gemini. Codex web (chatgpt.com/codex/cloud) has a distinct cloud task UI requiring environment
// setup that this app has not verified, so it is capability-gated off instead of being replaced by
// generic ChatGPT chat selectors.
// Persistence is fail-closed: a run is saved before it touches the page, partial answers are
// saved (throttled, encrypted vault) while streaming, and a finished run reaches onFinish (the
// handoff engine) only after its final save succeeded. Unsaved results stay in memory.
const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  prompt: 200000, output: 200000, error: 400, history: 20, runBytes: 3 * 1024 * 1024,
  loadMs: 30000, readyMs: 20000, submitMs: 15000, observeMs: 119000, pollMs: 1000, stableReadings: 3, saveThrottleMs: 2500, baselineChars: 4000
});
const PHASES = ['opening', 'checking', 'injecting', 'submitting', 'observing', 'stabilizing', 'saving', 'done'];
const STATUSES = ['running', 'completed', 'needsUser', 'error', 'cancelled', 'interrupted'];
const FAILURE_KINDS = ['quota', 'unknown'];
const AUTH_PATH = /^\/(login|signin|sign-in|auth|oauth|api\/auth|checkout|billing|payment|settings\/billing)(\/|$)/i;
// Wording that means throttling, transport, or context-size problems: never exhaustion even when
// it appears together with the word "limit".
const NOT_QUOTA = /rate limit|too many requests|\b429\b|network|connection|offline|context|too long|length|timeout|timed out|server error|try again|일시적|네트워크|연결|다시 시도|너무 깁|길이/i;

const WEB_PROVIDERS = Object.freeze({
  claude: {
    label: 'Claude 웹', automatic: true, newChatUrl: 'https://claude.ai/new', origins: ['https://claude.ai'],
    selectors: {
      promptInput: ["div.ProseMirror[contenteditable='true']", "div[contenteditable='true'][role='textbox']", "fieldset div[contenteditable='true']"],
      submitButton: ["button[aria-label*='Send' i]", "button[aria-label*='전송' i]", "button:has(svg[data-icon='paper-plane'])"],
      stopButton: ["button[aria-label*='Stop' i]", "button[aria-label*='중단' i]", "button[aria-label*='Stop generating' i]"],
      assistantMessage: ["div[data-is-streaming]", 'div.font-claude-message', "div[data-testid='assistant-message']"],
      userMessage: ["div[data-testid='user-message']", 'div.font-user-message'],
      errorBanner: ["div[data-testid*='error']", '.bg-danger-100', 'div.text-danger'],
      loginIndicator: ["input[type='email'][name='email']", "a[href*='/login']", "button[data-testid*='login']"],
      authenticatedIndicator: ["button[data-testid='user-menu-button']", "button[data-testid='user-menu']"],
      challengeIndicator: ["iframe[src*='cloudflare']", 'div#challenge-stage', "iframe[src*='turnstile']"]
    },
    // Matched only against a dedicated error banner (outside any message) that appeared during
    // this run. Requires explicit usage/message allocation wording; NOT_QUOTA wins on conflict.
    quotaPattern: /usage limit|message limit|out of (free )?messages|reached your (usage |message )?limit|(usage|message) limit reached|사용량 한도|메시지 한도|한도에 도달/i
  },
  gemini: {
    label: 'Gemini 웹', automatic: true, newChatUrl: 'https://gemini.google.com/app', origins: ['https://gemini.google.com'],
    selectors: {
      promptInput: ["div.ql-editor[contenteditable='true']", "textarea[aria-label*='prompt' i]", "div[role='textbox']"],
      submitButton: ["button[aria-label*='Send' i]", "button[aria-label*='보내기' i]", 'button.send-button', "button[mat-icon-button][aria-label*='send' i]"],
      stopButton: ["button[aria-label*='Stop' i]", "button[aria-label*='중지' i]", 'button.stop-generating-button'],
      assistantMessage: ['model-response .markdown', 'message-content .markdown', 'message-content', 'model-response', 'div.model-response-text', "div[data-test-id='model-response']"],
      userMessage: ['user-query', '.user-query-container', "div[data-test-id='user-query']"],
      errorBanner: ['.error-message', "[data-test-id='error-card']", '.sparkle-error-container'],
      loginIndicator: ["a[href*='accounts.google.com/ServiceLogin']", "a[href*='accounts.google.com/InteractiveLogin']", "a[aria-label*='Sign in' i]", "button[aria-label*='로그인' i]"],
      authenticatedIndicator: ["a[aria-label*='Google Account' i]", "a[aria-label*='Google 계정' i]", "a[href*='accounts.google.com/SignOutOptions']", "a[href*='myaccount.google.com']", 'gem-user-menu'],
      challengeIndicator: ["iframe[src*='recaptcha']", 'div.g-recaptcha', '#challenge-stage']
    },
    quotaPattern: /reached your (daily |usage )?limit|usage limit|quota (has been )?exceeded|exceeded your quota|out of (free )?(messages|requests|prompts)|(일일 |사용 |사용량 )?한도에 도달|사용량 한도|할당량(을|이) (초과|소진)/i
  },
  codex: {
    label: 'Codex 웹', automatic: false, origins: ['https://chatgpt.com'],
    reason: 'https://chatgpt.com/codex/cloud 작업 화면의 코드 환경 설정과 입력·실행·결과 연결 확인 전에는 수동 사용을 유지합니다. 일반 ChatGPT 대화 화면으로 대체하거나 임의 셀렉터를 사용하지 않으며, 수동 열기·복사만 지원합니다.'
  }
});

// Evaluated inside the provider page. Stateless per call; the only page-side state is the
// one-shot dispatch flag, the revocation flag and the last injected text, kept under a random
// per-run key. The origin AND the auth/payment path exclusion are re-checked here so a navigation
// between main's check and the evaluation cannot run the script on an excluded page.
const PAGE_SCRIPT = String(function pageScript(cfg, op, arg, origins, key) {
  try {
    if (!origins.includes(location.origin)) return { ok: false, code: 'ORIGIN' };
    if (new RegExp(cfg.authPath, 'i').test(location.pathname)) return { ok: false, code: 'ORIGIN' };
    const S = cfg.selectors;
    const q = (list, root) => { for (const s of list || []) { try { const el = (root || document).querySelector(s); if (el) return el; } catch (_) {} } return null; };
    const qa = (list, root) => { for (const s of list || []) { try { const els = Array.from((root || document).querySelectorAll(s)); if (els.length) return els; } catch (_) {} } return []; };
    const visible = el => { if (!el) return false; const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const anyVisible = list => { for (const s of list || []) { try { if (Array.from(document.querySelectorAll(s)).some(visible)) return true; } catch (_) {} } return false; };
    const input = () => q(S.promptInput);
    const textOf = el => { if (!el) return ''; const ce = el.isContentEditable || el.getAttribute('contenteditable') === 'true'; return (ce ? (el.innerText || '') : (el.value || '')).trim(); };
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
    const generating = () => anyVisible(S.stopButton);
    const sendButton = () => { const list = []; for (const s of S.submitButton || []) { try { list.push(...Array.from(document.querySelectorAll(s))); } catch (_) {} } return list.find(b => !/stop|중지|정지|voice|음성/.test(((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase()) && visible(b)) || null; };
    // Dedicated banners only: anything inside an assistant or user message is conversation text.
    const inMessage = el => { for (const s of [...(S.assistantMessage || []), ...(S.userMessage || [])]) { try { if (el.closest(s)) return true; } catch (_) {} } return false; };
    const banners = () => { const out = []; for (const s of S.errorBanner || []) { try { for (const el of document.querySelectorAll(s)) if (visible(el) && !inMessage(el)) { const t = norm(el.innerText || el.textContent); if (t) out.push(t.slice(0, 300)); } } catch (_) {} } return out; };
    const fullText = el => norm(el ? (el.innerText || el.textContent) : '');
    const lastAssistant = () => { const els = qa(S.assistantMessage); return { count: els.length, last: els.length ? els[els.length - 1] : null }; };
    const state = window[key] || (window[key] = { dispatched: false, revoked: false, injected: '' });
    if (op === 'revoke') { state.revoked = true; return { ok: true, dispatched: state.dispatched }; }
    if (op === 'ready') {
      const el = input();
      const { count, last } = lastAssistant();
      return { ok: true, login: anyVisible(S.loginIndicator), challenge: anyVisible(S.challengeIndicator), account: anyVisible(S.authenticatedIndicator), composer: !!el, composerText: textOf(el).length, assistantCount: count, lastText: fullText(last).slice(0, cfg.baselineChars), banners: banners() };
    }
    if (op === 'inject') {
      if (state.dispatched || state.revoked) return { ok: false, code: state.revoked ? 'REVOKED' : 'DISPATCHED' };
      const el = input();
      if (!el) return { ok: false, code: 'INPUT_NOT_FOUND' };
      if (textOf(el).length) return { ok: false, code: 'COMPOSER_NOT_EMPTY' };
      el.focus();
      const ce = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
      if (ce) {
        const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
        let inserted = false; try { inserted = document.execCommand('insertText', false, arg); } catch (_) { inserted = false; }
        if (!inserted) el.innerText = arg;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: arg }));
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, arg); else el.value = arg;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      state.injected = arg;
      return { ok: true, matches: norm(textOf(input())) === norm(arg) };
    }
    if (op === 'submit') {
      if (state.dispatched || state.revoked) return { ok: false, code: state.revoked ? 'REVOKED' : 'DISPATCHED' };
      const el = input(); const btn = sendButton();
      if (!el || !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || generating() || norm(textOf(el)) !== norm(state.injected) || !state.injected) return { ok: false, code: 'SEND_NOT_READY' };
      state.dispatched = true; // claimed before the click: a second call can never click again
      btn.click();
      return { ok: true };
    }
    if (op === 'observe') {
      // arg: { count, text } baseline taken before the send. A response counts as NEW only when a
      // node was added or the last node's text changed from the baseline (same-node streaming).
      const base = arg && typeof arg === 'object' ? arg : { count: 0, text: '' };
      const { count, last } = lastAssistant();
      const text = last ? fullText(last) : '';
      const changed = count > (base.count || 0) || (count === (base.count || 0) && count > 0 && text.slice(0, cfg.baselineChars) !== (base.text || ''));
      return { ok: true, challenge: anyVisible(S.challengeIndicator), login: anyVisible(S.loginIndicator), generating: generating(), assistantCount: count, changed, text: changed ? text.slice(0, 250000) : '', banners: banners() };
    }
    return { ok: false, code: 'OP' };
  } catch (e) { return { ok: false, code: 'SCRIPT', message: String(e && e.message ? e.message : e).slice(0, 120) }; }
});

const isText = (value, max) => typeof value === 'string' && value.length <= max;
const timeValue = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateWebRuns(data) {
  if (data === undefined || data === null) return { version: 1, runs: [] };
  if (!data || data.version !== 1 || !Array.isArray(data.runs) || data.runs.length > LIMITS.history) throw new Error('웹 자동 전송 기록 형식을 읽지 못했어요. 기존 보관함은 바꾸지 않았습니다.');
  const runs = data.runs.map(run => {
    if (!run || typeof run !== 'object' || !isText(run.id, 100) || !/^[a-zA-Z0-9-]+$/.test(run.id) || !STATUSES.includes(run.status) || !PHASES.includes(run.phase) || !isText(run.profileId, 100) || !isText(run.profileName, 120) || !Object.hasOwn(WEB_PROVIDERS, run.provider) || !isText(run.prompt, LIMITS.prompt) || !isText(run.output || '', LIMITS.output) || !isText(run.error || '', LIMITS.error) || (run.taskId !== null && run.taskId !== undefined && !isText(run.taskId, 100))) throw new Error('웹 자동 전송 기록이 손상되었어요. 기존 보관함은 바꾸지 않았습니다.');
    const failure = run.failure && typeof run.failure === 'object' ? { kind: FAILURE_KINDS.includes(run.failure.kind) ? run.failure.kind : 'unknown', code: isText(run.failure.code, 40) ? run.failure.code : '' } : null;
    return { id: run.id, status: run.status, phase: run.phase, profileId: run.profileId, profileName: run.profileName, provider: run.provider, prompt: run.prompt, output: run.output || '', error: run.error || '', failure, taskId: run.taskId || null, dispatchAttempted: run.dispatchAttempted === true || run.dispatched === true, dispatched: run.dispatched === true, createdAt: timeValue(run.createdAt), finishedAt: timeValue(run.finishedAt) };
  });
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('웹 자동 전송 기록에 중복된 ID가 있어요.');
  return { version: 1, runs };
}

// Dedicated-banner classification. Bounded and mutually exclusive with "accepted": a fresh banner
// is either confirmed quota (explicit exhaustion wording, no throttle/transport wording) or
// an unknown service error; it is never ignored.
function classifyBanners(definition, fresh) {
  if (!fresh.length) return null;
  const quota = fresh.some(text => definition.quotaPattern.test(text) && !NOT_QUOTA.test(text));
  return quota ? { kind: 'quota', code: 'banner' } : { kind: 'unknown', code: 'banner' };
}

// getWindow(profile) → Promise<BrowserWindow> (visible, isolated partition of that profile).
// store: { read, write, bytes, capacity } like the relay store. emit(event) → renderer.
function createWebAuto({ getWindow, store, emit, onFinish = null }) {
  let active = null; // { run, generation, window, key, guard, saveTimer }
  let generation = 0;
  let unsaved = null; // finished run whose final save failed: kept in memory, blocks new starts
  const now = () => Date.now();
  const snapshot = run => structuredClone(run);
  const publish = run => emit({ type: 'state', run: snapshot(run) });
  const cut = (value, max) => String(value || '').replace(/\p{Cc}/gu, ' ').slice(0, max);

  function persist(run) {
    const encoded = JSON.stringify(snapshot(run));
    if (Buffer.byteLength(encoded) > LIMITS.runBytes) throw new Error('이 웹 자동 전송 기록이 저장 한도(3MB)를 넘었어요. 화면의 결과를 직접 복사해 두세요.');
    const data = validateWebRuns(store.read());
    const others = data.runs.filter(item => item.id !== run.id);
    if (others.length >= LIMITS.history) throw new Error(`웹 자동 전송 기록이 ${LIMITS.history}개에 도달했어요. 이전 기록을 직접 삭제한 뒤 다시 시작하세요.`);
    store.write(validateWebRuns({ version: 1, runs: [JSON.parse(encoded), ...others] }));
  }

  function originAllowed(provider, url) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    return WEB_PROVIDERS[provider].origins.includes(parsed.origin) && !AUTH_PATH.test(parsed.pathname);
  }

  const live = state => active === state && state.generation === generation && !state.run.finishedAt && state.window && !state.window.isDestroyed();

  function pageCode(provider, op, arg, key) {
    const definition = WEB_PROVIDERS[provider];
    return `(${PAGE_SCRIPT})(${JSON.stringify({ selectors: definition.selectors, authPath: AUTH_PATH.source, baselineChars: LIMITS.baselineChars })}, ${JSON.stringify(op)}, ${JSON.stringify(arg === undefined ? null : arg)}, ${JSON.stringify(definition.origins)}, ${JSON.stringify(key)})`;
  }

  // Every script call re-checks the fence and the current origin/path in main first.
  async function page(state, op, arg) {
    if (!live(state)) throw new Error('cancelled');
    const contents = state.window.webContents;
    if (!originAllowed(state.run.provider, contents.getURL())) return { ok: false, code: 'ORIGIN' };
    let result;
    try { result = await contents.executeJavaScript(pageCode(state.run.provider, op, arg, state.key), true); } catch { return { ok: false, code: 'EVAL' }; }
    if (!live(state)) throw new Error('cancelled');
    return result && typeof result === 'object' ? result : { ok: false, code: 'EVAL' };
  }

  // Best-effort page-side revocation on cancel: a submit that is still queued in the page after
  // the cancel will refuse to click. Fire-and-forget, origin/path checked like every other call.
  function revoke(state) {
    try {
      if (!state.window || state.window.isDestroyed()) return;
      const contents = state.window.webContents;
      if (!originAllowed(state.run.provider, contents.getURL())) return;
      contents.executeJavaScript(pageCode(state.run.provider, 'revoke', null, state.key), true).catch(() => {});
    } catch {}
  }

  // Save-before-handoff, fail closed: onFinish runs only after the final save succeeded. On a
  // failed save the run (with its full output) stays in memory as 'unsaved' until retrySave().
  function commitFinished(run) {
    try { persist(run); } catch (saveError) {
      unsaved = run;
      run.saveFailed = true;
      run.saveError = cut(`결과를 USB 보관함에 저장하지 못했어요: ${saveError.message} 받은 답변은 화면에 그대로 있습니다. USB 연결을 확인한 뒤 ‘저장 다시 시도’를 누르세요. 저장되기 전에는 다른 팀원에게 넘기지 않습니다.`, LIMITS.error);
      publish(run);
      emit({ type: 'save-error', message: cut(saveError.message, LIMITS.error), runId: run.id, retryable: true });
      return false;
    }
    if (unsaved === run) unsaved = null;
    delete run.saveFailed; delete run.saveError;
    publish(run);
    if (typeof onFinish === 'function') { try { onFinish(snapshot(run)); } catch {} }
    return true;
  }

  function finish(state, status, { phase = 'done', error = '', failure = null } = {}) {
    if (active !== state || state.run.finishedAt) return;
    const run = state.run;
    clearTimeout(state.saveTimer); state.saveTimer = null;
    run.status = status; run.phase = phase; run.error = cut(error, LIMITS.error); run.failure = failure; run.finishedAt = now();
    active = null;
    commitFinished(run);
  }

  function retrySave() {
    if (!unsaved) throw new Error('다시 저장할 결과가 없어요.');
    const run = unsaved;
    if (!commitFinished(run)) throw new Error(run.saveError);
    return snapshot(run);
  }

  function setPhase(state, phase, extra = {}) {
    state.run.phase = phase;
    emit({ type: 'progress', runId: state.run.id, phase, ...extra });
    publish(state.run);
  }

  // Throttled encrypted save of the partial answer while streaming (same policy as the relay).
  // A failed partial save stops the run: nothing is kept only on screen without saying so.
  function schedulePartialSave(state) {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      if (!live(state)) return;
      try { persist(state.run); } catch (error) { finish(state, 'error', { phase: state.run.phase, error: `진행 내용을 USB에 저장하지 못해 관찰을 멈췄어요: ${error.message}`, failure: { kind: 'unknown', code: 'save' } }); }
    }, LIMITS.saveThrottleMs);
  }

  // guard: optional () => boolean supplied by the handoff engine; re-checked after every await
  // and immediately before injection and before the click. False → cancelled, nothing sent.
  async function start({ profile, prompt, taskId = null, guard = null }) {
    if (active) throw new Error('이미 웹 자동 전송이 진행 중이에요. 먼저 취소하세요.');
    if (unsaved) throw new Error('저장하지 못한 웹 자동 전송 결과가 있어요. ‘저장 다시 시도’로 먼저 저장하세요. 결과는 화면에 남아 있습니다.');
    if (!profile || !Object.hasOwn(WEB_PROVIDERS, profile.provider)) throw new Error('팀원 자리를 확인하세요.');
    const definition = WEB_PROVIDERS[profile.provider];
    if (!definition.automatic) throw new Error(`${definition.label}: ${definition.reason}`);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('보낼 질문이 비어 있어요.');
    if (prompt.length > LIMITS.prompt) throw new Error(`질문이 ${LIMITS.prompt.toLocaleString('ko-KR')}자를 넘어 보내지 않았어요.`);
    const data = validateWebRuns(store.read());
    if (data.runs.length >= LIMITS.history) throw new Error(`웹 자동 전송 기록이 ${LIMITS.history}개에 도달했어요. 이전 기록을 직접 삭제한 뒤 다시 시작하세요.`);
    if (store.bytes() + LIMITS.runBytes > store.capacity) throw new Error('보관함 여유 공간이 부족해 시작하지 않았어요. 기록을 정리한 뒤 다시 시도하세요.');
    if (typeof guard === 'function' && !guard()) throw new Error('이어받기가 취소되었거나 동의·팀원 상태가 바뀌어 시작하지 않았어요.');
    const run = { id: crypto.randomUUID(), status: 'running', phase: 'opening', profileId: profile.id, profileName: profile.name, provider: profile.provider, prompt, output: '', error: '', failure: null, taskId, dispatchAttempted: false, dispatched: false, createdAt: now(), finishedAt: null };
    const state = { run, generation: ++generation, window: null, key: `__aiplaygrand_${crypto.randomUUID().replaceAll('-', '')}`, guard: typeof guard === 'function' ? guard : null, saveTimer: null };
    persist(run); // saved before anything touches the page; a failed save leaves nothing active
    active = state;
    publish(run);
    drive(state).catch(error => { if (active === state) finish(state, 'error', { error: `자동 전송 중 오류: ${error.message}`, failure: { kind: 'unknown', code: '' } }); });
    return snapshot(run);
  }

  const fenced = state => !state.guard || state.guard();

  async function drive(state) {
    const run = state.run;
    const definition = WEB_PROVIDERS[run.provider];
    let window;
    try { window = await getWindow(run.profileId); } catch (error) { return finish(state, 'error', { error: `웹창을 열지 못했어요: ${error.message}`, failure: { kind: 'unknown', code: '' } }); }
    if (state.generation !== generation || active !== state) return;
    state.window = window;
    // Window closed while this run owns it: settle immediately (no wait for the poll loop).
    const closed = () => { if (active === state) finish(state, run.dispatched ? 'needsUser' : 'cancelled', { phase: run.phase, error: run.dispatched ? '웹창이 닫혀 관찰을 멈췄어요. 받은 부분 결과는 남겨 두었습니다.' : run.dispatchAttempted ? '전송 시도 중에 웹창이 닫혀 실제 전송 여부를 확인하지 못했어요. 다시 보내지 않습니다.' : '웹창이 닫혀 자동 전송을 멈췄어요. 아무것도 보내지 않았습니다.' }); };
    window.once('closed', closed);
    try {
      if (!fenced(state)) return finish(state, 'cancelled', { phase: 'opening', error: '이어받기가 취소되었거나 동의·팀원 상태가 바뀌어 보내지 않았어요. 아무것도 보내지 않았습니다.' });
      // 1. If the current page is on the provider origin and the composer holds text, never navigate over it.
      if (originAllowed(run.provider, window.webContents.getURL())) {
        const current = await page(state, 'ready');
        if (current.ok && current.composer && current.composerText > 0) return finish(state, 'needsUser', { phase: 'checking', error: `${run.profileName}의 웹창 입력창에 작성 중인 글이 있어 덮어쓰지 않았어요. 직접 정리한 뒤 다시 시작하세요.` });
      }
      setPhase(state, 'checking');
      await loadNewChat(state, definition.newChatUrl);
      if (!live(state)) return;
      // 2. Readiness: provider account marker required; login/challenge → user. A dedicated
      //    quota banner already shown on the fresh page is a confirmed exhaustion (nothing sent).
      const deadline = now() + LIMITS.readyMs;
      let ready = null;
      while (now() < deadline) {
        const probe = await page(state, 'ready');
        if (probe.code === 'ORIGIN') return finish(state, 'needsUser', { phase: 'checking', error: '로그인 또는 다른 화면으로 이동해 자동 전송을 멈췄어요. 웹창에서 직접 로그인한 뒤 다시 시작하세요. 앱은 로그인을 대신하지 않습니다.' });
        if (probe.ok && probe.challenge) return finish(state, 'needsUser', { phase: 'checking', error: '보안 확인(캡차 등)이 표시되어 자동 전송을 멈췄어요. 웹창에서 직접 처리한 뒤 다시 시작하세요.' });
        if (probe.ok && probe.login && !probe.account) return finish(state, 'needsUser', { phase: 'checking', error: `${run.profileName}의 ${definition.label} 로그인이 필요해요. 웹창에서 직접 로그인한 뒤 다시 시작하세요.` });
        if (probe.ok && probe.account && probe.banners.length) {
          const failure = classifyBanners(definition, probe.banners);
          if (failure.kind === 'quota') return finish(state, 'error', { phase: 'checking', error: `${definition.label}이(가) 새 대화 화면에서 사용량 한도 안내를 표시해 보내지 않았어요.`, failure });
          return finish(state, 'needsUser', { phase: 'checking', error: `${definition.label}이(가) 오류 안내를 표시해 보내지 않았어요 (한도 여부 확인 안 됨). 웹창을 직접 확인하세요.` });
        }
        if (probe.ok && probe.account && probe.composer) { ready = probe; break; }
        await sleep(500);
      }
      if (!live(state)) return;
      if (!ready) return finish(state, 'needsUser', { phase: 'checking', error: `${definition.label} 계정 표식과 입력창을 확인하지 못해 보내지 않았어요 (로그인 여부 확인 안 됨). 웹창에서 로그인 상태를 확인한 뒤 다시 시작하세요.` });
      const baseline = { count: ready.assistantCount, text: ready.lastText || '' };
      const baselineBanners = new Set(ready.banners);
      // 3. Inject (never overwrites a non-empty composer) and verify.
      if (!fenced(state)) return finish(state, 'cancelled', { phase: 'checking', error: '이어받기가 취소되었거나 동의·팀원 상태가 바뀌어 보내지 않았어요. 아무것도 보내지 않았습니다.' });
      setPhase(state, 'injecting');
      const injected = await page(state, 'inject', run.prompt);
      if (!injected.ok) return finish(state, injected.code === 'REVOKED' ? 'cancelled' : 'needsUser', { phase: 'injecting', error: injected.code === 'COMPOSER_NOT_EMPTY' ? '입력창에 이미 글이 있어 덮어쓰지 않았어요.' : injected.code === 'REVOKED' ? '취소되어 보내지 않았어요.' : `입력창에 질문을 넣지 못했어요 (${cut(injected.code, 30)}).` });
      if (!injected.matches) return finish(state, 'needsUser', { phase: 'injecting', error: '입력창의 내용이 보낼 질문과 달라 전송하지 않았어요. 웹창을 확인하세요.' });
      // 4. Single dispatch. The attempt is claimed and saved BEFORE the click so a cancel or crash
      //    during the pending script can never be reported as "nothing was sent".
      if (!fenced(state)) return finish(state, 'cancelled', { phase: 'injecting', error: '이어받기가 취소되었거나 동의·팀원 상태가 바뀌어 보내지 않았어요. 아무것도 보내지 않았습니다.' });
      setPhase(state, 'submitting');
      run.dispatchAttempted = true;
      try { persist(run); } catch (error) { run.dispatchAttempted = false; return finish(state, 'error', { phase: 'submitting', error: `전송 전 저장에 실패해 보내지 않았어요: ${error.message}`, failure: { kind: 'unknown', code: 'save' } }); }
      const sent = await page(state, 'submit');
      if (!sent.ok) {
        if (sent.code === 'SEND_NOT_READY' || sent.code === 'COMPOSER_NOT_EMPTY' || sent.code === 'REVOKED' || sent.code === 'ORIGIN') { run.dispatchAttempted = false; }
        return finish(state, sent.code === 'REVOKED' ? 'cancelled' : 'needsUser', { phase: 'submitting', error: sent.code === 'REVOKED' ? '취소되어 보내지 않았어요.' : run.dispatchAttempted ? `전송 버튼 클릭 결과를 확인하지 못했어요 (${cut(sent.code, 30)}). 실제 전송 여부를 웹창에서 직접 확인하세요. 중복 전송을 막기 위해 다시 보내지 않습니다.` : `전송 버튼을 누를 수 없어 보내지 않았어요 (${cut(sent.code, 30)}). 웹창에서 직접 확인하세요.` });
      }
      run.dispatched = true;
      try { persist(run); } catch (error) { return finish(state, 'error', { phase: 'submitting', error: `전송은 했지만 상태를 저장하지 못했어요: ${error.message}`, failure: { kind: 'unknown', code: 'save' } }); }
      // 5. Submission confirmation within 15 s: a fresh dedicated banner is classified FIRST
      //    (quota → confirmed exhaustion, else unknown error); otherwise a new/changed assistant
      //    node or a visible generation marker confirms acceptance. The two are exclusive.
      const confirmBy = now() + LIMITS.submitMs;
      let confirmed = false;
      while (now() < confirmBy) {
        const view = await page(state, 'observe', baseline);
        if (view.ok) {
          const failure = classifyBanners(definition, view.banners.filter(text => !baselineBanners.has(text)));
          if (failure) return finish(state, 'error', { phase: 'submitting', error: failure.kind === 'quota' ? `${definition.label}이(가) 전송 직후 사용량 한도 안내를 표시했어요. 답변은 받지 못했습니다.` : `${definition.label}이(가) 전송 직후 오류 안내를 표시했어요 (한도 여부 확인 안 됨). 다시 보내지 않습니다.`, failure });
          if (view.challenge) return finish(state, 'needsUser', { phase: 'submitting', error: '전송 직후 보안 확인이 표시됐어요. 웹창에서 직접 확인하세요. 중복 전송을 막기 위해 다시 보내지 않습니다.' });
          if (view.changed || view.generating) { confirmed = true; break; }
        }
        await sleep(500);
      }
      if (!live(state)) return;
      if (!confirmed) return finish(state, 'needsUser', { phase: 'submitting', error: '전송 버튼을 눌렀지만 15초 안에 새 답변이나 생성 표시를 확인하지 못했어요. 중복 전송을 막기 위해 다시 보내거나 다른 팀원에게 자동으로 넘기지 않습니다. 웹창을 직접 확인하세요.' });
      // 6. Observe up to 119 s: 3 identical non-empty readings with no visible generation marker.
      setPhase(state, 'observing', { remainingMs: LIMITS.observeMs, totalMs: LIMITS.observeMs });
      const observeUntil = now() + LIMITS.observeMs;
      let stable = 0, lastNorm = '';
      while (now() < observeUntil) {
        const view = await page(state, 'observe', baseline);
        if (!view.ok) { if (view.code === 'ORIGIN') return finish(state, 'needsUser', { phase: 'observing', error: '관찰 중 다른 화면으로 이동해 멈췄어요. 받은 부분 결과는 남겨 두었습니다.' }); await sleep(LIMITS.pollMs); continue; }
        if (view.challenge) return finish(state, 'needsUser', { phase: 'observing', error: '보안 확인이 표시되어 관찰을 멈췄어요. 받은 부분 결과는 남겨 두었습니다.' });
        const failure = classifyBanners(definition, view.banners.filter(text => !baselineBanners.has(text)));
        if (failure) return finish(state, 'error', { phase: 'observing', error: failure.kind === 'quota' ? `${definition.label}이(가) 사용량 한도 안내를 표시했어요. 받은 부분 결과는 남겨 두었습니다.` : `${definition.label}이(가) 오류 안내를 표시했어요 (한도 여부 확인 안 됨). 받은 부분 결과는 남겨 두었습니다.`, failure });
        const text = String(view.text || '');
        if (text.length > LIMITS.output) return finish(state, 'error', { phase: 'observing', error: `답변이 ${LIMITS.output.toLocaleString('ko-KR')}자 한도를 넘어 중단했어요.`, failure: { kind: 'unknown', code: '' } });
        if (text && text !== run.output) { run.output = text; emit({ type: 'output', runId: run.id, text }); schedulePartialSave(state); }
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!view.generating && normalized) { stable = normalized === lastNorm ? stable + 1 : 1; lastNorm = normalized; } else { stable = 0; lastNorm = normalized; }
        emit({ type: 'progress', runId: run.id, phase: stable ? 'stabilizing' : 'observing', remainingMs: Math.max(0, observeUntil - now()), totalMs: LIMITS.observeMs, stable });
        if (stable >= LIMITS.stableReadings) {
          setPhase(state, 'saving');
          return finish(state, 'completed');
        }
        await sleep(LIMITS.pollMs);
      }
      if (!live(state)) return;
      finish(state, 'error', { phase: 'observing', error: '119초 안에 답변이 안정되지 않아 관찰을 멈췄어요. 받은 부분 결과는 남겨 두었습니다. 자동으로 다시 보내지 않습니다.', failure: { kind: 'unknown', code: 'timeout' } });
    } catch (error) {
      if (error && error.message === 'cancelled') return;
      throw error;
    } finally {
      if (window && !window.isDestroyed()) window.removeListener('closed', closed);
    }
  }

  function loadNewChat(state, url) {
    return new Promise((resolve, reject) => {
      const contents = state.window.webContents;
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); contents.removeListener('did-finish-load', done); contents.removeListener('did-fail-load', failed); resolve(); };
      const failed = () => { if (settled) return; settled = true; clearTimeout(timer); contents.removeListener('did-finish-load', done); contents.removeListener('did-fail-load', failed); reject(new Error('페이지를 불러오지 못했어요. 인터넷 연결을 확인하세요.')); };
      const timer = setTimeout(failed, LIMITS.loadMs);
      contents.on('did-finish-load', done);
      contents.on('did-fail-load', failed);
      contents.loadURL(url).catch(() => {});
    });
  }

  // stop(): user cancel of the active run. stop({ runId } | { taskId }): cancel only if the active
  // run matches (handoff engine; never cancels an unrelated manual run). The message tells the
  // truth about dispatch: sent / attempted-but-unconfirmed / nothing sent.
  function stop(match) {
    if (!active) return false;
    const state = active;
    if (match && typeof match === 'object') {
      if (match.runId !== undefined && state.run.id !== match.runId) return false;
      if (match.taskId !== undefined && state.run.taskId !== match.taskId) return false;
    }
    generation++;
    revoke(state);
    const run = state.run;
    finish(state, 'cancelled', { phase: run.phase, error: run.dispatched ? '사용자가 취소했어요. 이미 전송된 질문은 서비스에서 계속 처리될 수 있으며, 받은 부분 결과는 남겨 두었습니다.' : run.dispatchAttempted ? '전송 시도 중에 취소되어 실제 전송 여부를 확인하지 못했어요. 웹창에서 직접 확인하세요. 다시 보내지 않습니다.' : '사용자가 취소했어요. 아무것도 보내지 않았습니다.' });
    return true;
  }

  function markInterrupted() {
    const data = validateWebRuns(store.read());
    let changed = false;
    for (const run of data.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted'; run.error = run.error || '앱이 닫혀 자동 전송이 중단됐어요. 부분 결과만 남아 있으며 자동으로 다시 보내지 않습니다.'; if (run.finishedAt === null) run.finishedAt = now(); changed = true;
    }
    if (changed) store.write(data);
    return data;
  }

  function state() {
    const data = validateWebRuns(store.read());
    const latest = active ? snapshot(active.run) : unsaved ? snapshot(unsaved) : (data.runs[0] ? snapshot(data.runs[0]) : null);
    const providers = Object.fromEntries(Object.entries(WEB_PROVIDERS).map(([id, item]) => [id, { label: item.label, automatic: item.automatic, reason: item.reason || '' }]));
    return { active: !!active, unsaved: !!unsaved, latest, history: data.runs.map(run => ({ id: run.id, status: run.status, profileName: run.profileName, provider: run.provider, createdAt: run.createdAt, prompt: run.prompt.slice(0, 120) })), providers, limits: { observeMs: LIMITS.observeMs, submitMs: LIMITS.submitMs, prompt: LIMITS.prompt } };
  }

  function load(id) {
    if (typeof id !== 'string') throw new Error('기록을 찾을 수 없어요.');
    const run = validateWebRuns(store.read()).runs.find(item => item.id === id);
    if (!run) throw new Error('기록을 찾을 수 없어요.');
    return snapshot(run);
  }

  function remove(id) {
    if (typeof id !== 'string') throw new Error('기록을 찾을 수 없어요.');
    if (active && active.run.id === id) throw new Error('진행 중인 자동 전송은 삭제할 수 없어요. 먼저 취소하세요.');
    const data = validateWebRuns(store.read());
    if (!data.runs.some(run => run.id === id)) throw new Error('기록을 찾을 수 없어요.');
    store.write({ version: 1, runs: data.runs.filter(run => run.id !== id) });
    return true;
  }

  return { start, stop, state, load, remove, retrySave, markInterrupted, isActive: () => !!active, hasUnsaved: () => !!unsaved, supports: provider => !!WEB_PROVIDERS[provider]?.automatic };
}

module.exports = { createWebAuto, validateWebRuns, classifyBanners, WEB_PROVIDERS, LIMITS, NOT_QUOTA };
