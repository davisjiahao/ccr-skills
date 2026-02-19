#!/usr/bin/env node

/**
 * CCR Model Management Script
 * Handles listing, querying, and setting models for Claude Code Router
 *
 * Features:
 * - Check CCR installation and daemon status
 * - Auto-start CCR daemon if not running
 * - Import providers from cc-switch if not configured
 * - Improved fuzzy matching for model names
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CCR_CONFIG_PATH = path.join(process.env.HOME, '.claude-code-router', 'config.json');
const CCR_PID_PATH = path.join(process.env.HOME, '.claude-code-router', '.claude-code-router.pid');
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');
const CC_SWITCH_DB_PATH = path.join(process.env.HOME, '.cc-switch', 'cc-switch.db');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
// CCR reads project/session configs from its own directory, not from ~/.claude/projects/
const CCR_PROJECTS_DIR = path.join(process.env.HOME, '.claude-code-router');
const SESSION_CACHE_DIR = path.join(require('os').tmpdir(), 'ccr-sessions');

// ============ Utility Functions ============

function log(msg, type = 'info') {
  const icons = {
    info: 'ℹ️ ',
    success: '✅',
    warning: '⚠️ ',
    error: '❌',
    action: '🔧'
  };
  console.log(`${icons[type] || ''}${msg}`);
}

function runCommand(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: silent ? 'pipe' : 'inherit' });
  } catch (e) {
    return null;
  }
}

// ============ CCR Installation Check ============

function checkCCRInstalled() {
  // Check if ccr command exists
  const ccrPath = runCommand('which ccr', true);
  if (!ccrPath) {
    log('CCR (claude-code-router) is not installed!', 'error');
    console.log('\nTo install CCR, run one of:');
    console.log('  npm install -g @anthropic-ai/claude-code-router');
    console.log('  npm install -g @musistudio/claude-code-router');
    return false;
  }

  // Check if config directory exists
  if (!fs.existsSync(path.dirname(CCR_CONFIG_PATH))) {
    log('CCR config directory not found. Running ccr init...', 'action');
    runCommand('ccr init');
  }

  return true;
}

// ============ CCR Daemon Check ============

function checkCCRDaemonRunning() {
  // Check via pid file
  if (fs.existsSync(CCR_PID_PATH)) {
    const pid = fs.readFileSync(CCR_PID_PATH, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      return true;
    } catch (e) {
      // Process not running
    }
  }

  // Check via pgrep
  const result = runCommand('pgrep -f "claude-code-router" | head -1', true);
  if (result && result.trim()) {
    return true;
  }

  return false;
}

function startCCRDaemon() {
  log('CCR daemon is not running. Starting...', 'action');

  const result = runCommand('ccr start', false);
  if (result !== null) {
    // Wait a bit for daemon to start
    let attempts = 0;
    while (attempts < 10 && !checkCCRDaemonRunning()) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      attempts++;
    }

    if (checkCCRDaemonRunning()) {
      log('CCR daemon started successfully!', 'success');
      return true;
    }
  }

  log('Failed to start CCR daemon. Please run: ccr start', 'error');
  return false;
}

function restartCCRDaemon() {
  log('Restarting CCR daemon to apply changes...', 'action');
  runCommand('ccr stop', true);

  let attempts = 0;
  while (attempts < 10 && checkCCRDaemonRunning()) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    attempts++;
  }

  return startCCRDaemon();
}

// ============ Config Reading ============

function getCCRConfig() {
  if (!fs.existsSync(CCR_CONFIG_PATH)) {
    return null;
  }
  try {
    const content = fs.readFileSync(CCR_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    log(`Error reading CCR config: ${e.message}`, 'error');
    return null;
  }
}

function saveCCRConfig(config) {
  fs.writeFileSync(CCR_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getClaudeSettings() {
  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return { env: {}, model: 'claude-sonnet-4-20250514' };
  }
}

// ============ CC-Switch Import ============

function getCCSwitchProviders() {
  if (!fs.existsSync(CC_SWITCH_DB_PATH)) {
    log('cc-switch database not found', 'warning');
    return null;
  }

  try {
    const result = runCommand(
      `sqlite3 "${CC_SWITCH_DB_PATH}" "SELECT name, settings_config FROM providers WHERE app_type='claude';"`,
      true
    );

    if (!result) return null;

    const providers = [];
    const lines = result.trim().split('\n');

    for (const line of lines) {
      const [name, configStr] = line.split('|');
      if (!configStr) continue;

      try {
        const config = JSON.parse(configStr);
        const env = config.env || {};
        const model = env.ANTHROPIC_MODEL || config.model || '';

        // Extract provider info
        const provider = {
          name: mapProviderName(name),
          api_base_url: env.ANTHROPIC_BASE_URL || '',
          api_key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
          models: model ? [model] : [],
          transformer: { use: [detectTransformer(name, env.ANTHROPIC_BASE_URL)] }
        };

        // Only add if we have required fields
        if (provider.api_base_url && provider.api_key && provider.models.length > 0) {
          providers.push(provider);
        }
      } catch (e) {
        // Skip invalid entries
      }
    }

    return providers;
  } catch (e) {
    log(`Error reading cc-switch: ${e.message}`, 'warning');
    return null;
  }
}

function mapProviderName(ccSwitchName) {
  // Common known mappings (can be extended)
  const knownMappings = {
    'Zhipu GLM': 'glm',
    'DouBaoSeed': 'doubao',
    'Xiaomi MiMo': 'mimo',
    'OpenRouter': 'openrouter',
    'Kimi For Coding': 'kimi',
    'MiniMax': 'minimax',
    'AntigravityTool': 'antigravity',
    'CCR Router': 'ccr'
  };

  // Check known mappings first
  if (knownMappings[ccSwitchName]) {
    return knownMappings[ccSwitchName];
  }

  // Dynamic fallback: normalize the name
  // 1. Convert to lowercase
  // 2. Replace spaces with hyphens
  // 3. Remove special characters except hyphens
  return ccSwitchName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Detect transformer type dynamically based on base URL patterns
 */
