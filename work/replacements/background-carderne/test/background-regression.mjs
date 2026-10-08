import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const nodeBase=(process.env.PI_SDK_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent'));
const pkg=(process.env.PI_PACKAGES_DIR??path.join(os.homedir(),'.pi/agent/npm/node_modules'));
const root=path.join(tmpdir(),'pi-bg-regression-'+process.pid);
const realTmp=path.join(root,'tmp');
process.env.TMPDIR=realTmp;
await fs.mkdir(realTmp,{recursive:true});
process.env.DO_NOT_TRACK='1';
await fs.mkdir(process.env.TMPDIR,{recursive:true});
const sdk=await import(pathToFileURL(path.join(nodeBase,'dist/index.js')));
const ai=await import(pathToFileURL(path.join(nodeBase,'node_modules/@earendil-works/pi-ai/dist/index.js')));
sdk.initTheme('dark',false);
const theme=(await import(pathToFileURL(path.join(nodeBase,'dist/modes/interactive/theme/theme.js')))).theme;
let sequence=0;
const cases=[];
const bg=process.env.BG_EXTENSION??path.resolve(import.meta.dirname,'..');
const sb=process.env.SANDBOX_EXTENSION??path.resolve(import.meta.dirname,'../../pi-sandbox-background-bridge');
function content(x){return (x?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')}
async function make({sandbox=true,enabled=true,label='default',cwdOverride,manager,extraDenied=[]}={}){
 const dir=path.join(root,label+'-'+(++sequence)),cwd=cwdOverride??path.join(dir,'project');
 const agentDir=path.join(dir,'agent');
 await fs.mkdir(cwd,{recursive:true});await fs.mkdir(agentDir,{recursive:true});
 process.env.PI_CODING_AGENT_DIR=agentDir;
 const denied=path.join(cwd,'forbidden.txt');
 const config={enabled,network:{allowedDomains:[],deniedDomains:[]},filesystem:{allowRead:[cwd],denyRead:[],allowWrite:[cwd],denyWrite:[denied,...extraDenied]},permissionPromptTimeoutSeconds:1};
 const configPath=path.join(agentDir,'sandbox.json');
 await fs.writeFile(configPath,JSON.stringify(config));await fs.writeFile(denied,'UNCHANGED');
 const settingsManager=sdk.SettingsManager.inMemory({codemode:{mode:'off'},retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:true});
 const loader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,additionalExtensionPaths:sandbox?[sb,bg]:[bg],noSkills:true,noPromptTemplates:true,noContextFiles:true});
 await loader.reload({resolveProjectTrust:async()=>true});
 const runtime=await sdk.ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
 const model=runtime.getModels('anthropic')[0];
 await runtime.setRuntimeApiKey('anthropic','offline-fixture');
 const {session,extensionsResult}=await sdk.createAgentSession({cwd,agentDir,resourceLoader:loader,settingsManager,modelRuntime:runtime,model,sessionManager:manager??sdk.SessionManager.inMemory(cwd)});
 assert.equal(extensionsResult.errors.length,0,JSON.stringify(extensionsResult.errors));
 const errors=[],notifications=[];
 await session.bindExtensions({onError:e=>errors.push(e),uiContext:{theme,notify:(message,type)=>notifications.push({message,type}),confirm:async()=>false,select:async()=>undefined,input:async()=>undefined,custom:async()=>undefined,setStatus(){},setWidget(){},setFooter(){},setHeader(){},setTitle(){},setWorkingMessage(){},setEditorText(){},pasteToEditor(){},setEditorComponent(){},setAutocompleteProvider(){},getEditorText(){return ''},getAllThemes(){return []},getTheme(){return theme},setTheme(){return {success:true}},getEditorExpansion(){return false},setEditorExpansion(){},getTerminalSize(){return {columns:80,rows:24}}}});
 let pending;
 session.agent.getApiKey=async()=>undefined;
 session.agent.streamFunction=async()=>{
 const stream=new ai.AssistantMessageEventStream();
 const message={role:'assistant',content:pending?[{type:'toolCall',id:'test-'+(++sequence),name:pending.name,arguments:pending.args}]:[{type:'text',text:'offline'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:pending?'toolUse':'stop',timestamp:Date.now()};
 pending=undefined;stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;};
 async function call(name,args){let n=session.messages.length;pending={name,args};await session.prompt('Offline SDK fixture');return session.messages.slice(n).filter(m=>m.role==='toolResult').at(-1)}
 const s={session,cwd,dir,agentDir,denied,config,configPath,call,errors,notifications,close:()=>session.dispose()};
 return s;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function record(name,fn){try{await fn();cases.push({name,status:'passed'});}catch(e){cases.push({name,status:'failed',error:e.message});}console.log(JSON.stringify(cases.at(-1)))}
async function taskWait(s,id){for(let i=0;i<80;i++){let text=content(await s.call('bg_task_status',{id,verbose:true}));if(/succeeded|failed|cancelled|timed_out/.test(text))return text;await pause(100)}throw new Error('Task did not finish')}
function taskId(x){return /\bid=(\S+)/.exec(content(x))?.[1]?? /\b(bg_[\w-]+)/.exec(content(x))?.[1]??/\b(task-[\w-]+)/.exec(content(x))?.[1]}
const s=await make({label:'protected'});
await record('operational-builtin-control',async()=>{await s.call('bash',{command:'printf MUTATED > forbidden.txt'});assert.equal(await fs.readFile(s.denied,'utf8'),'UNCHANGED',JSON.stringify(s.notifications));assert(!s.notifications.some(n=>n.message.includes('initialization failed')),JSON.stringify(s.notifications));});
for(const [name,args] of [['bg_task_spawn',{command:'printf MUTATED > forbidden.txt'}],['bg_task',{action:'spawn',command:'printf MUTATED > forbidden.txt'}],['bg_task_spawn',{argv:['/bin/sh','-c','printf MUTATED > forbidden.txt'],shell:false}],['bg_task_watch',{command:'printf MUTATED > forbidden.txt',success_when:{type:'exit_code',equals:0},timeout_seconds:2,interval_seconds:1}],['bg_task',{action:'watch',command:'printf MUTATED > forbidden.txt',success_when:{type:'exit_code',equals:0},timeout_seconds:2,interval_seconds:1}]]){
await record('denied-'+name+'-'+(args.shell===false?'argv':args.action??'dedicated'),async()=>{await fs.writeFile(s.denied,'UNCHANGED');const x=await s.call(name,{...args,callback:false,timeout_seconds:args.timeout_seconds??3});await pause(500);assert.equal(await fs.readFile(s.denied,'utf8'),'UNCHANGED',content(x));});
}
await record('allowed-long-job-is-nonblocking-and-cancellable',async()=>{const now=Date.now();const x=await s.call('bg_task_spawn',{command:'printf STARTED > allowed.txt; sleep 20; printf FINISHED >> allowed.txt',callback:false,timeout_seconds:25});assert(Date.now()-now<4000,content(x));const id=taskId(x);assert(id,content(x));await pause(500);assert.equal(await fs.readFile(path.join(s.cwd,'allowed.txt'),'utf8'),'STARTED');assert(content(await s.call('bg_task_log',{id})));const stop=await s.call('bg_task_stop',{id});assert(content(stop).includes('cancelled'),content(stop));await pause(400);assert.equal(await fs.readFile(path.join(s.cwd,'allowed.txt'),'utf8'),'STARTED');});
await record('alternate-cwd-cannot-change-policy',async()=>{const outside=path.join(s.dir,'outside');await fs.mkdir(path.join(outside,'.pi'),{recursive:true});await fs.writeFile(path.join(outside,'.pi','sandbox.json'),JSON.stringify({enabled:false}));const x=await s.call('bg_task_spawn',{command:'printf MUTATED > '+s.denied,cwd:outside,callback:false,timeout_seconds:3});await pause(400);assert.equal(await fs.readFile(s.denied,'utf8'),'UNCHANGED',content(x));});
await record('symlink-and-dotdot-paths-cannot-escape',async()=>{const outside=path.join(s.dir,'outside');await fs.mkdir(outside,{recursive:true});const target=path.join(outside,'sentinel.txt');await fs.writeFile(target,'UNCHANGED');await fs.symlink(target,path.join(s.cwd,'symlink.txt'));await s.call('bg_task_spawn',{command:'printf MUTATED > symlink.txt; printf MUTATED > ../outside/sentinel.txt',callback:false,timeout_seconds:3});await pause(400);assert.equal(await fs.readFile(target,'utf8'),'UNCHANGED');});
await record('shell-env-is-applied-inside-confinement',async()=>{const payload=path.join(s.cwd,'payload.sh');await fs.writeFile(payload,'printf MUTATED > '+s.denied+'\n');const x=await s.call('bg_task_spawn',{command:'printf %s "$FIXTURE_VALUE" > env.txt',env:{FIXTURE_VALUE:"literal value $() ' spaces",BASH_ENV:payload},callback:false,timeout_seconds:3});await pause(500);assert.equal(await fs.readFile(s.denied,'utf8'),'UNCHANGED',content(x));assert.equal(await fs.readFile(path.join(s.cwd,'env.txt'),'utf8'),"literal value $() ' spaces");});
await record('registry-control-plane-is-not-writable',async()=>{const target=path.join(process.env.TMPDIR,'pi-better-background-tasks','tampered.txt');const x=await s.call('bg_task_spawn',{command:'printf MUTATED > '+target,callback:false,timeout_seconds:3});await pause(500);assert.equal(await fs.readFile(target,'utf8').catch(()=>null),null,content(x));});
await record('bridge-source-is-not-writable',async()=>{const target=path.join(sb,'src','bridge-tampered.txt');const x=await s.call('bg_task_spawn',{command:'printf MUTATED > '+target,callback:false,timeout_seconds:3});await pause(500);assert.equal(await fs.readFile(target,'utf8').catch(()=>null),null,content(x));});
await record('live-watch-reloads-current-policy',async()=>{const target=path.join(s.cwd,'watch-live.txt');const x=await s.call('bg_task_watch',{command:'printf MUTATED > watch-live.txt; printf WAIT',success_when:{type:'stdout_contains',value:'DONE'},callback:false,interval_seconds:1,timeout_seconds:5,blind_checks:0});const id=taskId(x);assert(id,content(x));assert.equal(await fs.readFile(target,'utf8'),'MUTATED');s.config.filesystem.denyWrite.push(target);await fs.writeFile(s.configPath,JSON.stringify(s.config));await fs.writeFile(target,'UNCHANGED');await pause(1400);assert.equal(await fs.readFile(target,'utf8'),'UNCHANGED');await s.call('bg_task_stop',{id});});
await record('malformed-global-policy-blocks-launch',async()=>{
 try {
  await fs.writeFile(s.configPath,'{"filesystem":');
  await fs.writeFile(s.denied,'UNCHANGED');
  const result=await s.call('bg_task_spawn',{command:'printf MUTATED > forbidden.txt',callback:false,timeout_seconds:3});
  await pause(400);
  assert.equal(await fs.readFile(s.denied,'utf8'),'UNCHANGED',content(result));
  assert(/blocked|policy|config/i.test(content(result)),content(result));
 } finally {await fs.writeFile(s.configPath,JSON.stringify(s.config));await fs.writeFile(s.denied,'UNCHANGED');}
});
await record('malformed-trusted-project-policy-blocks-launch',async()=>{
 const projectPolicy=path.join(s.cwd,'.pi','sandbox.json'),target=path.join(s.cwd,'project-policy-sentinel.txt');
 try {
  await fs.mkdir(path.dirname(projectPolicy),{recursive:true});
  await fs.writeFile(projectPolicy,'{"filesystem":');
  await fs.writeFile(target,'UNCHANGED');
  const result=await s.call('bg_task_spawn',{command:'printf MUTATED > project-policy-sentinel.txt',callback:false,timeout_seconds:3});
  await pause(400);
  assert.equal(await fs.readFile(target,'utf8'),'UNCHANGED',content(result));
  assert(/blocked|policy|config/i.test(content(result)),content(result));
 } finally {await fs.rm(projectPolicy,{force:true});}
});
await record('structured-SSH-does-not-claim-local-protection',async()=>{const x=await s.call('bg_task_spawn',{command:'printf unsafe',ssh:{host:'127.0.0.1'},callback:false});assert(/blocked|cannot inherit|remote protection/i.test(content(x)),content(x));});
const http=await import('node:http');
const server=http.createServer((req,res)=>{server.hits++;res.end('host');});server.hits=0;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await record('network-policy-denies-direct-host-socket',async()=>{const x=await s.call('bg_task_spawn',{command:'curl --noproxy "*" --max-time 1 http://127.0.0.1:'+server.address().port,callback:false,timeout_seconds:3});await pause(1400);assert.equal(server.hits,0,content(x));});
server.close();

s.close();
const absent=await make({sandbox:false,label:'missing'});
await record('missing-bridge-fails-closed',async()=>{const x=await absent.call('bg_task_spawn',{command:'printf MUTATED > forbidden.txt',callback:false});await pause(200);assert.equal(await fs.readFile(absent.denied,'utf8'),'UNCHANGED',content(x));assert(/blocked|unavailable|bridge/i.test(content(x)),content(x));});absent.close();
const off=await make({enabled:false,label:'explicit-off'});
await record('explicit-off-is-visible-and-preserves-choice',async()=>{const x=await off.call('bg_task_spawn',{command:'printf MUTATED > forbidden.txt',callback:false,timeout_seconds:2});await pause(400);assert.equal(await fs.readFile(off.denied,'utf8'),'MUTATED');assert(/unconfined|disabled|off/i.test(content(x)),content(x));});off.close();
const invalid=await make({enabled:0,label:'invalid-enabled'});
await record('invalid-enabled-is-not-an-unconfined-opt-out',async()=>{const x=await invalid.call('bg_task_spawn',{command:'printf MUTATED > forbidden.txt',callback:false,timeout_seconds:2});await pause(400);assert.equal(await fs.readFile(invalid.denied,'utf8'),'UNCHANGED',content(x));assert(/blocked|failed|policy|config/i.test(content(x)),content(x));});invalid.close();
const original=await make({label:'resume-origin'});
const target=path.join(original.cwd,'resumed-target.txt');
const launched=await original.call('bg_task_watch',{command:'printf MUTATED > resumed-target.txt; printf WAIT',success_when:{type:'stdout_contains',value:'DONE'},callback:false,interval_seconds:1,timeout_seconds:7,blind_checks:0});
const resumedId=taskId(launched);assert(resumedId,content(launched));
const oldManager=original.session.sessionManager;original.close();
const resumed=await make({label:'resumed',cwdOverride:original.cwd,manager:oldManager,extraDenied:[target]});
await fs.writeFile(target,'UNCHANGED');
await record('resumed-watch-rebuilds-wrapper-under-current-policy',async()=>{await pause(1500);assert.equal(await fs.readFile(target,'utf8'),'UNCHANGED');const state=content(await resumed.call('bg_task_status',{id:resumedId,verbose:true}));assert(/lastCheckedAt/.test(state),state);await resumed.call('bg_task_stop',{id:resumedId});});
resumed.close();

await fs.writeFile(path.join(import.meta.dirname,'background-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),cases},null,2));
console.log(JSON.stringify({total:cases.length,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length}));
process.exit(cases.some(c=>c.status==='failed')?1:0);
