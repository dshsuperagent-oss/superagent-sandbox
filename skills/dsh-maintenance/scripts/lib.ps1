# lib.ps1 - funcoes comuns da skill dsh-maintenance.
# PowerShell 5.1, sem admin, sem dependencias externas.
# Mantido em ASCII puro de proposito: o PS 5.1 le .ps1 sem BOM como ANSI.

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Tempo / texto
# ---------------------------------------------------------------------------

function Get-IsoNow {
    return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
}

function Format-Day([datetime]$d) {
    return $d.ToString('yyyy-MM-dd')
}

function Format-Stamp([datetime]$d) {
    return $d.ToString('yyyyMMdd-HHmmss')
}

function Get-StableHash([string]$s) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $b = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s.ToLowerInvariant()))
        return (($b[0..3] | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $md5.Dispose()
    }
}

function Truncate-Text([string]$s, [int]$max) {
    if ($null -eq $s) { return $null }
    if ($s.Length -le $max) { return $s }
    return $s.Substring(0, $max) + '...'
}

# ---------------------------------------------------------------------------
# Processos: leitura de PPID + CommandLine sem admin (PEB) e fallback WMI.
#
# NtQueryInformationProcess + ReadProcessMemory leem o PEB do processo alvo:
#   PEB->ProcessParameters (offset 0x20 em x64)
#   RTL_USER_PROCESS_PARAMETERS->CommandLine (offset 0x70 em x64)
# Funciona para processos do mesmo usuario/integridade (inclui filhos do
# observador). Para processos de outra integridade o OpenProcess falha com
# acesso negado; nesse caso tentamos WMI (indisponivel em sandbox restrito).
# ---------------------------------------------------------------------------

if (-not ('PebReader' -as [type])) {
    $pebCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class PebReader {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int ret);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll")]
    private static extern bool IsWow64Process(IntPtr h, out bool wow64);

    public static bool IsWow64(int pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) { return false; }
        try {
            bool w;
            if (IsWow64Process(h, out w)) { return w; }
            return false;
        } finally { CloseHandle(h); }
    }

    public static string GetInfo(int pid, out int ppid, out string err) {
        ppid = 0;
        err = "";
        IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) {
            err = "OpenProcess:" + Marshal.GetLastWin32Error();
            return null;
        }
        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int rl;
            int st = NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl);
            if (st != 0) { err = "NtQueryInformationProcess:" + st; return null; }
            ppid = (int)pbi.InheritedFromUniqueProcessId.ToInt64();

            byte[] ptr = new byte[8];
            IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20), ptr, 8, out read)) {
                err = "PEB_ProcessParameters:" + Marshal.GetLastWin32Error();
                return null;
            }
            long pp = BitConverter.ToInt64(ptr, 0);
            if (pp == 0) { err = "ProcessParameters_nulo"; return null; }

            byte[] us = new byte[16];
            if (!ReadProcessMemory(h, (IntPtr)(pp + 0x70), us, 16, out read)) {
                err = "CommandLine_US:" + Marshal.GetLastWin32Error();
                return null;
            }
            ushort len = BitConverter.ToUInt16(us, 0);
            long buf = BitConverter.ToInt64(us, 8);
            if (len == 0 || len > 32767 || buf == 0) { err = "CommandLine_vazio"; return null; }

            byte[] str = new byte[len];
            if (!ReadProcessMemory(h, (IntPtr)buf, str, len, out read)) {
                err = "CommandLine_buf:" + Marshal.GetLastWin32Error();
                return null;
            }
            return System.Text.Encoding.Unicode.GetString(str).TrimEnd('\0');
        } finally {
            CloseHandle(h);
        }
    }
}

