#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
RUN_AUTH=true
CONFIG_ARGS=()

usage() {
  cat <<'USAGE'
Usage:
  bash install-opencode.sh [options]

Options:
  --no-auth                       configure OpenCode only; skip API-key prompt
  --port <number>                 local proxy port (default: 48761)
  --opencode-config <path>        opencode.json path
  --opencode-plugin-mode <mode>   plugin-list or symlink
  --opencode-plugin-dir <path>    plugin dir for symlink mode
  -h, --help                      show this help

After install, restart OpenCode. The bundled plugin starts the proxy
automatically when OpenCode launches.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-auth)
      RUN_AUTH=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --port|--opencode-config|--opencode-plugin-mode|--opencode-plugin-dir)
      if [ "$#" -lt 2 ]; then
        echo "install-opencode.sh: missing value for $1" >&2
        exit 2
      fi
      CONFIG_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "install-opencode.sh: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "install-opencode.sh: node not found; install Node.js >= 20 first" >&2
  exit 1
fi

"$NODE_BIN" "$ROOT/proxy/bin/bailian-cache-proxy-configure.mjs" opencode \
  --repo-root "$ROOT" \
  "${CONFIG_ARGS[@]}"

echo "[ok] OpenCode cache proxy configured"
echo "[next] Restart OpenCode so it loads $ROOT/plugins"

if [ "$RUN_AUTH" = "true" ]; then
  "$NODE_BIN" "$ROOT/proxy/bin/opencode-cache-proxy-auth.mjs"
else
  echo "[skip] auth bootstrap skipped by --no-auth"
fi
