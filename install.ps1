param(
  [string]$NodePath,
  [string]$CodexPath,
  [switch]$RunTests
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path $PSScriptRoot).Path
$MarketplaceJson = Join-Path $RepoRoot '.agents\plugins\marketplace.json'
$PluginJson = Join-Path $RepoRoot '.codex-plugin\plugin.json'
$Version = (Get-Content $PluginJson -Raw | ConvertFrom-Json).version
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }

function Test-NodeSqlite([string]$Exe) {
  if (-not $Exe -or -not (Test-Path $Exe)) { return $false }
  & $Exe -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>$null
  return ($LASTEXITCODE -eq 0)
}

$PathNode = $null
$PathCmd = Get-Command node -ErrorAction SilentlyContinue
if ($PathCmd -and (Test-NodeSqlite $PathCmd.Source)) {
  $PathNode = $PathCmd.Source
}

$ResolvedNode = $null
$UsedPathNode = $false

if ($NodePath) {
  if (-not (Test-NodeSqlite $NodePath)) {
    throw "Specified Node binary does not support node:sqlite (Node >= 22.5 required): $NodePath"
  }
  $ResolvedNode = (Resolve-Path $NodePath).Path
} elseif ($PathNode) {
  $ResolvedNode = $PathNode
  $UsedPathNode = $true
} else {
  $Candidates = @()
  $Appx = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Appx -and $Appx.InstallLocation) {
    $Candidates += (Join-Path $Appx.InstallLocation 'app\resources\cua_node\bin\node.exe')
  }
  $Candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
  $RuntimesDir = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  if (Test-Path $RuntimesDir) {
    Get-ChildItem $RuntimesDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $Candidates += (Join-Path $_.FullName 'bin\node.exe')
    }
  }
  foreach ($Candidate in $Candidates) {
    if (Test-NodeSqlite $Candidate) {
      $ResolvedNode = $Candidate
      break
    }
  }
}

if (-not $ResolvedNode) {
  throw 'Could not find Node.js >= 22.5 (with node:sqlite). Install Node.js 22+ or 24+ and ensure `node` is on PATH, or pass -NodePath.'
}

if (-not $CodexPath) {
  $Appx = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Appx -and $Appx.InstallLocation) {
    $AppCodex = Join-Path $Appx.InstallLocation 'app\resources\codex.exe'
    if (Test-Path $AppCodex) { $CodexPath = $AppCodex }
  }
  if (-not $CodexPath) {
    $Cmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($Cmd) { $CodexPath = $Cmd.Source }
  }
}

if (-not $CodexPath -or -not (Test-Path $CodexPath)) {
  throw 'Could not find Codex (OpenAI.Codex app or `codex` on PATH). Install Codex Desktop/CLI first or pass -CodexPath.'
}

if ($RunTests) {
  Write-Host "Running Hive Swarm v$Version test suite..."
  $TestFiles = Get-ChildItem $RepoRoot -Filter '*.test.mjs' | ForEach-Object { $_.FullName }
  & $ResolvedNode --test @TestFiles
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$InstallerScript = @'
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [codexExe, repoRoot, marketplaceJson, codexHome] = process.argv.slice(2);
const env = { ...process.env, CODEX_HOME: codexHome };
for (const key of [
  'CODEX_WINDOWS_REGISTERED_CORE',
  'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
  'CODEX_WINDOWS_SANDBOX_PROXY_PORTS',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
]) {
  delete env[key];
}

const child = spawn(codexExe, ['app-server', '-c', 'features.prefer_mxc=false'], {
  env,
  windowsHide: true,
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
'@

Write-Host "Installing hive-swarm@hive-swarm v$Version into $CodexHome..."
$InstallerScript | & $ResolvedNode --input-type=module - $CodexPath $RepoRoot $MarketplaceJson $CodexHome
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$CacheRoot = Join-Path $CodexHome "plugins\cache\hive-swarm\hive-swarm\$Version"
$CachedGit = Join-Path $CacheRoot '.git'
if (Test-Path $CachedGit) {
  Remove-Item -Recurse -Force $CachedGit
}

if (-not $UsedPathNode) {
  $CachedMcp = Join-Path $CacheRoot '.mcp.json'
  if (Test-Path $CachedMcp) {
    $Mcp = Get-Content $CachedMcp -Raw | ConvertFrom-Json
    $Mcp.mcpServers.hive_swarm.command = ($ResolvedNode -replace '\\', '/')
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($CachedMcp, ($Mcp | ConvertTo-Json -Depth 10), $Utf8NoBom)
    Write-Host "Configured cached MCP server to use Node at: $ResolvedNode"
  }
}

Write-Host "Done! Open a new chat in Codex Desktop (or restart Codex Desktop) and run /swarm."
