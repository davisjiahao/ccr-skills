#!/usr/bin/env node

/**
 * SessionStart hook - caches session ID and injects CCR model context.
 *
 * Claude Code fires SessionStart once when a session begins,
 * sending { session_id, transcript_path, cwd, ... } via stdin.
 *
 * Two responsibilities:
 * 1. Cache session_id to temp file (keyed by Claude Code PID) so that
 *    skills run via Bash tool can walk the process tree to find it.
 * 2. Output additionalContext JSON to stdout so Claude knows which
 *    CCR model is active at the start of the session.
 *
 * Output format (exit 0 required):
 *   { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
 *
 * Any output other than valid JSON on exit 0 causes a "startup hook error".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_CACHE_DIR = path.join(os.tmpdir(), 'ccr-sessions');
const CCR_CONFIG_PATH = path.join(process.env.HOME, '.claude-code-router', 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const CCR_PROJECTS_DIR = path.join(process.env.HOME, '.claude-code-router');

// ============ Session ID Caching ============

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

// ============ CCR Model Detection ============

function getCCRConfig() {
  try {
    return JSON.parse(fs.readFileSync(CCR_CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/**
 * Check if ANTHROPIC_BASE_URL points to the CCR daemon.
 */
function isCCRActive() {
  const config = getCCRConfig();
  if (!config) return false;

  const ccrOrigin = `http://${config.HOST || '127.0.0.1'}:${config.PORT || 3456}`;

  let baseUrl = process.env.ANTHROPIC_BASE_URL || '';

  if (!baseUrl) {
    try {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      baseUrl = settings.env?.ANTHROPIC_BASE_URL || '';
    } catch (e) {}
  }

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

/**
 * Get project ID by encoding cwd path (same scheme as Claude Code).
 */
function getProjectId(cwd) {
  if (!cwd || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  if (projects.includes(encoded)) return encoded;

  // Fallback: match by folder name suffix
  const folder = path.basename(cwd);
  const candidates = projects.filter(p =>
    p.endsWith('-' + folder) &&
    fs.statSync(path.join(CLAUDE_PROJECTS_DIR, p)).isDirectory()
  );

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Most specific (longest) match wins
    return candidates.sort((a, b) =>
      (b.match(/-/g) || []).length - (a.match(/-/g) || []).length
    )[0];
  }

  return null;
}

/**
 * Resolve the effective Router config: Session > Project > Global.
 * Returns { level, router } or null if nothing is configured.
 */
function getEffectiveRouter(sessionId, projectId) {
  const globalConfig = getCCRConfig();
  let effective = { level: 'global', router: globalConfig?.Router || {} };

  if (projectId) {
    const pcPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');
    try {
      const pc = JSON.parse(fs.readFileSync(pcPath, 'utf-8'));
      if (pc.Router && Object.values(pc.Router).some(v => v)) {
        effective = { level: 'project', router: pc.Router };
      }
    } catch (e) {}
  }

  if (projectId && sessionId) {
    const scPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);
    try {
      const sc = JSON.parse(fs.readFileSync(scPath, 'utf-8'));
      if (sc.Router && Object.values(sc.Router).some(v => v)) {
        effective = { level: 'session', router: sc.Router };
      }
    } catch (e) {}
  }

  return effective;
}

/**
 * Build a human-readable model context string to inject into Claude's context.
 * Returns null if CCR is not active or no model is configured.
 */
function buildModelContext(hookInput) {
  if (!isCCRActive()) return null;

  const cwd = hookInput?.cwd || process.cwd();
  const sessionId = hookInput?.session_id || null;
  const projectId = getProjectId(cwd);

  const { level, router } = getEffectiveRouter(sessionId, projectId);

  // Pick the primary model (default first, then fallback to other roles)
  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;

  if (!currentModel) return null;

  // CCR stores "provider,model", display as "provider/model"
  const displayModel = currentModel.replace(',', '/');

  const levelLabels = { global: '全局', project: '项目', session: '会话' };
  const levelLabel = levelLabels[level] || level;

  return `当前会话通过 CCR 路由，使用模型: ${displayModel}（${levelLabel}级配置）`;
}

// ============ Main ============

const hookInput = readHookInput();

// Step 1: cache session ID (side effect, must happen before any output)
cacheSessionId(hookInput);

// Step 2: inject CCR model info into Claude's context via additionalContext
const modelContext = buildModelContext(hookInput);

if (modelContext) {
  // Output structured JSON — Claude Code injects additionalContext into the session
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: modelContext
    }
  }));
}
// If no context (CCR inactive), produce no output — silent exit 0
