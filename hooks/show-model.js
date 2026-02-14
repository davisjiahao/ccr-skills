#!/usr/bin/env node

/**
 * Show current model info hook
 * Used by Claude Code hooks to display current model after each response
 */

const fs = require('fs');
const path = require('path');

const CCR_CONFIG_PATH = path.join(process.env.HOME, '.claude-code-router', 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');

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

// Helper to check if model matches
function modelMatches(modelStr, currentModel) {
  if (!modelStr || !currentModel) return false;
  if (modelStr === currentModel) return true;
  const parts = modelStr.split(/[/,]/);
  for (const part of parts) {
    if (part.trim() === currentModel) return true;
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

  // Show roles
  const router = config?.Router || {};
  const roles = [];
  if (modelMatches(router.think, currentModel)) roles.push('Think');
  if (modelMatches(router.longContext, currentModel)) roles.push('LongCtx');
  if (modelMatches(router.webSearch, currentModel)) roles.push('WebSearch');
  if (modelMatches(router.background, currentModel)) roles.push('Background');

  // Build output
  let output = '';
  if (providerInfo) {
    output = `${providerInfo.name}/${providerInfo.model}`;
  } else {
    output = currentModel;
  }

  if (roles.length > 0) {
    output += ` [${roles.join(', ')}]`;
  }

  // Output to stderr so it shows in the conversation
  console.error(`🤖 Model: ${output}`);
}

showCurrentModel();
