param([string]$Destination, [string]$VcVars)
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Run in PowerShell 7 x64 on Windows.' }
$repo = Split-Path $PSScriptRoot -Parent
if (!$Destination) { $Destination = Join-Path $repo 'data/native-win' }
$Destination = [IO.Path]::GetFullPath($Destination)
if (!$VcVars) {
  $VcVars = Get-ChildItem "${env:ProgramFiles(x86)}/Microsoft Visual Studio/2022/*/VC/Auxiliary/Build/vcvars64.bat" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (!$VcVars -or !(Test-Path -LiteralPath $VcVars) -or $VcVars -match '["%\r\n]') { throw 'Provide the installed Visual Studio x64 compiler environment batch file.' }
# Read the compiler environment in memory; do not print inherited secrets.
$compilerEnv = @{}
& cmd /d /s /c "call `"$VcVars`" >nul && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $compilerEnv[$Matches[1]] = $Matches[2] }
}
if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize the compiler environment.' }
function Build-Tool([string]$Exe, [string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new($Exe)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WorkingDirectory = $Destination
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  foreach ($key in $compilerEnv.Keys) { $info.Environment[$key] = $compilerEnv[$key] }
  $process = [Diagnostics.Process]::Start($info)
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw 'Windows compatibility build failed.' }
}
& node "$PSScriptRoot/generate-windows-compat.mjs" $Destination
if ($LASTEXITCODE -ne 0) { throw 'Source generation failed.' }
$bin = Join-Path $compilerEnv['VCToolsInstallDir'] 'bin/Hostx64/x64'
Build-Tool (Join-Path $bin 'ml64.exe') @('/nologo','/c','forward.asm')
Build-Tool (Join-Path $bin 'cl.exe') @('/nologo','/LD','/O2','/MT','compat.c','forward.obj','/link','ole32.lib','user32.lib','/DEF:compat.def','/OUT:QQNT.dll')
Write-Output 'Experimental Windows compatibility library built. Login acceptance remains a separate check.'
