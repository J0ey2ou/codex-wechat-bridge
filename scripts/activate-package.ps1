param(
    [Parameter(Mandatory=$true)][string]$CandidateDirectory,
    [Parameter(Mandatory=$true)][string]$CurrentDirectory,
    [string]$DataDirectory,
    [int]$Port=3210
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$release=Join-Path $workspace 'release'
function PackagePath([string]$value) {
    $resolved=[IO.Path]::GetFullPath($value)
    if ((Split-Path -Parent $resolved) -ne $release) { throw 'Package must be an immediate child of the workspace release directory.' }
    if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package cannot be a link.' }
    return $resolved
}
$candidate=PackagePath $CandidateDirectory
$current=PackagePath $CurrentDirectory
if ($candidate -eq $current) { throw 'Candidate and current must differ.' }
if (-not $DataDirectory) { $DataDirectory=Join-Path $workspace 'data' }
$data=[IO.Path]::GetFullPath($DataDirectory)
if (-not $data.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'This update helper only writes data inside the workspace.' }
$build=Get-Content -LiteralPath (Join-Path $candidate 'app\dist\src\build-info.json') -Raw | ConvertFrom-Json
$base="http://127.0.0.1:$Port"
$boot=Invoke-RestMethod "$base/api/bootstrap"
if ($boot.name -ne ([string][char]0x9c81+[char]0x6ee8+[char]0x900a)) { throw 'Unexpected service on update port.' }
$headers=@{'X-Bridge-Token'=$boot.csrf}
$state=Invoke-RestMethod "$base/api/state" -Headers $headers
if (@($state.tasks | Where-Object {$_.status -notin @('COMPLETED','FAILED','INTERRUPTED')}).Count -gt 0 -or @($state.messageAnalysis | Where-Object {$_.status -in @('queued','running','dispatching')}).Count -gt 0 -or @($state.deliveries | Where-Object {$_.status -in @('pending','retry','sending')}).Count -gt 0) { throw 'Bridge has unfinished work or pending messages; update deferred.' }
$pidFile=Join-Path $data 'bridge.pid'
$bridgePid=[int](Get-Content -LiteralPath $pidFile -Raw)
$owner=Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid"
$entry=Join-Path $current 'app\dist\src\app\main.js'
if (-not $owner -or $owner.Name -ne 'node.exe' -or $owner.CommandLine -notlike ('*'+$entry+'*')) { throw 'PID does not belong to the selected installed package.' }
if ($boot.build) {
    Invoke-RestMethod "$base/api/runtime/stop" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
} else {
    # Old releases have no guarded stop endpoint. The idle snapshot above is mandatory.
    Set-Content -LiteralPath (Join-Path $data 'stop.request') -Value 'update' -Encoding ascii
}
for($i=0;$i -lt 30;$i++) {
    if (-not (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
}
if(Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) { throw 'Graceful stop did not finish; no process was killed and no package was moved.' }
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=Join-Path $release ('previous-'+$stamp+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
if ((Split-Path -Parent ([IO.Path]::GetFullPath($backup))) -ne $release -or (Test-Path -LiteralPath $backup)) { throw 'Unsafe backup path.' }
$db=Join-Path $data 'bridge.sqlite'
$snapshot=Join-Path $release ('bridge-before-update-'+$stamp+'.sqlite')
$backupCode='const {DatabaseSync,backup}=require("node:sqlite"); const db=new DatabaseSync(process.argv[1],{readOnly:true}); backup(db,process.argv[2]).then(()=>db.close()).catch(e=>{console.error(e.message);process.exitCode=1;db.close()});'
& (Join-Path $candidate 'runtime\node.exe') -e $backupCode $db $snapshot
if($LASTEXITCODE -ne 0) { throw 'Database snapshot failed; current package was retained.' }
# Absolute paths were checked to be separate immediate children of release.
Move-Item -LiteralPath $current -Destination $backup
Move-Item -LiteralPath $candidate -Destination $current
$launcher=Get-ChildItem -LiteralPath $current -Filter '*.exe' -File | Select-Object -First 1
if(-not $launcher) { throw 'Packaged launcher missing.' }
Write-Output ("Installed candidate build: "+$build.id+"; startup still requires live verification.")
Write-Output ("Application: "+$launcher.FullName)
Write-Output ("Previous package: "+$backup)
Write-Output ("Database snapshot: "+$snapshot)
# Keep the EXE under this foreground tool session for its entire lifetime.
# The EXE in turn supervises its Node child and non-detached Bridge service.
# This deliberately does not return while the application is running.
$hostProcess=Start-Process -FilePath $launcher.FullName -WindowStyle Hidden -Wait -PassThru
if ($hostProcess.ExitCode -ne 0) { throw 'The managed application exited with an error; previous package and database snapshot are preserved.' }
