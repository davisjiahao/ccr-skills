---
name: ccr-model
description: Query and manage Claude Code Router (CCR) models. List all available models, search by natural language, and set the default model with fuzzy matching. Supports global, project, and session-level configuration.
metadata:
  short-description: CCR model management - list, query, and set models
  examples:
    - ccr-model list
    - ccr-model query claude
    - ccr-model set opus
    - ccr-model set glm-5 --project
    - ccr-model set glm-5 --session
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
- **Multi-level config**: Supports global, project, and session-level model configuration

## Config Priority

CCR supports three levels of configuration (highest to lowest priority):

1. **Session**: `~/.claude-code-router/<project-id>/<sessionId>.json`
2. **Project**: `~/.claude-code-router/<project-id>/config.json`
3. **Global**: `~/.claude-code-router/config.json`

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

**Global (default):**
```
ccr-model set <model name>
```
Set the global default model.

**Project-level:**
```
ccr-model set <model name> --project
```
Set model for current project. Overrides global config.

**Session-level:**
```
ccr-model set <model name> --session
```
Set model for current session. Highest priority, overrides project and global config.

**Specific role:**
```
ccr-model set <model name> --role=<role>
```
Set only a specific role. Available roles: `default`, `think`, `longContext`, `webSearch`, `background`, `image`

**How Dynamic Aliases Work:**

For a model named `glm-5`, these aliases are auto-generated:
- `glm5`, `g5` (abbreviation)

For `MiniMax-M2.5`:
- `minimaxm2.5`, `mm2.5`, `m2.5`, `min2.5`, `min25` (various forms)

For `claude-sonnet-4`:
- `claudesonnet4`, `cs4`, `sonnet4` (abbreviations)

**Examples:**
- `ccr-model set glm-5` - Set globally
- `ccr-model set glm-5 --project` - Set for current project
- `ccr-model set g5 --session` - Set for current session (matches glm-5)
- `ccr-model set m2.5 --role=think` - Set only think role globally

### View Config

**Project config:**
```
ccr-model project
```
Show current project-level router configuration.

**Session config:**
```
ccr-model session
```
Show current session-level router configuration.

### Import Providers
```
ccr-model import
```
Import providers from cc-switch database. Useful when setting up CCR for the first time.

### Check Status
```
ccr-model status
```
Show CCR installation status, daemon status, provider count, current model, and config level indicator.

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

- CCR Global Config: `~/.claude-code-router/config.json`
- CCR Project Config: `~/.claude-code-router/<project-id>/config.json`
- CCR Session Config: `~/.claude-code-router/<project-id>/<sessionId>.json`
- Claude Settings: `~/.claude/settings.json`
- CC-Switch DB: `~/.cc-switch/cc-switch.db`