function detectTransformer(name, baseUrl) {
  if (!baseUrl) return 'deepseek';

  const url = baseUrl.toLowerCase();

  // URL pattern to transformer mapping
  const patterns = [
    { pattern: 'openrouter.ai', transformer: 'openrouter' },
    { pattern: 'bigmodel.cn', transformer: 'Anthropic' },
    { pattern: 'anthropic.com', transformer: 'Anthropic' },
    { pattern: 'api.anthropic.com', transformer: 'Anthropic' },
    { pattern: 'deepseek.com', transformer: 'deepseek' },
    { pattern: 'moonshot.cn', transformer: 'deepseek' },
    { pattern: 'kimi', transformer: 'deepseek' },
    { pattern: 'zhipu', transformer: 'Anthropic' },
    { pattern: 'glm', transformer: 'Anthropic' },
    { pattern: 'minimax', transformer: 'deepseek' },
    { pattern: 'doubao', transformer: 'deepseek' },
    { pattern: 'bytedance', transformer: 'deepseek' },
    { pattern: 'ark', transformer: 'deepseek' },
    { pattern: 'mimo', transformer: 'deepseek' },
    { pattern: 'xiaomi', transformer: 'deepseek' }
  ];

  // Check each pattern
  for (const { pattern, transformer } of patterns) {
    if (url.includes(pattern)) {
      return transformer;
    }
  }

  // Default transformer
  return 'deepseek';
}

function importFromCCSwitch(config) {
  log('Importing providers from cc-switch...', 'action');

  const ccSwitchProviders = getCCSwitchProviders();
  if (!ccSwitchProviders || ccSwitchProviders.length === 0) {
    log('No valid providers found in cc-switch', 'warning');
    return false;
  }

  // Merge with existing providers
  config.Providers = config.Providers || [];
  const existingNames = new Set(config.Providers.map(p => p.name));

  let imported = 0;
  for (const provider of ccSwitchProviders) {
    if (!existingNames.has(provider.name)) {
      config.Providers.push(provider);
      imported++;
    }
  }

  if (imported > 0) {
    saveCCRConfig(config);
    log(`Imported ${imported} provider(s) from cc-switch`, 'success');
    return true;
  } else {
    log('All providers already exist in CCR config', 'info');
    return true;
  }
}

// ============ Model Management ============

function getAllModels() {
  const config = getCCRConfig();
  if (!config) return [];

  const models = [];
  for (const provider of (config.Providers || [])) {
    for (const model of (provider.models || [])) {
      models.push({
        provider: provider.name,
        model: model,
        fullName: `${provider.name}/${model}`
      });
    }
  }
  return models;
}

// ============ Dynamic Alias Generation ============

// Cache for dynamically generated aliases
let dynamicAliases = null;
let lastConfigHash = null;

/**
 * Generate aliases for a model name dynamically
 * Examples:
 *   "glm-5" -> ["glm5", "g5"]
 *   "MiniMax-M2.5" -> ["minimaxm2.5", "minimaxm25", "m2.5", "m25", "mm2.5"]
 *   "claude-sonnet-4" -> ["claudesonnet4", "cs4", "sonnet4"]
 *   "kimi-k2.5" -> ["kimik2.5", "kimik25", "k2.5", "k25"]
 */
