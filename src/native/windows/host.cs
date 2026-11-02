using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Security.AccessControl;
using System.Security.Principal;

namespace QQBridge.Windows {
  // The executable has the Windows subsystem: no console or QQ window is created.
  public static class Host {
    static Dictionary<string,string> config;
    static string root, profile, node, logs;
    static ProcessJob job;
    static bool stopping;
    static string Value(string key,string fallback) {
      string value; return config.TryGetValue(key,out value)&&value.Length>0 ? value : fallback;
    }
    static void ReadConfiguration(string[] args) {
      config=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
        string key=(string)entry.Key;
        if(!key.StartsWith("=")) config[key]=(string)entry.Value;
      }
      if(args.Length!=0) {
        if(args.Length!=2 || args[0]!="--env-file") throw new ArgumentException("Use --env-file followed by a local configuration file.");
        foreach(string raw in File.ReadAllLines(args[1],Encoding.UTF8)) {
          string line=raw.Trim(); if(line.Length==0||line.StartsWith("#")) continue;
          int equal=line.IndexOf('='); if(equal<1) throw new ArgumentException("Invalid configuration line.");
          string key=line.Substring(0,equal).Trim(),value=line.Substring(equal+1).Trim();
          if(!Regex.IsMatch(key,"^[A-Z][A-Z0-9_]*$")) throw new ArgumentException("Invalid configuration key.");
          if(value.Length>=2 && ((value[0]=='"'&&value[value.Length-1]=='"')||(value[0]=='\''&&value[value.Length-1]=='\''))) value=value.Substring(1,value.Length-2);
          if(value.IndexOf('\0')>=0) throw new ArgumentException("Invalid configuration value.");
          config[key]=value;
        }
      }
      root=Path.GetFullPath(Value("QQBRIDGE_ROOT",AppDomain.CurrentDomain.BaseDirectory));
      node=Path.GetFullPath(Value("QQBRIDGE_NODE_BINARY",Path.Combine(root,"runtime","node.exe")));
      string selected=Value("QQBRIDGE_QQ_PROFILE","");
      if(!Path.IsPathRooted(selected)) throw new ArgumentException("Configure a dedicated absolute QQ profile.");
      profile=Path.GetFullPath(selected);
      if(profile.TrimEnd('\\','/')==Path.GetPathRoot(profile).TrimEnd('\\','/')) throw new ArgumentException("Do not use a drive root as a profile.");
      string app=Value("QQBRIDGE_QQ_APP","");
      if(!Path.IsPathRooted(app) || !File.Exists(Path.Combine(app,"package.json"))) throw new ArgumentException("Configure the extracted supported QQ app directory.");
      if(profile.Equals(Path.GetFullPath(app),StringComparison.OrdinalIgnoreCase)||profile.StartsWith(Path.GetFullPath(app).TrimEnd('\\','/')+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Keep account data outside the QQ application directory.");
      string host=Value("QQBRIDGE_HOST","127.0.0.1");
      if(host!="127.0.0.1") throw new ArgumentException("The Windows local host requires QQBRIDGE_HOST=127.0.0.1.");
      if(Value("QQBRIDGE_BRIDGE_HOST","127.0.0.1")!="127.0.0.1") throw new ArgumentException("The Windows local host requires QQBRIDGE_BRIDGE_HOST=127.0.0.1.");
      if(!File.Exists(node)||!File.Exists(Path.Combine(root,"src","runtime-cli.mjs"))) throw new FileNotFoundException("The Windows bridge runtime is incomplete.");
      Directory.CreateDirectory(profile);
      var permissions=new DirectorySecurity();
      permissions.SetAccessRuleProtection(true,false);
      var inheritance=InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit;
      permissions.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,inheritance,PropagationFlags.None,AccessControlType.Allow));
      permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),FileSystemRights.FullControl,inheritance,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(profile,permissions);
      logs=Path.Combine(profile,"logs"); Directory.CreateDirectory(logs);
      config["QQBRIDGE_DRIVER"]=Path.Combine(root,"src","native","windows-driver.mjs");
      config["QQBRIDGE_WINDOWS_COMPAT"]=Value("QQBRIDGE_WINDOWS_COMPAT",Path.Combine(root,"native","QQNT.dll"));
      config["QQBRIDGE_QQ_PROFILE"]=profile;
      config["QQBRIDGE_HOST"]="127.0.0.1";
      string system=Path.Combine(profile,"system");
      foreach(string folder in new string[]{"roaming","local","temp"}) Directory.CreateDirectory(Path.Combine(system,folder));
      config["APPDATA"]=Path.Combine(system,"roaming"); config["LOCALAPPDATA"]=Path.Combine(system,"local");
      config["TEMP"]=config["TMP"]=Path.Combine(system,"temp");
      // The official QQ version folder carries its non-system runtime DLLs.
      string qqRuntime=Path.GetFullPath(Path.Combine(app,"..",".."));
      config["PATH"]=Path.GetFullPath(app)+Path.PathSeparator+qqRuntime+Path.PathSeparator+Value("PATH","");
    }
    static uint Start(string name,string script,string[] args,Dictionary<string,string> environment) {
      var arguments=new List<string>(); arguments.Add(Path.Combine(root,script)); arguments.AddRange(args);
      return job.Start(node,arguments.ToArray(),root,environment,Path.Combine(logs,name+".stdout.log"),Path.Combine(logs,name+".stderr.log"));
    }
    static bool BridgeReady(int port) {
      try { using(var client=new TcpClient()) { return client.ConnectAsync("127.0.0.1",port).Wait(200)&&client.Connected; } }
      catch { return false; }
    }
    static int Port(string key,int fallback) {
      int value; if(!Int32.TryParse(Value(key,fallback.ToString()),out value)||value<1||value>65535) throw new ArgumentException("Invalid local port configuration.");
      return value;
    }
    static void RequireFreePort(int port) {
      var reservation=new TcpListener(IPAddress.Loopback,port);
      reservation.ExclusiveAddressUse=true;
      try { reservation.Start(); } finally { reservation.Stop(); }
    }
    static void State(uint gateway,uint runtime,uint web,string phase) {
      string json="{\"host_pid\":"+Process.GetCurrentProcess().Id+",\"gateway_pid\":"+gateway+",\"runtime_pid\":"+runtime+",\"web_pid\":"+web+",\"phase\":\""+phase+"\"}";
      File.WriteAllText(Path.Combine(profile,"host-state.json"),json,Encoding.UTF8);
    }
    static uint Native(bool manual) {
      var environment=new Dictionary<string,string>(config,StringComparer.OrdinalIgnoreCase);
      if(manual) { environment["QQBRIDGE_FORCE_QR"]="1"; environment["QQBRIDGE_LOGIN_UIN"]=""; environment["QQBRIDGE_RECOVERY_MANUAL"]="authentication_required"; }
      return Start("native","src/runtime-cli.mjs",new string[0],environment);
    }
    [STAThread] public static int Main(string[] args) {
      try {
        ReadConfiguration(args);
        using(var ownership=new FileStream(Path.Combine(profile,".runtime.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
        using(job=new ProcessJob()) {
          Console.CancelKeyPress+=(sender,e)=>{e.Cancel=true;stopping=true;};
          int bridgePort=Port("QQBRIDGE_BRIDGE_PORT",5711);
          int apiPort=Port("QQBRIDGE_PORT",5700);
          if(apiPort==bridgePort) throw new ArgumentException("API and internal bridge ports must differ.");
          RequireFreePort(apiPort);RequireFreePort(bridgePort);
          if(Value("QQBRIDGE_UI_PORT","")!="" || Value("QQBRIDGE_ENABLE_LOGIN_WEB","0")=="1") {
            int webPort=Port("QQBRIDGE_UI_PORT",5702);
            if(webPort==apiPort||webPort==bridgePort) throw new ArgumentException("Login website port must differ from the API and internal bridge ports.");
            RequireFreePort(webPort);
          }
          uint gateway=Start("gateway","src/cli.mjs",new string[]{"start"},config),runtime=0,web=0;
          DateTime deadline=DateTime.UtcNow.AddSeconds(10);
          while(!BridgeReady(bridgePort)) {
            if(job.Poll(gateway).HasValue||DateTime.UtcNow>deadline) throw new InvalidOperationException("Gateway did not become ready.");
            Thread.Sleep(100);
          }
          runtime=Native(false);
          if(Value("QQBRIDGE_UI_PORT","")!="" || Value("QQBRIDGE_ENABLE_LOGIN_WEB","0")=="1") web=Start("web","src/login-web.mjs",new string[0],config);
          State(gateway,runtime,web,"started");
          bool manual=false;
          var attempts=new Queue<DateTime>();
          while(!stopping) {
            if(job.Poll(gateway).HasValue || (web!=0 && job.Poll(web).HasValue)) throw new InvalidOperationException("A local service stopped.");
            if(runtime!=0) {
              uint? exit=job.Poll(runtime);
              if(exit.HasValue) {
                runtime=0;
                if(manual) { State(gateway,0,web,"native_stopped"); }
                else {
                  DateTime now=DateTime.UtcNow;
                  while(attempts.Count>0&&(now-attempts.Peek()).TotalMinutes>=10) attempts.Dequeue();
                  manual=exit.Value==76||attempts.Count>=6;
                  if(!manual) { int delay=Math.Min(30000,1000*(1<<attempts.Count));attempts.Enqueue(now);Thread.Sleep(delay); }
                  runtime=Native(manual);State(gateway,runtime,web,manual?"manual_login":"recovering");
                }
              }
            }
            Thread.Sleep(100);
          }
        }
        return 0;
      } catch(Exception error) {
        // Configuration contents and tokens never enter the error text.
        if(logs!=null) try { File.AppendAllText(Path.Combine(logs,"host.error.log"),error.GetType().Name+": "+error.Message+Environment.NewLine); } catch {}
        return 78;
      }
    }
  }
}
