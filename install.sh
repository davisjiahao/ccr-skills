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

# 3. Update settings.json with hook configuration
echo "⚙️  Configuring hooks..."

# Check if settings.json exists
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "{}" > "$SETTINGS_FILE"
fi

# Use Node.js to merge hook config (more reliable than jq)
node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS_FILE';
const hookPath = '$SKILL_DIR/hooks/show-model.js';

try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Initialize hooks if not exists
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

    // Check if hook already exists
    const hookExists = settings.hooks.PostToolUse.some(h =>
        h.hooks && h.hooks.some(sub =>
            sub.command && sub.command.includes('show-model.js')
        )
    );

    if (!hookExists) {
        settings.hooks.PostToolUse.push({
            matcher: '',
            hooks: [{
                type: 'command',
                command: 'node ' + hookPath
            }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('✅ Hook configured successfully');
    } else {
        console.log('ℹ️  Hook already configured, updating path...');

        // Update existing hook path
        settings.hooks.PostToolUse.forEach(h => {
            if (h.hooks) {
                h.hooks.forEach(sub => {
                    if (sub.command && sub.command.includes('show-model.js')) {
                        sub.command = 'node ' + hookPath;
                    }
                });
            }
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('✅ Hook path updated');
    }
} catch (e) {
    console.error('❌ Error configuring hooks:', e.message);
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