function generateModelAliases(modelName) {
  const aliases = new Set();
  const lower = modelName.toLowerCase();
  const noSep = lower.replace(/[-_\s]/g, '');
  const parts = lower.split(/[-_\s]+/).filter(p => p);

  // 1. Full name without separators
  aliases.add(noSep);

  // 2. Generate abbreviations based on parts
  if (parts.length >= 2) {
    // First letter of each part (except version-like parts)
    const abbr = parts.map(p => p.charAt(0)).join('');
    if (abbr.length >= 2) aliases.add(abbr);

    // For version-like suffixes (e.g., "m2.5", "k2.5")
    const lastPart = parts[parts.length - 1];
    const versionMatch = lastPart.match(/^(\d+(?:\.\d+)?)$/);
    if (versionMatch) {
      // Provider abbreviation + version
      const providerAbbr = parts.slice(0, -1).map(p => p.charAt(0)).join('');
      aliases.add(providerAbbr + versionMatch[1]);
      aliases.add(providerAbbr + versionMatch[1].replace('.', ''));

      // First part + version
      if (parts.length >= 2) {
        aliases.add(parts[0] + versionMatch[1]);
        aliases.add(parts[0] + versionMatch[1].replace('.', ''));
      }
    }

    // For model-series-version pattern (e.g., "claude-sonnet-4")
    if (parts.length >= 3) {
      const seriesAbbr = parts.slice(1).map(p => p.charAt(0)).join('');
      aliases.add(parts[0].charAt(0) + seriesAbbr);

      // Series name + version
      const lastIsVersion = parts[parts.length - 1].match(/^\d+$/);
      if (lastIsVersion) {
        aliases.add(parts[1] + parts[2]); // e.g., "sonnet4"
        aliases.add(parts[1].charAt(0) + parts[2]); // e.g., "s4"
      }
    }

    // Two-part names: first letter + full second part
    if (parts.length === 2) {
      aliases.add(parts[0].charAt(0) + parts[1]);
      aliases.add(parts[0].charAt(0) + parts[1].replace(/\./g, ''));
    }
  }

  // 3. Remove dots from all aliases
  const aliasesWithNoDots = [...aliases].map(a => a.replace(/\./g, ''));
  aliasesWithNoDots.forEach(a => aliases.add(a));

  // 4. Common variations
  aliases.add(lower);
  if (lower.includes('-')) {
    aliases.add(lower.replace(/-/g, ''));
    aliases.add(lower.replace(/-/g, '_'));
  }

  return [...aliases];
}

/**
 * Generate provider aliases (e.g., "Zhipu GLM" -> ["zhipuglm", "glm", "zhipu"])
 */
function generateProviderAliases(providerName) {
  const aliases = new Set();
  const lower = providerName.toLowerCase();
  const noSep = lower.replace(/[-_\s]/g, '');

  aliases.add(lower);
  aliases.add(noSep);

  // First letter of each word
  const words = providerName.split(/[-_\s]+/).filter(p => p);
  if (words.length > 1) {
    aliases.add(words.map(w => w.charAt(0).toLowerCase()).join(''));
  }

  // Common short forms
  const shortForms = {
    'zhipu': ['zp'],
    'minimax': ['mm', 'min'],
    'openrouter': ['or'],
    'doubao': ['db'],
    'deepseek': ['ds'],
    'claude': ['cl'],
    'anthropic': ['ant', 'ap']
  };

  for (const [key, forms] of Object.entries(shortForms)) {
    if (lower.includes(key)) {
      forms.forEach(f => aliases.add(f));
    }
  }

  return [...aliases];
}

/**
 * Build dynamic alias cache from CCR config
 */
function buildDynamicAliases(config) {
  const aliases = {};
  const providerAliases = {};

  for (const provider of (config?.Providers || [])) {
    const pName = provider.name;
    providerAliases[pName] = generateProviderAliases(pName);

    for (const model of (provider.models || [])) {
      const fullName = `${pName}/${model}`;
      const modelAls = generateModelAliases(model);

      // Map each alias to the full model name
      for (const alias of modelAls) {
        if (!aliases[alias]) {
          aliases[alias] = fullName;
        }
      }

      // Also map model name directly
      aliases[model.toLowerCase()] = fullName;
      aliases[model.toLowerCase().replace(/[-_\s]/g, '')] = fullName;
    }
  }

  return { modelAliases: aliases, providerAliases };
}

/**
 * Get or build dynamic aliases cache
 */
function getDynamicAliases() {
  const config = getCCRConfig();
  if (!config) return { modelAliases: {}, providerAliases: {} };

  // Simple hash to detect config changes
  const configStr = JSON.stringify(config.Providers);
  const hash = configStr.length + '_' + (config.Providers?.length || 0);

  if (dynamicAliases && lastConfigHash === hash) {
    return dynamicAliases;
  }

  dynamicAliases = buildDynamicAliases(config);
  lastConfigHash = hash;
  return dynamicAliases;
}

