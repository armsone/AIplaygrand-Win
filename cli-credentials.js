'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seatRoot, SEAT_PROVIDERS } = require('./cli-seats');

const MAX_FILE_SIZE = 128 * 1024; // 128 KiB
const MAX_VAULT_ENTRIES = 100;
const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/;

const CREDENTIAL_FILES = Object.freeze({
  codex: {
    subPath: ['home', 'auth.json'],
    supportsDarwin: true
  },
  claude: {
    subPath: ['config', '.credentials.json'],
    supportsDarwin: false // macOS uses Keychain
  },
  gemini: {
    subPath: ['.gemini', 'oauth_creds.json'],
    supportsDarwin: true
  }
});

function sanitizeCodex(json) {
  if (!json || typeof json !== 'object') throw new Error('Codex 인증 형식이 올바르지 않습니다.');
  if (json.OPENAI_API_KEY && String(json.OPENAI_API_KEY).trim()) {
    throw new Error('API 키 방식은 백업할 수 없어요. OAuth 로그인만 지원합니다.');
  }
  if (json.auth_mode && json.auth_mode !== 'chatgpt') throw new Error('ChatGPT 로그인만 보관할 수 있어요.');
  const raw = json.tokens;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Codex 로그인 형식이 올바르지 않아요.');
  if (raw.OPENAI_API_KEY && String(raw.OPENAI_API_KEY).trim()) {
    throw new Error('API 키 방식은 백업할 수 없어요. OAuth 로그인만 지원합니다.');
  }
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token.trim() : '';
  const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) {
    throw new Error('Codex OAuth 토큰(access_token, refresh_token)을 찾을 수 없습니다.');
  }
  const tokens = { access_token: accessToken, refresh_token: refreshToken };
  if (typeof raw.account_id === 'string' && raw.account_id.trim()) {
    tokens.account_id = raw.account_id.trim();
  }
  if (typeof raw.id_token === 'string' && raw.id_token.trim()) {
    tokens.id_token = raw.id_token.trim();
  }
  const result = { tokens };
  if (json.auth_mode === 'chatgpt') result.auth_mode = 'chatgpt';
  if (typeof json.last_refresh === 'string') result.last_refresh = json.last_refresh;
  return result;
}

function sanitizeClaude(json) {
  if (!json || typeof json !== 'object') throw new Error('Claude 인증 형식이 올바르지 않습니다.');
  const oauth = json.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error('Claude OAuth 인증 정보를 찾을 수 없습니다.');
  }
  const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
  const refreshToken = typeof oauth.refreshToken === 'string' ? oauth.refreshToken.trim() : '';
  if (!accessToken || !refreshToken) {
    throw new Error('Claude OAuth 토큰(accessToken, refreshToken)이 올바르지 않습니다.');
  }
  const claudeAiOauth = { accessToken, refreshToken };
  if (Array.isArray(oauth.scopes) && oauth.scopes.every(s => typeof s === 'string')) claudeAiOauth.scopes = oauth.scopes;
  if (typeof oauth.rateLimitTier === 'string') claudeAiOauth.rateLimitTier = oauth.rateLimitTier;
  if (typeof oauth.expiresAt === 'number' || (typeof oauth.expiresAt === 'string' && oauth.expiresAt.trim())) {
    claudeAiOauth.expiresAt = oauth.expiresAt;
  }
  if (typeof oauth.subscriptionType === 'string' && oauth.subscriptionType.trim()) {
    claudeAiOauth.subscriptionType = oauth.subscriptionType.trim();
  }
  return { claudeAiOauth };
}