// Lista de processos sem alocar um objeto Process por processo: pares
// [pid, ppid, pid, ppid, ...] via NtQuerySystemInformation(SystemProcessInformation).
public class ProcSnap {
    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);

    public static int[] Get() {
        int len = 1 << 20;
        IntPtr buf = Marshal.AllocHGlobal(len);
        try {
            int ret = 0;
            int st;
            while ((st = NtQuerySystemInformation(5, buf, len, out ret)) == unchecked((int)0xC0000004)) {
                Marshal.FreeHGlobal(buf);
                len *= 2;
                buf = Marshal.AllocHGlobal(len);
            }
            if (st != 0) { return new int[0]; }
            List<int> list = new List<int>(1024);
            long off = 0;
            while (true) {
                IntPtr p = (IntPtr)(buf.ToInt64() + off);
                int next = Marshal.ReadInt32(p, 0);
                int pid = Marshal.ReadInt32(p, 80);
                int ppid = Marshal.ReadInt32(p, 88);
                list.Add(pid);
                list.Add(ppid);
                if (next == 0) { break; }
                off += next;
            }
            return list.ToArray();
        } finally {
            Marshal.FreeHGlobal(buf);
        }
    }

    [DllImport("psapi.dll")]
    private static extern bool EmptyWorkingSet(IntPtr h);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    // Reduz o working set do proprio observador (nao afeta o DSH).
    public static bool TrimWorkingSet() {
        try { return EmptyWorkingSet(GetCurrentProcess()); } catch { return false; }
    }
}
'@
    try {
        Add-Type -TypeDefinition $pebCode -Language CSharp -ErrorAction Stop
    } catch {
        # Sem compilador C#? O observador continua, mas sem CommandLine/PPID via PEB.
        $script:LibPebError = $_.Exception.Message
    }
}

function Get-PebInfo([int]$ProcId) {
    $out = [pscustomobject]@{ ok = $false; ppid = 0; cmdline = $null; error = $null; wow64 = $false }
    if ($ProcId -le 4) { $out.error = 'processo_de_sistema'; return $out }
    if (-not ('PebReader' -as [type])) { $out.error = 'peb_indisponivel'; return $out }
    try {
        if ([PebReader]::IsWow64($ProcId)) {
            $out.wow64 = $true
            $out.error = 'wow64'
            return $out
        }
        $ppid = 0
        $err = ''
        $cmd = [PebReader]::GetInfo($ProcId, [ref]$ppid, [ref]$err)
        if ($null -ne $cmd) {
            $out.ok = $true
            $out.ppid = $ppid
            $out.cmdline = $cmd
        } else {
            $out.ppid = $ppid
            $out.error = $err
        }
    } catch {
        $out.error = $_.Exception.Message
    }
    return $out
}

function Get-WmiProcessInfo([int]$ProcId) {
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop
        if ($null -ne $p) {
            return [pscustomobject]@{
                ok      = $true
                ppid    = [int]$p.ParentProcessId
                cmdline = [string]$p.CommandLine
                name    = [string]$p.Name
                error   = $null
            }
        }
    } catch { }
    return $null
}

# Melhor esforco: PEB (rapido, sem carregar modulos CIM). O fallback WMI existe
# como funcao separada, mas NAO e usado por padrao: carregar CimCmdlets custa
# ~30 MB de RAM e no sandbox do agente o WMI e negado de qualquer forma.
function Get-ProcessDetail([int]$ProcId, [string]$Name) {
    $peb = Get-PebInfo $ProcId
    if (-not $peb.ok -and $script:UseWmiFallback -eq $true) {
        $wmi = Get-WmiProcessInfo $ProcId
        if ($null -ne $wmi) {
            return [pscustomobject]@{
                pid     = $ProcId
                ppid    = $wmi.ppid
                name    = $(if ($Name) { $Name } else { $wmi.name })
                cmdline = $wmi.cmdline
                error   = $null
                fonte   = 'wmi'
            }
        }
    }
    $finalName = $Name
    if (-not $finalName) {
        try {
            $p = Get-Process -Id $ProcId -ErrorAction Stop
            try { $finalName = [string]$p.ProcessName } finally { $p.Dispose() }
        } catch { }
    }
    return [pscustomobject]@{
        pid     = $ProcId
        ppid    = $peb.ppid
        name    = $finalName
        cmdline = $peb.cmdline
        error   = $peb.error
        fonte   = 'peb'
    }
}

