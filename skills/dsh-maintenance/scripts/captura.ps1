# captura.ps1 - motor de captura rapida de processos (issue #33).
#
# Por que existe: o poll antigo (100 ms) rodava no MESMO thread do loop do
# observador e fazia snapshot + Get-Process + PEB + cadeia de ancestrais por
# processo novo. O intervalo efetivo passava de 100 ms e processos curtos
# (taskkill.exe vive ~117-165 ms) eram perdidos -> veredito 'unknown'.
#
# Este motor desacopla as duas coisas:
#   thread 1 (captura)  : NtQuerySystemInformation(SystemProcessInformation) a cada
#                         ~25 ms, SO diff de PID/PPID/CreateTime. sem PEB, sem JSON,
#                         sem I/O. buffer persistente (cresce so quando falta).
#   thread 2 (enriquecer): consome a fila de PIDs novos e resolve nome (OpenProcess +
#                         QueryFullProcessImageName) e cmdline (PEB x64), e resolve
#                         as saidas usando o cache.
#
# Nomes de assassinos conhecidos (taskkill etc.) sao enriquecidos na PROPRIA thread
# de captura, no mesmo tick, para nao perder a cmdline de um processo de ~120 ms.
#
# API publica (contrato fixo da issue #33):
#   Start-CapturaEngine [-IntervalMs 25] [-ParentPidToIgnore 0] -> [bool]
#   Stop-CapturaEngine
#   Get-CapturaState      -> @{ ok; erro; interval_ms; ticks; media_tick_ms; maior_gap_ms;
#                              visiveis; enfileirados; fila; descartados; uso_cpu_ms }
#   Receive-CapturaItem [-Max 200] -> array de itens kind/pid/ppid/create_time/name/
#                              cmdline/error/lifetime_ms/seen_ms
#   Get-CapturaPpid, Test-CapturaAlive, Get-CapturaName, Get-CapturaPairs
#
# ASCII puro de proposito: o PS 5.1 le .ps1 sem BOM como ANSI.

$ErrorActionPreference = 'Continue'
$script:CapturaOk = $false
$script:CapturaErro = ''

