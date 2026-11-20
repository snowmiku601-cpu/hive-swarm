param(
  [string]$NodePath,
  [string]$CodexPath,
  [switch]$RunTests
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path $PSScriptRoot).Path
$PluginJson = Join-Path $RepoRoot '.codex-plugin\plugin.json'
$Version = (Get-Content $PluginJson -Raw | ConvertFrom-Json).version
function Test-NodeSqlite([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
  # Windows PowerShell can turn native stderr into an error even with redirection.
  $ErrorActionPreference = 'Continue'
  & $Exe --disable-warning=ExperimentalWarning -e "const [major,minor]=process.versions.node.split('.').map(Number); if (!(major===22&&minor>=19||major===24&&minor>=2||major>24)) process.exit(1); import('node:sqlite').catch(()=>process.exit(1))" 2>$null
  return ($? -and $LASTEXITCODE -eq 0)
}

$PathNode = $null
if (-not $NodePath) {
  $PathCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($PathCmd -and (Test-NodeSqlite $PathCmd.Source)) {
    $PathNode = $PathCmd.Source
  }
}

$ResolvedNode = $null
if ($NodePath) {
  if (-not (Test-NodeSqlite $NodePath)) {
    throw "Specified Node binary does not support node:sqlite (Node >= 22.19 or 24.2+ required): $NodePath"
  }
  $ResolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
} elseif ($PathNode) {
  $ResolvedNode = $PathNode
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
  throw 'Could not find Node.js >= 22.19 or 24.2+ (with node:sqlite). Install Node.js 22+ or 24+ and ensure `node` is on PATH, or pass -NodePath.'
}

if ($RunTests) {
  Write-Host "Running Hive Swarm v$Version test suite..."
  $TestFiles = Get-ChildItem -LiteralPath $RepoRoot -Filter '*.test.mjs' | ForEach-Object { $_.FullName }
  & $ResolvedNode --test @TestFiles
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$PreviousCodex = $env:HIVE_SWARM_CODEX
try {
  if ($CodexPath) { $env:HIVE_SWARM_CODEX = (Resolve-Path -LiteralPath $CodexPath).Path }
  $InstallArgs = @('install', '--host', 'codex')
  if ($NodePath -or -not $PathNode) { $InstallArgs += '--bind-node' }
  & $ResolvedNode (Join-Path $RepoRoot 'cli.mjs') @InstallArgs
  $InstallExitCode = $LASTEXITCODE
} finally {
  $env:HIVE_SWARM_CODEX = $PreviousCodex
}
exit $InstallExitCode
