# Contratos de integração preservados

## CodeMode e Ask

CodeMode nativo está em `on`: ferramentas diretas coexistem com scripts. Ask permite leitura e descoberta, incluindo CodeMode/tool_search, e verifica chamadas aninhadas. Nega Bash, escrita e ferramentas desconhecidas por padrão, inclusive sem configuração válida. A mudança consulta `workflow:mutex:v1` antes de ativar/restaurar Ask. O Plan existente tem prioridade: sair com `/plan off` antes de entrar em `/mode ask`.

Implementação: `work/replacements/ask-fork/`. Justificativas upstream e mudanças em `LOCAL.md`.

## Background e Sandbox

Os dois forks compartilham `background-service:v1`. O Sandbox prepara execução com a política atual e identifica alterações de geração/política antes de liberar processos. Background exige preparação válida, reavalia cancelamento/suspensão/prazo e preserva avisos de confinamento. Interseções com caminhos protegidos permanecem negadas. SSH remoto fica bloqueado enquanto o Sandbox está ligado.

Implementações: `work/replacements/pi-sandbox-background-bridge/` e `work/replacements/background-carderne/`; manutenção em `MAINTAINED.md`. Carregar os dois forks juntos e filtrar os originais evita registro duplicado.

A proteção de rede depende da sessão; processos destacados após seu encerramento não têm proxy garantido. Isso precisa ser resolvido antes de prometer isolamento de tarefas duráveis na futura interface.

## Jev Browser

Servidor MCP oculto com `jev_navigate` exposto apenas no CodeMode. Ask e Plan negam seu uso na política atual; Build permite. Jev escolhe ações em Chromium com limites de tempo/passos. Chave Jev necessária para navegação real; preenchimento livre pode exigir provedor auxiliar. Chromium/MCP ficam fora do confinamento Bash do pi-sandbox.

## Extensões complementares

Os 13 plugins ativos não modificados estão fixados no inventário. Perfis de pesquisa são preservados em `work/profiles`. Herança de permissões em subagentes, interfaces IDE/Ask Question, consultas Usage, geração Memory e navegação Jev ainda têm verificações reais pendentes.
