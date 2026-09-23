$ErrorActionPreference = 'Stop'
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    @{ available = $false; reason = 'not_windows' } | ConvertTo-Json -Compress
    exit 0
  }
  $browserId = 0
  $ownerId = 0
  if (-not [int]::TryParse($env:GSTACK_NATIVE_BROWSER_PID, [ref]$browserId) -or $browserId -le 0 -or
      -not [int]::TryParse($env:GSTACK_NATIVE_OWNER_PID, [ref]$ownerId) -or $ownerId -le 0) {
    throw 'invalid_pid'
  }
  $browser = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $browserId"
  $parentMatched = $browser -and $browser.ParentProcessId -eq $ownerId
  $imageMatched = $browser -and [string]::Equals($browser.ExecutablePath, $env:GSTACK_NATIVE_BROWSER_IMAGE, [StringComparison]::OrdinalIgnoreCase)
  if (-not $browser -or -not $parentMatched -or -not $imageMatched) {
    @{ available = $false; reason = 'owned_process_unavailable'; parentMatched = [bool]$parentMatched; imageMatched = [bool]$imageMatched } | ConvertTo-Json -Compress
    exit 0
  }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeCookieCommandLine {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint length, out uint returned);
}
'@
  function Get-TextHash([string]$Value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
  }
  $count = 0
  $memory = [NativeCookieCommandLine]::CommandLineToArgvW($browser.CommandLine, [ref]$count)
  if ($memory -eq [IntPtr]::Zero -or $count -lt 1) { throw 'argument_parse_failed' }
  $arguments = @()
  try {
    for ($index = 1; $index -lt $count; $index++) {
      $arguments += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $index * [IntPtr]::Size))
    }
  } finally {
    [void][NativeCookieCommandLine]::LocalFree($memory)
  }
  $limits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  $jobFlags = $null
  $jobQueryError = $null
  try {
    $returned = [uint32]0
    if ([NativeCookieCommandLine]::QueryInformationJobObject([IntPtr]::Zero, 9, $limits, 144, [ref]$returned)) {
      $jobFlags = [Runtime.InteropServices.Marshal]::ReadInt32($limits, 16)
    } else {
      $jobQueryError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($limits)
  }
  $dataArgs = @($arguments | Where-Object { $_.StartsWith('--user-data-dir=') })
  @{
    available = $true
    parentMatched = $true
    imageMatched = $true
    commandLineHash = Get-TextHash $browser.CommandLine
    argumentHashes = @($arguments | ForEach-Object { Get-TextHash $_ })
    userDataDirCount = $dataArgs.Count
    userDataDirHash = if ($dataArgs.Count -eq 1) { Get-TextHash ($dataArgs[0].Substring(16)) } else { $null }
    pipePresent = $arguments -contains '--remote-debugging-pipe'
    observerJobLimitFlags = $jobFlags
    observerJobQueryError = $jobQueryError
  } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ available = $false; reason = 'command_line_probe_failed'; errorType = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
  exit 1
}