function fuzzyMatch(models, query) {
  const { modelAliases, providerAliases } = getDynamicAliases();
  const lowerQuery = query.toLowerCase();
  const noSepQuery = lowerQuery.replace(/[-_\s\.]/g, '');

  // Check if query matches any alias directly
  const aliasMatch = modelAliases[noSepQuery] || modelAliases[lowerQuery];

  // Score-based matching
  const scored = models.map(m => {
    let score = 0;
    const fullName = m.fullName.toLowerCase();
    const provider = m.provider.toLowerCase();
    const model = m.model.toLowerCase();
    const modelNoSep = model.replace(/[-_\s\.]/g, '');

    // Generate aliases for this model
    const modelAls = generateModelAliases(m.model);
    const pAls = providerAliases[m.provider] || generateProviderAliases(m.provider);

    // Exact alias match (highest priority)
    if (aliasMatch === m.fullName) {
      score = 100;
    }
    // Exact match (full name)
    else if (fullName === lowerQuery) {
      score = 100;
    }
    // Exact match (model only)
    else if (model === lowerQuery || modelNoSep === noSepQuery) {
      score = 95;
    }
    // Model alias match
    else if (modelAls.includes(noSepQuery) || modelAls.includes(lowerQuery)) {
      score = 92;
    }
    // Provider/model format match (e.g., "glm/glm-5")
    else if (lowerQuery.includes('/')) {
      const [p, mdl] = lowerQuery.split('/');
      if (provider.includes(p) && model.includes(mdl)) score = 90;
      else if (pAls.some(a => a.includes(p)) && model.includes(mdl)) score = 85;
    }
    // Model contains query (without separators)
    else if (modelNoSep.includes(noSepQuery)) {
      score = 85;
    }
    // Full name contains query
    else if (fullName.includes(lowerQuery)) {
      score = 80;
    }
    // Model contains query
    else if (model.includes(lowerQuery)) {
      score = 75;
    }
    // Starts with query
    else if (fullName.startsWith(lowerQuery) || modelNoSep.startsWith(noSepQuery)) {
      score = 70;
    }
    else if (model.startsWith(lowerQuery)) {
      score = 68;
    }
    // Provider alias match
    else if (pAls.includes(noSepQuery) || pAls.includes(lowerQuery)) {
      score = 65;
    }
    // Provider match
    else if (provider === lowerQuery || provider.includes(lowerQuery)) {
      score = 60;
    }
    // Fuzzy match (any part matches)
    else {
      const queryParts = noSepQuery.split(/[\s\-_\/]+/).filter(p => p && p.length >= 2);
      let matchCount = 0;

      for (const part of queryParts) {
        if (modelNoSep.includes(part) || modelAls.some(a => a.includes(part))) {
          matchCount++;
        } else if (pAls.some(a => a.includes(part))) {
          matchCount += 0.5;
        }
      }

      score = matchCount * 20;
    }

    return { ...m, score };
  });

  // Filter out zero scores and sort by score descending
  return scored.filter(m => m.score > 0).sort((a, b) => b.score - a.score);
}

// ============ Commands ============