function sanitizeGemini(json) {
  if (!json || typeof json !== 'object') throw new Error('Gemini 인증 형식이 올바르지 않습니다.');
  if (json.private_key || json.private_key_id || json.type === 'service_account' || json.client_email) {
    throw new Error('서비스 계정 키는 백업할 수 없어요. 개인 OAuth 로그인만 지원합니다.');
  }
  const accessToken = typeof json.access_token === 'string' ? json.access_token.trim() : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) {
    throw new Error('Gemini OAuth 토큰(access_token, refresh_token)을 찾을 수 없습니다.');
  }
  const content = { access_token: accessToken, refresh_token: refreshToken };
  if (typeof json.expiry_date === 'number' || (typeof json.expiry_date === 'string' && json.expiry_date.trim())) {
    content.expiry_date = json.expiry_date;
  }
  if (typeof json.token_type === 'string' && json.token_type.trim()) {
    content.token_type = json.token_type.trim();
  }
  if (typeof json.scope === 'string' && json.scope.trim()) {
    content.scope = json.scope.trim();
  }
  if (typeof json.id_token === 'string' && json.id_token.trim()) {
    content.id_token = json.id_token.trim();
  }
  return content;
}

function sanitizeCredentialContent(provider, json) {
  if (provider === 'codex') return sanitizeCodex(json);
  if (provider === 'claude') return sanitizeClaude(json);
  if (provider === 'gemini') return sanitizeGemini(json);
  throw new Error('지원되지 않는 제공자입니다.');
}

function validatePathAncestors(appData, targetPath) {
  const normAppData = path.normalize(path.resolve(appData));
  const normTarget = path.normalize(path.resolve(targetPath));
  const rel = path.relative(normAppData, normTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('경로가 허용된 앱 데이터 폴더를 벗어납니다.');
  }

  let realAppData;
  try {
    realAppData = fs.realpathSync(normAppData);
  } catch {
    realAppData = normAppData;
  }

  const parts = rel.split(path.sep);
  let current = normAppData;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error('심볼릭 링크나 정션은 허용되지 않습니다.');
      }
      const realCurrent = fs.realpathSync(current);
      const realRel = path.relative(realAppData, realCurrent);
      if (realRel !== parts.slice(0, i + 1).join(path.sep)) {
        throw new Error('경로가 허용된 앱 데이터 루트를 벗어납니다.');
      }
    }
  }
}

function readCredentialFileBounded(filePath) {
  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink()) throw new Error('심볼릭 링크 파일은 지원하지 않습니다.');
  if (!lstat.isFile()) throw new Error('일반 파일만 읽을 수 있습니다.');
  if (lstat.size > MAX_FILE_SIZE) throw new Error('자격 증명 파일 크기가 128KiB 제한을 초과했습니다.');
  if (lstat.size === 0) throw new Error('자격 증명 파일이 비어 있습니다.');

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  let buf = null;
  try {
    const fstat = fs.fstatSync(fd);
    if (fstat.isSymbolicLink()) throw new Error('심볼릭 링크는 허용되지 않습니다.');
    if (!fstat.isFile()) throw new Error('일반 파일만 읽을 수 있습니다.');
    if (fstat.size > MAX_FILE_SIZE) throw new Error('자격 증명 파일 크기가 128KiB 제한을 초과했습니다.');
    if (fstat.size !== lstat.size) throw new Error('파일 크기가 일치하지 않습니다.');
    if (lstat.ino && fstat.ino && lstat.ino !== fstat.ino) {
      throw new Error('파일 식별자가 일치하지 않습니다.');
    }

    buf = Buffer.alloc(fstat.size);
    let bytesRead = 0;
    while (bytesRead < fstat.size) {
      const n = fs.readSync(fd, buf, bytesRead, fstat.size - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead !== fstat.size) throw new Error('파일 읽기 크기가 일치하지 않습니다.');

    const str = buf.toString('utf8');
    try {
      return JSON.parse(str);
    } catch {
      throw new Error('자격 증명 파일이 올바른 JSON 형식이 아닙니다.');
    }
  } finally {
    if (buf) buf.fill(0);
    fs.closeSync(fd);
  }
}

