import os from 'node:os';
// Real Pi SDK integration; scripted assistant emits tool calls, never HTTP.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const work=path.resolve(import.meta.dirname,'..');
const sdkPath=process.env.PI_SDK_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent');
const packagesPath=process.env.PI_PACKAGES_DIR??path.join(os.homedir(),'.pi/agent/npm/node_modules');
process.env.DO_NOT_TRACK='1';
process.env.PI_MEMORY_DIR=path.join(work,'fixtures/memory');
process.env.XDG_CONFIG_HOME=path.join(work,'fixtures/xdg-config');
process.env.XDG_CACHE_HOME=path.join(work,'fixtures/xdg-cache');
process.env.PI_CODING_AGENT_DIR=path.join(work,'fixtures/integration-agent');
const sdk=await import(pathToFileURL(path.join(sdkPath,'dist/index.js')));
const ai=await import(pathToFileURL(path.join(sdkPath,'node_modules/@earendil-works/pi-ai/dist/index.js')));
sdk.initTheme('dark',false);
const themeModule=await import(pathToFileURL(path.join(sdkPath,'dist/modes/interactive/theme/theme.js')));
const requested=JSON.parse(await fs.readFile(path.join(work,'packages-requested.json'),'utf8'));
const report={generatedAt:new Date().toISOString(),scope:'Real SDK and installed extensions; scripted provider; offline MCP fixture; no real LLM or Jev requests',runtime:{node:process.version,sdkPath,packagesPath},cases:[],sessions:[],limitations:[]};
const cwd=path.join(work,'test-project');
await fs.mkdir(cwd,{recursive:true});
await fs.writeFile(path.join(cwd,'package.json'),JSON.stringify({name:'pi-compatibility-fixture',version:'1.0.0',scripts:{test:'node sample.mjs'}}));
await fs.writeFile(path.join(cwd,'sample.mjs'),'export function compatibilityAdd(a,b){return a+b;}\n');
let counter=0;
async function makeSession(names,{mode='on',planTools,mcp=true,label='session',captureUI=false,sessionManager}={}) {
  const agentDir=path.join(work,'fixtures',`${label}-${++counter}`);
  process.env.PI_CODING_AGENT_DIR=agentDir;
  await fs.mkdir(agentDir,{recursive:true});
  await fs.writeFile(path.join(agentDir,'pi-goal-x-settings.json'),JSON.stringify({maxAutonomousRuns:0,disabled:true,stallTimeoutMinutes:0}));
  if(planTools) await fs.writeFile(path.join(agentDir,'pi-plan-mode.json'),JSON.stringify({thinkingLevel:'inherit',defaultPlanTools:planTools}));
  await fs.writeFile(path.join(agentDir,'sandbox.json'),JSON.stringify({enabled:true,permissionPromptTimeoutSeconds:1,network:{allowedDomains:[],deniedDomains:[]},filesystem:{denyRead:[],allowRead:[cwd],allowWrite:[cwd],denyWrite:[path.join(cwd,'.env'),path.join(cwd,'forbidden.txt'),path.join(cwd,'forbidden-screenshot.png')]}}));
  if(mcp){await fs.writeFile(path.join(cwd,'mcp-sentinel.txt'),'unchanged');await fs.writeFile(path.join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(work,'tests/mcp-fixture.mjs'),cwd],exposure:'codemode',timeout:5}}}));}
  const settingsManager=sdk.SettingsManager.inMemory({defaultTools:['+codemode','+tool_search'],codemode:{mode,inlineBudget:1500},retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:true});
  const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,additionalExtensionPaths:names.map(n=>path.join(packagesPath,n)),extensionFactories:[sdk.createCodemodeExtension(),sdk.createToolSearchExtension(),sdk.createMcpExtension()],noSkills:true,noPromptTemplates:true,noContextFiles:true});
  await resourceLoader.reload({resolveProjectTrust:async()=>true});
  const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  const model=modelRuntime.getModels('anthropic')[0];
  await modelRuntime.setRuntimeApiKey('anthropic','offline-harness-placeholder');
  const {session,extensionsResult}=await sdk.createAgentSession({cwd,agentDir,resourceLoader,settingsManager,modelRuntime,model,sessionManager:sessionManager??sdk.SessionManager.inMemory(cwd)});
  const errors=[],events=[],notifications=[],prompts=[];
  const uiContext=captureUI?{theme:themeModule.theme,notify:(message,type)=>notifications.push({message,type}),confirm:async(...args)=>{prompts.push({kind:'confirm',args});return false},select:async(...args)=>{prompts.push({kind:'select',args});return undefined},input:async()=>undefined,custom:async()=>{prompts.push({kind:'custom'});return undefined},setStatus(){},setWidget(){},setFooter(){},setHeader(){},setTitle(){},setWorkingMessage(){},setEditorText(){},pasteToEditor(){},setEditorComponent(){},setAutocompleteProvider(){},getEditorText(){return ''},getAllThemes(){return []},getTheme(){return themeModule.theme},setTheme(){return {success:true}},getEditorExpansion(){return false},setEditorExpansion(){},getTerminalSize(){return {columns:80,rows:24}}}:undefined;
  await session.bindExtensions({onError:e=>errors.push(e),...(uiContext?{uiContext}:{})});
  let pending;
  session.agent.getApiKey=async()=>undefined;
  session.agent.streamFunction=async()=>{
    const stream=new ai.AssistantMessageEventStream();
    const message={role:'assistant',content:pending?[{type:'toolCall',id:`offline-${++counter}`,name:pending.name,arguments:pending.args}]:[{type:'text',text:'Offline scripted response. No external model request.'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:pending?'toolUse':'stop',timestamp:Date.now()};
    pending=undefined;stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  session.subscribe(e=>{if(e.type.startsWith('tool_execution'))events.push(e)});
  const inventory={label,mode,requestedPackages:names,loadedExtensions:extensionsResult.extensions.map(e=>({path:e.path,commands:[...e.commands.keys()],tools:[...e.tools.keys()],shortcuts:[...e.shortcuts.keys()]})),loadErrors:extensionsResult.errors,loadWarnings:extensionsResult.warnings??[],runtimeErrors:errors,notifications,prompts,activeTools:session.getActiveToolNames(),allTools:session.getAllTools().map(t=>({name:t.name,parameters:t.parameters,source:t.source,exposure:t.exposure}))};
  report.sessions.push(inventory);
  async function call(name,args){events.length=0;const before=session.messages.length;const activeBefore=session.getActiveToolNames();const callableBefore=session.getCallableToolNames();pending={name,args};await session.prompt('Offline compatibility fixture test');return {result:session.messages.slice(before).filter(m=>m.role==='toolResult').at(-1),events:[...events],activeBefore,callableBefore};}
  async function command(text){const before=errors.length;await session.prompt(text);return {errors:errors.slice(before),entries:session.sessionManager.getEntries().filter(e=>e.type==='custom').map(e=>({customType:e.customType,data:e.data}))};}
  if(mcp){await call('codemode',{code:'text(ALL_TOOLS.filter(t=>t.name.includes("fixture")));'});inventory.mcpReadiness=session.getAllTools().filter(t=>t.name.includes('fixture')).map(t=>t.name);}
  return {session,modelRuntime,call,command,errors,inventory,dispose:()=>session.dispose()};
}
function content(value){return (value?.result?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');}
async function check(id,group,fn){try{const evidence=await fn();report.cases.push({id,group,status:evidence.pass===false?'failed':'passed',...evidence});}catch(e){report.cases.push({id,group,status:'blocked',error:e.stack??String(e)});}await fs.writeFile(path.join(work,'test-results.json'),JSON.stringify(report,null,2));console.log(`${id}: ${report.cases.at(-1).status}`);}
const full=await makeSession(requested,{label:'all-17'});
await check('all-17-load',0,async()=>({pass:full.inventory.loadErrors.length===0&&requested.every(n=>full.inventory.loadedExtensions.some(e=>e.path.includes(`/${n}/`))),evidence:full.inventory}));
await check('native-mcp-local-roundtrip',0,async()=>{const x=await full.call('codemode',{code:'text(await tools.mcp__fixture__fixture_read({}));'});return {pass:content(x).includes('unchanged'),evidence:x}});
await check('native-jev-catalog-missing-auth',0,async()=>{const models=full.modelRuntime.getModelsOfType('classifier').map(m=>({provider:m.provider,id:m.id}));const auth={typesafe:(await full.modelRuntime.checkAuth('typesafe'))??null,openrouter:(await full.modelRuntime.checkAuth('openrouter'))??null};return {pass:models.some(m=>m.provider==='typesafe'&&m.id==='jev-latest'),evidence:{models,auth},limitation:'Catalog and credential checks only; no real classification without key.'}});
await check('full-stack-read',0,async()=>{const x=await full.call('codemode',{code:'text(await tools.read({path:"sample.mjs"}));'});return {pass:content(x).includes('compatibilityAdd'),evidence:x}});
await check('question-headless-cancel-contract',14,async()=>{const tool=full.session.getAllTools().find(t=>t.name==='ask_user_question');return {pass:!!tool,evidence:{schema:tool?.parameters},limitation:'TUI response and cancellation need interactive UI; registration only.'}});
await check('fff-search',12,async()=>{const tool=full.session.getAllTools().find(t=>t.name==='ffgrep');if(!tool)throw new Error('FFF search tool absent');const x=await full.call(tool.name,{query:'compatibilityAdd',pattern:'compatibilityAdd'});return {pass:!x.result?.isError,evidence:{schema:tool.parameters,...x}}});
await check('profile-debug-commands',12,async()=>({pass:['profile','debug'].every(n=>full.inventory.loadedExtensions.some(e=>e.commands.includes(n))),evidence:full.inventory.loadedExtensions.filter(e=>e.path.includes('profile')||e.path.includes('debug')),limitation:'No real debug hypothesis/LLM repair performed.'}));
await check('subagents-list-without-auth',5,async()=>{const enable=await full.call('subagents_enable',{});const x=await full.call('subagent',{action:'list',capabilities:true});return {pass:!x.result?.isError,evidence:{enable,...x},limitation:'Real discovery only. Child provider execution cannot be certified with absent credentials.'}});
await check('profile-run-checks',12,async()=>{const x=await full.call('run_checks',{tier:'test'});return {pass:!x.result?.isError,evidence:x,limitation:'Fixture project only; checks may explicitly require user configuration.'}});
await check('debug-headless-reproduction',12,async()=>{await full.command('/debug');const x=await full.call('debug_reproduction',{title:'Offline reproduction fixture',steps:['Read sample.mjs','Observe compatibilityAdd']});return {pass:!!x.result,evidence:x,limitation:'Headless checkpoint behavior only; no model-driven bug fix.'}});
await check('memory-write-read',11,async()=>{const schemas=full.session.getAllTools().filter(t=>['memory_write','memory_read'].includes(t.name));const x=await full.call('memory_write',{target:'long_term',content:'Compatibility decision: use offline fixtures only.',mode:'overwrite'});const y=await full.call('memory_read',{target:'long_term'});return {pass:!x.result?.isError&&content(y).includes('offline fixtures'),evidence:{schemas,write:x,read:y}}});
full.dispose();
const lifecycleNames=['@narumitw/pi-plan-mode','pi-goal-x','@juicesharp/rpiv-todo','pi-memory','pi-subagents'];
const lifecycle=await makeSession(lifecycleNames,{label:'goal-todo-lifecycle'});
await lifecycle.call('subagents_enable',{});
await lifecycle.command('/plan start');
await check('plan-blocks-goal-create-and-subagent-default',5,async()=>{const goal=await lifecycle.call('create_goal',{objective:'Offline fixture objective'});const child=await lifecycle.call('subagent',{agent:'worker',task:'Write sentinel.txt',async:false,timeoutMs:2000});return {pass:!!goal.result?.isError&&!!child.result?.isError,evidence:{goal,child},limitation:'Default deny prevents child dispatch; does not prove inherited restrictions after subagent opt-in.'}});
await lifecycle.command('/plan exit');
await check('goal-create-after-plan-exit',6,async()=>{const create=await lifecycle.call('create_goal',{objective:'Offline fixture objective: verify local data only.'});const get=await lifecycle.call('get_goal',{verbose:true});return {pass:!create.result?.isError&&content(get).includes('Offline fixture objective'),evidence:{create,get},setup:'maxAutonomousRuns=0, completion auditor disabled in isolated settings; no real planning or approval UI.'}});
await check('goal-tasks-and-independent-todo',7,async()=>{
  const tasks=await lifecycle.call('set_goal_tasks',{tasks:[{id:'fixture-task',title:'Verify fixture goal task'}]});
  const update=await lifecycle.call('update_goal_task',{task_id:'fixture-task',status:'start'});
  const before=await lifecycle.call('todo',{action:'list'});
  const create=await lifecycle.call('todo',{action:'create',subject:'Independent fixture todo'});
  const after=await lifecycle.call('todo',{action:'list'});
  const goal=await lifecycle.call('get_goal',{section:'tasks',verbose:true});
  return {pass:!tasks.result?.isError&&!create.result?.isError&&content(after).includes('Independent fixture todo')&&!content(before).includes('fixture-task'),evidence:{tasks,update,before,create,after,goal},limitation:'Task update tool unavailable after maxAutonomousRuns=0 pauses goal; creation/list persistence exercised. No automatic synchronization expected; the task trees are independent.'};
});
const manager=lifecycle.session.sessionManager;
const firstKept=manager.getBranch().find(e=>e.type==='message')?.id??null;
manager.appendCompaction('SYNTHETIC OFFLINE TEST SUMMARY: preserve fixture goal and todo state. This is not a model-generated summary.',firstKept,1000,{offlineFixture:true},true);
lifecycle.dispose();
const restored=await makeSession(lifecycleNames,{label:'restored-fixture',sessionManager:manager});
await check('memory-goal-todo-restore-synthetic-compaction',11,async()=>{const memory=await restored.call('memory_read',{target:'long_term'});const goal=await restored.call('get_goal',{section:'tasks',verbose:true});const todo=await restored.call('todo',{action:'list'});return {pass:content(memory).includes('offline fixtures')&&content(goal).includes('fixture-task')&&content(todo).includes('Independent fixture todo'),evidence:{memory,goal,todo,compaction:manager.getBranch().filter(e=>e.type==='compaction')},limitation:'Session restoration over an explicitly synthetic SDK compaction entry. Does not certify real model compaction quality.'}});
restored.dispose();
for(const mode of ['on','only']){
  const p=await makeSession(['@narumitw/pi-plan-mode'],{mode,label:`plan-${mode}`,planTools:['read','bash','codemode','mcp__fixture__fixture_read']});
  await p.command('/plan start');
  await check(`plan-${mode}-nested-read`,1,async()=>{const x=await p.call('codemode',{code:'text(await tools.read({path:"sample.mjs"}));'});return {pass:content(x).includes('compatibilityAdd'),evidence:x}});
  for(const operation of ['write','edit','bash','mcp']) await check(`plan-${mode}-deny-${operation}`,1,async()=>{
    await fs.writeFile(path.join(cwd,'sentinel.txt'),'unchanged');await fs.writeFile(path.join(cwd,'mcp-sentinel.txt'),'unchanged');
    const code={write:'text(await tools.write({path:"sentinel.txt",content:"MUTATED"}));',edit:'text(await tools.edit({path:"sentinel.txt",oldText:"unchanged",newText:"MUTATED"}));',bash:'text(await tools.bash({command:"printf MUTATED > sentinel.txt"}));',mcp:'text(await tools.mcp__fixture__fixture_write({text:"MUTATED"}));'}[operation];
    const x=await p.call('codemode',{code});const sentinel=await fs.readFile(path.join(cwd,operation==='mcp'?'mcp-sentinel.txt':'sentinel.txt'),'utf8');
    return {pass:sentinel==='unchanged'&&x.events.some(e=>e.parentToolCallId&&e.isError),evidence:{...x,sentinel}};
  });
  await check(`plan-${mode}-question-headless`,14,async()=>{const x=await p.call('plan_mode_question',{questions:[{id:'scope',header:'Scope',question:'Fixture option?',options:[{label:'Local',description:'Keep fixture local'},{label:'Cancel',description:'Cancel operation'}]}]});return {pass:!!x.result,evidence:x,limitation:'NoUI cannot prove form rendering or selecting/cancelling.'}});
  p.dispose();
  const a=await makeSession(['@dreki-gg/pi-ask-mode'],{mode,label:`ask-${mode}`});
  await a.command('/ask');
  await check(`ask-${mode}-visibility`,2,async()=>({pass:a.session.getActiveToolNames().includes('codemode'),evidence:{active:a.session.getActiveToolNames(),callable:a.session.getCallableToolNames()},limitation:'Ask removes codemode from active tools; CodeMode-only interaction is unavailable by default.'}));
  // Explicit test opt-in restores CodeMode to inspect nested policy, not default UX.
  a.session.setActiveToolsByName(['read','bash','edit','write','codemode','tool_search']);
  await check(`ask-${mode}-nested-read-after-optin`,2,async()=>{const x=await a.call('codemode',{code:'text(await tools.read({path:"sample.mjs"}));'});return {pass:content(x).includes('compatibilityAdd'),evidence:x}});
  for(const operation of ['write','edit','bash','mcp'])await check(`ask-${mode}-deny-${operation}-after-optin`,2,async()=>{
    await fs.writeFile(path.join(cwd,'sentinel.txt'),'unchanged');await fs.writeFile(path.join(cwd,'mcp-sentinel.txt'),'unchanged');
    const code={write:'text(await tools.write({path:"sentinel.txt",content:"MUTATED"}));',edit:'text(await tools.edit({path:"sentinel.txt",oldText:"unchanged",newText:"MUTATED"}));',bash:'text(await tools.bash({command:"printf MUTATED > sentinel.txt"}));',mcp:'text(await tools.mcp__fixture__fixture_write({text:"MUTATED"}));'}[operation];
    const x=await a.call('codemode',{code});const sentinel=await fs.readFile(path.join(cwd,operation==='mcp'?'mcp-sentinel.txt':'sentinel.txt'),'utf8');return {pass:sentinel==='unchanged',evidence:{...x,sentinel},setup:'CodeMode explicitly re-enabled while Ask remains on'};
  });a.dispose();
}
const sandbox=await makeSession(['pi-sandbox','pi-better-background-tasks'],{label:'sandbox-background',captureUI:true});
for(const nested of [false,true]){
  for(const kind of ['read','allowed-write','denied-write','bash-denied-write'])await check(`sandbox-${nested?'nested':'direct'}-${kind}`,3,async()=>{
    await fs.writeFile(path.join(cwd,'forbidden.txt'),'unchanged');
    const target=kind==='read'?'sample.mjs':kind==='allowed-write'?'allowed.txt':'forbidden.txt';
    const name=kind==='read'?'read':kind==='bash-denied-write'?'bash':'write';
    const args=name==='read'?{path:target}:name==='bash'?{command:'printf MUTATED > forbidden.txt'}:{path:target,content:'MUTATED'};
    const x=await sandbox.call(nested?'codemode':name,nested?{code:`text(await tools.${name}(${JSON.stringify(args)}));`}:args);
    const sentinel=await fs.readFile(path.join(cwd,target),'utf8').catch(()=>'(absent)');
    const pass=kind==='read'?content(x).includes('compatibilityAdd'):kind==='allowed-write'?sentinel==='MUTATED':sentinel==='unchanged';return {pass,evidence:{...x,sentinel}};
  });
}
await check('background-denied-path-policy',4,async()=>{await fs.writeFile(path.join(cwd,'forbidden.txt'),'unchanged');const t=sandbox.session.getAllTools().find(t=>t.name==='bg_task_spawn');if(!t)throw new Error('Background tool absent');const x=await sandbox.call(t.name,{command:'printf MUTATED > forbidden.txt',cwd,name:'offline-fixture',callback:false,timeout_seconds:5});await new Promise(r=>setTimeout(r,700));const sentinel=await fs.readFile(path.join(cwd,'forbidden.txt'),'utf8');return {pass:sentinel==='unchanged'&&!x.result?.isError,evidence:{schema:t.parameters,...x,sentinel}}});
sandbox.dispose();
const browser=await makeSession(['pi-sandbox','pi-agent-browser-native'],{label:'sandbox-browser',captureUI:true,mcp:false});
await check('browser-sandbox-offline-custom-write-policy',9,async()=>{
  const browserSession='pi-offline-compatibility-fixture';
  await fs.writeFile(path.join(cwd,'forbidden.txt'),'unchanged');
  const baseline=await browser.call('write',{path:'forbidden.txt',content:'MUTATED'});
  const open=await browser.call('agent_browser',{args:['--session',browserSession,'open','data:text/html,<html><body><button id="fixture">Offline Fixture</button></body></html>'],timeoutMs:15000});
  const snapshot=await browser.call('agent_browser',{args:['--session',browserSession,'snapshot','-i'],outputPath:path.join(cwd,'forbidden.txt'),timeoutMs:15000});
  const sentinel=await fs.readFile(path.join(cwd,'forbidden.txt'),'utf8');
  const click=await browser.call('agent_browser',{args:['--session',browserSession,'click','#fixture'],timeoutMs:15000});
  const screenshot=await browser.call('agent_browser',{args:['--session',browserSession,'screenshot',path.join(cwd,'browser-fixture.png')],timeoutMs:15000});
  const close=await browser.call('agent_browser',{args:['--session',browserSession,'close'],timeoutMs:10000});
  return {pass:!!baseline.result?.isError&&sentinel==='unchanged',evidence:{baseline,open,snapshot,sentinel,click,screenshot,close},limitation:'Local data URL interaction only; no public network/domain enforcement claim. outputPath write was compared with actual sandbox-blocked write to the same sentinel.'};
});
browser.dispose();
report.limitations.push('No provider calls or real Jev judgments. Browser public network, search result citations, IDE approval UI, real subagent writing, goal completion auditor, real compaction and TUI forms require additional environment/auth checks. Each is mapped explicitly in checklist.');
const groups=[
  [1,'Code Mode + Plan Mode','partial','Nested read/write/edit/bash/MCP tests in on and only; interactive plan approval UI still untested.'],
  [2,'Code Mode + Ask Mode','failed','Ask hides CodeMode; after explicit reenable, native MCP writes are not blocked.'],
  [3,'Code Mode + Sandbox','partial','Direct/nested file and bash sentinels; see runtime errors and individual failures.'],
  [4,'Sandbox + Background Tasks','partial','Real local background child tested; sandbox inheritance is evaluated separately.'],
  [5,'Subagents + Plan + Sandbox','partial','Real discovery and default Plan dispatch denial tested; real child model execution unavailable without model auth, inherited policy after opt-in remains uncertified.'],
  [6,'Plan Mode + Goal-X','partial','Plan blocks create_goal while active; Goal created after Plan exit, autonomous continuation explicitly disabled. Interactive approval and autonomous execution untested.'],
  [7,'Goal-X + rpiv-todo','partial','Both load and registries captured; task synchronization and interaction untested.'],
  [8,'Code Mode + IDE Bridge','blocked','No connected VS Code approval workflow exercised.'],
  [9,'Browser + Sandbox','partial','Offline local data URL browser interaction and custom outputPath policy tested; public network/domain enforcement untested.'],
  [10,'Web Search + Jev + Browser','blocked','No Jev/API credentials; catalogs only.'],
  [11,'Memory + Goal + Compaction','partial','Actual memory write/read; real model compaction and active goal restoration untested.'],
  [12,'FFF + Project Profile + Debug','partial','Actual FFF search attempted, registry/command checks; no model-driven bug repair.'],
  [13,'CC Extensions + Usage + Todo','partial','Loaded registry; narrow PTY smoke handled separately; usage providers unavailable.'],
  [14,'Ask User Question + Plan Mode','partial','Real plan tool called in headless mode; forms, answers/cancellation untested.'],
];
report.checklist=groups.map(([id,name,status,reason])=>{const cases=report.cases.filter(c=>c.group===id);if(cases.some(c=>c.status==='failed'))status='failed';return{id,name,status,reason,cases:cases.map(c=>c.id)}});
await fs.writeFile(path.join(work,'test-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({cases:report.cases.reduce((a,c)=>(a[c.status]=(a[c.status]??0)+1,a),{}),checklist:report.checklist.map(c=>({id:c.id,status:c.status})),results:path.join(work,'test-results.json')}));
// Third-party extensions keep process-wide watchers after dispose. All fixture
// background commands have already finished and MCP process groups are closed
// by Pi's exit hook; exit after persisting results rather than hang indefinitely.
process.exit(0);