function listModels() {
  const config = getCCRConfig();
  if (!config) {
    log('Cannot read CCR config', 'error');
    return;
  }

  const models = getAllModels();
  const router = config.Router || {};

  console.log('═══════════════════════════════════════════════════');
  console.log('              Available Models in CCR');
  console.log('═══════════════════════════════════════════════════\n');

  // Group by provider
  const byProvider = {};
  for (const m of models) {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m.model);
  }

  if (Object.keys(byProvider).length === 0) {
    log('No models configured!', 'warning');
    console.log('Run: ccr-model import   to import from cc-switch');
  } else {
    for (const [provider, modelList] of Object.entries(byProvider)) {
      console.log(`  ${provider}:`);
      for (const model of modelList) {
        console.log(`    - ${model}`);
      }
      console.log('');
    }
  }

  // Show current router config
  console.log('═══════════════════════════════════════════════════');
  console.log('              Current Router Configuration');
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`  Default Model:      ${router.default || 'N/A'}`);
  console.log(`  Background Model:  ${router.background || 'N/A'}`);
  console.log(`  Think Model:        ${router.think || 'N/A'}`);
  console.log(`  Long Context Model: ${router.longContext || 'N/A'}`);
  console.log(`  Web Search Model:   ${router.webSearch || 'N/A'}`);
  console.log('');

  // Show Claude settings model
  const settings = getClaudeSettings();
  console.log('═══════════════════════════════════════════════════');
  console.log('              Claude Code Current Model');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  Model: ${settings.model || 'default'}`);
  console.log('');
}

function queryModels(query) {
  const models = getAllModels();
  if (models.length === 0) {
    log('No models available. Import from cc-switch first.', 'warning');
    return;
  }

  const matches = fuzzyMatch(models, query);

  if (matches.length === 0) {
    console.log(`No models found matching: ${query}`);
    console.log('\nAvailable models:');
    listModels();
    return;
  }

  console.log(`Found ${matches.length} model(s) matching: "${query}"\n`);

  // Show top matches
  const uniqueMatches = [];
  const seen = new Set();
  for (const m of matches) {
    if (!seen.has(m.fullName)) {
      seen.add(m.fullName);
      uniqueMatches.push(m);
    }
  }

  console.log('Matches:');
  for (let i = 0; i < Math.min(uniqueMatches.length, 10); i++) {
    const m = uniqueMatches[i];
    const marker = i === 0 ? '▶' : ' ';
    console.log(`  ${marker} ${m.fullName} (score: ${m.score})`);
  }

  if (uniqueMatches.length > 10) {
    console.log(`  ... and ${uniqueMatches.length - 10} more`);
  }

  console.log('');
}

// ============ Project & Session Level Config ============

/**
 * Get current project ID from working directory or environment
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

  // Method 2: Fallback - match by basename (less precise, handles edge cases)
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

  // If multiple matches, try to find the best one by checking path depth
  if (candidates.length > 1) {
    // Prefer the one with more path segments (more specific match)
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
 * Get current session ID with source information.
 *
 * Priority:
 * 1. CLAUDE_CODE_SESSION_ID env var (set in MCP-CLI mode)
 * 2. Session cache file written by show-model hook (keyed by Claude Code PID)
 * 3. Fallback: most recently modified .jsonl file (unreliable with concurrent sessions)
 *
 * @returns {{ id: string, source: 'env'|'cache'|'mtime' } | null}
 */
function resolveSessionId() {
  const envSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (envSessionId) {
    return { id: envSessionId, source: 'env' };
  }

  const cachedId = getSessionIdFromCache();
  if (cachedId) {
    return { id: cachedId, source: 'cache' };
  }

  const mtimeId = getSessionIdByMtime(getCurrentProjectId());
  if (mtimeId) {
    return { id: mtimeId, source: 'mtime' };
  }

  return null;
}

/** Convenience wrapper that returns just the session ID string. */
function getCurrentSessionId() {
  const result = resolveSessionId();
  return result ? result.id : null;
}

/**
 * Walk up the process tree to find a session cache file written by the hook.
 *
 * Process chain: Claude Code (writes cache) → sh → node ccr-model.js
 * The hook's process.ppid is Claude Code's PID, so we walk up from our PID
 * until we find a matching cache file or reach PID 1.
 */
function getSessionIdFromCache() {
  if (!fs.existsSync(SESSION_CACHE_DIR)) return null;

  let pid = process.ppid;
  const maxDepth = 5; // Claude Code is at most a few levels up

  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const cachePath = path.join(SESSION_CACHE_DIR, `${pid}.json`);
    if (fs.existsSync(cachePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

        // Validate the cached session is still alive (PID still running)
        try {
          process.kill(data.pid, 0);
        } catch (e) {
          // Process is dead, remove stale cache
          try { fs.unlinkSync(cachePath); } catch (_) {}
          return null;
        }

        return data.session_id;
      } catch (e) {
        return null;
      }
    }

    // Walk up: get parent PID of current pid
    try {
      const ppidStr = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8' }).trim();
      pid = parseInt(ppidStr, 10);
      if (isNaN(pid)) break;
    } catch (e) {
      break;
    }
  }

  return null;
}

/**
 * Fallback: Get session ID from the most recent .jsonl file.
 * Unreliable when multiple sessions are open in the same directory.
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
 * Set model at project or session level
 * CCR reads configs from ~/.claude-code-router/<project-id>/ directory
 */
function setModelAtLevel(query, args, level) {
  const models = getAllModels();
  if (models.length === 0) {
    log('No models available.', 'error');
    console.log('Try: ccr-model import   to import from cc-switch');
    process.exit(1);
  }

  // Filter out option flags from query
  const cleanQuery = query.replace(/--\S+/g, '').trim();
  const matches = fuzzyMatch(models, cleanQuery);

  if (matches.length === 0) {
    console.error(`No models found matching: ${cleanQuery}`);
    process.exit(1);
  }

  const uniqueMatches = [];
  const seen = new Set();
  for (const m of matches) {
    if (!seen.has(m.fullName)) {
      seen.add(m.fullName);
      uniqueMatches.push(m);
    }
  }

  const selected = uniqueMatches[0];
  const fullModelName = selected.fullName;
  const ccrFormat = fullModelName.replace('/', ',');

  // Parse role option
  const roleArg = args.find(a => a.startsWith('--role=') || a.startsWith('-r='));
  const role = roleArg ? roleArg.split('=')[1] : null;
  const validRoles = ['default', 'think', 'longContext', 'webSearch', 'background', 'image'];

  // Get project ID
  const projectId = getCurrentProjectId();

  if (level === 'project') {
    // Project-level config - CCR reads from ~/.claude-code-router/<project-id>/config.json
    if (!projectId) {
      console.error('❌ Cannot determine current project. Make sure you are in a Claude Code project.');
      process.exit(1);
    }

    const projectConfigPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');

    // Ensure directory exists
    const projectDir = path.dirname(projectConfigPath);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // Read or create project config
    let projectConfig = {};
    if (fs.existsSync(projectConfigPath)) {
      try {
        projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      } catch (e) {
        projectConfig = {};
      }
    }

    projectConfig.Router = projectConfig.Router || {};

    if (role && validRoles.includes(role)) {
      projectConfig.Router[role] = ccrFormat;
      console.log(`✅ Project-level: Set role '${role}' to ${fullModelName}`);
    } else {
      // Set all roles
      projectConfig.Router.default = ccrFormat;
      projectConfig.Router.think = ccrFormat;
      projectConfig.Router.background = ccrFormat;
      projectConfig.Router.longContext = ccrFormat;
      projectConfig.Router.webSearch = ccrFormat;
      projectConfig.Router.image = ccrFormat;
      console.log(`✅ Project-level: Set all roles to ${fullModelName}`);
    }

    fs.writeFileSync(projectConfigPath, JSON.stringify(projectConfig, null, 2));
    console.log(`   Config saved to: ${projectConfigPath}`);
    restartCCRDaemon();
    return;
  }

  if (level === 'session') {
    // Session-level config - CCR reads from ~/.claude-code-router/<project-id>/<sessionId>.json
    const sessionId = getCurrentSessionId();
    if (!projectId || !sessionId) {
      console.error('❌ Cannot determine current project/session. Make sure you are in a Claude Code project with an active session.');
      process.exit(1);
    }

    const sessionConfigPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);

    // Read or create session config
    let sessionConfig = {};
    if (fs.existsSync(sessionConfigPath)) {
      try {
        sessionConfig = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
      } catch (e) {
        sessionConfig = {};
      }
    }

    sessionConfig.Router = sessionConfig.Router || {};

    if (role && validRoles.includes(role)) {
      sessionConfig.Router[role] = ccrFormat;
      console.log(`✅ Session-level: Set role '${role}' to ${fullModelName}`);
    } else {
      // Set all roles for session level
      sessionConfig.Router.default = ccrFormat;
      sessionConfig.Router.think = ccrFormat;
      sessionConfig.Router.background = ccrFormat;
      sessionConfig.Router.longContext = ccrFormat;
      sessionConfig.Router.webSearch = ccrFormat;
      sessionConfig.Router.image = ccrFormat;
      console.log(`✅ Session-level: Set all roles to ${fullModelName}`);
    }

    fs.writeFileSync(sessionConfigPath, JSON.stringify(sessionConfig, null, 2));
    console.log(`   Config saved to: ${sessionConfigPath}`);
    restartCCRDaemon();
    return;
  }
}

function setModel(query, args) {
  const models = getAllModels();
  if (models.length === 0) {
    log('No models available.', 'error');
    console.log('Try: ccr-model import   to import from cc-switch');
    process.exit(1);
  }

  // Filter out option flags from query
  const cleanQuery = query.replace(/--\S+/g, '').trim();

  const matches = fuzzyMatch(models, cleanQuery);

  if (matches.length === 0) {
    console.error(`No models found matching: ${query}`);
    process.exit(1);
  }

  // Get unique matches
  const uniqueMatches = [];
  const seen = new Set();
  for (const m of matches) {
    if (!seen.has(m.fullName)) {
      seen.add(m.fullName);
      uniqueMatches.push(m);
    }
  }

  const selected = uniqueMatches[0];
  const fullModelName = selected.fullName;

  if (uniqueMatches.length > 1) {
    console.log(`⚠️  Multiple matches found. Using first match: ${fullModelName}\n`);
    console.log('All matches:');
    uniqueMatches.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.fullName}`);
    });
    console.log('');
  }

  // Convert provider/model format to provider,model format (CCR uses comma)
  const ccrFormat = fullModelName.replace('/', ',');

  // Parse role option
  const roleArg = args.find(a => a.startsWith('--role=') || a.startsWith('-r='));
  const role = roleArg ? roleArg.split('=')[1] : null;

  // Valid roles
  const validRoles = ['default', 'think', 'longContext', 'webSearch', 'background', 'image'];

  // Get existing config
  const config = getCCRConfig();

  console.log(`✅ Setting model to: ${fullModelName}`);

  config.Router = config.Router || {};

  if (role && validRoles.includes(role)) {
    // Set specific role only
    config.Router[role] = ccrFormat;
    console.log(`   Role '${role}' = ${ccrFormat}`);
    console.log(`   Other roles unchanged.`);
  } else if (!role) {
    // Set all roles (default behavior)
    config.Router.default = ccrFormat;
    config.Router.think = ccrFormat;
    config.Router.background = ccrFormat;
    config.Router.longContext = ccrFormat;
    config.Router.webSearch = ccrFormat;
    config.Router.image = ccrFormat;
    console.log(`   All roles = ${ccrFormat}`);
  }

  saveCCRConfig(config);

  console.log(`\n✅ Model updated successfully!`);
  restartCCRDaemon();
}