if (-not ('CapturaEngine' -as [type])) {
    $capturaCode = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class CapturaItem {
    public string Kind;
    public int Pid;
    public int Ppid;
    public string CreateTime;
    public string Name;
    public string Cmdline;
    public string Error;
    public int LifetimeMs;
    public int SeenMs;
}

public class CapturaEngine {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private class Raw {
        public int Kind;          // 0 = novo, 1 = saiu
        public int Pid;
        public int Ppid;
        public long CreateTicks;
        public string Image;
        public long EnqMs;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsWow64Process(IntPtr h, out bool wow64);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

    private static readonly ConcurrentQueue<Raw> _raw = new ConcurrentQueue<Raw>();
    private static readonly ConcurrentQueue<CapturaItem> _out = new ConcurrentQueue<CapturaItem>();
    private static readonly object _lock = new object();
    private static Dictionary<int, int> _bufA = new Dictionary<int, int>(2048);
    private static Dictionary<int, int> _bufB = new Dictionary<int, int>(2048);
    private static Dictionary<int, int> _alive = _bufA;
    private static readonly List<Raw> _novos = new List<Raw>(32);
    private static readonly List<Raw> _saidas = new List<Raw>(16);
    private static readonly ManualResetEventSlim _sinal = new ManualResetEventSlim(false);
    private static Dictionary<int, string> _names = new Dictionary<int, string>(2048);
    private static Dictionary<int, string> _cmds = new Dictionary<int, string>(2048);
    private static Dictionary<int, int> _ppids = new Dictionary<int, int>(2048);
    private static Dictionary<int, string> _starts = new Dictionary<int, string>(2048);
    private static Dictionary<int, long> _startMs = new Dictionary<int, long>(2048);

    private static Thread _tc;
    private static Thread _te;
    private static volatile bool _run;
    private static int _interval = 25;
    private static int _ignorePid;
    private static int _selfPid;
    private static IntPtr _buf = IntPtr.Zero;
    private static int _bufLen = 1 << 20;
    private static long _ticks;
    private static long _tickSumMs;
    private static long _maxGapMs;
    private static long _enq;
    private static long _dropped;
    private static int _visible;
    private static int _outMax = 4096;
    private static string _erro = "";
    private static readonly Stopwatch _clock = Stopwatch.StartNew();
    private static readonly string[] _prioNomes = new string[] {
        "taskkill.exe", "taskkill", "tskill.exe", "psexec.exe", "procexp.exe", "procexp64.exe",
        "processhacker.exe", "wmic.exe", "schtasks.exe"
    };

    public static bool IsRunning { get { return _run; } }
    public static string Erro { get { return _erro; } }

    public static bool Start(int intervalMs, int parentPidToIgnore) {
        if (_run) { return true; }
        if (intervalMs < 10) { intervalMs = 10; }
        if (intervalMs > 200) { intervalMs = 200; }
        _interval = intervalMs;
        _ignorePid = parentPidToIgnore;
        _selfPid = Process.GetCurrentProcess().Id;
        _ticks = 0; _tickSumMs = 0; _maxGapMs = 0; _enq = 0; _dropped = 0; _visible = 0;
        _erro = "";
        Raw rd;
        while (_raw.TryDequeue(out rd)) { }
        CapturaItem ci;
        while (_out.TryDequeue(out ci)) { }
        if (_buf == IntPtr.Zero) { _buf = Marshal.AllocHGlobal(_bufLen); }
        _run = true;
        _sinal.Reset();
        _te = new Thread(EnrichLoop);
        _te.IsBackground = true;
        _te.Name = "captura-enrich";
        _te.Start();
        _tc = new Thread(CaptureLoop);
        _tc.IsBackground = true;
        _tc.Name = "captura-nqsi";
        _tc.Start();
        return true;
    }

    public static void Stop() {
        _run = false;
        try { if (_tc != null) { _tc.Join(1500); } } catch { }
        try { if (_te != null) { _te.Join(1500); } } catch { }
        _tc = null; _te = null;
        Raw rd;
        CapturaItem ci;
        while (_raw.TryDequeue(out rd)) { }
        while (_out.TryDequeue(out ci)) { }
        lock (_lock) {
            _alive = new Dictionary<int, int>(2048);
            _names = new Dictionary<int, string>(2048);
            _cmds = new Dictionary<int, string>(2048);
            _ppids = new Dictionary<int, int>(2048);
            _starts = new Dictionary<int, string>(2048);
            _startMs = new Dictionary<int, long>(2048);
        }
    }

    private static void CaptureLoop() {
        long lastStart = _clock.ElapsedMilliseconds;
        while (_run) {
            long start = _clock.ElapsedMilliseconds;
            try { Tick(); } catch (Exception ex) { _erro = "tick:" + ex.Message; }
            long cost = _clock.ElapsedMilliseconds - start;
            _ticks++;
            _tickSumMs += cost;
            long gap = start - lastStart;
            lastStart = start;
            if (gap > _maxGapMs) { _maxGapMs = gap; }
            int sleep = _interval - (int)cost;
            if (sleep < 1) { sleep = 1; }
            Thread.Sleep(sleep);
        }
    }

    private static void Tick() {
        int ret = 0;
        int st;
        while ((st = NtQuerySystemInformation(5, _buf, _bufLen, out ret)) == unchecked((int)0xC0000004)) {
            Marshal.FreeHGlobal(_buf);
            int nova = (ret > _bufLen) ? (ret + 65536) : (_bufLen * 2);
            _buf = Marshal.AllocHGlobal(nova);
            _bufLen = nova;
        }
        if (st != 0) { _erro = "NtQuerySystemInformation:" + st; return; }

        Dictionary<int, int> prev;
        lock (_lock) { prev = _alive; }

        // Dois dicionarios reaproveitados (evita alocar ~40/s e reduz GC/CPU).
        Dictionary<int, int> cur = object.ReferenceEquals(prev, _bufA) ? _bufB : _bufA;
        cur.Clear();
        _novos.Clear();
        _saidas.Clear();
        long now = _clock.ElapsedMilliseconds;

        long off = 0;
        while (true) {
            IntPtr p = (IntPtr)(_buf.ToInt64() + off);
            int next = Marshal.ReadInt32(p, 0);
            int pid = Marshal.ReadInt32(p, 0x50);
            int ppid = Marshal.ReadInt32(p, 0x58);
            if (pid > 0 && pid != _selfPid) {
                cur[pid] = ppid;
                if (!prev.ContainsKey(pid) && pid != _ignorePid) {
                    Raw r = new Raw();
                    r.Kind = 0;
                    r.Pid = pid;
                    r.Ppid = ppid;
                    r.CreateTicks = Marshal.ReadInt64(p, 0x20);
                    r.EnqMs = now;
                    r.Image = LerImageName(p);
                    _novos.Add(r);
                }
            }
            if (next == 0) { break; }
            off += next;
        }

        foreach (int pid in prev.Keys) {
            if (cur.ContainsKey(pid)) { continue; }
            Raw r = new Raw();
            r.Kind = 1;
            r.Pid = pid;
            r.EnqMs = now;
            _saidas.Add(r);
        }

        lock (_lock) { _alive = cur; _visible = cur.Count; }

        // Assassinos conhecidos: enriquecer JA, neste tick, para nao perder a
        // cmdline de um processo que vive ~120 ms (taskkill).
        foreach (Raw r in _novos) {
            if (EhPrioritario(r.Image)) {
                Enfileirar(Enriquecer(r));
            } else {
                _raw.Enqueue(r);
            }
        }
        foreach (Raw r in _saidas) { _raw.Enqueue(r); }
        if (_novos.Count > 0 || _saidas.Count > 0) { _sinal.Set(); }
    }

    private static bool EhPrioritario(string img) {
        if (img == null || img.Length == 0) { return false; }
        string b = BaseName(img);
        for (int i = 0; i < _prioNomes.Length; i++) {
            if (String.Equals(b, _prioNomes[i], StringComparison.OrdinalIgnoreCase)) { return true; }
        }
        return false;
    }

    private static string BaseName(string img) {
        if (img == null) { return ""; }
        int i = img.LastIndexOf('\\');
        if (i >= 0) { return img.Substring(i + 1); }
        return img;
    }

    private static string LerImageName(IntPtr p) {
        try {
            int nameLen = Marshal.ReadInt16(p, 0x38);
            long nameBuf = Marshal.ReadInt64(p, 0x40);
            if (nameLen <= 0 || nameLen > 4096 || nameBuf == 0) { return null; }
            return Marshal.PtrToStringUni((IntPtr)nameBuf, nameLen / 2);
        } catch { return null; }
    }

    private static void Enfileirar(CapturaItem it) {
        if (_out.Count >= _outMax) { _dropped++; return; }
        _out.Enqueue(it);
        _enq++;
    }

    private static string Ftime(long ft) {
        if (ft <= 0) { return null; }
        try { return DateTime.FromFileTimeUtc(ft).ToLocalTime().ToString("o"); } catch { return null; }
    }

    private static CapturaItem Enriquecer(Raw r) {
        CapturaItem it = new CapturaItem();
        it.Kind = "start";
        it.Pid = r.Pid;
        it.Ppid = r.Ppid;
        it.CreateTime = Ftime(r.CreateTicks);
        it.LifetimeMs = -1;
        it.SeenMs = (int)(_clock.ElapsedMilliseconds - r.EnqMs);
        string img = r.Image;
        string cmd = null;
        string err = null;
        IntPtr h = OpenProcess(0x1010, false, r.Pid); // QUERY_LIMITED_INFORMATION | VM_READ
        if (h == IntPtr.Zero) {
            err = "OpenProcess:" + Marshal.GetLastWin32Error();
        } else {
            try {
                StringBuilder sb = new StringBuilder(1024);
                int cap = sb.Capacity;
                if (QueryFullProcessImageName(h, 0, sb, ref cap)) {
                    img = sb.ToString();
                } else if (err == null) {
                    err = "QueryFullProcessImageName:" + Marshal.GetLastWin32Error();
                }
                string pebErr = null;
                cmd = LerCmdline(h, out pebErr);
                if (cmd == null) {
                    if (err == null) { err = (pebErr != null) ? pebErr : "cmdline_indisponivel"; }
                }
            } finally { CloseHandle(h); }
        }
        it.Name = (img != null && img.Length > 0) ? BaseName(img) : "?";
        it.Cmdline = cmd;
        it.Error = err;
        it.SeenMs = (int)(_clock.ElapsedMilliseconds - r.EnqMs);
        lock (_lock) {
            _names[r.Pid] = it.Name;
            _ppids[r.Pid] = r.Ppid;
            _cmds[r.Pid] = cmd;
            _starts[r.Pid] = it.CreateTime;
            _startMs[r.Pid] = (r.CreateTicks > 0) ? (r.CreateTicks / 10000L - 11644473600000L) : -1;
        }
        return it;
    }

    private static string LerCmdline(IntPtr h, out string erro) {
        erro = null;
        try {
            bool w;
            if (IsWow64Process(h, out w) && w) { erro = "wow64"; return null; }
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int rl;
            int st = NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl);
            if (st != 0) { erro = "NtQueryInformationProcess:" + st; return null; }
            byte[] ptr = new byte[8];
            IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20), ptr, 8, out read)) {
                erro = "PEB_ProcessParameters:" + Marshal.GetLastWin32Error();
                return null;
            }
            long pp = BitConverter.ToInt64(ptr, 0);
            if (pp == 0) { erro = "ProcessParameters_nulo"; return null; }
            byte[] us = new byte[16];
            if (!ReadProcessMemory(h, (IntPtr)(pp + 0x70), us, 16, out read)) {
                erro = "CommandLine_US:" + Marshal.GetLastWin32Error();
                return null;
            }
            ushort len = BitConverter.ToUInt16(us, 0);
            long buf = BitConverter.ToInt64(us, 8);
            if (len == 0 || len > 32767 || buf == 0) { erro = "CommandLine_vazio"; return null; }
            byte[] str = new byte[len];
            if (!ReadProcessMemory(h, (IntPtr)buf, str, len, out read)) {
                erro = "CommandLine_buf:" + Marshal.GetLastWin32Error();
                return null;
            }
            return Encoding.Unicode.GetString(str).TrimEnd('\0');
        } catch (Exception ex) {
            erro = "peb:" + ex.Message;
            return null;
        }
    }

    private static void EnrichLoop() {
        Raw r;
        while (_run) {
            if (!_raw.TryDequeue(out r)) { _sinal.Wait(5); _sinal.Reset(); continue; }
            try {
                if (r.Kind == 0) {
                    Enfileirar(Enriquecer(r));
                } else {
                    CapturaItem it = new CapturaItem();
                    it.Kind = "exit";
                    it.Pid = r.Pid;
                    it.LifetimeMs = -1;
                    it.SeenMs = (int)(_clock.ElapsedMilliseconds - r.EnqMs);
                    long startMs = -1;
                    lock (_lock) {
                        string s;
                        if (_names.TryGetValue(r.Pid, out s)) { it.Name = s; }
                        int p;
                        if (_ppids.TryGetValue(r.Pid, out p)) { it.Ppid = p; }
                        if (_cmds.TryGetValue(r.Pid, out s)) { it.Cmdline = s; }
                        if (_starts.TryGetValue(r.Pid, out s)) { it.CreateTime = s; }
                        if (_startMs.TryGetValue(r.Pid, out startMs)) { }
                        _names.Remove(r.Pid);
                        _cmds.Remove(r.Pid);
                        _ppids.Remove(r.Pid);
                        _starts.Remove(r.Pid);
                        _startMs.Remove(r.Pid);
                    }
                    if (startMs > 0) {
                        long agora = r.EnqMs + 11644473600000L;
                        long vida = agora - startMs;
                        if (vida >= 0 && vida < 86400000L) { it.LifetimeMs = (int)vida; }
                    }
                    Enfileirar(it);
                }
            } catch { }
        }
    }

    public static CapturaItem[] Receive(int max) {
        if (max <= 0) { max = 100; }
        List<CapturaItem> list = new List<CapturaItem>(max);
        CapturaItem it;
        while (list.Count < max && _out.TryDequeue(out it)) { list.Add(it); }
        return list.ToArray();
    }

    public static int Ppid(int pid) {
        lock (_lock) {
            int v;
            if (_ppids.TryGetValue(pid, out v)) { return v; }
            if (_alive.TryGetValue(pid, out v)) { return v; }
            return 0;
        }
    }

    public static bool Alive(int pid) {
        lock (_lock) { return _alive.ContainsKey(pid); }
    }

    public static string Nome(int pid) {
        lock (_lock) {
            string v;
            if (_names.TryGetValue(pid, out v)) { return v; }
            return null;
        }
    }

    public static int[] Pairs() {
        lock (_lock) {
            int[] arr = new int[_alive.Count * 2];
            int i = 0;
            foreach (KeyValuePair<int, int> kv in _alive) {
                arr[i] = kv.Key;
                arr[i + 1] = kv.Value;
                i += 2;
            }
            return arr;
        }
    }

    public static long Ticks() { return _ticks; }
    public static long TickSumMs() { return _tickSumMs; }
    public static long MaxGapMs() { return _maxGapMs; }
    public static int Visible() { lock (_lock) { return _visible; } }
    public static long Enqueued() { return _enq; }
    public static long Dropped() { return _dropped; }
    public static int QueueLen() { return _out.Count; }
    public static int Interval() { return _interval; }
    public static long CpuMs() {
        try { return (long)Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds; } catch { return 0; }
    }
}
'@
    try {
        Add-Type -TypeDefinition $capturaCode -Language CSharp -ErrorAction Stop
    } catch {
        $script:CapturaErro = $_.Exception.Message
    }
}

