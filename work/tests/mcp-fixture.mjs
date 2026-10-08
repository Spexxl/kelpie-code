import os from 'node:os';
// Offline MCP stdio fixture. Writes are confined to the disposable test project.
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const tools = [
  { name: 'fixture_read', description: 'Read the local compatibility sentinel', inputSchema: {type:'object',properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,destructiveHint:false}},
  { name: 'fixture_write', description: 'Write only the local compatibility sentinel', inputSchema: {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true}},
];
const rl = readline.createInterface({input:process.stdin});
for await (const line of rl) {
  try {
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    switch(msg.method) {
      case 'initialize': result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'offline-compatibility-fixture',version:'1.0.0'}}; break;
      case 'ping': result={}; break;
      case 'tools/list': result={tools}; break;
      case 'tools/call': {
        const sentinel=path.join(root,'mcp-sentinel.txt');
        if(msg.params.name==='fixture_write') await fs.writeFile(sentinel,msg.params.arguments.text);
        else if(msg.params.name!=='fixture_read') throw new Error('Unknown fixture tool');
        result={content:[{type:'text',text:await fs.readFile(sentinel,'utf8')}]};
        break;
      }
      default: throw new Error(`Unsupported method ${msg.method}`);
    }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\n');
  } catch (error) {
    process.stderr.write(String(error)+'\n');
  }
}
