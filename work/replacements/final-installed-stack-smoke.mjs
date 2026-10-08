import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname),sdkPath=(process.env.PI_SDK_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent')),agentDir=path.join(os.homedir(),'.pi/agent');
const fixture=await fs.mkdtemp('/tmp/pi-full-stack-');
process.env.DO_NOT_TRACK='1';process.env.PI_MEMORY_DIR=path.join(fixture,'memory');process.env.PI_CODING_AGENT_DIR=agentDir;
const sdk=await import(pathToFileURL(path.join(sdkPath,'dist/index.js')));sdk.initTheme('dark',false);
const settingsManager=sdk.SettingsManager.create(fixture,agentDir,{projectTrusted:true});
const resourceLoader=new sdk.DefaultResourceLoader({cwd:fixture,agentDir,settingsManager,extensionFactories:[sdk.createCodemodeExtension(),sdk.createToolSearchExtension(),sdk.createMcpExtension()],noSkills:true,noPromptTemplates:true,noContextFiles:true});
await resourceLoader.reload({resolveProjectTrust:async()=>true});
const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(fixture,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
const model=modelRuntime.getModels('anthropic')[0];await modelRuntime.setRuntimeApiKey('anthropic','offline-scripted-fixture');
const {session,extensionsResult}=await sdk.createAgentSession({cwd:fixture,agentDir,settingsManager,resourceLoader,modelRuntime,model,sessionManager:sdk.SessionManager.inMemory(fixture)});
const ai=await import(pathToFileURL(path.join(sdkPath,'node_modules/@earendil-works/pi-ai/dist/index.js')));
session.agent.getApiKey=async()=>undefined;
session.agent.streamFunction=async()=>{const stream=new ai.AssistantMessageEventStream();const message={role:'assistant',content:[{type:'text',text:'Offline scripted response; no provider call.'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};stream.push({type:'done',reason:'stop',message});stream.end();return stream;};
const command=async text=>{await session.prompt(text);await new Promise(resolve=>setImmediate(resolve));await session.waitForIdle();};
const runtimeErrors=[];await session.bindExtensions({onError:e=>runtimeErrors.push(e)});
const paths=extensionsResult.extensions.map(e=>e.path),commands=extensionsResult.extensions.flatMap(e=>[...e.commands.keys()]),tools=session.getAllTools().map(t=>t.name);
const local=['pi-ask-codemode-local','pi-sandbox-background-bridge','background-carderne'];
const originals=['pi-sandbox','pi-better-background-tasks','@dreki-gg/pi-ask-mode','pi-agent-browser-native'];
const activeBefore=session.getActiveToolNames();
const checks={
  loadWithoutErrors:extensionsResult.errors.length===0&&runtimeErrors.length===0,
  localPackagesLoaded:local.every(n=>paths.some(p=>p.startsWith(path.join(agentDir,'local-packages',n)+path.sep))),
  originalsFiltered:originals.every(n=>!paths.some(p=>p.startsWith(path.join(agentDir,'npm/node_modules',n)+path.sep))),
  requiredRegistrations:tools.includes('codemode')&&tools.some(n=>n.startsWith('bg_task'))&&commands.includes('mode')&&commands.includes('plan')&&commands.includes('sandbox'),
  defaultBuildTools:activeBefore.includes('write')&&activeBefore.includes('bash')&&activeBefore.includes('codemode'),
};
try {
 await command('/mode ask');
 const ask=session.getActiveToolNames();
 checks.askRetainsCodeMode=ask.includes('codemode')&&ask.includes('read')&&!ask.includes('write')&&!ask.includes('bash');
 await command('/mode build');
 checks.buildRestoresTools=activeBefore.every(n=>session.getActiveToolNames().includes(n));
 await command('/plan on');
 const plan=session.getActiveToolNames();await command('/mode ask');
 checks.askRefusesActivePlan=JSON.stringify(plan)===JSON.stringify(session.getActiveToolNames())&&session.sessionManager.getBranch().filter(e=>e.type==='custom'&&e.customType==='plan-mode-state').at(-1)?.data.enabled===true;
 await command('/plan off');
 checks.noCommandRuntimeErrors=runtimeErrors.length===0;
} finally {session.dispose();await new Promise(resolve=>setImmediate(resolve));}
checks.noCommandRuntimeErrors=runtimeErrors.length===0;
const result={generatedAt:new Date().toISOString(),scope:'Actual installed global packages loaded together in Pi SDK; headless mode commands and scripted offline assistant only, no live provider or browser calls.',checks,passed:Object.values(checks).filter(Boolean).length,total:Object.keys(checks).length,pass:Object.values(checks).every(Boolean),loadErrors:extensionsResult.errors,runtimeErrors:[...runtimeErrors],loadedExtensionPaths:paths,registeredTools:tools,commands};
await fs.writeFile(path.join(root,'final-installed-stack-smoke.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));process.exit(result.pass?0:1);
