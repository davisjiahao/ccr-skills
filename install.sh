#!/bin/bash

# CCR Skills Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/xxx/ccr-skills/main/install.sh | bash
# Or: ./install.sh

set -e

SKILL_DIR="$HOME/.claude/skills/ccr-model"
SETTINGS_FILE="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════════════════════════════════════════════"
echo "           CCR Skills Installer"
echo "═══════════════════════════════════════════════════"
echo ""

# 1. Create skill directory
echo "📁 Creating skill directory..."
mkdir -p "$SKILL_DIR"

# 2. Copy skill files
echo "📋 Copying skill files..."
cp -r "$SCRIPT_DIR/skills/ccr-model/"* "$SKILL_DIR/"

# 3. Copy hooks to skill directory
echo "📋 Copying hooks..."
cp -r "$SCRIPT_DIR/hooks" "$SKILL_DIR/"

# 4. Update settings.json with hook and statusline configuration
echo "⚙️  Configuring hooks and statusline..."

# Check if settings.json exists
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "{}" > "$SETTINGS_FILE"
fi

# Use Node.js to merge hook + statusline config (more reliable than jq)
node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS_FILE';
const sessionStartHookPath = '$SKILL_DIR/hooks/session-start.js';
const statuslinePath = '$SKILL_DIR/hooks/statusline.js';

try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!settings.hooks) settings.hooks = {};

    // --- Remove legacy PostToolUse show-model.js hook ---
    if (settings.hooks.PostToolUse) {
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(h =>
            !(h.hooks && h.hooks.some(sub =>
                sub.command && sub.command.includes('show-model.js')
            ))
        );
        if (settings.hooks.PostToolUse.length === 0) {
            delete settings.hooks.PostToolUse;
        }
        console.log('✅ Legacy PostToolUse hook removed');
    }

    // --- SessionStart hook (session ID caching, fires once) ---
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

    const hookExists = settings.hooks.SessionStart.some(h =>
        h.hooks && h.hooks.some(sub =>
            sub.command && sub.command.includes('session-start.js')
        )
    );

    if (!hookExists) {
        settings.hooks.SessionStart.push({
            matcher: '',
            hooks: [{
                type: 'command',
                command: 'node ' + sessionStartHookPath
            }]
        });
        console.log('✅ SessionStart hook configured');
    } else {
        settings.hooks.SessionStart.forEach(h => {
            if (h.hooks) {
                h.hooks.forEach(sub => {
                    if (sub.command && sub.command.includes('session-start.js')) {
                        sub.command = 'node ' + sessionStartHookPath;
                    }
                });
            }
        });
        console.log('✅ SessionStart hook updated');
    }

    // --- StatusLine (model display) ---
    settings.statusLine = {
        type: 'command',
        command: 'node ' + statuslinePath
    };
    console.log('✅ StatusLine configured');

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
} catch (e) {
    console.error('❌ Error configuring settings:', e.message);
    process.exit(1);
}
"

echo ""
echo "═══════════════════════════════════════════════════"
echo "           Installation Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Installed to: $SKILL_DIR"
echo ""
echo "Available commands:"
echo "  /ccr-model list      - List all models"
echo "  /ccr-model set <name> - Set default model"
echo "  /ccr-model status    - Check CCR status"
echo ""
echo "Restart Claude Code to activate the skill."
