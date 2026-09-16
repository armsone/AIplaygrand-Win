'use strict';
// Provider adapters for the automatic CLI relay.
// Every untrusted string (task, role text, previous outputs) travels through stdin only.
// Argument arrays contain constant strings and app-owned paths; no shell is ever involved.
//
// Enforcement model (what actually prevents tool use, per provider):
//   claude : --safe-mode (hooks, MCP, plugins, skills, CLAUDE.md and other customizations off),
//            --tools "" (no built-in tools), --strict-mcp-config (no imported MCP servers),
//            --permission-prompts none (anything that would prompt is denied), dontAsk mode,
//            --no-session-persistence. All flags are verified against the installed `claude --help`
//            before the first request; a missing flag fails closed.
//   codex  : exec with --sandbox read-only, --ignore-user-config (no ~/.codex/config.toml, so no
//            imported MCP servers, hooks or profiles), --ignore-rules, approval_policy=never,
//            --ephemeral, cwd = empty app-owned workspace. Read-only sandbox means the model may
//            still *read* files or run read-only commands; the relay aborts the stage as soon as a
//            non-message item appears, but that is detection, not prevention.
//   gemini : pinned 0.59.0 with app-owned GEMINI_CLI_HOME/system policy, tools.core=[], hooks off,
//            extensions none and an unconfigured random MCP allowlist entry. Existing managed
//            settings cause a refusal; no user's existing Gemini configuration is overwritten.

const PROVIDERS = Object.freeze({
  claude: { label: 'Claude Code', automatic: true, mode: '도구 없음(--tools "")·safe-mode·MCP/훅 차단·권한 요청 자동 거부' },
  codex: { label: 'Codex CLI', automatic: true, mode: '읽기 전용 샌드박스·사용자 설정/MCP/규칙 미로드·승인 없음' },
  gemini: { label: 'Gemini CLI', automatic: true, mode: '앱 전용 로그인·도구 없음·확장/훅 차단·MCP 허용 목록 제한' }
});

// Fixed instruction passed as the positional prompt. The real content arrives on stdin.
const STDIN_NOTICE = 'The task, your role, and prior teammates\' outputs are provided in the piped input. Answer in plain text only. Do not call tools, run commands, browse, or modify files.';

// Each provider lists the exact help-text checks that must pass on the installed CLI before any
// request is sent. Unknown flags make the CLI exit with a usage error, but verifying up front
// gives the user a precise message instead of a generic failure and never falls back to a
// weaker flag set.
// options.seat: the command runs for an isolated CLI seat (cli-seats.js). Codex then pins the
// documented file credential store so exec reads the same auth.json the seat's login wrote.
function buildCommand(provider, workspace, options = {}) {
  const seatArgs = options.seat && provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"'] : [];
  switch (provider) {
    case 'claude':
      return {
        helpArgs: ['--help'],
        required: [
          { name: '-p/--print', test: /(^|\s)-p,\s*--print\b/ },
          { name: '--output-format stream-json', test: /--output-format\b[\s\S]{0,200}stream-json/ },
          { name: '--verbose', test: /(^|\s)--verbose\b/ },
          { name: '--include-partial-messages', test: /(^|\s)--include-partial-messages\b/ },
          { name: '--safe-mode', test: /(^|\s)--safe-mode\b/ },
          { name: '--tools ""', test: /(^|\s)--tools\b[\s\S]{0,200}""/ },
          { name: '--strict-mcp-config', test: /(^|\s)--strict-mcp-config\b/ },
          { name: '--permission-mode dontAsk', test: /(^|\s)--permission-mode\b[\s\S]{0,300}dontAsk/ },
          { name: '--permission-prompts none', test: /(^|\s)--permission-prompts\b[\s\S]{0,400}"none"/ },
          { name: '--no-session-persistence', test: /(^|\s)--no-session-persistence\b/ },
          { name: '--disable-slash-commands', test: /(^|\s)--disable-slash-commands\b/ }
        ],
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands', STDIN_NOTICE],
        cwd: workspace
      };
    case 'codex':
      return {
        helpArgs: ['exec', '--help'],
        required: [
          { name: '--json', test: /(^|\s)--json\b/ },
          { name: '--sandbox read-only', test: /(^|\s)-s,\s*--sandbox\b[\s\S]{0,200}read-only/ },
          { name: '--ignore-user-config', test: /(^|\s)--ignore-user-config\b/ },
          { name: '--ignore-rules', test: /(^|\s)--ignore-rules\b/ },
          { name: '--ephemeral', test: /(^|\s)--ephemeral\b/ },
          { name: '--skip-git-repo-check', test: /(^|\s)--skip-git-repo-check\b/ },
          { name: '-C/--cd', test: /(^|\s)-C,\s*--cd\b/ },
          { name: '-c/--config', test: /(^|\s)-c,\s*--config\b/ },
          { name: 'stdin prompt (-)', test: /read from stdin/ }
        ],
        // `codex exec` in the installed version has no -a/--ask-for-approval; approval_policy is set
        // through the documented -c override instead. mcp_servers={} clears any project-level table.
        args: ['exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', ...seatArgs, '--ephemeral', '--skip-git-repo-check', '--cd', workspace, '-'],
        cwd: workspace
      };
    case 'gemini':
      return {
        helpArgs: ['--help'],
        required: [
          { name: '--prompt', test: /--prompt\b/ },
          { name: '--output-format stream-json', test: /--output-format\b[\s\S]{0,400}stream-json/ },
          { name: '--extensions', test: /--extensions\b/ },
          { name: '--allowed-mcp-server-names', test: /--allowed-mcp-server-names\b/ },
          { name: '--approval-mode', test: /--approval-mode\b/ }
        ],
        args: ['--prompt', 'Decode the JSON request in stdin and answer its request value in plain text. Do not use tools or expand file references.', '--output-format', 'stream-json', '--approval-mode', 'default', '--extensions', 'none', '--allowed-mcp-server-names', `aiplaygrand-none-${require('node:crypto').randomUUID()}`],
        cwd: workspace
      };
    default:
      throw new Error('지원하지 않는 공급자입니다.');
  }
}

