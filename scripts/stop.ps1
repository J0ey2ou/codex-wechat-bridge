param([switch]$Mock)
. (Join-Path $PSScriptRoot 'common.ps1')
if ($Mock) { $env:BRIDGE_DATA_DIR=Join-Path $BridgeRoot 'data\mock' }
$dataPath = Get-BridgeDataDir
$pidFile = Join-Path $dataPath 'bridge.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'Bridge is not running.'; exit 0 }
$bridgePid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
$entryPath = Join-Path $BridgeRoot 'dist\src\app\main.js'
$portableEntryPath = Join-Path $BridgeRoot 'release\鲁滨逊\app\dist\src\app\main.js'
if (-not $process) { Write-Host 'No process owns the saved PID. The next startup will recover stale state.'; exit 0 }
if ($process.Name -ne 'node.exe' -or ($process.CommandLine -notlike ('*'+$entryPath+'*') -and $process.CommandLine -notlike ('*'+$portableEntryPath+'*'))) { throw 'PID does not belong to this Bridge. Refusing to stop another process.' }
Set-Content -LiteralPath (Join-Path $dataPath 'stop.request') -Value 'stop' -Encoding ascii
for ($attempt=0; $attempt -lt 20; $attempt++) {
  if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { Write-Host 'Bridge stopped. Running tasks will be rechecked as UNKNOWN on restart.'; exit 0 }
  Start-Sleep -Milliseconds 500
}
throw 'Graceful shutdown timed out. Inspect the Bridge and Codex processes locally; no unrelated process was killed.'
