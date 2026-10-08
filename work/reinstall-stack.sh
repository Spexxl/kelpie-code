#!/usr/bin/env bash
# Instalações e configurações requerem permissões locais normais, sem chaves.
set -euo pipefail
source "$HOME/.nvm/nvm.sh"
nvm install 24.21.0
nvm alias default 24.21.0
npm install -g --allow-scripts=agent-browser,esbuild,@google/genai,protobufjs @earendil-works/pi-coding-agent@1.1.0 agent-browser@0.38.2 @jkudish/jev-browser@0.8.4
pi install npm:pi-subagents@0.76.1
pi install npm:@narumitw/pi-plan-mode@0.59.2
pi install npm:pi-goal-x@0.32.3
pi install npm:pi-memory@0.4.2
pi install npm:@lenard9191/pi-project-profile@1.3.0
pi install npm:@ff-labs/pi-fff@0.11.0
pi install npm:pi-debug-mode@0.1.12
pi install npm:@m4riok/pi-ide-bridge@0.2.0
pi install npm:pi-cc-extensions@0.9.11
pi install npm:@gagansd/pi-web-search@0.2.1
pi install npm:pi-better-background-tasks@0.8.0
pi install npm:pi-sandbox@0.7.1
pi install npm:@narumitw/pi-usage@0.64.1
pi install npm:@juicesharp/rpiv-ask-user-question@2.12.0
pi install npm:@juicesharp/rpiv-todo@2.12.0
pi install npm:@dreki-gg/pi-ask-mode@0.3.3
agent-browser install
node "$HOME/.nvm/versions/node/v24.21.0/lib/node_modules/@jkudish/jev-browser/node_modules/playwright/cli.js" install chromium
if command -v code >/dev/null 2>&1; then
  code --install-extension m4riok.pi-ide-bridge-vscode
else
  echo "Complemento IDE pendente: editor code não encontrado."
fi
mkdir -p "$HOME/.local/bin"
for pi_command in pi agent-browser jev-browser; do
  if [[ -e "$HOME/.local/bin/$pi_command" || -L "$HOME/.local/bin/$pi_command" ]]; then
    cp -a "$HOME/.local/bin/$pi_command" "$HOME/.local/bin/$pi_command.backup-$(date +%Y%m%dT%H%M%S)"
  fi
  printf '%s\n' '#!/usr/bin/env bash' 'export PATH="${HOME}/.nvm/versions/node/v24.21.0/bin:$PATH"' "exec \"${HOME}/.nvm/versions/node/v24.21.0/bin/$pi_command\" \"\$@\"" > "$HOME/.local/bin/$pi_command"
  chmod 755 "$HOME/.local/bin/$pi_command"
done
if ! command -v rg >/dev/null 2>&1 && [[ -x /usr/lib/chatgpt/resources/rg ]]; then
  install -m 755 /usr/lib/chatgpt/resources/rg "$HOME/.local/bin/rg"
fi
# Reaplicar desativações verificadas sem remover pacotes ou alterar autenticação.
pi_stack_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$pi_stack_script_dir/replacements" <<'STACK_CONFIG_PY'
import json,pathlib,sys,shutil,datetime
p=pathlib.Path.home()/'.pi/agent/settings.json'
sources=pathlib.Path(sys.argv[1])
d=json.loads(p.read_text())
backup=p.parent.parent/'backups'/('reinstall-settings-'+datetime.datetime.now().strftime('%Y%m%dT%H%M%S')+'.json')
backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,backup)
packages=[]
for x in d.get('packages',[]):
 source=x if isinstance(x,str) else x['source']
 if source.startswith('npm:pi-agent-browser-native@'):continue
 if any(source.startswith('npm:'+name+'@') for name in ['@dreki-gg/pi-ask-mode','pi-better-background-tasks','pi-sandbox']):
  x={'source':source, 'extensions':[]}
 packages.append(x)
agent=p.parent
for folder,name in [('ask-fork','pi-ask-codemode-local'),('pi-sandbox-background-bridge','pi-sandbox-background-bridge'),('background-carderne','background-carderne')]:
 target=agent/'local-packages'/name
 if target.exists():shutil.copytree(target,backup.parent/(backup.stem+'-'+name),symlinks=True,ignore=shutil.ignore_patterns('node_modules','background-fixture-*'))
 shutil.copytree(sources/folder,target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','background-fixture-*','demo'))
 if str(target) not in packages:packages.append(str(target))
for name,dependency in [('pi-sandbox-background-bridge','@carderne/sandbox-runtime'),('background-carderne','proper-lockfile')]:
 link=agent/'local-packages'/name/'node_modules'/dependency
 link.parent.mkdir(parents=True,exist_ok=True)
 if not link.exists():link.symlink_to(agent/'npm/node_modules'/dependency,target_is_directory=True)
d['packages']=packages
d['codemode']={'mode':'on','inlineBudget':1500}
d['defaultTools']=list(dict.fromkeys([*d.get('defaultTools',[]),'+codemode','+tool_search','+grep','+find','+ls']))
for filename in ['modes.config.json','mcp.json']:
 if (agent/filename).exists():shutil.copy2(agent/filename,backup.parent/(backup.stem+'-'+filename))
shutil.copy2(sources/'ask-fork/modes.config.example.json',agent/'modes.config.json')
mcp_path=agent/'mcp.json'
mcp=json.loads(mcp_path.read_text()) if mcp_path.exists() else {}
entry=json.loads((sources/'config/jev-browser.mcp-entry.json').read_text())['mcpServers']['jev-browser']
node_root=pathlib.Path.home()/'.nvm/versions/node/v24.21.0'
entry['command']=str(node_root/'bin/node')
entry['args']=[str(node_root/'lib/node_modules/@jkudish/jev-browser/dist/index.js')]
mcp.setdefault('mcpServers',{})['jev-browser']=entry
mcp_path.write_text(json.dumps(mcp,indent=2)+'\n')
p.write_text(json.dumps(d,indent=2)+'\n')
STACK_CONFIG_PY
