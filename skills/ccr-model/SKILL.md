---
name: ccr-model
description: Query and manage Claude Code Router (CCR) models. List all available models, search by natural language, and set the default model with fuzzy matching.
metadata:
  short-description: CCR model management - list, query, and set models
  examples:
    - ccr-model list
    - ccr-model query claude
    - ccr-model set opus
    - ccr-model status
    - ccr-model import
---

# CCR Model Management

Manage Claude Code Router models with natural language queries.

## Features

- **Auto-check**: Automatically checks CCR installation, daemon status, and provider configuration
- **Auto-start**: Starts CCR daemon if not running
- **Auto-import**: Import providers from cc-switch if not configured
- **Dynamic fuzzy matching**: Automatically generates aliases from configured models (no hardcoded mappings)

## Available Commands

### List All Models
```
ccr-model list
```
Shows all available models grouped by provider, current router configuration, and the active Claude model.

### Query Models
```
ccr-model query <natural language>
```
Search for models using natural language. Examples:
- `ccr-model query claude` - Find Claude models
- `ccr-model query sonnet` - Find Sonnet models
- `ccr-model query glm` - Find GLM provider models

### Set Model
```
ccr-model set <model name>
```
Set the default model with dynamic fuzzy matching. The system automatically generates aliases based on your configured models.

**How Dynamic Aliases Work:**

For a model named `glm-5`, these aliases are auto-generated:
- `glm5`, `g5` (abbreviation)

For `MiniMax-M2.5`:
- `minimaxm2.5`, `mm2.5`, `m2.5`, `min2.5`, `min25` (various forms)

For `claude-sonnet-4`:
- `claudesonnet4`, `cs4`, `sonnet4` (abbreviations)

**Examples:**
- `ccr-model set glm-5` - Set to glm-5
- `ccr-model set g5` - Also matches glm-5
- `ccr-model set m2.5` - Matches MiniMax-M2.5

### Import Providers
```
ccr-model import
```
Import providers from cc-switch database. Useful when setting up CCR for the first time.

### Check Status
```
ccr-model status
```
Show CCR installation status, daemon status, provider count, and cc-switch availability.

## Execution

```bash
node ~/.claude/skills/ccr-model/ccr-model.js [command] [options]
```

## Auto-Actions

The script automatically:
1. Checks if CCR is installed (prompts installation if not)
2. Checks if CCR daemon is running (starts it if not)
3. Validates provider configuration (suggests import from cc-switch if empty)

## Dynamic Features

### Model Alias Generation
Aliases are dynamically generated from model names in your CCR config:
- **No hardcoded mappings** - works with any provider
- **Automatic updates** - aliases change when you update providers
- **Smart abbreviations** - generates intuitive short forms

### Provider Detection
Transformers are detected dynamically based on API base URL patterns:
- OpenRouter URLs → `openrouter` transformer
- Anthropic URLs → `Anthropic` transformer
- Other URLs → `deepseek` transformer (default)

## Configuration Files

- CCR Config: `~/.claude-code-router/config.json`
- Claude Settings: `~/.claude/settings.json`
- CC-Switch DB: `~/.cc-switch/cc-switch.db`
