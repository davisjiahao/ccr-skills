#!/usr/bin/env node

/**
 * SessionStart hook - cache session ID to temp file.
 *
 * Claude Code fires SessionStart once when a session begins,
 * sending { session_id, transcript_path, cwd, ... } via stdin.
 *
 * This hook persists session_id keyed by Claude Code's PID so that
 * skills (run via Bash tool) can walk the process tree to find it.
 *
 * NOTE: SessionStart hooks must NOT produce any output (stdout or stderr).
 * Any output causes Claude Code to report "startup hook error".
 * Model info is displayed by statusline.js instead.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_CACHE_DIR = path.join(os.tmpdir(), 'ccr-sessions');

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

// Main - no output allowed
const hookInput = readHookInput();
cacheSessionId(hookInput);
