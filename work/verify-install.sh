#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.nvm/nvm.sh"
nvm use 24.21.0
pi --version
node --version
pi list
agent-browser --version
rg --version
python3 - <<'VERIFY_CONFIG_PY'
import json,pathlib
settings=json.loads((pathlib.Path.home()/'.pi/agent/settings.json').read_text())
packages=settings.get('packages',[])
expected=['@dreki-gg/pi-ask-mode','pi-better-background-tasks','pi-sandbox']
for name in expected:
 entries=[p for p in packages if isinstance(p,dict) and p.get('source','').startswith('npm:'+name+'@')]
 assert entries and all(p.get('extensions')==[] for p in entries), 'Expected disabled package: '+name
assert not any((x if isinstance(x,str) else x.get('source','')).startswith('npm:pi-agent-browser-native@') for x in packages), 'Native browser should be removed'
for name in ['pi-ask-codemode-local','pi-sandbox-background-bridge','background-carderne']:
 target=pathlib.Path.home()/'.pi/agent/local-packages'/name
 assert str(target) in packages and (target/'package.json').is_file(), 'Missing local package: '+name
mcp=json.loads((pathlib.Path.home()/'.pi/agent/mcp.json').read_text())
assert mcp['mcpServers']['jev-browser']['toolExposure']['jev_navigate']=='codemode'
assert settings.get('codemode',{}).get('mode')=='on', 'Expected Code Mode on'
assert '+codemode' in settings.get('defaultTools',[]), 'Expected enabled codemode tool'
print(json.dumps({'packageCount':len(packages),'disabledExtensionPackages':expected,'codemode':'on'}))
VERIFY_CONFIG_PY
