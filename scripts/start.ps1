param([switch]$Foreground,[switch]$Mock)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location -LiteralPath $BridgeRoot
$nodePath = Get-BridgeNode
$entryPath = Join-Path $BridgeRoot 'dist\src\app\main.js'
if (-not (Test-Path -LiteralPath $entryPath)) { throw 'Build missing. Run scripts\install.ps1 first.' }
if ($Mock) { $env:BRIDGE_MOCK='1'; $env:BRIDGE_DATA_DIR=Join-Path $BridgeRoot 'data\mock' }
$dataPath = Get-BridgeDataDir
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
$stopRequest = Join-Path $dataPath 'stop.request'
if (Test-Path -LiteralPath $stopRequest) { Remove-Item -LiteralPath $stopRequest }
if ($Foreground) { & $nodePath $entryPath; exit $LASTEXITCODE }
$process = Start-Process -FilePath $nodePath -ArgumentList @('"'+$entryPath+'"') -WorkingDirectory $BridgeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'service.stdout.log') -RedirectStandardError (Join-Path $dataPath 'service.stderr.log') -PassThru
Start-Sleep -Seconds 2
if ($process.HasExited) { throw 'Bridge exited during startup. Check data\service.stderr.log.' }
$bridgeConfig = Get-BridgeConfig
Write-Host "Bridge started (PID $($process.Id)): http://127.0.0.1:$($bridgeConfig.port)"
