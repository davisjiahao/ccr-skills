#!/usr/bin/env node

/**
 * Show current model info hook
 * Used by Claude Code hooks to display current model after each response
 *
 * Supports CCR's config priority:
 * 1. Session: ~/.claude-code-router/<project-id>/<sessionId>.json
 * 2. Project: ~/.claude-code-router/<project-id>/config.json
 * 3. Global:  ~/.claude-code-router/config.json
 */

const fs = require('fs');
const path = require('path');

const CCR_CONFIG_PATH = path.join(process.env.HOME, '.claude-code-router', 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const CCR_PROJECTS_DIR = path.join(process.env.HOME, '.claude-code-router');
const SESSION_CACHE_DIR = path.join(require('os').tmpdir(), 'ccr-sessions');

/**
 * Read hook event data from stdin (non-blocking).
 * Claude Code sends JSON with session_id, transcript_path, cwd, etc.
 */
function readHookInput() {
  try {
    const input = fs.readFileSync(0, 'utf-8');
    if (input.trim()) {
      return JSON.parse(input);
    }
  } catch (e) {
    // stdin not available or not valid JSON
  }
  return null;
}

/**
 * Persist session_id to a temp file keyed by Claude Code's PID.
 *
 * Hook's process.ppid is the Claude Code process.
 * Skills (run via Bash tool) can walk up the process tree to find this file.
 */
function cacheSessionId(hookInput) {
  if (!hookInput || !hookInput.session_id) return;

  try {
    if (!fs.existsSync(SESSION_CACHE_DIR)) {
      fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
    }

    const claudePid = process.ppid;
    const cachePath = path.join(SESSION_CACHE_DIR, `${claudePid}.json`);

    fs.writeFileSync(cachePath, JSON.stringify({
      session_id: hookInput.session_id,
      pid: claudePid,
      cwd: hookInput.cwd || process.cwd(),
      ts: Date.now()
    }));
  } catch (e) {
    // Best-effort; don't break the hook
  }
}

function getClaudeSettings() {
  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return { model: null };
  }
}

function getCCRConfig() {
  try {
    const content = fs.readFileSync(CCR_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

/**
 * Get current project ID from working directory
 *
 * Claude Code project IDs are encoded versions of the project path.
 * E.g., "/Users/hungrywu/Documents/opensrc/ccr-skills" becomes
 *      "-Users-hungrywu-Documents-opensrc-ccr-skills"
 */
function getCurrentProjectId() {
  const cwd = process.cwd();

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return null;
  }

  const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);

  // Method 1: Try exact match by encoding the cwd path
  // Claude encodes path as: leading slash becomes leading dash, other slashes become dashes
  const encodedCwd = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');

  if (projects.includes(encodedCwd)) {
    return encodedCwd;
  }

  // Method 2: Fallback - match by basename (less precise)
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

  // If only one match, use it
  if (candidates.length === 1) {
    return candidates[0];
  }

  // If multiple matches, prefer more specific one
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

/**
 * Fallback: Get session ID from the most recent .jsonl file.
 * Used only when stdin hook input is not available.
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

  if (files.length > 0) {
    return files[0].replace('.jsonl', '');
  }

  return null;
}

/**
 * Get effective router config following CCR's priority:
 * Session > Project > Global
 *
 * @param {object|null} hookInput - parsed hook stdin data with session_id
 */
function getEffectiveConfig(hookInput) {
  const projectId = getCurrentProjectId();
  // Prefer session_id from hook stdin; fall back to mtime-based detection
  const sessionId = (hookInput && hookInput.session_id) || getSessionIdByMtime(projectId);

  // Start with global config
  const globalConfig = getCCRConfig();
  let effective = {
    level: 'global',
    config: globalConfig?.Router || {}
  };

  // Check project level
  if (projectId) {
    const projectConfigPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');
    if (fs.existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        if (projectConfig.Router && Object.keys(projectConfig.Router).length > 0) {
          effective = {
            level: 'project',
            config: projectConfig.Router
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Check session level (highest priority)
  if (projectId && sessionId) {
    const sessionConfigPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);
    if (fs.existsSync(sessionConfigPath)) {
      try {
        const sessionConfig = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
        if (sessionConfig.Router && Object.keys(sessionConfig.Router).length > 0) {
          effective = {
            level: 'session',
            config: sessionConfig.Router
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return effective;
}

// Helper to check if model matches (handles both "provider/model" and "provider,model" formats)
function modelMatches(modelStr, currentModel) {
  if (!modelStr || !currentModel) return false;

  // Direct match
  if (modelStr === currentModel) return true;

  // Check both formats: "glm/glm-5" and "glm,glm-5"
  const parts = modelStr.split(/[/,]/);
  for (const part of parts) {
    if (part.trim() === currentModel) return true;
    // Also check provider/model combination
    const fullName = parts.length >= 2 ? `${parts[0].trim()}/${parts[1].trim()}` : null;
    if (fullName === currentModel) return true;
  }
  return false;
}

// Convert CCR format (provider,model) to display format (provider/model)
function ccrFormatToDisplay(ccrFormat) {
  if (!ccrFormat) return null;
  return ccrFormat.replace(',', '/');
}

function showCurrentModel() {
  const hookInput = readHookInput();
  cacheSessionId(hookInput);
  const config = getCCRConfig();
  const effective = getEffectiveConfig(hookInput);
  const router = effective.config;
  const level = effective.level;

  // Get current model from effective router config
  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;

  if (!currentModel) {
    // Fallback to settings.model for display
    const settings = getClaudeSettings();
    if (!settings.model) return;
    console.error(`🤖 Model: ${settings.model}`);
    return;
  }

  const displayModel = ccrFormatToDisplay(currentModel) || currentModel;

  // Try to find provider info
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

  // Show roles
  const roles = [];
  if (modelMatches(router.think, currentModel)) roles.push('Think');
  if (modelMatches(router.longContext, currentModel)) roles.push('LongCtx');
  if (modelMatches(router.webSearch, currentModel)) roles.push('WebSearch');
  if (modelMatches(router.background, currentModel)) roles.push('Bg');
  if (modelMatches(router.image, currentModel)) roles.push('Img');

  // Level indicator
  const levelIcons = {
    global: '🌐',
    project: '📁',
    session: '💬'
  };

  // Build output
  let output = '';
  if (providerInfo) {
    output = `${providerInfo.name}/${providerInfo.model}`;
  } else {
    output = displayModel;
  }

  if (roles.length > 0) {
    output += ` [${roles.join(', ')}]`;
  }

  // Add level indicator
  output += ` ${levelIcons[level] || ''}`;

  // Output to stderr so it shows in the conversation
  console.error(`🤖 Model: ${output}`);
}

showCurrentModel();
