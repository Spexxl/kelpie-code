import os from 'node:os';
// Real Pi SDK integration; scripted assistant emits tool calls, never HTTP.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const work=path.resolve(import.meta.dirname,'..');
const outDir=process.env.ASK_TEST_OUTPUT_DIR??`/tmp/pi-ask-regression-${process.pid}`;
const resultPath=process.env.ASK_TEST_RESULT??path.join(work,'replacements/ask-fork-results.json');
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
const cwd=path.join(outDir,'ask-candidate-fixture');
await fs.mkdir(cwd,{recursive:true});
await fs.writeFile(path.join(cwd,'package.json'),JSON.stringify({name:'pi-compatibility-fixture',version:'1.0.0',scripts:{test:'node sample.mjs'}}));
await fs.writeFile(path.join(cwd,'sample.mjs'),'export function compatibilityAdd(a,b){return a+b;}\n');
let counter=0;
async function makeSession(names,{mode='on',planTools,mcp=true,label='session',captureUI=true,sessionManager,externalBusy=false,cliMode,configKind='strict'}={}) {
  const agentDir=path.join(outDir,`${label}-${++counter}`);
  process.env.PI_CODING_AGENT_DIR=agentDir;
  await fs.mkdir(agentDir,{recursive:true});
  if(configKind!=='missing')await fs.writeFile(path.join(agentDir,'modes.config.json'),configKind==='malformed'?'{"modes":':configKind==='null-modes'?'{"modes":null}':configKind==='null-ask'?'{"modes":{"ask":null}}':JSON.stringify({defaultMode:'build',modes:{ask:{allowTools:['codemode','tool_search','mcp__fixture__fixture_read'],blockUnknownTools:true,thinkingLevel:null,bash:'deny'},plan:{enabled:false},review:{enabled:false},debug:{enabled:false},yolo:{enabled:false}}}));
  await fs.writeFile(path.join(agentDir,'pi-goal-x-settings.json'),JSON.stringify({maxAutonomousRuns:0,disabled:true,stallTimeoutMinutes:0}));
  if(planTools) await fs.writeFile(path.join(agentDir,'pi-plan-mode.json'),JSON.stringify({thinkingLevel:'inherit',defaultPlanTools:planTools}));
  await fs.writeFile(path.join(agentDir,'sandbox.json'),JSON.stringify({enabled:true,permissionPromptTimeoutSeconds:1,network:{allowedDomains:[],deniedDomains:[]},filesystem:{denyRead:[],allowRead:[cwd],allowWrite:[cwd],denyWrite:[path.join(cwd,'.env'),path.join(cwd,'forbidden.txt'),path.join(cwd,'forbidden-screenshot.png')]}}));
  if(mcp){await fs.writeFile(path.join(cwd,'mcp-sentinel.txt'),'unchanged');await fs.writeFile(path.join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[path.join(work,'tests/mcp-fixture.mjs'),cwd],exposure:'codemode',timeout:5}}}));}
  const settingsManager=sdk.SettingsManager.inMemory({defaultTools:['+codemode','+tool_search','+grep','+find','+ls'],codemode:{mode,inlineBudget:1500},retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:true});
  const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,additionalExtensionPaths:names.map(n=>n.startsWith('/')?n:path.join(packagesPath,n)),extensionFactories:[(pi)=>{let identity;pi.on('session_start',(_e,ctx)=>{identity=ctx.sessionManager;});pi.events.on('workflow:mutex:v1',x=>{if(externalBusy&&(!identity||x.session===identity)&&x.group==='agent-workflow')x.busy=true;});pi.registerCommand('fixture-add',{description:'Test dynamic tool registration',handler:async()=>{pi.registerTool({...sdk.createWriteToolDefinition(cwd),name:'fixture_dynamic_write',description:'Mutate fixture dynamic marker',annotations:{readOnlyHint:true},exposure:'codemode'});}});},sdk.createCodemodeExtension(),sdk.createToolSearchExtension(),sdk.createMcpExtension()],noSkills:true,noPromptTemplates:true,noContextFiles:true});
  await resourceLoader.reload({resolveProjectTrust:async()=>true});
  const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  const model=modelRuntime.getModels('anthropic')[0];
  await modelRuntime.setRuntimeApiKey('anthropic','offline-harness-placeholder');
  const {session,extensionsResult}=await sdk.createAgentSession({cwd,agentDir,resourceLoader,settingsManager,modelRuntime,model,sessionManager:sessionManager??sdk.SessionManager.inMemory(cwd)});
  if(cliMode)extensionsResult.runtime.flagValues.set('modes',cliMode);
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
  async function call(name,args){events.length=0;const before=session.messages.length;const activeBefore=session.getActiveToolNames();const callableBefore=session.getCallableToolNames();pending={name,args};await session.prompt('Offline compatibility fixture test');await session.waitForIdle();return {result:session.messages.slice(before).filter(m=>m.role==='toolResult').at(-1),events:[...events],activeBefore,callableBefore};}
  async function command(text){const before=errors.length;await session.prompt(text);await session.waitForIdle();console.log('CMD '+text+' ACTIVE '+session.getActiveToolNames().join(','));return {errors:errors.slice(before),entries:session.sessionManager.getEntries().filter(e=>e.type==='custom').map(e=>({customType:e.customType,data:e.data}))};}
  if(mcp){
    // Prime the real MCP extension while Build is active. Merely reading
    // ALL_TOOLS does not connect lazy MCP servers in this SDK version.
    const read=await call('codemode',{code:'text(await tools.mcp__fixture__fixture_read({}));'});
    const write=await call('codemode',{code:'text(await tools.mcp__fixture__fixture_write({text:"build-prime"}));'});
    inventory.mcpPrime={read:content(read),write:content(write)};
    await fs.writeFile(path.join(cwd,'mcp-sentinel.txt'),'unchanged');
    inventory.mcpReadiness=session.getAllTools().filter(t=>t.name.includes('fixture')).map(t=>t.name);
  }
  return {session,modelRuntime,call,command,errors,inventory,extensionsResult,dispose:()=>session.dispose()};
}
function content(value){return (value?.result?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');}

const candidate=process.env.ASK_EXTENSION??path.join(work,'replacements/ask-fork');
const cases=[];
async function test(id, fn) {try{const result=await fn();cases.push({id,...result});}catch(e){cases.push({id,pass:false,error:String(e),stack:e.stack});}console.log(id+': '+cases.at(-1).pass);}
for(const mode of ['on','only']){
 const s=await makeSession([candidate,'@narumitw/pi-plan-mode'],{mode,label:'candidate-'+mode,planTools:['read','bash','codemode','tool_search','mcp__fixture__fixture_read']});
 await test(mode+'-loaded',()=>({pass:s.inventory.loadErrors.length===0&&s.errors.length===0,evidence:s.inventory}));
 const baseline=s.session.getActiveToolNames();
 await s.command('/mode ask');
 await test(mode+'-codemode-visible',()=>({pass:s.session.getActiveToolNames().includes('codemode'),evidence:s.session.getActiveToolNames()}));
 await test(mode+'-read',async()=>{const r=await s.call('codemode',{code:'text(await tools.read({path:"sample.mjs"}));'});return {pass:content(r).includes('compatibilityAdd'),evidence:r}});
 await test(mode+'-mcp-read',async()=>{const r=await s.call('codemode',{code:'text(await tools.mcp__fixture__fixture_read({}));'});return {pass:content(r).includes('unchanged'),evidence:r}});
 for(const name of ['grep','find','ls'])await test(mode+'-readonly-'+name,async()=>{const args=name==='grep'?{pattern:'compatibilityAdd',path:'.'}:name==='find'?{pattern:'*.mjs',path:'.'}:{path:'.'};const r=await s.call('codemode',{code:'text(await tools.'+name+'('+JSON.stringify(args)+'));'});return {pass:!content(r).includes('Blocked')&&!r.result?.isError,evidence:r}});
 for(const nested of [false,true])for(const op of ['write','edit','bash','mcp']){
  const file=op==='mcp'?'mcp-sentinel.txt':'sentinel.txt';await fs.writeFile(path.join(cwd,file),'unchanged');
  const name={write:'write',edit:'edit',bash:'bash',mcp:'mcp__fixture__fixture_write'}[op];
  const args={write:{path:'sentinel.txt',content:'MUTATED'},edit:{path:'sentinel.txt',oldText:'unchanged',newText:'MUTATED'},bash:{command:'printf MUTATED > sentinel.txt'},mcp:{text:'MUTATED'}}[op];
  await test(mode+'-'+(nested?'nested':'direct')+'-'+op,async()=>{const r=await s.call(nested?'codemode':name,nested?{code:'text(await tools.'+name+'('+JSON.stringify(args)+'));'}:args);return {pass:(await fs.readFile(path.join(cwd,file),'utf8'))==='unchanged',evidence:r}});
 }
 for(const command of ['cat sample.mjs','find . -exec touch sentinel.txt \;','awk \'BEGIN { system("touch sentinel.txt") }\'','rg --pre "touch sentinel.txt" x','git -c core.fsmonitor="touch sentinel.txt" status','cat $(touch sentinel.txt)','cat sentinel.txt > sentinel.txt']){
  const r=await s.call('codemode',{code:'text(await tools.bash('+JSON.stringify({command})+'));'});await test(mode+'-shell-'+command,()=>({pass:content(r).includes('Blocked')||content(r).includes('does not exist')||content(r).includes('bash is disabled'),evidence:r}));
 }
 await s.command('/fixture-add');await fs.writeFile(path.join(cwd,'dynamic.txt'),'unchanged');
 await test(mode+'-dynamic-nested',async()=>{const r=await s.call('codemode',{code:'text(await tools.fixture_dynamic_write({path:"dynamic.txt",content:"MUTATED"}));'});return {pass:(await fs.readFile(path.join(cwd,'dynamic.txt'),'utf8'))==='unchanged'&&content(r).includes('Blocked'),evidence:r}});
 await test(mode+'-tool-search-activation',async()=>{const r=await s.call('tool_search',{query:'fixture_dynamic_write',limit:8});const w=await s.call('codemode',{code:'text(await tools.fixture_dynamic_write({path:"dynamic.txt",content:"MUTATED"}));'});return {pass:content(r).includes('fixture_dynamic_write')&&(await fs.readFile(path.join(cwd,'dynamic.txt'),'utf8'))==='unchanged'&&content(w).includes('Blocked'),evidence:{search:r,write:w}}});
 await s.command('/mode build');await test(mode+'-restore',()=>({pass:baseline.every(n=>s.session.getActiveToolNames().includes(n)),evidence:{baseline,active:s.session.getActiveToolNames()}}));
 await s.command('/plan on');const planBaseline=s.session.getActiveToolNames();await s.command('/mode ask');await test(mode+'-ask-refused-during-plan',()=>({pass:planBaseline.every(n=>s.session.getActiveToolNames().includes(n))&&s.inventory.notifications.some(n=>n.message.includes('workflow')),evidence:{baseline:planBaseline,active:s.session.getActiveToolNames(),notifications:s.inventory.notifications}}));await s.command('/mode build');
 await s.command('/mode back');await test(mode+'-back-refused-during-plan',()=>({pass:planBaseline.every(n=>s.session.getActiveToolNames().includes(n)),evidence:s.session.getActiveToolNames()}));const cycle=s.extensionsResult.extensions.find(e=>e.path.includes('ask-fork')||e.path.includes('pi-ask-codemode-local')).shortcuts.values().find(x=>x.description.startsWith('Cycle'));await cycle.handler(s.session.extensionRunner.createContext());await test(mode+'-cycle-refused-during-plan',()=>({pass:planBaseline.every(n=>s.session.getActiveToolNames().includes(n)),evidence:s.session.getActiveToolNames()}));
 await test(mode+'-plan-still-active',()=>({pass:s.session.sessionManager.getBranch().filter(x=>x.type==='custom'&&x.customType==='plan-mode-state').at(-1)?.data.enabled===true,evidence:s.session.getActiveToolNames()}));
 await fs.writeFile(path.join(cwd,'sentinel.txt'),'unchanged');await test(mode+'-plan-write-after-refusal',async()=>{const r=await s.call('codemode',{code:'text(await tools.write({path:"sentinel.txt",content:"MUTATED"}));'});return {pass:(await fs.readFile(path.join(cwd,'sentinel.txt'),'utf8'))==='unchanged'&&content(r).includes('Plan mode blocks'),evidence:r}});
 await s.command('/plan off');await s.command('/mode ask');await s.command('/plan on');await s.command('/plan off');
 await fs.writeFile(path.join(cwd,'sentinel.txt'),'unchanged');const r=await s.call('codemode',{code:'text(await tools.write({path:"sentinel.txt",content:"MUTATED"}));'});
 await test(mode+'-ask-after-plan-toggle',async()=>({pass:(await fs.readFile(path.join(cwd,'sentinel.txt'),'utf8'))==='unchanged',evidence:r}));
 await s.command('/mode build');await test(mode+'-restore-after-plan',()=>({pass:baseline.every(n=>s.session.getActiveToolNames().includes(n)),evidence:{baseline,active:s.session.getActiveToolNames()}}));const last=await s.call('codemode',{code:'text(await tools.write({path:"legit.txt",content:"LEGIT"}));'});await test(mode+'-build-legitimate-write',async()=>({pass:await fs.readFile(path.join(cwd,'legit.txt'),'utf8').catch(()=>null)==='LEGIT',evidence:last}));s.dispose();
}
for(const mode of ['on','only'])for(const kind of ['flag','persisted']){
 const manager=sdk.SessionManager.inMemory(cwd);if(kind==='persisted')manager.appendCustomEntry('pi-modes',{version:2,mode:'ask',previousMode:'build',changedAt:Date.now()});
 const s=await makeSession([candidate],{mode,label:'guard-'+kind,sessionManager:manager,externalBusy:true,cliMode:kind==='persisted'?undefined:'ask',mcp:false});
 await test(mode+'-'+kind+'-busy-startup',()=>({pass:s.session.getActiveToolNames().includes('write')&&s.inventory.notifications.some(n=>n.message.includes('workflow')),evidence:{active:s.session.getActiveToolNames(),notifications:s.inventory.notifications}}));
 manager.appendCustomEntry('pi-modes',{version:2,mode:'ask',previousMode:'build',changedAt:Date.now()});await s.session.extensionRunner.emit({type:'session_tree',newLeafId:manager.getLeafId()});
 await test(mode+'-'+kind+'-busy-tree',()=>({pass:s.session.getActiveToolNames().includes('write'),evidence:{active:s.session.getActiveToolNames(),notifications:s.inventory.notifications}}));s.dispose();
}
for(const mode of ['on','only'])for(const reverse of [false,true])for(const kind of ['flag','persisted','disabled']){
 const manager=sdk.SessionManager.inMemory(cwd);manager.appendCustomEntry('plan-mode-state',{enabled:true,awaitingAction:false});if(kind==='disabled')manager.appendCustomEntry('plan-mode-state',{enabled:false,awaitingAction:false});
 manager.appendCustomEntry('pi-modes',{version:2,mode:kind==='flag'?'build':'ask',previousMode:'build',changedAt:Date.now()});
 const names=reverse?['@narumitw/pi-plan-mode',candidate]:[candidate,'@narumitw/pi-plan-mode'];
 const s=await makeSession(names,{mode,label:'real-restore-'+kind+'-'+reverse,sessionManager:manager,cliMode:kind==='flag'?'ask':undefined,mcp:false});
 await test(mode+'-plan-restore-'+kind+'-'+reverse,()=>({pass:kind==='disabled'?!s.session.getActiveToolNames().includes('write'):s.session.getActiveToolNames().includes('write')&&s.inventory.notifications.some(n=>n.message.includes('workflow')),evidence:{active:s.session.getActiveToolNames(),notifications:s.inventory.notifications}}));
 if(kind!=='disabled'){await s.command('/plan off');await s.command('/mode ask');await test(mode+'-plan-restore-then-ask-'+kind+'-'+reverse,()=>({pass:!s.session.getActiveToolNames().includes('write')&&s.session.getActiveToolNames().includes('codemode'),evidence:s.session.getActiveToolNames()}));}
 s.dispose();
}
for(const mode of ['on','only'])for(const configKind of ['missing','malformed','null-modes','null-ask']){
 const s=await makeSession([candidate],{mode,label:`default-${mode}-${configKind}`,mcp:false,cliMode:'ask',configKind});
 const prefix=`${mode}-${configKind}-strict-default`;
 await test(prefix+'-load',()=>({pass:s.inventory.loadErrors.length===0&&s.errors.length===0,evidence:s.inventory}));
 await test(prefix+'-codemode',async()=>{const r=await s.call('codemode',{code:'text(await tools.read({path:"sample.mjs"}));'});return {pass:s.session.getActiveToolNames().includes('codemode')&&content(r).includes('compatibilityAdd'),evidence:r}});
 const sentinel=path.join(cwd,'ask-default-sentinel.txt');await fs.writeFile(sentinel,'UNCHANGED');
 await test(prefix+'-bash',async()=>{const r=await s.call('bash',{command:`find ${sentinel} -delete`});return {pass:await fs.readFile(sentinel,'utf8').catch(()=>null)==='UNCHANGED',evidence:r}});
 await fs.writeFile(sentinel,'UNCHANGED');
 await test(prefix+'-nested-write',async()=>{const r=await s.call('codemode',{code:'text(await tools.write({path:"ask-default-sentinel.txt",content:"MUTATED"}));'});return {pass:await fs.readFile(sentinel,'utf8').catch(()=>null)==='UNCHANGED',evidence:r}});
 s.dispose();
}
await fs.writeFile(resultPath,JSON.stringify({generatedAt:new Date().toISOString(),extension:candidate,cases},null,2));
console.log(JSON.stringify({total:cases.length,passed:cases.filter(x=>x.pass).length,failed:cases.filter(x=>!x.pass).length}));
process.exit(cases.some(x=>!x.pass)?1:0);
