param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,63}$')][string]$BotId,
  [Parameter(Mandatory)][string]$EnvFile,
  [Parameter(Mandatory)][string]$KeyFile,
  [ValidateRange(1,65535)][int]$ApiPort = 5700
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$configFile = (Resolve-Path -LiteralPath $EnvFile).Path
$secretFile = (Resolve-Path -LiteralPath $KeyFile).Path
function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw 'Docker operation failed; account storage has been retained.' }
}
& docker info --format '{{.OSType}}' *> $null
if ($LASTEXITCODE -ne 0) {
  $desktop = @(
    "$env:LOCALAPPDATA/Programs/DockerDesktop/Docker Desktop.exe",
    "$env:ProgramFiles/Docker/Docker/Docker Desktop.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (!$desktop) { throw 'Docker Desktop installation was not found.' }
  Start-Process -FilePath $desktop -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Seconds 2
    & docker info --format '{{.OSType}}' *> $null
    if ($LASTEXITCODE -eq 0) { break }
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { throw 'Docker did not become ready.' }
}
$variables = @('QQBRIDGE_BOT_ID','QQBRIDGE_STORAGE_KEY_FILE','QQBRIDGE_API_PORT')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
  $env:QQBRIDGE_BOT_ID = $BotId
  $env:QQBRIDGE_STORAGE_KEY_FILE = $secretFile
  $env:QQBRIDGE_API_PORT = "$ApiPort"
  $compose = @('compose','--env-file',$configFile,'-p',"qqbridge-$BotId",'-f',"$repo/compose.storage.yaml")
  # Rebind the application only after the shared parent and encrypted mount exist.
  Invoke-Docker @compose stop qqbridge storage
  $start = [Diagnostics.ProcessStartInfo]::new('wsl.exe')
  foreach ($argument in @('-d','docker-desktop','-u','root','--','sh','-s','--',$BotId)) { $start.ArgumentList.Add($argument) }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $hostSetup = [Diagnostics.Process]::Start($start)
  $stdout = $hostSetup.StandardOutput.ReadToEndAsync()
  $stderr = $hostSetup.StandardError.ReadToEndAsync()
  $hostSetup.StandardInput.Write(([IO.File]::ReadAllText("$PSScriptRoot/prepare-storage-host.sh")).Replace("`r",''))
  $hostSetup.StandardInput.Close()
  $hostSetup.WaitForExit()
  if ($hostSetup.ExitCode -ne 0) { throw 'Unable to prepare the Docker Desktop shared mount. Existing data has been retained.' }
  Invoke-Docker @compose up -d --build --wait storage
  Invoke-Docker @compose up -d --build qqbridge
  Write-Output 'Encrypted QQBridge started. Check get_login_state for actual QQ login status.'
} finally {
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
}
