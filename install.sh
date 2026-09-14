#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() {
    printf '[phpulse] %s\n' "$1"
}

fail() {
    printf '[phpulse] Error: %s\n' "$1" >&2
    exit 1
}

find_editor_cli() {
    if [[ -n "${VSCODE_CLI:-}" ]]; then
        command -v "$VSCODE_CLI" >/dev/null 2>&1 || fail "VSCODE_CLI '$VSCODE_CLI' was not found."
        printf '%s' "$VSCODE_CLI"
        return
    fi

    local candidate
    for candidate in code code-insiders codium cursor; do
        if command -v "$candidate" >/dev/null 2>&1; then
            printf '%s' "$candidate"
            return
        fi
    done

    fail "No VS Code CLI found. Install the 'code' shell command or run with VSCODE_CLI=/path/to/cli."
}

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

EDITOR_CLI="$(find_editor_cli)"

log "Using editor CLI: $EDITOR_CLI"
log "Installing Node dependencies"
npm install

log "Running TypeScript checks"
npm run lint

log "Building and packaging extension"
npm run package

EXTENSION_VERSION="$(node -p "require('./package.json').version")"
VSIX_PATH="$SCRIPT_DIR/phpulse-vscode-$EXTENSION_VERSION.vsix"
[[ -f "$VSIX_PATH" ]] || fail "Packaging completed without producing $VSIX_PATH."

log "Installing $(basename "$VSIX_PATH")"
"$EDITOR_CLI" --install-extension "$VSIX_PATH" --force

log "Installation complete. Reload the VS Code window to activate the new build."