function showProjectConfig() {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    console.log('❌ Cannot determine current project.');
    return;
  }

  // CCR reads project config from ~/.claude-code-router/<project-id>/config.json
  const projectConfigPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');

  console.log('═══════════════════════════════════════════════════');
  console.log(`              Project: ${projectId}`);
  console.log('═══════════════════════════════════════════════════\n');

  if (fs.existsSync(projectConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
      if (config.Router) {
        console.log('  Project-level Router Config:');
        console.log(JSON.stringify(config.Router, null, 2));
      } else {
        console.log('  No Router config found in project config.');
      }
    } catch (e) {
      console.log('  Error reading project config:', e.message);
    }
  } else {
    console.log('  No project config file found.');
    console.log(`  Expected path: ${projectConfigPath}`);
  }
  console.log('');
}

function showSessionConfig() {
  const projectId = getCurrentProjectId();
  const sessionId = getCurrentSessionId();

  if (!projectId || !sessionId) {
    console.log('❌ Cannot determine current project/session.');
    return;
  }

  // CCR reads session config from ~/.claude-code-router/<project-id>/<sessionId>.json
  const sessionConfigPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);

  console.log('═══════════════════════════════════════════════════');
  console.log(`              Session: ${sessionId}`);
  console.log(`              Project: ${projectId}`);
  console.log('═══════════════════════════════════════════════════\n');

  if (fs.existsSync(sessionConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
      if (config.Router) {
        console.log('  Session-level Router Config:');
        console.log(JSON.stringify(config.Router, null, 2));
      } else {
        console.log('  No Router config found in session config.');
      }
    } catch (e) {
      console.log('  Error reading session config:', e.message);
    }
  } else {
    console.log('  No session config file found.');
    console.log(`  Expected path: ${sessionConfigPath}`);
  }
  console.log('');
}

