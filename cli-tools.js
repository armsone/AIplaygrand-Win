const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
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

function createCliManager(dataRoot, shell) {
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
      const result = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
        ? await run(powershell(), ['-NoProfile', '-EncodedCommand', encode(`& ${psQuote(executable)} --version`)], { timeout: 8000, maxBuffer: 8192, windowsHide: true })
        : await run(executable, ['--version'], { timeout: 8000, maxBuffer: 8192, windowsHide: true });
      const version = result.stdout.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
      const outdated = id === 'node' && (!version || Number(version.split('.')[0]) < 20);
      return { id, label: definition.label, status: !version ? 'error' : outdated ? 'outdated' : 'ready', version: version || '' };
    } catch { return { id, label: definition.label, status: 'error', version: '' }; }
  }
  async function terminal(executable, args, workingDirectory) {
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
        const child = spawn(powershell(), ['-NoProfile', '-NoExit', '-EncodedCommand', encode(code)], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    } else if (process.platform === 'darwin') {
      const script = path.join(dataRoot, `cli-${require('node:crypto').randomUUID()}.command`);
      const envPath = [path.dirname(executable), locate('node') ? path.dirname(locate('node')) : '', process.env.PATH || ''].filter(Boolean).join(':');
      fs.writeFileSync(script, `#!/bin/sh\nexport PATH=${shQuote(envPath)}\ncd ${shQuote(workingDirectory)} || exit 1\n${shQuote(executable)} ${args.map(shQuote).join(' ')}\nprintf '\\nReturn to AIplaygrand to check resources. Press Enter to close.\\n'\nread reply\n`, { mode: 0o700 });
      const error = await shell.openPath(script);
      if (error) throw new Error('터미널을 열지 못했어요. 공식 설치 안내를 확인하세요.');
    } else throw new Error('현재 런처는 Windows와 macOS를 지원합니다.');
  }
  return {
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
      await terminal(locate('npm'), ['install', '--prefix', toolRoot, '--no-audit', '--no-fund', definitions[id].package], dataRoot);
    },
    async launch(id) {
      if (!Object.hasOwn(definitions, id) || !definitions[id].package) throw new Error('지원하지 않는 CLI입니다.');
      if ((await inspect(id)).status !== 'ready') throw new Error('CLI 준비 상태를 확인하고 설치를 마쳐 주세요.');
      await terminal(locate(definitions[id].command), [], path.join(dataRoot, 'Projects'));
    }
  };
}
module.exports = { createCliManager, definitions, psQuote, shQuote };
