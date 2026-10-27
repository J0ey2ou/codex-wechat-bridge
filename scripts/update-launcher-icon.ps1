param(
    [Parameter(Mandatory=$true)][string]$PackageDirectory,
    [Parameter(Mandatory=$true)][string]$ExistingDirectory,
    [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$release = Join-Path $workspace 'release'
$releasePrefix = $release.TrimEnd('\') + '\'
if ((Get-Item -LiteralPath $release).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release directory must not be a link.' }
foreach ($directory in @($PackageDirectory, $ExistingDirectory)) {
    $absolute = [IO.Path]::GetFullPath($directory)
    if (-not $absolute.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Launcher update must stay inside this workspace release directory.' }
    if ([IO.Path]::GetDirectoryName($absolute.TrimEnd('\')) -ine $release) { throw 'Package must be a direct child of the release directory.' }
    if ((Get-Item -LiteralPath $absolute).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package directory must not be a link.' }
}
$source = Join-Path $PackageDirectory '鲁滨逊.exe'
$current = Join-Path $ExistingDirectory '鲁滨逊.exe'
if ([IO.Path]::GetFullPath($source) -eq [IO.Path]::GetFullPath($current)) { throw 'Source and current launcher must be different files.' }
foreach ($relative in @('.package-manifest.json', '鲁滨逊.exe')) {
    foreach ($directory in @($PackageDirectory, $ExistingDirectory)) {
        if ((Get-Item -LiteralPath (Join-Path $directory $relative)).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Manifest and launcher must not be links.' }
    }
}
foreach ($relative in @('app', 'app\dist', 'app\dist\src', 'app\dist\src\ui', 'app\dist\src\ui\icon.svg')) {
    if ((Get-Item -LiteralPath (Join-Path $ExistingDirectory $relative)).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Window artwork path must not contain links.' }
}
$newManifest = Get-Content -LiteralPath (Join-Path $PackageDirectory '.package-manifest.json') -Raw | ConvertFrom-Json
$oldManifest = Get-Content -LiteralPath (Join-Path $ExistingDirectory '.package-manifest.json') -Raw | ConvertFrom-Json
if ($newManifest.format -ne 'robinson-portable-v1' -or $oldManifest.format -ne 'robinson-portable-v1' -or $newManifest.version -ne $oldManifest.version) { throw 'Icon-only replacement requires managed packages of the same application version.' }
$original = Join-Path $ExistingDirectory 'app\dist\src\ui\icon.svg'
if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant() -ne $newManifest.icon.sourceSha256) { throw 'The current window icon and new EXE icon have different source artwork.' }
foreach ($file in @($source, $current, $original)) {
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Launcher or artwork must not be a link.' }
}
$running = @(Get-Process -ErrorAction Stop | Where-Object { $_.Path -eq [IO.Path]::GetFullPath($current) })
if ($running.Count) { throw 'The current launcher is open. Leave its service and tasks alone; close only its app window before replacing the launcher.' }
& $NodePath (Join-Path $PSScriptRoot 'verify-exe-icon.mjs') $source (Join-Path $PackageDirectory 'robinson.ico')
if ($LASTEXITCODE -ne 0) { throw 'New launcher icon could not be verified.' }
$pending = Join-Path $ExistingDirectory ('.launcher-' + [Guid]::NewGuid().ToString('N') + '.new')
$backup = Join-Path $ExistingDirectory ('鲁滨逊.before-icon-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    Copy-Item -LiteralPath $source -Destination $pending
    [IO.File]::Replace($pending, $current, $backup)
    & $NodePath (Join-Path $PSScriptRoot 'verify-exe-icon.mjs') $current (Join-Path $PackageDirectory 'robinson.ico')
    if ($LASTEXITCODE -ne 0) { throw "Updated EXE verification failed. Original launcher is preserved at $backup" }
    Write-Output "Updated launcher only: $current"
    Write-Output "Original launcher preserved: $backup"
    Write-Output 'Existing app files, runtime, user data and running service were not replaced or restarted.'
} finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
}
