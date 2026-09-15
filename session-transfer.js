// Only sessions created inside this app are passed to these helpers.
async function restoreCookies(target, cookies) {
  let restored = 0, skipped = 0;
  for (const cookie of cookies || []) {
    if (!cookie || cookie.partitionKey || cookie.partitioned) { skipped++; continue; }
    if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) { skipped++; continue; }
    const host = String(cookie.domain || '').replace(/^\./, '');
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') { skipped++; continue; }
    const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`, name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: !!cookie.secure, httpOnly: !!cookie.httpOnly, sameSite: cookie.sameSite || 'unspecified' };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    try { await target.cookies.set(details); restored++; } catch { skipped++; }
  }
  return { restored, skipped };
}
module.exports = { restoreCookies };
