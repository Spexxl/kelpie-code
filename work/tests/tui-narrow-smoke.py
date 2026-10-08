"""Bounded real PTY smoke. Captures output; does not certify visual layout."""
import os, pathlib, pty, select, signal, struct, subprocess, time, fcntl, termios, json, re
work=pathlib.Path(__file__).resolve().parents[1]
node=os.environ.get('PI_TEST_NODE','/home/sll/.nvm/versions/node/v24.21.0/bin/node')
sdk=os.environ.get('PI_SDK_DIR','/home/sll/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent')
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,50,0,0))
env=dict(os.environ,TERM='xterm-256color',DO_NOT_TRACK='1',PI_MEMORY_DIR=str(work/'fixtures/tui-memory'))
env['PATH']=str(pathlib.Path(node).parent)+os.pathsep+env.get('PATH','')
proc=subprocess.Popen([node,sdk+'/dist/cli.js','--tui-mode','regular'],cwd=work/'test-project',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
data=bytearray()
def drain(seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        ready,_,_=select.select([master],[],[],0.1)
        if ready:
            try:data.extend(os.read(master,65536))
            except OSError:return
drain(8)
for command in ['/todos','/usage','/ccstyle']:
    os.write(master,command.encode()+b'\r');drain(1.5);os.write(master,b'\x1b');drain(.3)
os.write(master,b'\x03');drain(.4);os.write(master,b'\x03');drain(.5)
if proc.poll() is None:
    os.killpg(proc.pid,signal.SIGTERM)
    try:proc.wait(2)
    except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
os.close(master)
text=data.decode(errors='replace')
(work/'tests/tui-narrow.raw.log').write_text(text)
clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text)
clean=re.sub(r'\x1b\][^\x07]*\x07','',clean)
(work/'tests/tui-narrow.log').write_text(clean)
result={'columns':50,'rows':24,'exitCode':proc.returncode,'bytesCaptured':len(data),'commandsSent':['/todos','/usage','/ccstyle'],'fatalMarkers':[x for x in ['TypeError:','ReferenceError:','UnhandledPromiseRejection','Extension failed'] if x in clean],'limitation':'Real TUI startup and command input at narrow width; no screenshot/visual assertion or authenticated usage data.'}
result['startupObserved']=len(data)>100 and not result['fatalMarkers']
result['pass']=None
result['status']='partial' if result['startupObserved'] else 'blocked'
result['limitation']+=' PTY lacks a terminal emulator, so commands sent are not equivalent to verified rendered dialogs. Controlled process termination is recorded.'
(work/'tui-narrow-smoke.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