function importProviders() {
  let config = getCCRConfig();

  if (!config) {
    // Create new config
    config = {
      LOG: true,
      LOG_LEVEL: "info",
      HOST: "127.0.0.1",
      PORT: 3456,
      APIKEY: "",
      API_TIMEOUT_MS: "600000",
      PROXY_URL: "",
      transformers: [],
      Providers: [],
      Router: {
        default: "",
        background: "",
        think: "",
        longContext: "",
        webSearch: ""
      }
    };
  }

  config.Providers = config.Providers || [];

  if (config.Providers.length === 0) {
    log('No providers configured in CCR', 'warning');
  }

  const result = importFromCCSwitch(config);
  if (result) {
    // Set default model if not set
    if (!config.Router.default && config.Providers.length > 0) {
      const firstProvider = config.Providers[0];
      if (firstProvider.models && firstProvider.models.length > 0) {
        config.Router.default = `${firstProvider.name}/${firstProvider.models[0]}`;
        saveCCRConfig(config);
        log(`Set default model to: ${config.Router.default}`, 'info');
      }
    }

    // Restart daemon so new providers take effect
    if (checkCCRDaemonRunning()) {
      restartCCRDaemon();
    }
  }

  return result;
}

function showStatus() {
  console.log('═══════════════════════════════════════════════════');
  console.log('              CCR Status Check');
  console.log('═══════════════════════════════════════════════════\n');

  // Check CCR installation
  const ccrInstalled = checkCCRInstalled();
  console.log(`  CCR Installed:     ${ccrInstalled ? '✅ Yes' : '❌ No'}`);

  if (!ccrInstalled) {
    return;
  }

  // Check daemon
  const daemonRunning = checkCCRDaemonRunning();
  console.log(`  CCR Daemon:        ${daemonRunning ? '✅ Running' : '⚠️  Not running'}`);

  // Check providers
  const config = getCCRConfig();
  const providerCount = config?.Providers?.length || 0;
  console.log(`  Providers:         ${providerCount > 0 ? `✅ ${providerCount} configured` : '❌ None configured'}`);

  // Check cc-switch
  const hasCCSwitch = fs.existsSync(CC_SWITCH_DB_PATH);
  console.log(`  CC-Switch:         ${hasCCSwitch ? '✅ Available' : '⚠️  Not found'}`);

  // Project & Session info
  const projectId = getCurrentProjectId();
  const sessionResult = resolveSessionId();
  console.log(`  Project ID:        ${projectId || '❌ Not detected'}`);
  console.log(`  Session ID:        ${sessionResult ? sessionResult.id : '❌ Not detected'}`);

  if (sessionResult) {
    const sourceLabels = {
      env: 'env (CLAUDE_CODE_SESSION_ID)',
      cache: 'cache (hook temp file)',
      mtime: 'mtime (fallback, may be inaccurate)'
    };
    console.log(`  Session Source:    ${sourceLabels[sessionResult.source]}`);
  }

  // Current model - show effective model based on hierarchy
  const effective = getEffectiveConfig();
  const router = effective.config;
  const level = effective.level;
  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;
  const displayModel = ccrFormatToDisplay(currentModel) || currentModel || 'default';

  const levelLabels = {
    global: '🌐 Global',
    project: '📁 Project',
    session: '💬 Session'
  };

  console.log(`  Current Model:     ${displayModel}`);
  console.log(`  Model Source:      ${levelLabels[level] || level}`);

  console.log('');

  // Suggest actions
  if (!daemonRunning) {
    console.log('💡 Run: ccr start    to start the daemon');
  }
  if (providerCount === 0 && hasCCSwitch) {
    console.log('💡 Run: ccr-model import    to import providers from cc-switch');
  }
}

// ============ Get Effective Model (Session > Project > Global) ============

/**
 * Get effective router config following CCR's priority:
 * 1. CUSTOM_ROUTER_PATH (custom JS script) - not handled here
 * 2. Session: ~/.claude-code-router/<project-id>/<sessionId>.json
 * 3. Project: ~/.claude-code-router/<project-id>/config.json
 * 4. Global: ~/.claude-code-router/config.json
 *
 * Session ID is resolved via CLAUDE_CODE_SESSION_ID env var when available,
 * otherwise falls back to mtime-based detection.
 */
