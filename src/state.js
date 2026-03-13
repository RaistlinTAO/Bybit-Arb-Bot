const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createDefaultState(config) {
  return {
    manualInventory: {
      USDT: String(config.initialUsdt),
      USDC: String(config.initialUsdc),
    },
    processedExecIds: [],
    updatedAt: new Date().toISOString(),
  };
}

function loadState(config) {
  ensureParentDir(config.stateFile);

  if (!fs.existsSync(config.stateFile)) {
    const state = createDefaultState(config);
    saveState(config.stateFile, state);
    return state;
  }

  const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  return {
    manualInventory: {
      USDT: String(parsed?.manualInventory?.USDT ?? parsed?.inventory?.USDT ?? config.initialUsdt),
      USDC: String(parsed?.manualInventory?.USDC ?? parsed?.inventory?.USDC ?? config.initialUsdc),
    },
    processedExecIds: Array.isArray(parsed?.processedExecIds)
      ? parsed.processedExecIds.map(String)
      : [],
    updatedAt: parsed?.updatedAt || new Date().toISOString(),
  };
}

function saveState(filePath, state) {
  ensureParentDir(filePath);
  const normalized = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

module.exports = {
  loadState,
  saveState,
};