function Get-AncestorChain([int]$StartPpid, [int]$MaxDepth = 6, $PpidMap = $null) {
    $chain = New-Object System.Collections.ArrayList
    $cur = $StartPpid
    $visited = @{}
    $depth = 0
    while ($cur -gt 4 -and $depth -lt $MaxDepth -and -not $visited.ContainsKey($cur)) {
        $visited[$cur] = $true
        $detail = Get-ProcessDetail $cur $null
        $nextPpid = $detail.ppid
        if ($nextPpid -le 0 -and $null -ne $PpidMap -and $PpidMap.ContainsKey($cur)) {
            $nextPpid = [int]$PpidMap[$cur]
        }
        $null = $chain.Add([pscustomobject]@{
            pid     = $cur
            ppid    = $nextPpid
            name    = $detail.name
            cmdline = Truncate-Text $detail.cmdline 500
            error   = $detail.error
        })
        if ($nextPpid -le 0 -or $nextPpid -eq $cur) { break }
        $cur = $nextPpid
        $depth++
    }
    return $chain.ToArray()
}

function Get-ProcessIdPairs {
    try {
        if ('ProcSnap' -as [type]) { return [ProcSnap]::Get() }
    } catch { }
    return @()
}

# Coleta lixo e devolve as paginas frias ao sistema. Barato e raro (1x/min).
function Trim-ObserverMemory {
    try { [System.GC]::Collect() } catch { }
    try { [System.GC]::WaitForPendingFinalizers() } catch { }
    try { if ('ProcSnap' -as [type]) { [void][ProcSnap]::TrimWorkingSet() } } catch { }
}

function Get-ProcessNameMap {
    $map = @{}
    try {
        $procs = [System.Diagnostics.Process]::GetProcesses()
        foreach ($p in $procs) {
            try {
                $map[[int]$p.Id] = [string]$p.ProcessName
            } catch {
                $map[[int]$p.Id] = '?'
            } finally {
                try { $p.Dispose() } catch { }
            }
        }
    } catch { }
    return $map
}

function Test-ProcessAlive([int]$ProcId) {
    if ($ProcId -le 0) { return $false }
    try {
        $p = Get-Process -Id $ProcId -ErrorAction Stop
        $p.Dispose()
        return $true
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Porta 3080: netstat (Get-NetTCPConnection exige privilegio em alguns perfis)
# ---------------------------------------------------------------------------

function Get-PortInfo([int]$Port) {
    $res = [pscustomobject]@{
        listen    = $false
        owner_pid = 0
        states    = @{ LISTEN = 0; ESTABLISHED = 0; FIN_WAIT_2 = 0; CLOSE_WAIT = 0; TIME_WAIT = 0 }
    }
    $needle = ':' + $Port
    try {
        $lines = & netstat.exe -ano 2>$null
        foreach ($ln in $lines) {
            $t = [string]$ln
            if ($t.Length -lt 20) { continue }
            $f = $t.Trim() -split '\s+'
            if ($f.Count -lt 4) { continue }
            if ($f[0] -ne 'TCP') { continue }
            $local = $f[1]
            if (-not $local.EndsWith($needle)) { continue }
            $state = $f[3]
            if ($state -eq 'LISTENING') {
                $res.listen = $true
                try { $res.owner_pid = [int]$f[4] } catch { $res.owner_pid = 0 }
                $res.states['LISTEN'] = [int]$res.states['LISTEN'] + 1
            } elseif ($state -eq 'ESTABLISHED') {
                $res.states['ESTABLISHED'] = [int]$res.states['ESTABLISHED'] + 1
            } elseif ($state -eq 'FIN_WAIT_2') {
                $res.states['FIN_WAIT_2'] = [int]$res.states['FIN_WAIT_2'] + 1
            } elseif ($state -eq 'CLOSE_WAIT') {
                $res.states['CLOSE_WAIT'] = [int]$res.states['CLOSE_WAIT'] + 1
            } elseif ($state -eq 'TIME_WAIT') {
                $res.states['TIME_WAIT'] = [int]$res.states['TIME_WAIT'] + 1
            }
        }
    } catch { }
    return $res
}

# ---------------------------------------------------------------------------
# HTTP: curl.exe (mesma semantica usada pelo vigia 3080). Fallback .NET.
# ---------------------------------------------------------------------------

function Invoke-HttpProbe([int]$Port, [int]$TimeoutSec = 4) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $code = '000'
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -ne $curl) {
        try {
            $o = & curl.exe -s -o NUL -w '%{http_code}' --max-time $TimeoutSec ("http://127.0.0.1:{0}/" -f $Port) 2>$null
            $code = ([string]$o).Trim()
            if (-not $code) { $code = '000' }
        } catch { $code = '000' }
    } else {
        try {
            $req = [System.Net.HttpWebRequest]::Create(("http://127.0.0.1:{0}/" -f $Port))
            $req.Timeout = $TimeoutSec * 1000
            $req.Proxy = $null
            $resp = $req.GetResponse()
            $code = [string][int]$resp.StatusCode
            $resp.Close()
        } catch {
            if ($null -ne $_.Exception.Response) {
                try { $code = [string][int]$_.Exception.Response.StatusCode } catch { $code = '000' }
            } else {
                $code = '000'
            }
        }
    }
    $sw.Stop()
    return [pscustomobject]@{ code = $code; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
}

# ---------------------------------------------------------------------------
# JSONL com rotacao diaria + retencao
# ---------------------------------------------------------------------------

$script:JsonlWriters = @{}
$script:JsonlLines = @{}
$script:UseWmiFallback = $false

function Open-JsonlWriter([string]$Path) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
        $null = New-Item -ItemType Directory -Force -Path $dir
    }
    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $sw = [System.IO.StreamWriter]::new($fs, (New-Object System.Text.UTF8Encoding($false)))
    $sw.AutoFlush = $true
    $lines = 0
    try {
        if (Test-Path -LiteralPath $Path) {
            $lines = (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
        }
    } catch { }
    return [pscustomobject]@{ Path = $Path; Writer = $sw; Lines = $lines }
}

