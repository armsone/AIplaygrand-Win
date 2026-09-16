'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Configuration contract is source-reviewed against this release, not arbitrary future versions.
const VERSION = '0.59.0';
// Sanitized environment shared by every CLI the app spawns for an isolated seat.
// Do not inherit API billing keys, Node preload hooks, IDE bridges or provider overrides.
function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOME|USER|LOGNAME|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|BROWSER|SSH_.*|CI|DEBIAN_FRONTEND)$/i.test(key)) env[key] = value;
  }
  return env;
}
// homeOverride: an app-owned per-seat folder (cli-seats.js). Default is the shared app login folder.
function prepareGemini(appData, homeOverride) {
  const systemDir = process.platform === 'win32'
    ? 'C:\\ProgramData\\gemini-cli'
    : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
  if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      ['settings.json', 'system-defaults.json'].some(name => fs.existsSync(path.join(systemDir, name)))) {
    throw new Error('이 PC에는 관리자가 지정한 Gemini 설정이 있어요. 앱이 이를 덮어쓰지 않습니다. 관리자의 확인을 받은 PC에서 사용하세요.');
  }
  const home = homeOverride || path.join(appData, 'AIplaygrand-Win', 'Gemini');
  const configDir = path.join(home, '.gemini');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(home, 'app-policy.json');
  const settings = {
    general: { enableAutoUpdate: false },
    context: { fileName: [], includeDirectories: [] },
    tools: { core: [], discoveryCommand: '', callCommand: '', useRipgrep: false },
    hooksConfig: { enabled: false },
    skills: { enabled: false },
    experimental: { enableAgents: false },
    telemetry: { enabled: false },
    security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' } }
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const env = baseEnv();
  env.GEMINI_CLI_HOME = home;
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
  return { env, cwd };
}
function encodePrompt(prompt) {
  // Gemini expands @file references before model inference, even with model tools disabled.
  // JSON Unicode escapes preserve the question without triggering that preprocessor.
  return JSON.stringify({ request: prompt }).replaceAll('@', '\\u0040');
}
module.exports = { VERSION, prepareGemini, encodePrompt, baseEnv };
