'use strict';
// Independent CLI seats: one official CLI login per teammate profile, isolated with the CLI's own
// documented configuration-directory mechanism. Official login runs in the seat's environment.
// Optional explicit transfer of seat-only credential files is implemented in cli-credentials.js.
//   claude : CLAUDE_CONFIG_DIR   (credential file and keychain entry are keyed to this directory)
//   codex  : CODEX_HOME          (auth.json lives here; exec --ignore-user-config keeps auth in CODEX_HOME)
//   gemini : GEMINI_CLI_HOME     (already used by the pinned app-owned runtime; here per seat)
// Seat folders live under the OS app-data folder, never on the USB, and are keyed by validated
// persisted profile ids only. Login/status/automatic runs all receive the same sanitized env.
const fs = require('node:fs');
const path = require('node:path');
const { baseEnv, prepareGemini } = require('./gemini-runtime');

const SEAT_PROVIDERS = Object.freeze({
  claude: { label: 'Claude Code', envKey: 'CLAUDE_CONFIG_DIR', loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status', '--json'], isolation: 'CLAUDE_CONFIG_DIR (공식 문서: 자격 증명 파일과 macOS 키체인 항목이 이 폴더에 묶임)' },
  codex: { label: 'Codex CLI', envKey: 'CODEX_HOME', loginArgs: ['login', '-c', 'cli_auth_credentials_store="file"'], statusArgs: ['login', 'status', '-c', 'cli_auth_credentials_store="file"'], isolation: 'CODEX_HOME + cli_auth_credentials_store="file" (공식 문서: 이 폴더의 auth.json에 저장. 키체인 저장 방식은 자리별 격리가 문서화되지 않아 쓰지 않음)' },
  gemini: { label: 'Gemini CLI', envKey: 'GEMINI_CLI_HOME', loginArgs: [], statusArgs: null, isolation: 'GEMINI_CLI_HOME (공식 문서: 사용자 설정·상태를 이 폴더 아래 .gemini에 격리)' }
});
const ID = /^[a-zA-Z0-9-]{1,100}$/;

function seatRoot(appData) { return path.join(appData, 'AIplaygrand-Win', 'CliSeats'); }

// profile must come from the validated persisted list (main re-reads the vault before calling).
function seatDir(appData, profile) {
  if (!profile || profile.kind !== 'cli' || !ID.test(String(profile.id)) || !Object.hasOwn(SEAT_PROVIDERS, profile.provider)) throw new Error('독립 CLI 자리를 찾을 수 없어요.');
  const dir = path.join(seatRoot(appData), profile.provider, profile.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Returns { env, cwd } for every command run on behalf of this seat. Inherited API keys, provider
// overrides and tokens are excluded by the allowlist in baseEnv; HOME/USERPROFILE of the app
// process are passed through unchanged (the CLI needs them), only the CLI's own config dir is set.
function seatEnvironment(appData, profile) {
  const dir = seatDir(appData, profile);
  if (profile.provider === 'gemini') {
    const prepared = prepareGemini(appData, dir);
    return { env: prepared.env, cwd: prepared.cwd, dir };
  }
  const env = baseEnv();
  const configDir = path.join(dir, profile.provider === 'claude' ? 'config' : 'home');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  env[SEAT_PROVIDERS[profile.provider].envKey] = configDir;
  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { env, cwd, dir };
}

// Interprets the official status command. Only booleans and an anonymous code leave this function;
// no account names, tokens or raw output are returned. Unknown formats stay 'unknown'.
function interpretStatus(provider, { error, code, stdout }) {
  if (provider === 'codex') {
    if (code === 0) return { state: 'loggedIn' };
    if (code === 1) return { state: 'authNeeded' };
    return { state: 'unknown', code: error ? String(error.code || 'error').slice(0, 30) : `exit-${code}` };
  }
  if (provider === 'claude') {
    let parsed;
    try { parsed = JSON.parse(String(stdout || '').trim()); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && typeof parsed.loggedIn === 'boolean') return { state: parsed.loggedIn ? 'loggedIn' : 'authNeeded' };
    return { state: 'unknown', code: code === 0 ? 'format' : `exit-${code}` };
  }
  return { state: 'unknown', code: 'no-status-command' };
}

module.exports = { SEAT_PROVIDERS, seatDir, seatEnvironment, interpretStatus, seatRoot };
