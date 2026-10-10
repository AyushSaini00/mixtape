#!/usr/bin/env bash
# Installs mixtape and starts its background recorder.
#
#   curl -fsSL https://raw.githubusercontent.com/AyushSaini00/mixtape/main/install.sh | bash
#
# Set MIXTAPE_VERSION (e.g. 0.1.0) to install a specific release instead of
# the latest one.
set -euo pipefail

REPO="AyushSaini00/mixtape"
if [[ -n "${MIXTAPE_VERSION:-}" ]]; then
  PACKAGE_URL="https://github.com/${REPO}/releases/download/v${MIXTAPE_VERSION#v}/mixtape.tgz"
else
  PACKAGE_URL="https://github.com/${REPO}/releases/latest/download/mixtape.tgz"
fi

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "mixtape only runs on macOS."
command -v brew >/dev/null 2>&1 || fail "Homebrew is required. Install it from https://brew.sh and re-run."

if brew list --formula media-control >/dev/null 2>&1; then
  say "media-control is already installed"
else
  say "Installing media-control (reads macOS Now Playing)"
  brew install media-control
fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

if node_ok; then
  say "Using Node $(node --version) at $(command -v node)"
else
  say "Installing Node (mixtape needs 22.13 or newer)"
  brew install node
  hash -r
  node_ok || fail "Node 22.13+ still isn't first on your PATH. Fix that and re-run."
fi

say "Installing mixtape from ${PACKAGE_URL}"
npm install --global --no-audit --no-fund "$PACKAGE_URL"

MIXTAPE="$(npm prefix --global)/bin/mixtape"
[[ -x "$MIXTAPE" ]] || fail "mixtape wasn't installed where npm said it would be ($MIXTAPE)."

say "Starting the recorder (LaunchAgent, runs at every login)"
"$MIXTAPE" service install
sleep 2 # let the recorder start so status reports it

echo
"$MIXTAPE" status
echo
say "Done. Play something in the YouTube Music app, then run: mixtape"