function Get-JsonlPath([string]$ObsDir, [string]$Category, [datetime]$Day) {
    return (Join-Path $ObsDir ('{0}-{1}.jsonl' -f $Category, $Day.ToString('yyyy-MM-dd')))
}

# Acrescenta um registro JSONL e devolve o numero da linha (1-based).
function Add-JsonlRecord([string]$ObsDir, [string]$Category, $Record, [datetime]$Day) {
    $path = Get-JsonlPath $ObsDir $Category $Day
    $entry = $script:JsonlWriters[$path]
    if ($null -eq $entry) {
        try {
            $entry = Open-JsonlWriter $path
            $script:JsonlWriters[$path] = $entry
        } catch {
            return 0
        }
    }
    try {
        $json = $Record | ConvertTo-Json -Compress -Depth 12
        $entry.Writer.WriteLine($json)
        $entry.Lines = [int]$entry.Lines + 1
        return [int]$entry.Lines
    } catch {
        return 0
    }
}

function Close-JsonlWriters {
    foreach ($k in @($script:JsonlWriters.Keys)) {
        try {
            $script:JsonlWriters[$k].Writer.Flush()
            $script:JsonlWriters[$k].Writer.Dispose()
        } catch { }
        $script:JsonlWriters.Remove($k)
    }
}

function Write-JsonFile([string]$Path, $Object) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Force -Path $dir }
    $json = $Object | ConvertTo-Json -Depth 12
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) {
        try { [System.IO.File]::Replace($tmp, $Path, $null) }
        catch {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            [System.IO.File]::Move($tmp, $Path)
        }
    } else {
        [System.IO.File]::Move($tmp, $Path)
    }
}

function Read-JsonFile([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Get-LineCount([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return 0 }
        return (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
    } catch { return 0 }
}

function Remove-OldObservationFiles([string]$ObsDir, [datetime]$Today, [int]$RetentionDays) {
    $cut = $Today.Date.AddDays(-1 * $RetentionDays)
    $removed = 0
    try {
        foreach ($f in Get-ChildItem -LiteralPath $ObsDir -File -ErrorAction SilentlyContinue) {
            if ($f.Name -match '^(snapshot|processos|eventos|hash-sessoes|lacunas)-(\d{4}-\d{2}-\d{2})\.jsonl$') {
                try {
                    $d = [datetime]::ParseExact($Matches[2], 'yyyy-MM-dd', $null)
                    if ($d -lt $cut) {
                        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                        $removed++
                    }
                } catch { }
            }
        }
    } catch { }
    return $removed
}

# ---------------------------------------------------------------------------
# Logs texto (rotacao por dia + retencao)
# ---------------------------------------------------------------------------

function Write-PlainLog([string]$LogDir, [string]$Name, [string]$Message) {
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) { $null = New-Item -ItemType Directory -Force -Path $LogDir }
        $path = Join-Path $LogDir ('{0}-{1}.log' -f $Name, (Get-Date).ToString('yyyy-MM-dd'))
        $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Message
        Add-Content -LiteralPath $path -Value $line -Encoding UTF8
    } catch { }
}

