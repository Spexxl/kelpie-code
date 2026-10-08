import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname), sdkDir=(process.env.PI_SDK_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent')), browserDir=(process.env.JEV_BROWSER_DIR??path.join(os.homedir(),'.nvm/versions/node/v24.21.0/lib/node_modules/@jkudish/jev-browser'));
const out={generatedAt:new Date().toISOString(),scope:'Actual Pi MCP and Code Mode; scripted offline assistant only; no fabricated Jev decisions',cases:[]};
const credentialNames=['TYPESAFE_API_KEY','OPENROUTER_API_KEY','CLOUDFLARE_API_TOKEN','JEV_CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','JEV_BROWSER_TYPE_PROVIDER','JEV_PROVIDER'];
out.credentialPresence=Object.fromEntries(credentialNames.map(k=>[k,!!process.env[k]]));
for(const k of credentialNames) delete process.env[k];
process.env.DO_NOT_TRACK='1';
const fixture=path.join(root,'browser-fixture');await fs.mkdir(fixture,{recursive:true});
let requests=0;const server=http.createServer((_req,res)=>{requests++;res.end('<button id="mutate">Mutate sentinel</button>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const args={task:'Click the button',start_url:url,max_steps:1,max_seconds:10,allow_typing:false,screenshot:'none'};
const sentinel=path.join(fixture,'sentinel.txt');await fs.writeFile(sentinel,'unchanged');
const mcp=await import(pathToFileURL(path.join(sdkDir,'node_modules/@earendil-works/pi-mcp/dist/index.js')));
const client=new mcp.McpClient({name:'pi-browser-verification',version:'1.0',requestTimeoutMs:15000});
const transport=new mcp.StdioTransport({command:process.execPath,args:[path.join(browserDir,'dist/index.js')],inheritEnv:false,env:{PATH:'/usr/bin:/bin',HOME:os.homedir()}});
try{
 const initialize=await client.connect(transport);const tools=await client.listTools();
 out.cases.push({id:'initialize-tools-schema',pass:initialize.serverInfo.version==='0.8.4'&&tools.length===1&&tools[0].name==='jev_navigate'&&tools[0].inputSchema.required.includes('task'),initialize,tools});
 const missing=await client.callTool('jev_navigate',args);
 out.cases.push({id:'stdio-missing-auth-no-navigation',pass:missing.isError===true&&JSON.stringify(missing).includes('TYPESAFE_API_KEY')&&requests===0&&await fs.readFile(sentinel,'utf8')==='unchanged',result:missing,httpRequests:requests,sentinel:await fs.readFile(sentinel,'utf8')});
 const invalid=await client.callTool('jev_navigate',{...args,start_url:'file:///tmp/sentinel'});
 out.cases.push({id:'stdio-schema-rejects-file-url',pass:invalid.isError===true&&requests===0,result:invalid});
}finally{await client.close();}
const {chromium}=await import(pathToFileURL(path.join(browserDir,'node_modules/playwright/index.mjs')));
const launch=chromium.launch;let launches=0;chromium.launch=async()=>{launches++;throw new Error('Browser launch was reached during missing-auth check');};
try{const {navigate}=await import(pathToFileURL(path.join(browserDir,'dist/library.js')));let error;try{await navigate({task:'Inspect fixture',startUrl:url,allowTyping:false});}catch(e){error=e.message;}
 out.cases.push({id:'library-missing-auth-before-launch',pass:launches===0&&error?.includes('TYPESAFE_API_KEY'),launches,error});
}finally{chromium.launch=launch;}
const sdk=await import(pathToFileURL(path.join(sdkDir,'dist/index.js')));const ai=await import(pathToFileURL(path.join(sdkDir,'node_modules/@earendil-works/pi-ai/dist/index.js')));sdk.initTheme('dark',false);
for(const mode of ['on','only']){
 const agentDir=path.join(fixture,mode);await fs.mkdir(agentDir,{recursive:true});process.env.PI_CODING_AGENT_DIR=agentDir;
 const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'.pi/agent/mcp.json'),'utf8'));await fs.writeFile(path.join(agentDir,'mcp.json'),JSON.stringify(config));
 const settingsManager=sdk.SettingsManager.inMemory({defaultTools:['+codemode','+tool_search'],codemode:{mode},retry:{enabled:false},compaction:{enabled:false}},{projectTrusted:true});
 const resourceLoader=new sdk.DefaultResourceLoader({cwd:fixture,agentDir,settingsManager,additionalExtensionPaths:[path.join(os.homedir(),'.pi/agent/npm/node_modules/@narumitw/pi-plan-mode')],extensionFactories:[sdk.createCodemodeExtension(),sdk.createToolSearchExtension(),sdk.createMcpExtension()],noSkills:true,noPromptTemplates:true,noContextFiles:true});await resourceLoader.reload({resolveProjectTrust:async()=>true});
 const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});const model=modelRuntime.getModels('anthropic')[0];await modelRuntime.setRuntimeApiKey('anthropic','offline-scripted-assistant-placeholder');
 const {session,extensionsResult}=await sdk.createAgentSession({cwd:fixture,agentDir,settingsManager,resourceLoader,modelRuntime,model,sessionManager:sdk.SessionManager.inMemory(fixture)});const errors=[];await session.bindExtensions({onError:e=>errors.push(e)});
 let pending;session.agent.getApiKey=async()=>undefined;session.agent.streamFunction=async()=>{const stream=new ai.AssistantMessageEventStream();const message={role:'assistant',content:pending?[{type:'toolCall',id:`fixture-${mode}-${Date.now()}`,name:'codemode',arguments:{code:pending}}]:[{type:'text',text:'Offline scripted fixture'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:pending?'toolUse':'stop',timestamp:Date.now()};pending=undefined;stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;};
 const call=async(code)=>{const before=session.messages.length;pending=code;await session.prompt('Offline fixture');return session.messages.slice(before).filter(m=>m.role==='toolResult').at(-1);};
 try{
 const discovery=await call('text(await searchTools("Jev navigate",{namespace:"mcp__jev_browser"})); text(await describeTool("mcp__jev_browser__jev_navigate")); text(await describeNamespace("mcp__jev_browser"));');
 const found=session.getAllTools().find(t=>t.name==='mcp__jev_browser__jev_navigate');out.cases.push({id:`native-codemode-${mode}-discovery`,pass:!!found&&JSON.stringify(discovery).includes('start_url')&&extensionsResult.errors.length===0,tool:found,result:discovery,loadErrors:extensionsResult.errors});
 const missing=await call(`text(await tools.mcp__jev_browser__jev_navigate(${JSON.stringify(args)}));`);out.cases.push({id:`native-codemode-${mode}-missing-auth`,pass:JSON.stringify(missing).includes('TYPESAFE_API_KEY')&&requests===0,result:missing,httpRequests:requests});
 await session.prompt('/plan start');const denied=await call(`text(await tools.mcp__jev_browser__jev_navigate(${JSON.stringify(args)}));`);out.cases.push({id:`native-plan-${mode}-denies-browser`,pass:JSON.stringify(denied).includes('Plan mode')&&!JSON.stringify(denied).includes('TYPESAFE_API_KEY')&&requests===0,result:denied,httpRequests:requests,runtimeErrors:errors});
 }finally{session.dispose();}
}
await new Promise(r=>server.close(r));out.pass=out.cases.every(c=>c.pass);await fs.writeFile(path.join(root,'browser-tests.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({pass:out.pass,cases:out.cases.map(({id,pass})=>({id,pass}))}));process.exit(out.pass?0:1);
