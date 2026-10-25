. (Join-Path $PSScriptRoot 'common.ps1')
$nodePath = Get-BridgeNode
& $nodePath --version
$config = Get-BridgeConfig
& $config.codexBin --version
& $config.codexBin login status
$env:BRIDGE_CODEX_BIN=$config.codexBin
Set-Location -LiteralPath $BridgeRoot
& $nodePath scripts\probe-codex.mjs
exit $LASTEXITCODE
