using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace QQBridge.Windows {
  // Children enter the job atomically during CreateProcess. Killing the host
  // closes the only job handle, including when no managed cleanup can run.
  public sealed class ProcessJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
      public long ProcessTime, JobTime;
      public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet;
      public uint ActiveProcesses;
      public UIntPtr Affinity;
      public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public Limits Basic;
      public Counters Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
      public uint Size;
      public IntPtr Reserved, Desktop, Title;
      public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
      public ushort Show, ReservedBytes;
      public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,IntPtr name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,UIntPtr bytes,IntPtr previous,IntPtr result);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr job;
    readonly Dictionary<uint,IntPtr> children = new Dictionary<uint,IntPtr>();

    public ProcessJob() {
      job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero);
      if(job==IntPtr.Zero) throw new Win32Exception();
      var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) { Dispose(); throw new Win32Exception(); }
    }
    static string Quote(string value) {
      if(value.IndexOf('\0')>=0) throw new ArgumentException("Invalid argument.");
      var text=new StringBuilder("\""); int slashes=0;
      foreach(char c in value) {
        if(c=='\\') { slashes++; continue; }
        if(c=='\"') { text.Append('\\',slashes*2+1); text.Append(c); }
        else { text.Append('\\',slashes); text.Append(c); }
        slashes=0;
      }
      text.Append('\\',slashes*2); text.Append('"'); return text.ToString();
    }
    public uint Start(string executable,string[] arguments,string directory,IDictionary<string,string> environment,string output,string error) {
      if(job==IntPtr.Zero || children.Count>=16) throw new InvalidOperationException("Process job is unavailable or full.");
      var command=new StringBuilder(Quote(executable));
      foreach(string argument in arguments) command.Append(' ').Append(Quote(argument));
      if(command.Length>=32767) throw new ArgumentException("Command line is too long.");
      var block=new StringBuilder();
      foreach(var entry in new SortedDictionary<string,string>(environment,StringComparer.OrdinalIgnoreCase)) {
        if(entry.Key.Length==0 || entry.Key.IndexOfAny(new char[]{'\0','='})>=0 || entry.Value.IndexOf('\0')>=0) throw new ArgumentException("Invalid environment.");
        block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
      }
      block.Append('\0');
      IntPtr env=Marshal.StringToHGlobalUni(block.ToString()), list=IntPtr.Zero, jobs=IntPtr.Zero, handles=IntPtr.Zero;
      IntPtr input=IntPtr.Zero, stdout=IntPtr.Zero, stderr=IntPtr.Zero;
      bool initialized=false;
      try {
        var security=new Security { Size=(uint)Marshal.SizeOf(typeof(Security)), Inherit=true };
        input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
        stdout=CreateFileW(output,4,3,ref security,4,0x80,IntPtr.Zero);
        stderr=CreateFileW(error,4,3,ref security,4,0x80,IntPtr.Zero);
        foreach(IntPtr file in new IntPtr[]{input,stdout,stderr}) if(file==new IntPtr(-1)) throw new Win32Exception();
        UIntPtr size=UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        list=Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
        if(!InitializeProcThreadAttributeList(list,2,0,ref size)) throw new Win32Exception();
        initialized=true;
        jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
        handles=Marshal.AllocHGlobal(IntPtr.Size*3);
        Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,stdout); Marshal.WriteIntPtr(handles,IntPtr.Size*2,stderr);
        if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero) ||
           !UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new UIntPtr((uint)IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
        var startup=new StartupEx(); startup.Basic.Size=(uint)Marshal.SizeOf(typeof(StartupEx)); startup.Attributes=list;
        startup.Basic.Flags=0x100; startup.Basic.Input=input; startup.Basic.Output=stdout; startup.Basic.Error=stderr;
        ProcessInfo child;
        if(!CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080400,env,directory,ref startup,out child)) throw new Win32Exception();
        CloseHandle(child.Thread); children.Add(child.Pid,child.Process); return child.Pid;
      } finally {
        if(initialized) DeleteProcThreadAttributeList(list);
        foreach(IntPtr pointer in new IntPtr[]{list,jobs,handles,env}) if(pointer!=IntPtr.Zero) Marshal.FreeHGlobal(pointer);
        foreach(IntPtr file in new IntPtr[]{input,stdout,stderr}) if(file!=IntPtr.Zero && file!=new IntPtr(-1)) CloseHandle(file);
      }
    }
    public uint? Poll(uint pid) {
      IntPtr process;
      if(!children.TryGetValue(pid,out process)) throw new ArgumentException("Unknown managed process.");
      if(WaitForSingleObject(process,0)==258) return null;
      uint code; if(!GetExitCodeProcess(process,out code)) throw new Win32Exception();
      CloseHandle(process); children.Remove(pid); return code;
    }
    public void Kill(uint pid) {
      IntPtr process;
      if(!children.TryGetValue(pid,out process)) throw new ArgumentException("Unknown managed process.");
      if(!TerminateProcess(process,1)) throw new Win32Exception();
    }
    public void Dispose() {
      if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
      foreach(IntPtr process in children.Values) CloseHandle(process);
      children.Clear();
    }
  }
}
