param([string]$HostExecutable,[string]$NodeExecutable)
$ErrorActionPreference='Stop'
if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'Run PowerShell 7 x64 on Windows.' }
$repo=Split-Path $PSScriptRoot -Parent
$run=Join-Path $repo ('data/windows-host-tests/'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($run)>$null
if (!$HostExecutable) {
  & "$PSScriptRoot/build-windows-host.ps1" -Destination (Join-Path $run 'build')
  $HostExecutable=Join-Path $run 'build/qqbridge.exe'
}
$HostExecutable=(Resolve-Path -LiteralPath $HostExecutable).Path
if (!$NodeExecutable) { $NodeExecutable=(Get-Command node).Source }
$NodeExecutable=(Resolve-Path -LiteralPath $NodeExecutable).Path
$fixture=Join-Path $run 'fixture'
$profile=Join-Path $run 'profile with spaces'
[IO.Directory]::CreateDirectory((Join-Path $fixture 'src'))>$null
[IO.Directory]::CreateDirectory((Join-Path $run 'qq-app'))>$null
'{}'|Set-Content -LiteralPath (Join-Path $run 'qq-app/package.json') -Encoding utf8NoBOM
# These are transport/process fixtures only. No QQ SDK, credentials or login is used.
@'
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const profile=process.env.QQBRIDGE_QQ_PROFILE;
for(const name of ['QQBRIDGE_PORT','QQBRIDGE_BRIDGE_PORT']) {
  net.createServer(socket=>socket.end()).listen(Number(process.env[name]),'127.0.0.1');
}
setInterval(()=>{if(fs.existsSync(path.join(profile,'stop-gateway')))process.exit(43);},50);
'@|Set-Content -LiteralPath (Join-Path $fixture 'src/cli.mjs') -Encoding utf8NoBOM
@'
import fs from 'node:fs';
import path from 'node:path';
const file=path.join(process.env.QQBRIDGE_QQ_PROFILE,'native-starts');
let starts=0;try{starts=Number(fs.readFileSync(file,'utf8'));}catch{}
fs.writeFileSync(file,String(++starts));
if(starts===1)setTimeout(()=>process.exit(42),250);
else setInterval(()=>{},1000);
'@|Set-Content -LiteralPath (Join-Path $fixture 'src/runtime-cli.mjs') -Encoding utf8NoBOM
"import net from 'node:net'; net.createServer(socket=>socket.end()).listen(Number(process.env.QQBRIDGE_UI_PORT),'127.0.0.1');"|Set-Content -LiteralPath (Join-Path $fixture 'src/login-web.mjs') -Encoding utf8NoBOM
function FreePort {
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  try { $listener.Start(); return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
$ports=@();while($ports.Count -lt 3){$port=FreePort;if($port -notin $ports){$ports+= $port}}
$envFile=Join-Path $run 'fixture.env'
@("QQBRIDGE_ROOT=$fixture","QQBRIDGE_NODE_BINARY=$NodeExecutable","QQBRIDGE_QQ_APP=$(Join-Path $run 'qq-app')","QQBRIDGE_QQ_PROFILE=$profile",'QQBRIDGE_HOST=127.0.0.1','QQBRIDGE_BRIDGE_HOST=127.0.0.1',"QQBRIDGE_PORT=$($ports[0])","QQBRIDGE_BRIDGE_PORT=$($ports[1])","QQBRIDGE_UI_PORT=$($ports[2])")|Set-Content -LiteralPath $envFile -Encoding utf8NoBOM
function Launch { Start-Process -FilePath $HostExecutable -ArgumentList @('--env-file',('"'+$envFile+'"')) -WindowStyle Hidden -PassThru }
function WaitUntil([scriptblock]$Condition) {
  $until=[DateTime]::UtcNow.AddSeconds(15)
  do { if(&$Condition){return};Start-Sleep -Milliseconds 50 } while([DateTime]::UtcNow -lt $until)
  throw 'Host integration condition timed out.'
}
function State {
  try { Get-Content -LiteralPath (Join-Path $profile 'host-state.json') -Raw|ConvertFrom-Json } catch { return $null }
}
function Children($state) {
  @($state.gateway_pid,$state.runtime_pid,$state.web_pid)|ForEach-Object {
    $info=Get-CimInstance Win32_Process -Filter "ProcessId=$_"
    if($info.ExecutablePath -ne $NodeExecutable -or $info.ParentProcessId -ne $state.host_pid){throw 'Unexpected test child.'}
    Get-Process -Id $_ -ErrorAction Stop
  }
}
function AssertExited($processes) {
  foreach($process in $processes){if(!$process.WaitForExit(10000)){throw 'Test process did not exit.'}}
}
$hostProcess=$null
try {
  $hostProcess=Launch
  WaitUntil { (State).phase -eq 'recovering' }
  WaitUntil { (Get-Content -LiteralPath (Join-Path $profile 'native-starts') -ErrorAction SilentlyContinue) -eq '2' }
  $state=State;$children=@(Children $state)
  foreach($process in @($hostProcess)+$children){if($process.MainWindowHandle -ne 0){throw 'Unexpected test window.'}}
  $duplicate=Launch
  if(!$duplicate.WaitForExit(5000) -or $duplicate.ExitCode -ne 78){throw 'Duplicate profile was not rejected.'}
  if($hostProcess.HasExited -or @($children|Where-Object HasExited).Count){throw 'Duplicate launch disturbed the owner.'}
  # The process object is the exact GUI host launched by this test.
  $hostProcess.Kill();AssertExited (@($hostProcess)+$children)
  foreach($port in $ports){$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port);$l.ExclusiveAddressUse=$true;try{$l.Start()}finally{$l.Stop()}}
  $previousHost=$state.host_pid
  $hostProcess=Launch
  WaitUntil { $current=State; $current -and $current.host_pid -ne $previousHost -and $current.phase -eq 'started' }
  $children=@(Children (State))
  'stop'|Set-Content -LiteralPath (Join-Path $profile 'stop-gateway')
  AssertExited (@($hostProcess)+$children)
  if($hostProcess.ExitCode -ne 78){throw 'Gateway failure did not fail the host.'}
  @{native_recovery=$true;duplicate_profile_rejected=$true;parent_exit_cleans_children=$true;ports_released=$true;gateway_failure_cleans_children=$true;no_main_windows=$true;real_qq_used=$false}|ConvertTo-Json -Compress
} finally {
  if($hostProcess -and !$hostProcess.HasExited){$hostProcess.Kill();$hostProcess.WaitForExit(5000)>$null}
}