// Windows access control is inherited from the user's app-data directory.
function writeCredentialFileExclusive(appData, targetPath, content) {
  const parentDir = path.dirname(targetPath);
  validatePathAncestors(appData, targetPath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  validatePathAncestors(appData, targetPath);

  try {
    fs.lstatSync(targetPath);
    throw new Error('대상 경로에 이미 파일이 존재합니다. 기존 자격 증명은 덮어쓰지 않습니다.');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const contentStr = JSON.stringify(content, null, 2);
  const contentBuf = Buffer.from(contentStr, 'utf8');
  if (contentBuf.byteLength > MAX_FILE_SIZE) {
    contentBuf.fill(0);
    throw new Error('복원할 자격 증명 크기가 128KiB를 초과합니다.');
  }

  const tempPath = path.join(parentDir, `.tmp-${crypto.randomUUID()}`);
  let tempFd;
  try {
    tempFd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(tempFd, contentBuf);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    try {
      fs.linkSync(tempPath, targetPath);
    } catch (linkErr) {
      if (linkErr.code === 'EEXIST') {
        throw new Error('대상 경로에 이미 파일이 존재합니다. 기존 자격 증명은 덮어쓰지 않습니다.');
      }
      throw new Error('이 PC의 저장 위치가 안전한 로그인 복원을 지원하지 않아요. 공식 로그인으로 진행하세요.');
    }
  } finally {
    if (tempFd !== undefined) {
      try { fs.closeSync(tempFd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    contentBuf.fill(0);
  }
}

function validateAndResolveProfile(getProfile, profileId) {
  if (typeof profileId !== 'string' || !ID_PATTERN.test(profileId)) {
    throw new Error('올바르지 않은 프로필 식별자입니다.');
  }
  if (typeof getProfile !== 'function') {
    throw new Error('getProfile 함수가 필요합니다.');
  }
  const profile = getProfile(profileId);
  if (!profile || typeof profile !== 'object' || profile.kind !== 'cli' ||
      !ID_PATTERN.test(String(profile.id)) || profile.id !== profileId ||
      !Object.hasOwn(SEAT_PROVIDERS, profile.provider)) {
    throw new Error('독립 CLI 자리를 찾을 수 없어요.');
  }
  return profile;
}

function createCredentialTransfer({ appData, vault, getProfile }) {
  if (!appData || typeof appData !== 'string') throw new Error('appData 경로가 올바르지 않습니다.');
  if (!vault || typeof vault.requireOpen !== 'function' || typeof vault.save !== 'function') {
    throw new Error('올바른 Vault 인스턴스가 필요합니다.');
  }

  function status(profileId) {
    vault.requireOpen();
    const profile = validateAndResolveProfile(getProfile, profileId);
    const descriptor = CREDENTIAL_FILES[profile.provider];
    const isDarwinClaude = profile.provider === 'claude' && process.platform === 'darwin';
    const supported = Boolean(descriptor && !isDarwinClaude);
    const reason = supported ? null : 'macOS의 Claude Code 자격 증명은 키체인에 저장되므로 보관함 이전이 지원되지 않습니다.';

    let localPresent = false;
    if (supported) {
      try {
        const dir = path.join(seatRoot(appData), profile.provider, profile.id);
        const targetPath = path.join(dir, ...descriptor.subPath);
        validatePathAncestors(appData, targetPath);
        if (fs.existsSync(targetPath)) {
          const stat = fs.lstatSync(targetPath);
          localPresent = !stat.isSymbolicLink() && stat.isFile();
        }
      } catch {
        localPresent = false;
      }
    }

    let savedAt = null;
    let vaultPresent = false;
    if (vault.data && vault.data.cliCredentials && typeof vault.data.cliCredentials === 'object') {
      const entry = vault.data.cliCredentials[profile.id];
      if (entry && entry.provider === profile.provider && typeof entry.createdAt === 'string') {
        savedAt = entry.createdAt;
        vaultPresent = true;
      }
    }

    return {
      profileId: profile.id,
      provider: profile.provider,
      supported,
      reason,
      localPresent,
      vaultPresent,
      savedAt
    };
  }

  function capture(profileId) {
    vault.requireOpen();
    const profile = validateAndResolveProfile(getProfile, profileId);
    if (profile.provider === 'claude' && process.platform === 'darwin') {
      throw new Error('macOS의 Claude Code 자격 증명은 키체인에 저장되므로 보관함 이전이 지원되지 않습니다.');
    }
    const descriptor = CREDENTIAL_FILES[profile.provider];
    const dir = path.join(seatRoot(appData), profile.provider, profile.id);
    const targetPath = path.join(dir, ...descriptor.subPath);

    validatePathAncestors(appData, targetPath);
    if (!fs.existsSync(targetPath)) {
      throw new Error('해당 자리의 CLI 로그인 자격 증명 파일이 없습니다. 먼저 터미널에서 로그인하세요.');
    }

    const rawJson = readCredentialFileBounded(targetPath);
    const cleanContent = sanitizeCredentialContent(profile.provider, rawJson);

    vault.requireOpen();
    const currentMap = (vault.data.cliCredentials && typeof vault.data.cliCredentials === 'object' && !Array.isArray(vault.data.cliCredentials))
      ? { ...vault.data.cliCredentials }
      : {};

    if (Object.keys(currentMap).length >= MAX_VAULT_ENTRIES && !Object.hasOwn(currentMap, profile.id)) {
      throw new Error('보관함에 저장할 수 있는 CLI 자격 증명은 최대 100개입니다.');
    }

    const entry = {
      id: profile.id,
      provider: profile.provider,
      version: 1,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      content: cleanContent
    };

    const nextData = {
      ...vault.data,
      cliCredentials: {
        ...currentMap,
        [profile.id]: entry
      }
    };

    // Vault.save executes atomically; if it fails, vault.data is unchanged
    vault.save(nextData);

    return {
      captured: true,
      profileId: profile.id,
      provider: profile.provider,
      createdAt: entry.createdAt
    };
  }

  function restore(profileId) {
    const profile = validateAndResolveProfile(getProfile, profileId);
    vault.requireOpen();

    const creds = vault.data.cliCredentials;
    if (!creds || !creds[profile.id]) {
      throw new Error('보관함에 해당 프로필의 저장된 자격 증명이 없습니다.');
    }
    const entry = creds[profile.id];
    if (!entry || typeof entry !== 'object') {
      throw new Error('보관함의 자격 증명 데이터가 손상되었습니다.');
    }
    if (entry.id !== profile.id || entry.provider !== profile.provider || entry.version !== 1) {
      throw new Error('자격 증명 메타데이터가 현재 프로필과 일치하지 않습니다.');
    }
    if (profile.provider === 'claude' && (process.platform === 'darwin' || entry.platform === 'darwin')) {
      throw new Error('macOS의 Claude Code 자격 증명은 키체인에 저장되므로 보관함 복원이 지원되지 않습니다.');
    }

    if (Buffer.byteLength(JSON.stringify(entry.content) || '') > MAX_FILE_SIZE) throw new Error('보관된 로그인 자료가 크기 제한을 넘었어요.');
    const validatedContent = sanitizeCredentialContent(profile.provider, entry.content);
    const descriptor = CREDENTIAL_FILES[profile.provider];
    const dir = path.join(seatRoot(appData), profile.provider, profile.id);
    const targetPath = path.join(dir, ...descriptor.subPath);

    validatePathAncestors(appData, targetPath);
    writeCredentialFileExclusive(appData, targetPath, validatedContent);

    return {
      restored: true,
      profileId: profile.id,
      provider: profile.provider
    };
  }

  function forget(profileId) {
    const profile = validateAndResolveProfile(getProfile, profileId);
    vault.requireOpen();

    const currentMap = (vault.data.cliCredentials && typeof vault.data.cliCredentials === 'object' && !Array.isArray(vault.data.cliCredentials))
      ? { ...vault.data.cliCredentials }
      : {};

    if (!Object.hasOwn(currentMap, profile.id)) {
      return {
        forgotten: false,
        profileId: profile.id,
        message: '보관함에 저장된 자격 증명이 없습니다.'
      };
    }

    const nextMap = { ...currentMap };
    delete nextMap[profile.id];
    vault.save({ ...vault.data, cliCredentials: nextMap });

    return {
      forgotten: true,
      profileId: profile.id,
      message: '보관함의 암호화된 백업 항목을 삭제했습니다. PC 로컬의 CLI 로그인 상태와 보관함 백업 파일(.bak)에는 이전 기록이 남아있을 수 있습니다.'
    };
  }

  return { status, capture, restore, forget };
}

module.exports = { createCredentialTransfer };
