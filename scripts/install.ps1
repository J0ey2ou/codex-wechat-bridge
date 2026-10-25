param([switch]$SkipTests)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location -LiteralPath $BridgeRoot
$nodePath = Get-BridgeNode
& $nodePath -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js >=22.13 is required.' }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmCli = Join-Path $BridgeRoot '.tools\npm\bin\npm-cli.js'
if (-not $npmCommand -and -not (Test-Path -LiteralPath $npmCli)) {
  $toolDir = Join-Path $BridgeRoot '.tools\npm'
  New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
  $archive = Join-Path $BridgeRoot '.tools\npm-bootstrap.tgz'
  Invoke-WebRequest -Uri 'https://registry.npmjs.org/npm/-/npm-11.6.2.tgz' -OutFile $archive -UseBasicParsing
  & tar.exe -xzf $archive -C $toolDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw 'npm bootstrap extraction failed.' }
}
if ($npmCommand) { & $npmCommand.Source ci --no-audit --no-fund } else { & $nodePath $npmCli ci --no-audit --no-fund --cache .tools\npm-cache }
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $nodePath node_modules\typescript\bin\tsc
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
& $nodePath scripts\copy-ui.mjs
if (-not $SkipTests) {
  & $nodePath node_modules\tsx\dist\cli.mjs --test tests/*.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
}
$configPath = Join-Path $BridgeRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  $initial = Get-BridgeConfig
  $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($codexCommand) { $initial.codexBin = $codexCommand.Source }
  else {
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $candidate = Get-ChildItem -LiteralPath $binRoot -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate) { $initial.codexBin = $candidate.FullName }
  }
  $initial | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
}
$dataPath = Get-BridgeDataDir
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $dataPath /inheritance:r /grant:r "*$($currentSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict data directory ACL.' }
Write-Host 'Installed. Run .\scripts\start.ps1, then open http://127.0.0.1:3210'
