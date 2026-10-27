param(
    [string]$NodePath,
    [string]$NodeLicensePath,
    [string]$CodexPath,
    [string]$CodexLicensePath,
    [string]$OutputName,
    [switch]$UpdateExistingLauncher
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$release = Join-Path $workspace 'release'
$target = Join-Path $release '鲁滨逊'
if ($OutputName) {
    if ($OutputName -match '[\\/:*?"<>|\x00-\x1f]' -or $OutputName -match '[. ]$' -or $OutputName -in @('.', '..')) { throw 'OutputName must be one directory name.' }
    $target = Join-Path $release $OutputName
} elseif (Test-Path -LiteralPath $target) {
    # Preserve active services, user data and local edits in every previous package.
    $target = Join-Path $release ('鲁滨逊-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
}
if (Test-Path -LiteralPath $target) { throw "Output already exists; use a fresh OutputName: $target" }
$archive = Join-Path $release '鲁滨逊-Windows-x64.zip'
$stage = Join-Path $release ('.package-stage-' + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)

function Assert-ChildPath([string]$Candidate, [string]$Parent) {
    $resolved = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe package path: $resolved"
    }
    return $resolved
}
function Write-Utf8([string]$File, [string]$Text) {
    [IO.File]::WriteAllText($File, $Text, $utf8)
}
function Copy-PackageTree([string]$Source, [string]$Destination) {
    if ((Get-Item -LiteralPath $Source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Package input contains a link: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Package input contains a link: $($item.FullName)"
        }
        if ($item.Name -match '^(?:\.git|\.github|\.npmrc|\.env(?:\..*)?|node_modules|docs?|tests?|test-output|examples?|coverage|benchmarks?)$') { continue }
        if ($item.Name -ieq 'config.local.json') { throw "Local configuration found in package input: $($item.FullName)" }
        $destinationPath = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-PackageTree $item.FullName $destinationPath }
        elseif ($item.Extension -ne '.map') { Copy-Item -LiteralPath $item.FullName -Destination $destinationPath }
    }
}
function Assert-CleanPackage([string]$Directory) {
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -Force) {
        $relative = $file.FullName.Substring($Directory.Length).TrimStart('\').Replace('\', '/')
        if ($relative -match '(^|/)(?:\.git|\.env(?:\.[^/]+)?|secrets?|tokens?|config\.local\.json|test-output|tests?|docs)(/|$)' -or ($relative -match '(^|/)data(/|$)' -and $relative -notmatch '^app/node_modules/') -or
            $relative -match '\.(?:sqlite|db|log|pem|key)(?:-|$|\.)') {
            throw "Disallowed package entry: $relative"
        }
    }
}

