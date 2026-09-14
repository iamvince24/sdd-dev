'use strict';

const fs = require('fs');
const path = require('path');

const TOOL_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(TOOL_ROOT, 'devplan.local.json');

function defaultConfig() {
  return { hookMode: 'warn', projects: {} };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return defaultConfig();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    const wrapped = new Error(`Invalid local config: ${error.message}`);
    wrapped.code = 'INVALID_CONFIG';
    throw wrapped;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('Invalid local config: root must be an object');
    error.code = 'INVALID_CONFIG';
    throw error;
  }
  parsed.projects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
  parsed.hookMode = parsed.hookMode === 'block' ? 'block' : 'warn';
  return parsed;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function resolveRepoRoot(entry) {
  return path.resolve(TOOL_ROOT, entry.repoRoot);
}

function relativeRepoRoot(repoRoot) {
  return path.relative(TOOL_ROOT, path.resolve(repoRoot)) || '.';
}

module.exports = { TOOL_ROOT, CONFIG_PATH, defaultConfig, loadConfig, saveConfig, resolveRepoRoot, relativeRepoRoot };