function Remove-OldLogFiles([string]$LogDir, [datetime]$Today, [int]$RetentionDays) {
    $cut = $Today.Date.AddDays(-1 * $RetentionDays)
    try {
        foreach ($f in Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue) {
            if ($f.Name -match '^(observador|supervisor-observador)-(\d{4}-\d{2}-\d{2})\.log$') {
                try {
                    $d = [datetime]::ParseExact($Matches[2], 'yyyy-MM-dd', $null)
                    if ($d -lt $cut) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop }
                } catch { }
            }
        }
    } catch { }
}

# ---------------------------------------------------------------------------
# Event Log (System/Application/TaskScheduler) sem admin
# ---------------------------------------------------------------------------

function Get-RelevantEvents([datetime]$Since, [int]$MaxPerLog = 60) {
    $out = New-Object System.Collections.ArrayList
    $specs = @(
        @{ Log = 'System'; Ids = @(41, 1074, 6005, 6006, 6008, 7030, 7031, 7034) },
        @{ Log = 'Application'; Ids = @(1000, 1001, 1002, 1026) },
        @{ Log = 'Microsoft-Windows-TaskScheduler/Operational'; Ids = $null }
    )
    foreach ($spec in $specs) {
        try {
            $filter = @{ LogName = $spec.Log; StartTime = $Since; MaxEvents = $MaxPerLog }
            if ($null -ne $spec.Ids) { $filter['Id'] = $spec.Ids }
            $evs = Get-WinEvent -FilterHashtable $filter -ErrorAction Stop
            foreach ($e in $evs) {
                if ($spec.Log -like '*TaskScheduler*') {
                    if ($e.Message -notmatch '(?i)(repo-watcher|restart-dsh|dsh-diario|superagent|observador)') { continue }
                }
                $null = $out.Add([pscustomobject]@{
                    log       = $spec.Log
                    id        = $e.Id
                    level     = [string]$e.LevelDisplayName
                    provider  = [string]$e.ProviderName
                    time      = $e.TimeCreated.ToString('o')
                    record_id = $e.RecordId
                    message   = Truncate-Text ($e.Message -replace '\s+', ' ').Trim() 600
                })
            }
        } catch {
            $msg = [string]$_.Exception.Message
            if ($msg -match '(?i)(no events were found|encontrado nenhum evento|no matching events)') {
                continue
            }
            $null = $out.Add([pscustomobject]@{
                log       = $spec.Log
                id        = 0
                level     = 'erro_leitura'
                provider  = ''
                time      = (Get-IsoNow)
                record_id = 0
                message   = Truncate-Text $msg 300
            })
        }
    }
    return $out.ToArray()
}

# ---------------------------------------------------------------------------
# Sessoes do DSH: mtime/tamanho + hash parcial quando muda
# ---------------------------------------------------------------------------

function Get-SessionSnapshot {
    $root = Join-Path $env:USERPROFILE '.dsh\sessions'
    $list = New-Object System.Collections.ArrayList
    try {
        if (Test-Path -LiteralPath $root) {
            $files = Get-ChildItem -LiteralPath $root -Recurse -Filter 'session.v4.jsonl.zstd' -File -ErrorAction SilentlyContinue
            foreach ($f in $files) {
                $item = [pscustomobject]@{
                    path = $f.FullName
                    mtime = $f.LastWriteTime.ToString('o')
                    size = [long]$f.Length
                    quick_hash = $null
                }
                $null = $list.Add($item)
            }
        }
    } catch { }
    return $list.ToArray()
}

