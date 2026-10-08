# Instalação atual e operação

Pi Agent `1.1.0` usa Node `24.21.0`. A configuração aplicada está em `~/.pi/agent/settings.json`, `~/.pi/agent/modes.config.json` e `~/.pi/agent/mcp.json`.

## Ask Mode

O padrão continua `/mode build`. Para consultar código com Code Mode, execute `/plan off` e depois `/mode ask`. Ask permite `codemode`, `tool_search`, `grep`, `find`, `ls` e leitura; bloqueia Bash, escrita, edição e ferramentas desconhecidas. Para editar, use `/mode build`. Ask recusa a ativação enquanto o Plan Mode estiver ativo. Seus padrões seguros também valem quando a configuração estiver ausente ou inválida.

## Background Tasks e Sandbox

O Background local e a ponte de Sandbox precisam ser carregados juntos. As cópias originais continuam instaladas, mas filtradas, para evitar extensões duplicadas. Em uma sessão nova, use `pi list` para confirmar as três entradas locais e as três originais marcadas como `(filtered)`. Se algo não carregar, use `/reload` e consulte a saída de inicialização.

Tarefas locais passam pela política atual do sandbox. Remote SSH é bloqueado enquanto o sandbox está ligado. A rede restrita depende da sessão de Pi; não há garantia de proxy para processos destacados depois que a sessão fecha.

## Navegador Jev

O servidor MCP `jev-browser` inicia oculto e publica `jev_navigate` apenas dentro do Code Mode. Requer uma chave Jev para navegação real. Sem chave, os testes confirmam inicialização, integração e falha antes de abrir o navegador; eles não confirmam julgamentos Jev ou pesquisa pública. Esse processo de navegador não herda a política de `pi-sandbox` para Bash. O CLI `agent-browser` permanece disponível como ferramenta separada.

## Desfazer

Backups globais:

- `/home/sll/.pi/backups/replacements-20261008T124905Z` — estado anterior à troca do navegador e configuração MCP.
- `/home/sll/.pi/backups/replacements-ask-background-20261008T132426Z` — settings, MCP e perfis anteriores à integração dos forks locais.

Feche o Pi antes de restaurar. Copie os arquivos de backup para os caminhos correspondentes em `~/.pi/agent/`; preserve antes as configurações atuais. Os pacotes npm originais de Ask, Background e Sandbox permanecem instalados, com suas extensões filtradas na configuração.

## Atualizar os forks locais

As três pastas locais em `~/.pi/agent/local-packages/` são cópias mantidas localmente; atualização upstream não as altera automaticamente. Ao atualizar, reaplique a ponte `background-service:v1` e as alterações de Ask descritas nos respectivos `MAINTAINED.md`/`LOCAL.md`, execute as suítes documentadas e compare as configurações do Pi antes de substituir os pacotes.

Os testes distribuídos junto ao pacote fonte são offline. O teste de Jev usa chamadas bloqueadas ou fixtures locais, sem chamadas pagas. A suíte de Sandbox pula três casos upstream documentados no log por depender de contextos de subagente/shell específicos.

## Revisão e helpers

As versões locais atuais são Ask `0.3.0-local.2`, Sandbox `0.7.1+background-bridge.2` e Background `0.8.0+carderne.2`. O backup desta revisão está em `/home/sll/.pi/backups/revision-review-20261008T140040Z`.

`../verify-install.sh` confirma o estado instalado; `../reinstall-stack.sh` instala as versões selecionadas, aplica os forks e filtra os originais. Feche o Pi antes de reinstalar. A sintaxe do reinstalador foi validada; ele não foi executado novamente sobre a instalação já corrigida. Os pacotes fonte excluem node_modules; o helper usa os peers do Pi e liga as dependências runtime dos dois pacotes originais preservados.
