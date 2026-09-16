const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { VERSION: GEMINI_VERSION, prepareGemini, baseEnv } = require('./gemini-runtime');
const { SEAT_PROVIDERS, seatEnvironment, interpretStatus } = require('./cli-seats');
// Environment keys whose app-owned values are written into the macOS launcher script verbatim.
// Everything else is re-expanded from the OS at execution so no process secrets are persisted.
const SEAT_ENV_KEY = /^(GEMINI_CLI_[A-Z_]+|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
const definitions = {
  node: { command: 'node', label: 'Node.js', help: 'https://nodejs.org/en/download' },
  npm: { command: 'npm', label: 'npm', help: 'https://nodejs.org/en/download' },
  git: { command: 'git', label: 'Git (권장)', help: 'https://git-scm.com/downloads' },
  claude: { command: 'claude', label: 'Claude Code', package: '@anthropic-ai/claude-code', help: 'https://code.claude.com/docs/en/setup' },
  gemini: { command: 'gemini', label: 'Gemini CLI', package: '@google/gemini-cli', help: 'https://geminicli.com/docs/get-started/installation/' },
  codex: { command: 'codex', label: 'Codex CLI', package: '@openai/codex', help: 'https://developers.openai.com/codex/cli' }
};
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const shQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encode = value => Buffer.from(value, 'utf16le').toString('base64');

function createCliManager(dataRoot, shell, appData) {
  // Dependencies are platform-specific; copying USB tools never implies compatibility.
  const toolRoot = path.join(dataRoot, 'Tools', `${process.platform}-${process.arch}`);
  function locate(command) {
    const folders = [path.join(toolRoot, 'node_modules', '.bin'), ...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
    if (process.platform === 'win32') folders.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'));
    for (const folder of folders.filter(Boolean)) for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
      const candidate = path.join(folder, command + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
    return null;
  }
  async function inspect(id) {
    const definition = definitions[id], executable = locate(definition.command);
    if (!executable) return { id, label: definition.label, status: 'missing', version: '' };
    try {
      const direct = definition.package ? resolveSpawn(id) : null;
      const node = locate('node');
      const env = { ...process.env, PATH: [node ? path.dirname(node) : '', process.env.PATH || ''].filter(Boolean).join(path.delimiter) };
      const result = direct
        ? await run(direct.file, [...direct.prefix, '--version'], { timeout: 8000, maxBuffer: 8192, windowsHide: true, env })
        : process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
        ? await run(powershell(), ['-NoProfile', '-EncodedCommand', encode(`& ${psQuote(executable)} --version`)], { timeout: 8000, maxBuffer: 8192, windowsHide: true, env })
        : await run(executable, ['--version'], { timeout: 8000, maxBuffer: 8192, windowsHide: true, env });
      const version = result.stdout.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
      const outdated = (id === 'node' && (!version || Number(version.split('.')[0]) < 20)) || (id === 'gemini' && version !== GEMINI_VERSION);
      return { id, label: definition.label, status: !version ? 'error' : outdated ? 'outdated' : 'ready', version: version || '' };
    } catch { return { id, label: definition.label, status: 'error', version: '' }; }
  }
  async function terminal(executable, args, workingDirectory, childEnv = process.env) {
    fs.mkdirSync(workingDirectory, { recursive: true });
    if (process.platform === 'win32' && /npm\.cmd$/i.test(executable)) {
      const npmScript = path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const node = locate('node');
      if (!node || !fs.existsSync(npmScript)) throw new Error('npm 설치 경로를 확인하지 못했어요. Node.js 공식 설치를 복구한 뒤 다시 점검하세요.');
      executable = node;
      args = [npmScript, ...args];
    }
    if (process.platform === 'win32') {
      const nodeFolder = locate('node') ? path.dirname(locate('node')) : path.dirname(executable);
      const code = `$env:Path = ${psQuote(nodeFolder)} + ';' + $env:Path; Set-Location -LiteralPath ${psQuote(workingDirectory)}; & ${psQuote(executable)} ${args.map(psQuote).join(' ')}; Write-Host 'Return to AIplaygrand and check resources again.'`;
      await new Promise((resolve, reject) => {
        const child = spawn(powershell(), ['-NoProfile', '-NoExit', '-EncodedCommand', encode(code)], { detached: true, stdio: 'ignore', windowsHide: false, env: childEnv });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    } else if (process.platform === 'darwin') {
      const script = path.join(dataRoot, `cli-${require('node:crypto').randomUUID()}.command`);
      const envPath = [path.dirname(executable), locate('node') ? path.dirname(locate('node')) : '', process.env.PATH || ''].filter(Boolean).join(':');
      // Persist only app-owned paths, never the calling process's environment values (proxy
      // credentials, for example). Retained OS values are expanded by Terminal at execution.
      const isolatedEnv = Object.keys(childEnv).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).map(key => SEAT_ENV_KEY.test(key)
        ? shQuote(`${key}=${childEnv[key]}`) : `${key}="\${${key}-}"`).join(' ');
      const invocation = childEnv === process.env ? `${shQuote(executable)} ${args.map(shQuote).join(' ')}` : `/usr/bin/env -i ${isolatedEnv} ${shQuote(executable)} ${args.map(shQuote).join(' ')}`;
      fs.writeFileSync(script, `#!/bin/sh\nexport PATH=${shQuote(envPath)}\ncd ${shQuote(workingDirectory)} || exit 1\n${invocation}\nprintf '\\nReturn to AIplaygrand to check resources. Press Enter to close.\\n'\nread reply\n`, { mode: 0o700 });
      const error = await shell.openPath(script);
      if (error) throw new Error('터미널을 열지 못했어요. 공식 설치 안내를 확인하세요.');
    } else throw new Error('현재 런처는 Windows와 macOS를 지원합니다.');
  }
  // Resolve a CLI for direct spawn without a shell. Windows npm shims (.cmd/.bat) are
  // replaced by node + the package's bin script so no cmd.exe quoting is involved.
  // Shim layouts handled:
  //   local prefix : <prefix>\node_modules\.bin\claude.cmd  -> <prefix>\node_modules\@anthropic-ai\claude-code
  //   global npm   : %APPDATA%\npm\claude.cmd                -> %APPDATA%\npm\node_modules\@anthropic-ai\claude-code
  function resolveSpawn(id) {
    const definition = definitions[id];
    if (!definition?.package) throw new Error('지원하지 않는 CLI입니다.');
    const executable = locate(definition.command);
    if (!executable) throw new Error(`${definition.label}이(가) 설치되어 있지 않아요. 실행 준비에서 설치하고 다시 점검하세요.`);
    if (process.platform !== 'win32' || /\.exe$/i.test(executable)) return { file: executable, prefix: [] };
    if (!/\.(cmd|bat)$/i.test(executable)) throw new Error(`${definition.label} 실행 파일 형식을 확인하지 못했어요.`);
    const node = locate('node');
    const shimFolder = path.dirname(executable);
    const packageParts = definition.package.split('/');
    const candidates = path.basename(shimFolder).toLowerCase() === '.bin'
      ? [path.join(path.dirname(shimFolder), ...packageParts)]
      : [path.join(shimFolder, 'node_modules', ...packageParts)];
    let script;
    for (const packageRoot of candidates) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); } catch { continue; }
      if (!manifest || manifest.name !== definition.package) continue;
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[definition.command];
      if (typeof bin !== 'string' || path.isAbsolute(bin)) continue;
      const candidate = path.resolve(packageRoot, bin);
      const relative = path.relative(packageRoot, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue; // bin must stay inside the package
      try { if (fs.statSync(candidate).isFile()) { script = candidate; break; } } catch {}
    }
    if (!node || !script) throw new Error(`${definition.label}의 Node 실행 스크립트를 찾지 못했어요 (npm 심 위치: ${shimFolder}). 공식 설치를 복구한 뒤 다시 점검하세요.`);
    return { file: node, prefix: [script] };
  }
  return {
    resolveSpawn,
    // seat: a validated persisted profile of kind 'cli' (cli-seats.js). With a seat every command
    // (login, status, automatic run) gets the same sanitized per-seat environment.
    async prepare(id, seat) {
      const resolved = resolveSpawn(id);
      const nodeDir = locate('node') ? path.dirname(locate('node')) : '';
      if (seat) {
        if (seat.provider !== id) throw new Error('CLI 자리의 서비스가 요청과 달라요.');
        if (id === 'gemini' && (await inspect(id)).status !== 'ready') throw new Error(`앱 내 Gemini 대화에는 CLI ${GEMINI_VERSION}이 필요해요. 실행 준비에서 Gemini 설치/복구 후 다시 점검하세요.`);
        const { env, cwd } = seatEnvironment(appData, seat);
        env.PATH = [nodeDir, env.PATH || ''].filter(Boolean).join(path.delimiter);
        return { ...resolved, env, cwd, seat: true };
      }
      if (id !== 'gemini') {
        const env = baseEnv();
        const envKey = SEAT_PROVIDERS[id]?.envKey;
        if (envKey && process.env[envKey]?.trim()) env[envKey] = process.env[envKey];
        env.PATH = [nodeDir, env.PATH || ''].filter(Boolean).join(path.delimiter);
        return { ...resolved, env };
      }
      const info = await inspect(id);
      if (info.status !== 'ready') throw new Error(`앱 내 Gemini 대화에는 CLI ${GEMINI_VERSION}이 필요해요. 실행 준비에서 Gemini 설치/복구 후 다시 점검하세요.`);
      const { env, cwd } = prepareGemini(appData);
      if (locate('node')) env.PATH = [path.dirname(locate('node')), env.PATH || ''].join(path.delimiter);
      return { ...resolved, env, cwd };
    },
    inspect,
    async check() {
      const tools = await Promise.all(Object.keys(definitions).map(inspect));
      let freeGB = null;
      try { const disk = fs.statfsSync(dataRoot); freeGB = Math.floor(disk.bavail * disk.bsize / 1024 ** 3); } catch {}
      return { tools, platform: process.platform, arch: process.arch, ramGB: Math.round(os.totalmem() / 1024 ** 3), freeGB };
    },
    async help(id) {
      if (!Object.hasOwn(definitions, id)) throw new Error('지원하지 않는 도구입니다.');
      await shell.openExternal(definitions[id].help);
    },
    async install(id) {
      if (!Object.hasOwn(definitions, id) || !definitions[id].package) throw new Error('공식 설치 안내에서 설치하세요.');
      const [node, npm] = await Promise.all([inspect('node'), inspect('npm')]);
      if (node.status !== 'ready' || npm.status !== 'ready') throw new Error('먼저 Node.js 20 이상과 npm을 설치한 뒤 다시 점검하세요.');
      const packageSpec = definitions[id].package + (id === 'gemini' ? `@${GEMINI_VERSION}` : '');
      await terminal(locate('npm'), ['install', '--prefix', toolRoot, '--no-audit', '--no-fund', packageSpec], dataRoot);
    },
    async launch(id) {
      if (!Object.hasOwn(definitions, id) || !definitions[id].package) throw new Error('지원하지 않는 CLI입니다.');
      if ((await inspect(id)).status !== 'ready') throw new Error('CLI 준비 상태를 확인하고 설치를 마쳐 주세요.');
      const prepared = await this.prepare(id);
      await terminal(prepared.file, prepared.prefix, prepared.cwd || path.join(dataRoot, 'Projects'), id === 'gemini' ? prepared.env : process.env);
    },
    // Opens the official login command of the seat's CLI in a terminal carrying the seat env.
    // The user completes the login there; the app never sees or stores credentials.
    async seatLogin(seat) {
      const id = seat?.provider;
      if (!Object.hasOwn(SEAT_PROVIDERS, id)) throw new Error('지원하지 않는 CLI 자리입니다.');
      if ((await inspect(id)).status !== 'ready') throw new Error(`${SEAT_PROVIDERS[id].label} 준비 상태를 확인하고 설치를 마쳐 주세요.`);
      const prepared = await this.prepare(id, seat);
      await terminal(prepared.file, [...prepared.prefix, ...SEAT_PROVIDERS[id].loginArgs], prepared.cwd, prepared.env);
    },
    // Official status command only (no model request, no credential file read). Returns booleans.
    async seatStatus(seat) {
      const id = seat?.provider;
      if (!Object.hasOwn(SEAT_PROVIDERS, id)) throw new Error('지원하지 않는 CLI 자리입니다.');
      if ((await inspect(id)).status !== 'ready') return { state: 'cliMissing' };
      const definition = SEAT_PROVIDERS[id];
      if (!definition.statusArgs) return { state: 'unknown', code: 'no-status-command' };
      const prepared = await this.prepare(id, seat);
      return new Promise(resolve => {
        execFile(prepared.file, [...prepared.prefix, ...definition.statusArgs], { cwd: prepared.cwd, env: prepared.env, timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
          const code = error ? (Number.isInteger(error.code) ? error.code : null) : 0;
          resolve(interpretStatus(id, { error, code, stdout }));
        });
      });
    }
  };
}
module.exports = { createCliManager, definitions, psQuote, shQuote };