function Get-QuickHash([string]$Path) {
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $len = [int][Math]::Min(4096, $fs.Length)
            $buf = New-Object byte[] $len
            $null = $fs.Read($buf, 0, $len)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $h = $sha.ComputeHash($buf)
                return (($h[0..7] | ForEach-Object { $_.ToString('x2') }) -join '')
            } finally { $sha.Dispose() }
        } finally { $fs.Dispose() }
    } catch { return $null }
}

# ---------------------------------------------------------------------------
# Instancia unica (mutex) e descoberta de processos do proprio observador
# ---------------------------------------------------------------------------

function New-InstanceMutex([string]$Name) {
    try {
        $m = New-Object System.Threading.Mutex($false, $Name)
        if ($m.WaitOne(0)) { return $m }
        try { $m.Dispose() } catch { }
        return $null
    } catch {
        return $null
    }
}

function Get-ObserverMutexName([string]$DataDir) {
    $h = Get-StableHash $DataDir
    return ('Global\DSH-Observador-{0}' -f $h)
}

function Get-SupervisorMutexName([string]$DataDir) {
    $h = Get-StableHash $DataDir
    return ('Global\DSH-SupervisorObservador-{0}' -f $h)
}

# Para processos do proprio observador (mesmo usuario/integridade). A guarda
# exige o caminho EXATO do script instalado, nao apenas o diretorio.
function Stop-OwnScriptProcesses([string]$InstallDir, [string]$ScriptFile) {
    $stopped = New-Object System.Collections.ArrayList
    $candidates = New-Object System.Collections.ArrayList
    $exact = Join-Path (Join-Path $InstallDir 'scripts') $ScriptFile
    try {
        foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
            try {
                if ($p.ProcessName -match '^(powershell|pwsh)$') { $null = $candidates.Add([int]$p.Id) }
            } catch { } finally { try { $p.Dispose() } catch { } }
        }
    } catch { }
    foreach ($cand in $candidates) {
        if ($cand -eq $PID) { continue }
        $info = Get-PebInfo $cand
        if (-not $info.ok -or -not $info.cmdline) { continue }
        if ($info.cmdline -like "*$exact*") {
            try {
                Stop-Process -Id $cand -Force -ErrorAction Stop
                $null = $stopped.Add($cand)
            } catch { }
        }
    }
    return $stopped.ToArray()
}

# ---------------------------------------------------------------------------
# Supervisor: ultima saida registrada do DSH e cauda do console
# ---------------------------------------------------------------------------

function Get-SupervisorExitInfo([string]$LogDir, [int]$TargetPid, [datetime]$Since) {
    $result = $null
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) { return $null }
        $files = Get-ChildItem -LiteralPath $LogDir -Filter 'supervisor-*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
        foreach ($f in $files) {
            try {
                $lines = Get-Content -LiteralPath $f.FullName -ErrorAction Stop
            } catch { continue }
            for ($i = $lines.Count - 1; $i -ge 0; $i--) {
                $ln = [string]$lines[$i]
                if (-not $ln) { continue }
                try { $rec = $ln | ConvertFrom-Json } catch { continue }
                if ($rec.event -ne 'dsh_exit') { continue }
                if ($TargetPid -gt 0 -and [int]$rec.dsh_pid -ne $TargetPid) { continue }
                try { $when = [datetime]::Parse($rec.ts) } catch { $when = (Get-Item $f.FullName).LastWriteTime }
                if ($when -lt $Since) { continue }
                $rec | Add-Member -NotePropertyName fonte -NotePropertyValue $f.Name -Force
                $result = $rec
                break
            }
            if ($null -ne $result) { break }
        }
    } catch { }
    return $result
}

function Get-ConsoleTail([string]$LogPath, [int]$Lines = 80) {
    try {
        if (-not (Test-Path -LiteralPath $LogPath)) { return @() }
        return @(Get-Content -LiteralPath $LogPath -Tail $Lines -ErrorAction SilentlyContinue)
    } catch { return @() }
}

function Test-StackSignature([string[]]$Lines) {
    $rx = '(?i)(exception|stack trace|\bat [A-Za-z0-9_.$]+\s*\(|ELIFECYCLE|command failed with exit code|error:|fatal error|uncaught|panic)'
    foreach ($ln in $Lines) {
        if ($ln -match $rx) { return $true }
    }
    return $false
}