if (-not $NodePath) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $NodePath = $command.Source }
    else { $NodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersion = (& $NodePath -p 'process.version').Trim()
$nodeArch = (& $NodePath -p 'process.arch').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArch -ne 'x64') { throw 'A working x64 Node.js runtime is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $workspace 'dist\src\app\main.js'))) { throw 'Build the application before packaging.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler was not found.' }
$metadata = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
$productionScript = @'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(Object.entries(lock.packages).filter(([name, value]) => name.startsWith("node_modules/") && value.dev !== true).map(([name, value]) => ({path: name, link: value.link === true}))));
'@
$productionJson = $productionScript | & $NodePath - (Join-Path $workspace 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read production dependency closure.' }
$production = $productionJson | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $release | Out-Null
if ((Get-Item -LiteralPath $release).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The release directory must not be a link.' }
New-Item -ItemType Directory -Path $stage | Out-Null
$stage = Assert-ChildPath $stage $release
try {
    $app = Join-Path $stage 'app'
    $runtime = Join-Path $stage 'runtime'
    $licenses = Join-Path $stage 'LICENSES'
    New-Item -ItemType Directory -Force -Path $app,$runtime,$licenses,(Join-Path $app 'dist'),(Join-Path $app 'scripts') | Out-Null
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $runtime 'node.exe')
    Copy-PackageTree (Join-Path $workspace 'dist\src') (Join-Path $app 'dist\src')
    Copy-PackageTree (Join-Path $workspace 'assets\fonts') (Join-Path $app 'assets\fonts')
    Copy-Item -LiteralPath (Join-Path $workspace 'assets\fonts\OFL.txt') -Destination (Join-Path $licenses 'NotoSansCJK-OFL.txt')
    if ($CodexPath) {
        $codexSource = Split-Path -Parent (Resolve-Path -LiteralPath $CodexPath).Path
        $codexTarget = Join-Path $runtime 'codex'
        New-Item -ItemType Directory -Path $codexTarget | Out-Null
        foreach ($binary in @('codex.exe','codex-code-mode-host.exe','codex-command-runner.exe','codex-windows-sandbox-setup.exe')) {
            Copy-Item -LiteralPath (Join-Path $codexSource $binary) -Destination $codexTarget
        }
        if (-not $CodexLicensePath) { throw 'Bundled Codex requires its official license file.' }
        Copy-Item -LiteralPath $CodexLicensePath -Destination (Join-Path $licenses 'Codex-LICENSE.txt')
        $codexVersion = (& $CodexPath --version).Trim()
        Write-Utf8 (Join-Path $runtime 'codex-provenance.json') (([ordered]@{version=$codexVersion;source='locally installed official OpenAI Codex binaries';sha256=(Get-FileHash -LiteralPath $CodexPath -Algorithm SHA256).Hash.ToLowerInvariant()}) | ConvertTo-Json)
    }
    foreach ($script in @('robinson.mjs', 'launch-config.mjs', 'package-self-test.mjs')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $app 'scripts')
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'config.example.json') -Destination $app
    $packageMetadata = [ordered]@{ name=$metadata.name; version=$metadata.version; private=$true; type='module'; engines=$metadata.engines; dependencies=$metadata.dependencies }
    Write-Utf8 (Join-Path $app 'package.json') ($packageMetadata | ConvertTo-Json -Depth 10)
    $packageNames = @()
    foreach ($entry in @($production)) {
        if ($entry.path -match '(^|/)\.\.(/|$)' -or $entry.link -eq $true) { throw "Unsupported package location: $($entry.path)" }
        $source = Assert-ChildPath (Join-Path $workspace $entry.path) (Join-Path $workspace 'node_modules')
        $destination = Assert-ChildPath (Join-Path $app $entry.path) (Join-Path $app 'node_modules')
        Copy-PackageTree $source $destination
        $packageNames += $entry.path.Substring('node_modules/'.Length)
        foreach ($license in Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)' }) {
            $licenseName = $entry.path.Substring('node_modules/'.Length).Replace('/', '__') + '__' + $license.Name
            Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $licenses $licenseName)
        }
    }
    $nodeLicense = Join-Path $licenses 'Node.js-LICENSE.txt'
    if (-not $NodeLicensePath) {
        $NodeLicensePath = Join-Path $release "Node-$nodeVersion-LICENSE.txt"
        if (-not (Test-Path -LiteralPath $NodeLicensePath)) {
            $licenseUrl = "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE"
            Invoke-WebRequest -UseBasicParsing -Uri $licenseUrl -OutFile $NodeLicensePath
        }
    }
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $NodeLicensePath).Path -Destination $nodeLicense
    if ((Get-Item -LiteralPath $nodeLicense).Length -lt 1000) { throw 'Node.js license text is missing or incomplete.' }
    Write-Utf8 (Join-Path $licenses 'README.txt') "Node.js $nodeVersion is copied from the installed local runtime. Its full license and dependency notices are included in Node.js-LICENSE.txt.`r`nProduction package licenses are copied from their installed distributions.`r`n"
    $launcher = Join-Path $stage '鲁滨逊.exe'
    $sourceIcon = Join-Path $workspace 'src\ui\icon.svg'
    $sourceIconHash = (Get-FileHash -LiteralPath $sourceIcon -Algorithm SHA256).Hash.ToLowerInvariant()
    $iconBuilder = Join-Path $release ('.icon-builder-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $icon = Join-Path $stage 'robinson.ico'
    $preview = Join-Path $release ('.icon-preview-' + [Guid]::NewGuid().ToString('N') + '.png')
    try {
        & $compiler /nologo /target:exe /platform:x64 /optimize+ /codepage:65001 /reference:System.Drawing.dll /reference:System.Xml.dll "/out:$iconBuilder" (Join-Path $workspace 'packaging\BuildIcon.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Original SVG icon converter compilation failed; existing EXE has not been touched.' }
        & $iconBuilder $sourceIcon $icon $preview
        if ($LASTEXITCODE -ne 0) { throw 'Original SVG icon conversion failed.' }
    } finally {
        if (Test-Path -LiteralPath $iconBuilder) { Remove-Item -LiteralPath (Assert-ChildPath $iconBuilder $release) -Force }
    }
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32icon:$icon" "/out:$launcher" (Join-Path $workspace 'packaging\Launcher.cs')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw 'Launcher compilation failed.' }
    & $NodePath (Join-Path $PSScriptRoot 'verify-exe-icon.mjs') $launcher $icon
    if ($LASTEXITCODE -ne 0) { throw 'EXE icon resource verification failed.' }
    $manifest = [ordered]@{ format='robinson-portable-v1'; version=$metadata.version; node=$nodeVersion; packages=$packageNames; createdUtc=[DateTime]::UtcNow.ToString('o'); icon=[ordered]@{ source='src/ui/icon.svg'; sourceSha256=$sourceIconHash; icoSha256=(Get-FileHash -LiteralPath $icon -Algorithm SHA256).Hash.ToLowerInvariant(); sizes=@(16,20,24,32,40,48,64,128,256) } }
    Write-Utf8 (Join-Path $stage '.package-manifest.json') ($manifest | ConvertTo-Json -Depth 5)
    Assert-CleanPackage $stage
    $report = Join-Path $release ('.self-test-' + [Guid]::NewGuid().ToString('N') + '.json')
    $test = Start-Process -FilePath $launcher -ArgumentList @('--self-test', ('"' + $report + '"')) -WindowStyle Hidden -PassThru -Wait
    if ($test.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $report)) { throw "Packaged runtime self-test failed; inspect $report" }
    $testResult = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if (-not $testResult.ok) { throw "Packaged runtime self-test failed; inspect $report" }
    $target = Assert-ChildPath $target $release
    if (Test-Path -LiteralPath $target) { throw "Output appeared during packaging; not replacing it: $target" }
    Move-Item -LiteralPath $stage -Destination $target
    $archiveStage = Join-Path $release ('.archive-' + [Guid]::NewGuid().ToString('N') + '.zip')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($target, $archiveStage, [IO.Compression.CompressionLevel]::Optimal, $true)
    $zip = [IO.Compression.ZipFile]::OpenRead($archiveStage)
    try {
        foreach ($item in $zip.Entries) {
            if ($item.FullName -match '(^|/)(?:\.git|\.env(?:\.[^/]+)?|secrets?|tokens?|config\.local\.json|test-output|tests?|docs)(/|$)' -or ($item.FullName -match '(^|/)data(/|$)' -and $item.FullName -notmatch '/app/node_modules/')) { throw "Disallowed ZIP entry: $($item.FullName)" }
        }
    } finally { $zip.Dispose() }
    if (Test-Path -LiteralPath $archive) {
        $previousArchive = Assert-ChildPath (Join-Path $release ('鲁滨逊-Windows-x64.previous-' + [Guid]::NewGuid().ToString('N') + '.zip')) $release
        Move-Item -LiteralPath $archive -Destination $previousArchive
    }
    Move-Item -LiteralPath $archiveStage -Destination $archive
    if ($UpdateExistingLauncher) {
        & (Join-Path $PSScriptRoot 'update-launcher-icon.ps1') -PackageDirectory $target -ExistingDirectory (Join-Path $release '鲁滨逊') -NodePath $NodePath
    }
    Write-Output "Portable application: $target"
    Write-Output "Archive: $archive"
    Write-Output "Self-test report: $report"
} finally {
    if (Test-Path -LiteralPath $stage) {
        $stage = Assert-ChildPath $stage $release
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
