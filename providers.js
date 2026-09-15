(function (root) {
  const providers = Object.freeze({
    claude: { name: 'Claude', url: 'https://claude.ai/' },
    gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
    codex: { name: 'Codex', url: 'https://chatgpt.com/codex' }
  });
  if (typeof module === 'object' && module.exports) module.exports = providers;
  else root.providers = providers;
})(globalThis);
