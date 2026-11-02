param([string]$Destination)
$ErrorActionPreference='Stop'
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Run PowerShell 7 x64 on Windows.' }
$repo=Split-Path $PSScriptRoot -Parent
if (!$Destination) { $Destination=Join-Path $repo 'data/windows-host' }
[IO.Directory]::CreateDirectory($Destination)>$null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework compiler is unavailable on this build machine.' }
$output=Join-Path ([IO.Path]::GetFullPath($Destination)) 'qqbridge.exe'
$version=(Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version.' }
$assemblyVersion=($version -split '-')[0]+'.0'
$assembly=Join-Path ([IO.Path]::GetFullPath($Destination)) 'AssemblyInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("QQBridge Windows host")]
[assembly: AssemblyProduct("QQBridge")]
[assembly: AssemblyCompany("QQBridge")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content -LiteralPath $assembly -Encoding utf8
$jobSource=(Resolve-Path -LiteralPath (Join-Path $repo 'src/native/windows/process-job.cs')).Path
$hostSource=(Resolve-Path -LiteralPath (Join-Path $repo 'src/native/windows/host.cs')).Path
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" $jobSource $hostSource $assembly
if ($LASTEXITCODE -ne 0) { throw 'Windows host build failed.' }
Write-Output 'Windows host built. The launcher creates no console window.'
