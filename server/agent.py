#!/usr/bin/env python3
"""Self-contained, read-only host snapshot: capacity (CPU, RAM, VRAM, GPU, disk) and AI CLI harness processes.

It is piped to `python3 -c` on each monitored host over SSH, so it uses only the standard library
and needs nothing installed on the host. It reads process names and working directories of the
current user only; it never reads terminal contents, prompts or files.
"""
import json, math, os, pathlib, shutil, subprocess, sys, time
DRM=pathlib.Path("/sys/class/drm")
def _run(cmd,timeout=5):
    return subprocess.run(cmd,capture_output=True,text=True,timeout=timeout,check=True).stdout

def _cpu_linux():
    def sample():
        f=open('/proc/stat').readline().split()[1:]
        v=[int(x) for x in f]; return sum(v), v[3]+(v[4] if len(v)>4 else 0)
    t0,i0=sample(); time.sleep(.4); t1,i1=sample()
    return max(0.0,min(100.0,100.0*(1-(i1-i0)/(t1-t0)))) if t1>t0 else 0.0

def _cpu_mac(cores):
    total=sum(float(x) for x in _run(['ps','-A','-o','%cpu=']).split())
    return max(0.0,min(100.0,total/cores))

def _ram():
    if sys.platform=='darwin':
        total=int(_run(['sysctl','-n','hw.memsize']))
        out=_run(['vm_stat']); page=int(out.split('page size of')[1].split()[0])
        pages={}
        for line in out.splitlines()[1:]:
            if ':' in line: k,v=line.split(':',1); pages[k.strip()]=int(v.strip().rstrip('.') or 0)
        free=(pages.get('Pages free',0)+pages.get('Pages inactive',0)+pages.get('Pages speculative',0)+pages.get('Pages purgeable',0))*page
        return {'used':max(0,total-free),'total':total}
    info={}
    for line in open('/proc/meminfo'):
        k,v=line.split(':',1); info[k]=int(v.split()[0])*1024
    return {'used':info['MemTotal']-info['MemAvailable'],'total':info['MemTotal']}


def _amd_vram():
    # amdgpu exposes VRAM per card in sysfs; non-AMD cards lack these files and are skipped.
    used=total=count=0
    for device in sorted(DRM.glob('card[0-9]/device')):
        try: u=int((device/'mem_info_vram_used').read_text()); t=int((device/'mem_info_vram_total').read_text())
        except (OSError,ValueError): continue
        used+=u; total+=t; count+=1
    return {'used':used,'total':total,'gpus':count} if total>0 and used<=total else None

def _vram():
    # None means no discrete GPU reported (Apple silicon uses unified memory, counted under RAM).
    try:
        rows=[l.split(',') for l in _run(['nvidia-smi','--query-gpu=memory.used,memory.total','--format=csv,noheader,nounits']).strip().splitlines() if l.strip()]
        used=sum(int(r[0]) for r in rows)*1048576; total=sum(int(r[1]) for r in rows)*1048576
        return {'used':used,'total':total,'gpus':len(rows)} if total>0 else _amd_vram()
    except (OSError,subprocess.SubprocessError,ValueError,IndexError): return _amd_vram()

def _gpu():
    # GPU core utilization, averaged across GPUs. None when the host does not report it (never zero).
    try:
        if sys.platform=='darwin':
            import re
            values=[int(v) for v in re.findall(r'"Device Utilization %"=(\d+)',_run(['ioreg','-r','-d','1','-w0','-c','IOAccelerator'],8))]
        else:
            try: values=[int(l.strip()) for l in _run(['nvidia-smi','--query-gpu=utilization.gpu','--format=csv,noheader,nounits']).splitlines() if l.strip()]
            except (OSError,subprocess.SubprocessError,ValueError): values=[]
            if not values:
                values=[int(p.read_text()) for p in sorted(DRM.glob('card[0-9]/device/gpu_busy_percent'))]
        return {'percent':round(sum(values)/len(values),1),'gpus':len(values)} if values and all(0<=v<=100 for v in values) else None
    except (OSError,subprocess.SubprocessError,ValueError): return None

def local_resources():
    cores=os.cpu_count() or 1
    cpu=_cpu_mac(cores) if sys.platform=='darwin' else _cpu_linux()
    usage=shutil.disk_usage(str(pathlib.Path.home()))
    return {'cpu':{'percent':round(cpu,1),'cores':cores,'load1':round(os.getloadavg()[0],2)},
            'ram':_ram(),'vram':_vram(),'gpu':_gpu(),'disk':{'used':usage.used,'total':usage.total}}

def _fraction(x):
    return isinstance(x,dict) and all(type(x.get(k)) is int and x[k]>=0 for k in ('used','total')) and x['total']>0 and x['used']<=x['total']

def validate(r):
    c=r['cpu']
    if not (isinstance(c,dict) and all(isinstance(c.get(k),(int,float)) and math.isfinite(c[k]) for k in ('percent','load1')) and 0<=c['percent']<=100 and type(c.get('cores')) is int and c['cores']>0): raise ValueError('Invalid CPU')
    if not _fraction(r['ram']): raise ValueError('Invalid RAM')
    if not _fraction(r['disk']): raise ValueError('Invalid disk')
    if r['vram'] is not None and not (_fraction(r['vram']) and type(r['vram'].get('gpus')) is int): raise ValueError('Invalid VRAM')
    gpu=r.get('gpu')
    if gpu is not None and not (isinstance(gpu,dict) and isinstance(gpu.get('percent'),(int,float)) and not isinstance(gpu['percent'],bool) and math.isfinite(gpu['percent']) and 0<=gpu['percent']<=100 and type(gpu.get('gpus')) is int and gpu['gpus']>0): raise ValueError('Invalid GPU')
    return dict({k:r[k] for k in ('cpu','ram','vram','disk')},gpu=gpu)


