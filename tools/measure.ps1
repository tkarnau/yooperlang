# measure.ps1 - time and peak RSS for any process
#
# Uses GetProcessMemoryInfo (psapi.dll) via P/Invoke.
# The handle must be cached before WaitForExit() - that's why
# $proc.Handle is read first; it keeps the OS handle alive.
#
# Usage:
#   .\tests\measure.ps1 .\tests\bench_native.exe
#   .\tests\measure.ps1 node tests\bench_node.js

param([string]$Exe, [string[]]$Rest)

# Load psapi GetProcessMemoryInfo once per session
if (-not ([System.Management.Automation.PSTypeName]'WinProcMem').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinProcMem {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_MEMORY_COUNTERS {
        public uint    cb;
        public uint    PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool GetProcessMemoryInfo(
        IntPtr hProcess,
        ref PROCESS_MEMORY_COUNTERS ppsmemCounters,
        uint cb);

    public static long PeakWorkingSetBytes(IntPtr handle) {
        var mc = new PROCESS_MEMORY_COUNTERS();
        mc.cb = (uint)Marshal.SizeOf(mc);
        GetProcessMemoryInfo(handle, ref mc, mc.cb);
        return (long)mc.PeakWorkingSetSize;
    }
}
"@
}

# Resolve to a full path - try the filesystem first, then PATH
if (Test-Path $Exe) {
    $resolved = (Resolve-Path $Exe).Path
} else {
    $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error "Cannot find '$Exe' on disk or in PATH"; exit 1 }
    $resolved = $cmd.Source
}

$psi = [System.Diagnostics.ProcessStartInfo]::new($resolved)
$psi.Arguments        = $Rest -join ' '
$psi.UseShellExecute  = $false
$psi.WorkingDirectory = (Get-Location).Path

$proc = [System.Diagnostics.Process]::new()
$proc.StartInfo = $psi

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc.Start() | Out-Null
$handle = $proc.Handle      # cache handle now - WaitForExit may release it
$proc.WaitForExit()
$sw.Stop()

$peakBytes = [WinProcMem]::PeakWorkingSetBytes($handle)
$peakMB    = [math]::Round($peakBytes / 1MB, 2)

Write-Host ""
Write-Host "--- process stats ---"
Write-Host ("  time     : {0} ms"  -f $sw.ElapsedMilliseconds)
Write-Host ("  peak RSS : {0} MB"  -f $peakMB)
Write-Host ("  exit     : {0}"     -f $proc.ExitCode)