function Start-CapturaEngine {
    param(
        [int]$IntervalMs = 25,
        [int]$ParentPidToIgnore = 0
    )
    if ($script:CapturaOk) { return $true }
    if (-not ('CapturaEngine' -as [type])) {
        $script:CapturaErro = 'Add-Type indisponivel: ' + [string]$script:CapturaErro
        return $false
    }
    try {
        $ok = [CapturaEngine]::Start($IntervalMs, $ParentPidToIgnore)
        $script:CapturaOk = [bool]$ok
        return [bool]$ok
    } catch {
        $script:CapturaErro = $_.Exception.Message
        $script:CapturaOk = $false
        return $false
    }
}

function Stop-CapturaEngine {
    if (-not ('CapturaEngine' -as [type])) { return }
    try { [CapturaEngine]::Stop() } catch { }
    $script:CapturaOk = $false
}

function Get-CapturaState {
    $erro = $script:CapturaErro
    if (-not ('CapturaEngine' -as [type])) {
        return [pscustomobject]@{
            ok = $false; erro = $erro; interval_ms = 0; ticks = 0; media_tick_ms = 0
            maior_gap_ms = 0; visiveis = 0; enfileirados = 0; fila = 0; descartados = 0; uso_cpu_ms = 0
        }
    }
    $ticks = 0
    $soma = 0
    $gap = 0
    $vis = 0
    $enq = 0
    $fila = 0
    $desc = 0
    $cpu = 0
    $intv = 0
    try {
        $ticks = [long][CapturaEngine]::Ticks()
        $soma = [long][CapturaEngine]::TickSumMs()
        $gap = [long][CapturaEngine]::MaxGapMs()
        $vis = [int][CapturaEngine]::Visible()
        $enq = [long][CapturaEngine]::Enqueued()
        $fila = [int][CapturaEngine]::QueueLen()
        $desc = [long][CapturaEngine]::Dropped()
        $cpu = [long][CapturaEngine]::CpuMs()
        $intv = [int][CapturaEngine]::Interval()
    } catch { }
    $media = 0
    if ($ticks -gt 0) { $media = [math]::Round(($soma / $ticks), 2) }
    return [pscustomobject]@{
        ok            = [bool]$script:CapturaOk
        erro          = $erro
        interval_ms   = $intv
        ticks         = $ticks
        media_tick_ms = $media
        maior_gap_ms  = $gap
        visiveis      = $vis
        enfileirados  = $enq
        fila          = $fila
        descartados   = $desc
        uso_cpu_ms    = $cpu
    }
}