# Executable (or script) name -> display name. Hosts rarely run most of these; absent ones simply never appear.
ALIASES={'claude':'Claude', 'claude-code':'Claude', 'codex':'Codex', 'gemini':'Gemini', 'gemini-cli':'Gemini',
 'opencode':'OpenCode', 'hermes':'Hermes', 'hermes-agent':'Hermes', 'pi':'Pi', 'pi-coding-agent':'Pi',
 'zcode':'ZCode', 'z-code':'ZCode', 'deepseek':'DeepSeek', 'deepseek-tui':'DeepSeek', 'deepseek-cli':'DeepSeek',
 'aider':'Aider', 'goose':'Goose', 'amp':'Amp', 'cursor-agent':'Cursor', 'qwen':'Qwen Code', 'qwen-code':'Qwen Code',
 'kimi':'Kimi', 'kimi-cli':'Kimi', 'crush':'Crush', 'droid':'Droid', 'copilot':'Copilot', 'cline':'Cline',
 'kilo':'Kilo', 'kilocode':'Kilo', 'openhands':'OpenHands', 'forge':'Forge', 'plandex':'Plandex',
 'auggie':'Augment', 'junie':'Junie', 'grok':'Grok', 'vibe':'Vibe', 'mistral-vibe':'Vibe'}
NAMES=ALIASES
RUNTIMES=set(ALIASES.values())
# Harnesses installed from npm or pip run as an interpreter; the script name identifies them.
INTERPRETERS=('node','nodejs','bun','deno','python','uv','npx','bunx')
SCRIPT_SUFFIXES=('.js','.mjs','.cjs','.ts','.py')
GENERIC_SCRIPTS=('cli','index','main','bin','run','__main__')

def interpreter_runtime(args):
    """Name the harness behind an interpreter command line, or None."""
    words=[w for w in args[1:6] if w and not w.startswith('-')]
    for word in words[:3]:
        path=pathlib.PurePath(word); stem=path.name.lower()
        for suffix in SCRIPT_SUFFIXES:
            if stem.endswith(suffix): stem=stem[:-len(suffix)]
        candidates=[stem]
        if stem in GENERIC_SCRIPTS: candidates=[p.lower() for p in path.parts[-4:-1][::-1] if p.lower() not in ('dist','bin','lib','src','build')]
        for candidate in candidates:
            if candidate in ALIASES: return ALIASES[candidate]
    return None

def process_args(pid):
    try: return pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().decode(errors='replace').split('\0')
    except OSError: pass
    try:
        out=subprocess.run(['ps','-o','args=','-p',str(pid)],capture_output=True,text=True,timeout=4).stdout
        return out.split()
    except (OSError,subprocess.SubprocessError): return []

def mac_working_directories(pids):
    if not pids: return {}
    try:
        result=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',','.join(map(str,pids)),'-d','cwd','-Fpn'],capture_output=True,text=True,timeout=8)
        if result.returncode not in (0,1): return {}
        directories={}; pid=None
        for line in result.stdout.splitlines():
            if line.startswith('p'): pid=int(line[1:]) if line[1:].isdigit() else None
            elif line.startswith('n') and pid in pids:
                path=line[1:]
                if path.startswith('/') and len(path)<=4096: directories[pid]=path
        return directories
    except (OSError,subprocess.SubprocessError,ValueError): return {}

def local_presence():
    p=subprocess.run(['ps','-A','-o','uid=','-o','stat=','-o','pid=','-o','ppid=','-o','comm='],capture_output=True,text=True,timeout=8,check=True)
    counts={}; processes=[]; runtime_by_pid={}; parents={}
    for line in p.stdout.splitlines():
        fields=line.strip().split(None,4)
        if len(fields)!=5 or fields[0]!=str(os.getuid()) or fields[1].startswith('Z'): continue
        name=pathlib.PurePath(fields[4]).name.lower()
        try: pid=int(fields[2]); ppid=int(fields[3])
        except ValueError: continue
        if pid <= 0: continue
        runtime=ALIASES.get(name)
        if runtime is None and (name in INTERPRETERS or name.startswith('python')): runtime=interpreter_runtime(process_args(pid))
        if runtime is None: continue
        runtime_by_pid[pid]=runtime; parents[pid]=ppid
    for pid,runtime in runtime_by_pid.items():
        # A wrapper and the child it launches are one harness, not two.
        if runtime_by_pid.get(parents[pid])==runtime: continue
        counts[runtime]=counts.get(runtime,0)+1
        item={'runtime':runtime,'pid':pid}
        try:
            cwd=os.readlink('/proc/'+str(pid)+'/cwd')
            if cwd.startswith('/') and len(cwd)<=4096: item['cwd']=cwd
        except OSError: pass
        processes.append(item)
    if sys.platform=='darwin':
        directories=mac_working_directories({item['pid'] for item in processes})
        for item in processes:
            if item['pid'] in directories: item['cwd']=directories[item['pid']]
    return {'counts':counts,'processes':processes}


def snapshot():
    return {'resources':local_resources(),'presence':local_presence()}

if __name__=='__main__':
    print(json.dumps(snapshot()))
