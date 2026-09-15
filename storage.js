const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(`${file}.bak`)) return fallback;
    throw new Error(`${path.basename(file)} 파일을 읽지 못했어요. 원본은 보존됩니다. Data 폴더의 백업을 확인하세요.`, { cause: error });
  }
}

function writeJSON(file, value) {
  // Never recreate a disconnected drive's path or fall back to the host PC.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (fs.existsSync(file)) {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.copyFileSync(file, `${file}.bak`);
      const backup = fs.openSync(`${file}.bak`, 'r+');
      try { fs.fsyncSync(backup); } finally { fs.closeSync(backup); }
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error('저장하지 못했어요. USB 연결·남은 공간·쓰기 권한을 확인하고 다시 저장하세요. 화면의 내용은 기록 내보내기로 보관할 수 있어요.', { cause: error });
  }
}

function validateTasks(items, requireId = true) {
  if (!Array.isArray(items) || items.length > 5000) throw new Error('미션은 최대 5,000개까지 저장할 수 있어요.');
  const ids = new Set();
  return items.map(task => {
    if (!task || typeof task !== 'object' ||
      typeof task.prompt !== 'string' || typeof task.result !== 'string' ||
      task.prompt.length > 200000 || task.result.length > 1000000 ||
      typeof task.profileId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(task.profileId) ||
      typeof task.profileName !== 'string' || task.profileName.length > 120 ||
      !['claude', 'gemini', 'codex'].includes(task.provider) ||
      !['queued', 'opened', 'paused', 'done'].includes(task.status) ||
      typeof task.created !== 'string' || !Number.isFinite(Date.parse(task.created)) ||
      (requireId && (typeof task.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(task.id) || ids.has(task.id)))) {
      throw new Error('올바른 실습 기록이 아니에요. 앱에서 내보낸 파일을 선택하세요. 기존 기록은 그대로 있어요.');
    }
    ids.add(task.id);
    return { id: requireId ? task.id : crypto.randomUUID(), profileId: task.profileId,
      profileName: task.profileName, provider: task.provider, prompt: task.prompt,
      result: task.result, status: task.status, created: task.created };
  });
}

function validateNotebook(value) {
  if (!value || value.version !== 1 || typeof value.draft !== 'string' || value.draft.length > 200000) {
    throw new Error('실습 노트 형식을 읽지 못했어요. 기존 파일을 보존합니다.');
  }
  const result = { version: 1, tasks: validateTasks(value.tasks), draft: value.draft };
  if (Buffer.byteLength(JSON.stringify(result)) > 10 * 1024 * 1024) throw new Error('기록이 10MB를 넘었어요. 기존 기록을 내보내고 정리해 주세요.');
  return result;
}

module.exports = { readJSON, writeJSON, validateTasks, validateNotebook };
