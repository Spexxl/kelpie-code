import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'pi-watch-preparation-'));
const previousTmp=process.env.TMPDIR;
process.env.TMPDIR=root;
const sdk=process.env.PI_SDK_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent');
const base=process.env.BG_EXTENSION??new URL('..',import.meta.url).pathname;
const {createJiti}=await import(join(sdk,'node_modules/jiti/lib/jiti.mjs'));
const jiti=createJiti(import.meta.url,{fsCache:false});
const runtime=await jiti.import(join(base,'src/runtime.ts'));
const registry=await jiti.import(join(base,'src/registry.ts'));
after(()=>{runtime.suspendScheduledWork();if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;rmSync(root,{recursive:true,force:true});});

async function pausedWatch(label) {
 runtime.resumeScheduledWork();
 let calls=0, release, ready;
 const waiting=new Promise(resolve=>{ready=resolve});
 const pi={events:{emit(_channel,request){request.provide({prepare:async()=>{
  if(++calls===2){ready();await new Promise(resolve=>{release=resolve});}
  return {confined:false,notice:'Sandbox: UNCONFINED (explicit fixture opt-out).'};
 }})}},sendMessage(){}};
 const marker=join(root,label+'.txt');
 const meta=await runtime.startWatchTask(pi,{command:`printf MUTATED > '${marker}'; printf WAIT`,callback:false,interval_seconds:60,timeout_seconds:10,success_when:{type:'stdout_contains',value:'DONE'},blind_checks:0},root);
 let timeout;
 await Promise.race([waiting,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('watch did not reach preparation')),3000)})]);
 clearTimeout(timeout);
 return {pi,meta,marker,release:()=>release()};
}

test('cancelled watch cannot launch after async preparation completes',async()=>{
 const s=await pausedWatch('cancelled');
 try {
  assert.equal((await runtime.stopTask(s.pi,s.meta.id)).status,'cancelled');
  assert.equal(existsSync(s.marker),false);
  s.release();
  await runtime.awaitFirstWatchCheck(s.meta.id,3000);
  assert.equal(existsSync(s.marker),false);
 } finally {s.release();runtime.suspendScheduledWork();}
});

test('suspend and resume cannot revive an old in-flight watch preparation',async()=>{
 const s=await pausedWatch('suspended');
 try {
  runtime.suspendScheduledWork();runtime.resumeScheduledWork();
  s.release();
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(existsSync(s.marker),false);
 } finally {s.release();await runtime.stopTask(s.pi,s.meta.id);runtime.suspendScheduledWork();}
});

test('watch deadline expiring during preparation prevents command launch',async()=>{
 const s=await pausedWatch('deadline');
 try {
  const latest=registry.readMeta(s.meta.id);latest.deadlineAt=Date.now()-1;registry.writeMeta(latest);
  s.release();await runtime.awaitFirstWatchCheck(s.meta.id,3000);
  assert.equal(existsSync(s.marker),false);
  assert.equal(registry.readMeta(s.meta.id).status,'timed_out');
 } finally {s.release();await runtime.stopTask(s.pi,s.meta.id);runtime.suspendScheduledWork();}
});

test('watch persists and logs a change to explicit unconfined execution',async()=>{
 runtime.resumeScheduledWork();let calls=0;
 const pi={events:{emit(_channel,request){request.provide({prepare:async()=>++calls===1?
  {confined:true,notice:'Sandbox: policy applied.',argv:['/bin/true'],launchEnv:{PATH:'/usr/bin:/bin'}}:
  {confined:false,notice:'Sandbox: UNCONFINED (explicit fixture opt-out).'}
 })}},sendMessage(){}};
 const meta=await runtime.startWatchTask(pi,{command:'printf WAIT',callback:false,interval_seconds:60,timeout_seconds:10,success_when:{type:'stdout_contains',value:'DONE'},blind_checks:0},root);
 try {
  await runtime.awaitFirstWatchCheck(meta.id,3000);
  assert.match(registry.readMeta(meta.id).sandboxNotice,/UNCONFINED/);
  assert.match(readFileSync(meta.logPath,'utf8'),/UNCONFINED/);
 } finally {await runtime.stopTask(pi,meta.id);runtime.suspendScheduledWork();}
});
