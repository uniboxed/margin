"""Read-only Margin + attributed WebKit sampling; never opens or moves a window.

The resource-coalition read is XNU's proc_pidinfo flavor 20, a 40-byte result
(two coalition IDs and three reserved words). Unknown ABI/reads fail closed.
proc_pid_rusage v0 is the public 96-byte SDK layout. Values are bytes and Mach
CPU ticks. Sources and measurement limits are in README.md. No product code
uses this probe, and no process memory contents or page data are read.
"""
import argparse
import ctypes as C, json, subprocess, time
from pathlib import Path
lib = C.CDLL('/usr/lib/libproc.dylib', use_errno=True)
class Coal(C.Structure):
    _fields_=[('ids',C.c_uint64*2),('reserved',C.c_uint64*3)]
class Usage(C.Structure):
    _fields_=[('uuid',C.c_uint8*16)]+[(n,C.c_uint64) for n in ['user','system','idle_wakeups','interrupt_wakeups','pageins','wired','resident','footprint','started','exited']]
lib.proc_pidinfo.argtypes=[C.c_int,C.c_int,C.c_uint64,C.c_void_p,C.c_int]
lib.proc_pid_rusage.argtypes=[C.c_int,C.c_int,C.c_void_p]
class Timebase(C.Structure):
    _fields_=[('numer',C.c_uint32),('denom',C.c_uint32)]
system=C.CDLL('/usr/lib/libSystem.B.dylib')
system.mach_timebase_info.argtypes=[C.POINTER(Timebase)]
timebase=Timebase()
cpu_clock_known=system.mach_timebase_info(C.byref(timebase))==0 and timebase.denom>0
assert C.sizeof(Coal)==40 and C.sizeof(Usage)==96
APP=str(Path.home()/'Applications/Margin.app/Contents/MacOS/Margin')
def coal(pid):
    c=Coal()
    return tuple(c.ids) if lib.proc_pidinfo(pid,20,0,C.byref(c),C.sizeof(c))==C.sizeof(c) else None
def usage(pid):
    u=Usage()
    if lib.proc_pid_rusage(pid,0,C.byref(u))!=0: return None
    result={n:getattr(u,n) for n in ['resident','footprint','user','system','started']}
    if cpu_clock_known: result['cpu_ns']=(u.user+u.system)*timebase.numer//timebase.denom
    return result
def sample():
    ps=[]
    for l in subprocess.check_output(['/bin/ps','-axo','pid=,comm='],text=True).splitlines():
        fields=l.strip().split(None,1)
        if len(fields)==2: ps.append((int(fields[0]),fields[1]))
    apps=[p for p,n in ps if n==APP]
    if len(apps)!=1: return {'error':'no unique Margin process','at':time.time()}
    pid=apps[0]; group=coal(pid)
    if not group or not group[0]: return {'error':'Margin coalition unread; no aggregate claimed','at':time.time(),'app_pid':pid}
    members=[]
    for p,n in ps:
        if p==pid or 'com.apple.WebKit.' in n:
            c=coal(p)
            if c and c[0]==group[0]:
                u=usage(p)
                members.append({'pid':p,'kind':'app' if p==pid else n.rsplit('/',1)[-1],'coalition':c,**(u or {'unread':True})})
    helpers=[{'pid':p,**(usage(p) or {})} for p,n in ps if n.endswith('Helpers/margin-helper')]
    complete=any(m['pid']==pid for m in members) and all(not m.get('unread') for m in members)
    return {'at':time.time(),'app_pid':pid,'coalition':group,'coverage':'Margin and attributed WebKit; helper separate','complete':complete,
            'members':members,'helper':helpers,
            'total_footprint':sum(m['footprint'] for m in members) if complete else None,
            'total_resident':sum(m['resident'] for m in members) if complete else None}
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration',type=float,default=0)
    parser.add_argument('--interval',type=float,default=.25)
    args=parser.parse_args()
    if not 0<=args.duration<=600 or not .1<=args.interval<=10: parser.error('duration 0–600 seconds, interval 0.1–10 seconds')
    end=time.monotonic()+args.duration
    while True:
        print(json.dumps(sample()),flush=True)
        if time.monotonic()>=end: break
        time.sleep(args.interval)
