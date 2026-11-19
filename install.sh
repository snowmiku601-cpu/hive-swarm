#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_JSON="$REPO_ROOT/.agents/plugins/marketplace.json"
PLUGIN_JSON="$REPO_ROOT/.codex-plugin/plugin.json"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
RUN_TESTS=0

for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: ./install.sh [--test]" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 22.5 (with node:sqlite) is required and must be on PATH." >&2
  exit 1
fi

if ! node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "Found $(node -v), but node:sqlite is missing. Upgrade to Node.js 22.5+ or 24+." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI ('codex') was not found on PATH." >&2
  exit 1
fi

VERSION="$(node -e "import {readFileSync} from 'node:fs'; console.log(JSON.parse(readFileSync(process.argv[1],'utf8')).version)" "$PLUGIN_JSON")"

if [ "$RUN_TESTS" -eq 1 ]; then
  echo "Running Hive Swarm v$VERSION test suite..."
  node --test "$REPO_ROOT"/*.test.mjs
fi

echo "Installing hive-swarm@hive-swarm v$VERSION into $CODEX_HOME..."
node --input-type=module - "$REPO_ROOT" "$MARKETPLACE_JSON" "$CODEX_HOME" <<'EOF'
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [repoRoot, marketplaceJson, codexHome] = process.argv.slice(2);
const child = spawn('codex', ['app-server'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let seq = 0;
const pending = new Map();
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const handler = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else handler.resolve(msg.result);
    }
  } catch {}
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  await rpc('initialize', { clientInfo: { name: 'hive_swarm_installer', version: '1.7.4' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
  const added = await rpc('marketplace/add', { source: repoRoot });
  const installed = await rpc('plugin/install', { marketplacePath: marketplaceJson, pluginName: 'hive-swarm' });
  console.log(JSON.stringify({ marketplace: added.marketplaceName, authPolicy: installed.authPolicy }));
} catch (error) {
  console.error(error.message);
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
EOF

rm -rf "$CODEX_HOME/plugins/cache/hive-swarm/hive-swarm/$VERSION/.git"
echo "Done! Open a new chat in Codex Desktop (or reload Codex) and run /swarm."