const REDACT = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})/g;
const CONTROL = /\p{Cc}/gu;
function safeMessage(value, limit = 400) {
  if (typeof value !== 'string') return '';
  return value.replace(REDACT, '[숨김]').replace(CONTROL, ' ').slice(0, limit);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

function hasToolUse(content) {
  return Array.isArray(content) && content.some(part => part && (part.type === 'tool_use' || part.type === 'server_tool_use'));
}

// Failure classification for the automatic handoff. Only structured, machine-readable fields of
// the official CLI event schemas are consulted; assistant text, result prose, HTTP 429, generic
// "too many requests"/rate-limit codes and network errors are never treated as exhaustion.
//   claude : `rate_limit_event` (raw stream-json) with rate_limit_info.status === 'rejected' AND a
//            known usage window (five_hour, seven_day, seven_day_opus, seven_day_sonnet). An
//            overage rejection while the overall status is allowed is NOT exhaustion.
//   gemini : pinned 0.59.0 emits {type:'result', status:'error', error:{type, message}} where
//            error.type is the Error class name. Only the non-retryable TerminalQuotaError counts
//            (provider quota block, not necessarily a daily limit); RetryableQuotaError is a
//            temporary throttle and stays 'unknown'.
//   codex  : official protocol UsageLimitReachedError emits prefix "You’ve hit your usage limit."
//            in turn.failed.error.message (and type:error envelope). Matched only against that
//            exact anchored prefix for generic account usage exhaustion. Per-model limits
//            ("... for <model>"), spend caps, credits, and billing limits remain manual.
//   unknown : everything else (the handoff is then offered manually, never started automatically)
const CODES = Object.freeze({
  gemini: { quota: ['terminalquotaerror'], auth: [] }
});
const CLAUDE_QUOTA_WINDOWS = Object.freeze(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);
function classify(provider, ...codes) {
  const table = CODES[provider];
  const code = codes.map(value => typeof value === 'string' ? value.toLowerCase() : '').find(Boolean) || '';
  if (table && code) {
    if (table.quota.includes(code)) return { kind: 'quota', code };
    if (table.auth.includes(code)) return { kind: 'auth', code };
  }
  return { kind: 'unknown', code: code.slice(0, 40) };
}
// Claude Code rate_limit_event → confirmed usage exhaustion only for a rejected known window.
function classifyClaudeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const status = typeof info.status === 'string' ? info.status.toLowerCase() : '';
  const window = typeof info.rateLimitType === 'string' ? info.rateLimitType.toLowerCase() : '';
  if (status === 'rejected' && CLAUDE_QUOTA_WINDOWS.includes(window)) return { kind: 'quota', code: `rate_limit:${window}` };
  return null;
}
// Codex CLI turn.failed / type:error → confirmed generic account usage exhaustion only for exact prefix.
const CODEX_USAGE_LIMIT_PREFIX = /^You[’']ve hit your usage limit\./;
function classifyCodexMessage(rawMessage) {
  if (typeof rawMessage !== 'string') return { kind: 'unknown', code: '' };
  const trimmed = rawMessage.trim();
  if (CODEX_USAGE_LIMIT_PREFIX.test(trimmed)) {
    return { kind: 'quota', code: 'usage_limit_reached' };
  }
  return { kind: 'unknown', code: '' };
}

// Parsers return a list of normalized events per JSON line:
//   { kind: 'text', text }        streamed assistant text (append)
//   { kind: 'final', text }       authoritative full text (replaces streamed text if non-empty)
//   { kind: 'done' }              provider reported successful completion
//   { kind: 'error', message, failure }  provider reported failure (failure: classify())
//   { kind: 'hint', failure }     structured signal that a later error is confirmed exhaustion
//   { kind: 'tool', name }        provider attempted a tool call (relay aborts)
// Unknown or malformed lines yield [] and are never treated as completion.
function createParser(provider) {
  let streamed = false;
  const parse = line => {
    let event;
    try { event = JSON.parse(line); } catch { return []; }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return [];
    switch (provider) {
      case 'claude': return parseClaude(event);
      case 'codex': return parseCodex(event);
      case 'gemini': return parseGemini(event);
      default: return [];
    }
  };
  function parseGemini(event) {
    if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') return [{ kind: 'text', text: event.content }];
    if (event.type === 'tool_use' || event.type === 'tool_result') return [{ kind: 'tool', name: safeMessage(event.tool_name || 'tool', 60) }];
    if (event.type === 'result') {
      if (event.status === 'success') return [{ kind: 'done' }];
      const failure = classify('gemini', event.error && event.error.type);
      return [{ kind: 'error', message: failure.kind === 'quota' ? 'Gemini CLI가 사용량 한도 차단(TerminalQuotaError)을 보고했어요.' : 'Gemini가 작업을 완료하지 못했어요. 로그인·네트워크·이용 한도를 확인하세요.', failure }];
    }
    if (event.type === 'error' && event.severity !== 'warning') return [{ kind: 'error', message: 'Gemini가 오류를 보고했어요. 로그인·네트워크·이용 한도를 확인하세요.', failure: classify('gemini', event.error && event.error.type) }];
    return [];
  }
  function parseClaude(event) {
    if (event.type === 'rate_limit_event') {
      const failure = classifyClaudeRateLimit(event.rate_limit_info);
      return failure ? [{ kind: 'hint', failure }] : [];
    }
    if (event.type === 'stream_event') {
      const inner = event.event;
      if (inner && inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string') {
        streamed = true;
        return [{ kind: 'text', text: inner.delta.text }];
      }
      if (inner && inner.type === 'content_block_start' && inner.content_block && (inner.content_block.type === 'tool_use' || inner.content_block.type === 'server_tool_use')) return [{ kind: 'tool', name: safeMessage(inner.content_block.name, 60) }];
      return [];
    }
    if (event.type === 'assistant') {
      const content = event.message && event.message.content;
      if (hasToolUse(content)) return [{ kind: 'tool', name: 'tool_use' }];
      if (event.parent_tool_use_id) return [];
      const text = textOf(content);
      return !streamed && text ? [{ kind: 'text', text }] : [];
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') return [{ kind: 'tool', name: 'permission_denied' }];
    if (event.type === 'result') {
      if (event.is_error === true || event.subtype !== 'success') return [{ kind: 'error', message: `Claude Code가 결과를 오류로 보고했어요 (${safeMessage(String(event.subtype || 'error'), 40)}).`, failure: classify('claude') }];
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) return [{ kind: 'tool', name: 'permission_denials' }];
      const out = [];
      if (typeof event.result === 'string' && event.result) out.push({ kind: 'final', text: event.result });
      out.push({ kind: 'done' });
      return out;
    }
    return [];
  }
  function parseCodex(event) {
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (!item || typeof item !== 'object') return [];
      if (item.type === 'agent_message') return event.type === 'item.completed' && typeof item.text === 'string' ? [{ kind: 'text', text: item.text, whole: true }] : [];
      if (item.type === 'reasoning') return [];
      if (item.type === 'error') return [{ kind: 'error', message: `Codex CLI 오류: ${safeMessage(item.message) || '자세한 내용 없음'} (한도 여부 자동 확인 불가)`, failure: classify('codex') }];
      return [{ kind: 'tool', name: safeMessage(String(item.type || 'tool'), 60) }];
    }
    if (event.type === 'turn.completed') return [{ kind: 'done' }];
    if (event.type === 'turn.failed') {
      const raw = event.error && event.error.message;
      const failure = classifyCodexMessage(raw);
      const message = failure.kind === 'quota'
        ? 'Codex CLI가 계정 사용량 한도(UsageLimitReachedError)를 보고했어요.'
        : `Codex 작업이 실패했어요: ${safeMessage(raw) || '자세한 내용 없음'} (한도 여부 자동 확인 불가)`;
      return [{ kind: 'error', message, failure }];
    }
    if (event.type === 'error') {
      const raw = event.message;
      const failure = classifyCodexMessage(raw);
      const message = failure.kind === 'quota'
        ? 'Codex CLI가 계정 사용량 한도(UsageLimitReachedError)를 보고했어요.'
        : `Codex CLI 오류: ${safeMessage(raw) || '자세한 내용 없음'} (한도 여부 자동 확인 불가)`;
      return [{ kind: 'error', message, failure }];
    }
    return [];
  }
  return parse;
}

// Which providers can ever report a confirmed quota through structured events (for UI/README).
const QUOTA_DETECTION = Object.freeze({
  claude: 'rate_limit_event(status rejected, 5시간/7일 창)',
  gemini: 'result.error.type = TerminalQuotaError',
  codex: 'turn.failed.error.message prefix "You’ve hit your usage limit."'
});

module.exports = { PROVIDERS, buildCommand, createParser, safeMessage, classify, classifyClaudeRateLimit, classifyCodexMessage, QUOTA_DETECTION, STDIN_NOTICE };
