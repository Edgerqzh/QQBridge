param([Parameter(Mandatory)][string]$Destination,[string]$NodeExecutable,[string]$NodeLicense,[string]$VcVars)
$ErrorActionPreference='Stop'
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Build on Windows using PowerShell 7 x64.' }
$repo=Split-Path $PSScriptRoot -Parent
$Destination=[IO.Path]::GetFullPath($Destination)
if ((Test-Path -LiteralPath $Destination) -or (Test-Path -LiteralPath "$Destination.zip")) { throw 'Use a new destination. Existing builds and data are never replaced.' }
$build=Get-Content -LiteralPath (Join-Path $repo 'src/native/windows/build.json') -Raw | ConvertFrom-Json
if (!$NodeExecutable) { $NodeExecutable=(Get-Command node).Source }
$NodeExecutable=(Resolve-Path -LiteralPath $NodeExecutable).Path
if ((Get-FileHash -LiteralPath $NodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.node_sha256) { throw 'Node binary differs from the pinned official download.' }
$temporary=Join-Path $repo ('data/windows-build/'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary)>$null
if (!$NodeLicense) {
  $NodeLicense=Join-Path $temporary 'node-LICENSE.txt'
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/v$($build.node_version)/LICENSE" -OutFile $NodeLicense
}
if ((Get-FileHash -LiteralPath $NodeLicense -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.node_license_sha256) { throw 'Node license differs from the pinned source release.' }
& "$PSScriptRoot/build-windows-compat.ps1" -Destination (Join-Path $temporary 'native') -VcVars $VcVars
& "$PSScriptRoot/build-windows-host.ps1" -Destination (Join-Path $temporary 'host')
[IO.Directory]::CreateDirectory($Destination)>$null
foreach ($folder in @('src','scripts','docs')) { Copy-Item -LiteralPath (Join-Path $repo $folder) -Destination (Join-Path $Destination $folder) -Recurse }
foreach ($file in @('package.json','package-lock.json','README.md','LICENSE','.env.example')) { Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $Destination $file) }
foreach ($folder in @('runtime','native','licenses')) { [IO.Directory]::CreateDirectory((Join-Path $Destination $folder))>$null }
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $Destination 'runtime/node.exe')
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $Destination 'licenses/node-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $temporary 'native/QQNT.dll') -Destination (Join-Path $Destination 'native/QQNT.dll')
Copy-Item -LiteralPath (Join-Path $temporary 'host/qqbridge.exe') -Destination (Join-Path $Destination 'qqbridge.exe')
& npm ci --prefix $Destination --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Windows production dependency installation failed.' }
$files=@(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
  @{path=[IO.Path]::GetRelativePath($Destination,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$package=Get-Content -LiteralPath (Join-Path $Destination 'package.json') -Raw | ConvertFrom-Json
@{version=$package.version;platform='win32';architecture='x64';qualification='development-validation-in-progress';qq=$build;files=$files} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Destination 'build-manifest.json') -Encoding utf8
[IO.Compression.ZipFile]::CreateFromDirectory($Destination,"$Destination.zip",[IO.Compression.CompressionLevel]::Optimal,$true)
@{archive="$Destination.zip";sha256=(Get-FileHash -LiteralPath "$Destination.zip" -Algorithm SHA256).Hash.ToLowerInvariant();files=$files.Count} | ConvertTo-Json -Compress
