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

function saveClaudeSettings(settings) {
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
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
    { pattern: 'byteDance', transformer: 'deepseek' },
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

/**
 * Normalize model name using dynamic aliases
 */
function normalizeModelName(name) {
  const { modelAliases } = getDynamicAliases();
  const lower = name.toLowerCase().replace(/[-_\s]/g, '');

  // Check dynamic aliases first
  if (modelAliases[lower]) {
    return modelAliases[lower];
  }
  if (modelAliases[name.toLowerCase()]) {
    return modelAliases[name.toLowerCase()];
  }

  return name;
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

function setModel(query, args) {
  const models = getAllModels();
  if (models.length === 0) {
    log('No models available.', 'error');
    console.log('Try: ccr-model import   to import from cc-switch');
    process.exit(1);
  }

  const matches = fuzzyMatch(models, query);

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

  // Parse options
  const isSession = args.includes('--session') || args.includes('-s');
  const isTemp = args.includes('--temp') || args.includes('-t');

  if (isSession || isTemp) {
    // Session-level: set via environment variable (won't persist)
    console.log(`✅ Setting session model: ${fullModelName}`);
    console.log(`   Format: ${ccrFormat}`);
    console.log(`\nℹ️  Session model active! Will reset when Claude Code restarts.`);
    console.log(`   To use in current session, set in settings.json or restart Claude Code.`);

    // Also update CCR config as fallback
    const config = getCCRConfig();
    config.Router = config.Router || {};
    config.Router.default = ccrFormat;
    saveCCRConfig(config);

    const settings = getClaudeSettings();
    settings.model = fullModelName;
    saveClaudeSettings(settings);

    console.log(`\n✅ Model updated!`);
    return;
  }

  console.log(`✅ Setting model to: ${fullModelName}`);

  // Update CCR config router.default (preserve other router configs)
  const config = getCCRConfig();
  config.Router = config.Router || {};
  config.Router.default = ccrFormat;

  // Preserve existing role-specific configs if they exist
  const existingRouter = getCCRConfig()?.Router || {};
  if (existingRouter.think) config.Router.think = existingRouter.think;
  if (existingRouter.longContext) config.Router.longContext = existingRouter.longContext;
  if (existingRouter.longContextThreshold) config.Router.longContextThreshold = existingRouter.longContextThreshold;
  if (existingRouter.webSearch) config.Router.webSearch = existingRouter.webSearch;
  if (existingRouter.background) config.Router.background = existingRouter.background;
  if (existingRouter.image) config.Router.image = existingRouter.image;

  saveCCRConfig(config);

  // Also update Claude settings
  const settings = getClaudeSettings();
  settings.model = fullModelName;
  saveClaudeSettings(settings);

  console.log(`\n✅ Model updated successfully!`);
  console.log(`   Router default: ${ccrFormat}`);
  console.log(`   Claude settings model: ${fullModelName}`);
  console.log(`\nℹ️  CCR 立即生效，无需重启 daemon`);
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

  // Current model
  const settings = getClaudeSettings();
  console.log(`  Current Model:     ${settings.model || 'default'}`);

  console.log('');

  // Suggest actions
  if (!daemonRunning) {
    console.log('💡 Run: ccr start    to start the daemon');
  }
  if (providerCount === 0 && hasCCSwitch) {
    console.log('💡 Run: ccr-model import    to import providers from cc-switch');
  }
}

// ============ Show Current Model ============

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
  const settings = getClaudeSettings();
  const config = getCCRConfig();
  const currentModel = settings.model;

  if (!currentModel) return;

  // Try to find provider info
  let providerInfo = null;
  for (const provider of (config?.Providers || [])) {
    for (const model of (provider.models || [])) {
      const fullName = `${provider.name}/${model}`;
      if (fullName === currentModel || model === currentModel || provider.name === currentModel) {
        providerInfo = { name: provider.name, model: model };
        break;
      }
    }
    if (providerInfo) break;
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('              Current Model');
  console.log('═══════════════════════════════════════════════════\n');

  if (providerInfo) {
    console.log(`  Provider:  ${providerInfo.name}`);
    console.log(`  Model:     ${providerInfo.model}`);
  } else {
    console.log(`  Model:     ${currentModel}`);
  }

  // Show roles (model can have multiple roles)
  const router = config?.Router || {};
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
      setModel(modelQuery, args);
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
  set <model>         Set the default model (supports fuzzy matching)
  set <model> --session  Set model for current session only
  import              Import providers from cc-switch
  status              Show CCR installation and configuration status
  help                Show this help message

Examples:
  ccr-model list
  ccr-model query claude
  ccr-model set glm-5
  ccr-model set M2.5          # Matches MiniMax-M2.5
  ccr-model set min2.5        # Also matches MiniMax-M2.5
  ccr-model set opus --session  # Session-only (resets on restart)
  ccr-model import            # Import from cc-switch
  ccr-model status            # Check CCR status
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
