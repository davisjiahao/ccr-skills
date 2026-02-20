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
 *
 * Stdin from Claude Code contains:
 *   { session_id, transcript_path, cwd, context_window: { used_percentage } }
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

/**
 * Get project ID from a given cwd path (or process.cwd() as fallback).
 * Claude Code encodes project path as: leading slash → dash, other slashes → dashes.
 */
function getCurrentProjectId(cwd) {
  const dir = cwd || process.cwd();

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return null;
  }

  const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);

  // Method 1: exact encoded path match
  const encodedCwd = '-' + dir.replace(/^\//, '').replace(/\//g, '-');
  if (projects.includes(encodedCwd)) {
    return encodedCwd;
  }

  // Method 2: fallback by folder name suffix
  const cwdFolder = path.basename(dir);
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
    // Prefer the longest match (most specific path)
    candidates.sort((a, b) => {
      const segmentsA = (a.match(/-/g) || []).length;
      const segmentsB = (b.match(/-/g) || []).length;
      return segmentsB - segmentsA;
    });
    return candidates[0];
  }

  return null;
}

/**
 * Get session ID by most-recently-modified .jsonl file.
 * Only used as last resort when stdin doesn't provide session_id.
 */
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

/**
 * Resolve effective CCR router config following priority: Session > Project > Global.
 *
 * @param {string|null} sessionId - From stdin (most reliable) or mtime fallback
 * @param {string|null} projectId - From encoded cwd
 * @returns {{ level: 'global'|'project'|'session', config: object }}
 */
function getEffectiveConfig(sessionId, projectId) {
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
        // Only promote if Router has at least one non-empty value
        if (projectConfig.Router && Object.values(projectConfig.Router).some(v => v)) {
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
        // Only promote if Router has at least one non-empty value
        if (sessionConfig.Router && Object.values(sessionConfig.Router).some(v => v)) {
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

  // Handle both "provider/model" and "provider,model" formats
  const parts = modelStr.split(/[/,]/);
  for (const part of parts) {
    if (part.trim() === currentModel) return true;
  }
  if (parts.length >= 2) {
    const fullName = `${parts[0].trim()}/${parts[1].trim()}`;
    if (fullName === currentModel) return true;
  }

  return false;
}

function ccrFormatToDisplay(ccrFormat) {
  if (!ccrFormat) return null;
  // CCR stores as "provider,model", display as "provider/model"
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

  // Use session_id from stdin (most accurate), fallback to mtime
  // Use cwd from stdin for correct project detection in all situations
  const stdinCwd = stdinData.cwd || null;
  const projectId = getCurrentProjectId(stdinCwd);

  // stdin session_id is the most reliable source — no process-tree walking needed
  const sessionId = stdinData.session_id || getSessionIdByMtime(projectId);

  const config = getCCRConfig();
  const effective = getEffectiveConfig(sessionId, projectId);
  const router = effective.config;
  const level = effective.level;

  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;

  let modelDisplay = '';

  if (currentModel) {
    const displayModel = ccrFormatToDisplay(currentModel) || currentModel;

    // Find provider info for friendly display
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

    // Show non-default roles that differ from default
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

  // Level indicator: 🌐 global / 📁 project / 💬 session
  const levelIcons = { global: '\u{1F310}', project: '\u{1F4C1}', session: '\u{1F4AC}' };
  const levelIcon = levelIcons[level] || '';

  console.log(`${levelIcon} ${modelDisplay} | ${bar} ${ctxPct}% ctx`);
}

main();
