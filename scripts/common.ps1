$ErrorActionPreference = 'Stop'
$BridgeRoot = Split-Path -Parent $PSScriptRoot
function Get-BridgeNode {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { return $nodeCommand.Source }
  $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $runtimeNode) { return $runtimeNode }
  throw 'Node.js 22.13+ is required. Install Node.js LTS from https://nodejs.org/'
}
function Get-BridgeConfig {
  $configFile = Join-Path $BridgeRoot 'config.local.json'
  if (Test-Path -LiteralPath $configFile) { return Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json }
  return Get-Content -LiteralPath (Join-Path $BridgeRoot 'config.example.json') -Raw | ConvertFrom-Json
}
function Get-BridgeDataDir {
  $bridgeConfig = Get-BridgeConfig
  if ($env:BRIDGE_DATA_DIR) { return [IO.Path]::GetFullPath($env:BRIDGE_DATA_DIR) }
  if ([IO.Path]::IsPathRooted($bridgeConfig.dataDir)) { return [IO.Path]::GetFullPath($bridgeConfig.dataDir) }
  return [IO.Path]::GetFullPath((Join-Path $BridgeRoot $bridgeConfig.dataDir))
}