function Receive-CapturaItem {
    param([int]$Max = 200)
    if (-not ('CapturaEngine' -as [type])) { return @() }
    $out = New-Object System.Collections.ArrayList
    try {
        foreach ($it in [CapturaEngine]::Receive($Max)) {
            $null = $out.Add([pscustomobject]@{
                    kind        = [string]$it.Kind
                    pid         = [int]$it.Pid
                    ppid        = [int]$it.Ppid
                    create_time = [string]$it.CreateTime
                    name        = [string]$it.Name
                    cmdline     = [string]$it.Cmdline
                    error       = [string]$it.Error
                    lifetime_ms = $(if ([int]$it.LifetimeMs -ge 0) { [int]$it.LifetimeMs } else { $null })
                    seen_ms     = [int]$it.SeenMs
                })
        }
    } catch { }
    return $out.ToArray()
}

function Get-CapturaPpid {
    param([int]$ProcId)
    if (-not ('CapturaEngine' -as [type])) { return 0 }
    try { return [int][CapturaEngine]::Ppid($ProcId) } catch { return 0 }
}

function Test-CapturaAlive {
    param([int]$ProcId)
    if ($ProcId -le 0) { return $false }
    if (-not ('CapturaEngine' -as [type])) { return $false }
    try { return [bool][CapturaEngine]::Alive($ProcId) } catch { return $false }
}

function Get-CapturaName {
    param([int]$ProcId)
    if (-not ('CapturaEngine' -as [type])) { return $null }
    try {
        $n = [CapturaEngine]::Nome($ProcId)
        if ([string]::IsNullOrEmpty($n)) { return $null }
        return [string]$n
    } catch { return $null }
}

function Get-CapturaPairs {
    if (-not ('CapturaEngine' -as [type])) { return @() }
    try { return [int[]][CapturaEngine]::Pairs() } catch { return @() }
}
