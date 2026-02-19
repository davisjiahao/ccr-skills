#!/usr/bin/env node

/**
 * CCR StatusLine script for Claude Code
 *
 * Reads Claude Code's statusLine stdin JSON and combines it with
 * CCR router config to show the actual backend model in the status bar.
 *
 * Output goes to stdout (required by Claude Code statusLine).
 *
 * Config priority: Session > Project > Global
 */

const fs = require('fs');
const path = require('path');

const CCR_CONFIG_PATH = path.join(process.env.HOME, '.claude-code-router', 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const CCR_PROJECTS_DIR = path.join(process.env.HOME, '.claude-code-router');

function readStdin() {
  try {
    const input = fs.readFileSync(0, 'utf-8');
    if (input.trim()) {
      return JSON.parse(input);
    }
  } catch (e) {
    // stdin not available or not valid JSON
  }
  return {};
}

function getCCRConfig() {
  try {
    return JSON.parse(fs.readFileSync(CCR_CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function getCurrentProjectId() {
  const cwd = process.cwd();

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return null;
  }

  const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  const encodedCwd = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');

  if (projects.includes(encodedCwd)) {
    return encodedCwd;
  }

  const cwdFolder = path.basename(cwd);
  const candidates = [];

  for (const projectId of projects) {
    if (projectId.endsWith('-' + cwdFolder)) {
      const projectPath = path.join(CLAUDE_PROJECTS_DIR, projectId);
      if (fs.statSync(projectPath).isDirectory()) {
        candidates.push(projectId);
      }
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1) {
    candidates.sort((a, b) => {
      const segmentsA = (a.match(/-/g) || []).length;
      const segmentsB = (b.match(/-/g) || []).length;
      return segmentsB - segmentsA;
    });
    return candidates[0];
  }

  return null;
}

function getSessionIdByMtime(projectId) {
  if (!projectId) return null;

  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectId);
  if (!fs.existsSync(projectDir)) return null;

  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(projectDir, a));
      const statB = fs.statSync(path.join(projectDir, b));
      return statB.mtimeMs - statA.mtimeMs;
    });

  return files.length > 0 ? files[0].replace('.jsonl', '') : null;
}

function getEffectiveConfig() {
  const projectId = getCurrentProjectId();
  const sessionId = getSessionIdByMtime(projectId);

  const globalConfig = getCCRConfig();
  let effective = {
    level: 'global',
    config: globalConfig?.Router || {}
  };

  if (projectId) {
    const projectConfigPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');
    if (fs.existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        if (projectConfig.Router && Object.keys(projectConfig.Router).length > 0) {
          effective = { level: 'project', config: projectConfig.Router };
        }
      } catch (e) { /* ignore */ }
    }
  }

  if (projectId && sessionId) {
    const sessionConfigPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);
    if (fs.existsSync(sessionConfigPath)) {
      try {
        const sessionConfig = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
        if (sessionConfig.Router && Object.keys(sessionConfig.Router).length > 0) {
          effective = { level: 'session', config: sessionConfig.Router };
        }
      } catch (e) { /* ignore */ }
    }
  }

  return effective;
}

function modelMatches(modelStr, currentModel) {
  if (!modelStr || !currentModel) return false;
  if (modelStr === currentModel) return true;

  const parts = modelStr.split(/[/,]/);
  for (const part of parts) {
    if (part.trim() === currentModel) return true;
  }
  const fullName = parts.length >= 2 ? `${parts[0].trim()}/${parts[1].trim()}` : null;
  if (fullName === currentModel) return true;

  return false;
}

function ccrFormatToDisplay(ccrFormat) {
  if (!ccrFormat) return null;
  return ccrFormat.replace(',', '/');
}

/**
 * Check if Claude Code is routing through CCR by comparing
 * ANTHROPIC_BASE_URL against CCR's configured HOST:PORT.
 */
function isCCRActive() {
  const config = getCCRConfig();
  if (!config) return false;

  const ccrHost = config.HOST || '127.0.0.1';
  const ccrPort = config.PORT || 3456;
  const ccrOrigin = `http://${ccrHost}:${ccrPort}`;

  // Check process env
  let baseUrl = process.env.ANTHROPIC_BASE_URL || '';

  // Check settings.json env
  if (!baseUrl) {
    try {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      baseUrl = settings.env?.ANTHROPIC_BASE_URL || '';
    } catch (e) {}
  }

  // Check settings.local.json env
  if (!baseUrl) {
    try {
      const localPath = path.join(process.env.HOME, '.claude', 'settings.local.json');
      const local = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      baseUrl = local.env?.ANTHROPIC_BASE_URL || '';
    } catch (e) {}
  }

  if (!baseUrl) return false;

  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized === ccrOrigin || normalized.startsWith(ccrOrigin + '/');
}

function main() {
  const stdinData = readStdin();

  // Context window from Claude Code stdin
  const ctxPct = Math.round(stdinData?.context_window?.used_percentage || 0);
  const barWidth = 10;
  const filled = Math.round(ctxPct / 100 * barWidth);
  const empty = barWidth - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  // If not routing through CCR, show only context bar (no CCR model info)
  if (!isCCRActive()) {
    console.log(`${bar} ${ctxPct}% ctx`);
    return;
  }

  const config = getCCRConfig();
  const effective = getEffectiveConfig();
  const router = effective.config;
  const level = effective.level;

  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;

  let modelDisplay = '';

  if (currentModel) {
    const displayModel = ccrFormatToDisplay(currentModel) || currentModel;

    // Find provider info
    let providerInfo = null;
    for (const provider of (config?.Providers || [])) {
      for (const model of (provider.models || [])) {
        const fullName = `${provider.name}/${model}`;
        if (fullName === displayModel || model === displayModel || provider.name === displayModel) {
          providerInfo = { name: provider.name, model: model };
          break;
        }
      }
      if (providerInfo) break;
    }

    modelDisplay = providerInfo
      ? `${providerInfo.name}/${providerInfo.model}`
      : displayModel;

    // Roles
    const roles = [];
    if (modelMatches(router.think, currentModel)) roles.push('Think');
    if (modelMatches(router.longContext, currentModel)) roles.push('LongCtx');
    if (modelMatches(router.webSearch, currentModel)) roles.push('Web');
    if (modelMatches(router.background, currentModel)) roles.push('Bg');
    if (modelMatches(router.image, currentModel)) roles.push('Img');

    if (roles.length > 0) {
      modelDisplay += ` [${roles.join(',')}]`;
    }
  } else {
    modelDisplay = 'CCR (no model)';
  }

  // Level indicator
  const levelIcons = { global: '\u{1F310}', project: '\u{1F4C1}', session: '\u{1F4AC}' };
  const levelIcon = levelIcons[level] || '';

  console.log(`${levelIcon} ${modelDisplay} | ${bar} ${ctxPct}% ctx`);
}

main();