function getEffectiveConfig() {
  const projectId = getCurrentProjectId();
  const sessionId = getCurrentSessionId();

  // Start with global config
  const globalConfig = getCCRConfig();
  let effective = {
    level: 'global',
    config: globalConfig?.Router || {},
    projectId: null,
    sessionId: null
  };

  // Check project level - CCR reads from ~/.claude-code-router/<project-id>/config.json
  if (projectId) {
    const projectConfigPath = path.join(CCR_PROJECTS_DIR, projectId, 'config.json');
    if (fs.existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        if (projectConfig.Router && Object.keys(projectConfig.Router).length > 0) {
          effective = {
            level: 'project',
            config: projectConfig.Router,
            projectId: projectId,
            sessionId: null
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Check session level (highest priority) - CCR reads from ~/.claude-code-router/<project-id>/<sessionId>.json
  if (projectId && sessionId) {
    const sessionConfigPath = path.join(CCR_PROJECTS_DIR, projectId, `${sessionId}.json`);
    if (fs.existsSync(sessionConfigPath)) {
      try {
        const sessionConfig = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
        if (sessionConfig.Router && Object.keys(sessionConfig.Router).length > 0) {
          effective = {
            level: 'session',
            config: sessionConfig.Router,
            projectId: projectId,
            sessionId: sessionId
          };
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return effective;
}

// Convert CCR format (provider,model) to display format (provider/model)
function ccrFormatToDisplay(ccrFormat) {
  if (!ccrFormat) return null;
  return ccrFormat.replace(',', '/');
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

function showCurrentModel() {
  // Get effective config based on hierarchy (Session > Project > Global)
  const effective = getEffectiveConfig();
  const config = getCCRConfig();
  const router = effective.config;
  const level = effective.level;

  // Get current model (from default role or any role)
  const currentModel = router.default || router.think || router.background ||
                       router.longContext || router.webSearch || router.image;

  if (!currentModel) {
    // Fallback to global settings.model
    const settings = getClaudeSettings();
    if (!settings.model) return;
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

  console.log('\n═══════════════════════════════════════════════════');
  console.log('              Current Model');
  console.log('═══════════════════════════════════════════════════\n');

  // Show config level
  const levelLabels = {
    global: '🌐 Global',
    project: '📁 Project',
    session: '💬 Session'
  };
  console.log(`  Config:    ${levelLabels[level] || level}`);

  if (providerInfo) {
    console.log(`  Provider:  ${providerInfo.name}`);
    console.log(`  Model:     ${providerInfo.model}`);
  } else {
    console.log(`  Model:     ${displayModel}`);
  }

  // Show roles (model can have multiple roles)
  const roles = [];

  if (modelMatches(router.think, currentModel)) {
    roles.push('Think 🧠');
  }
  if (modelMatches(router.longContext, currentModel)) {
    roles.push('Long Context 📚');
  }
  if (modelMatches(router.webSearch, currentModel)) {
    roles.push('Web Search 🌐');
  }
  if (modelMatches(router.background, currentModel)) {
    roles.push('Background 🔄');
  }
  if (modelMatches(router.image, currentModel)) {
    roles.push('Image 🖼️');
  }

  // Check if it's the default model
  if (router.default === currentModel) {
    roles.push('Default');
  }

  if (roles.length > 0) {
    console.log(`  Role:      ${roles.join(', ')}`);
  } else {
    console.log(`  Role:      Default`);
  }

  console.log('');
}

// ============ Main ============

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  // For non-status commands, check CCR installation first
  if (command !== 'status' && command !== 'help') {
    if (!checkCCRInstalled()) {
      process.exit(1);
    }

    // Check daemon for most commands
    if (command !== 'import') {
      if (!checkCCRDaemonRunning()) {
        if (!startCCRDaemon()) {
          process.exit(1);
        }
      }
    }
  }

  // Execute command
  let showModelInfo = true;
  switch (command) {
    case 'list':
      listModels();
      break;

    case 'query':
      const query = args.slice(1).join(' ');
      if (!query) {
        console.error('Please provide a search query');
        process.exit(1);
      }
      queryModels(query);
      break;

    case 'set':
      const modelQuery = args.slice(1).join(' ');
      if (!modelQuery) {
        console.error('Please provide a model to set');
        process.exit(1);
      }

      // Check for level flags
      if (args.includes('--project')) {
        setModelAtLevel(modelQuery, args, 'project');
        return;
      }
      if (args.includes('--session')) {
        setModelAtLevel(modelQuery, args, 'session');
        return;
      }

      setModel(modelQuery, args);
      break;

    case 'project':
      // Show current project config
      showProjectConfig();
      break;

    case 'session':
      // Show current session config
      showSessionConfig();
      break;

    case 'import':
      importProviders();
      break;

    case 'status':
      showStatus();
      showModelInfo = false;
      break;

    case 'help':
      showModelInfo = false;
      console.log(`
CCR Model Management

Usage:
  ccr-model [command] [options]

Commands:
  list                List all available models
  query <text>        Search models by natural language
  set <model>         Set global model (all roles)
  set <model> --project     Set project-level model
  set <model> --session    Set session-level model
  set <model> --role=<role>  Set specific role only
  project             Show current project config
  session             Show current session config
  import              Import providers from cc-switch
  status              Show CCR installation and configuration status
  help                Show this help message

Config Levels (CCR priority order):
  1. Session:  ~/.claude-code-router/<project-id>/<sessionId>.json
  2. Project:  ~/.claude-code-router/<project-id>/config.json
  3. Global:   ~/.claude-code-router/config.json

Roles:
  default, think, longContext, webSearch, background, image

Examples:
  ccr-model list
  ccr-model query claude
  ccr-model set glm-5              # Set global (all roles)
  ccr-model set glm-5 --project    # Set for current project
  ccr-model set glm-5 --session    # Set for current session
  ccr-model set m2.5 --role=think  # Set only think role
  ccr-model project                # Show project config
  ccr-model session                # Show session config
  ccr-model import
  ccr-model status
      `);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "ccr-model help" for usage information');
      process.exit(1);
  }

  // Show current model info after each command (except help, status)
  if (showModelInfo) {
    showCurrentModel();
  }
}

main();
