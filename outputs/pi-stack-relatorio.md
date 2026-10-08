# Pi Agent — instalação e compatibilidade atualizadas

**Verificação em 8 de outubro de 2026.** Pi Agent `1.1.0` está instalado sob Node `24.21.0`. A troca do navegador e os forks locais de Ask/Background/Sandbox foram integrados à configuração global. O comando final `pi list` confirmou 19 declarações de pacote: 16 ativas e três originais filtradas para não carregar extensões duplicadas.

## O que ficou instalado

Os plugins npm ativos são: `pi-subagents@0.76.1`, `@narumitw/pi-plan-mode@0.59.2`, `pi-goal-x@0.32.3`, `pi-memory@0.4.2`, `@lenard9191/pi-project-profile@1.3.0`, `@ff-labs/pi-fff@0.11.0`, `pi-debug-mode@0.1.12`, `@m4riok/pi-ide-bridge@0.2.0`, `pi-cc-extensions@0.9.11`, `@gagansd/pi-web-search@0.2.1`, `@narumitw/pi-usage@0.64.1`, `@juicesharp/rpiv-ask-user-question@2.12.0` e `@juicesharp/rpiv-todo@2.12.0`.

Três forks locais ativos substituem os originais problemáticos:

| Componente ativo | Implementação aplicada |
| --- | --- |
| Ask Mode | `pi-ask-codemode-local@0.3.0-local.2`, mantém Code Mode e bloqueia ações de escrita/Bash/ferramentas desconhecidas |
| Sandbox | `pi-sandbox@0.7.1+background-bridge.2`, ponte com o serviço de tarefas em segundo plano |
| Background Tasks | `pi-better-background-tasks@0.8.0+carderne.2`, aplica a política ativa do Sandbox a cada lançamento e retomada local |

As declarações originais de `@dreki-gg/pi-ask-mode@0.3.3`, `pi-sandbox@0.7.1` e `pi-better-background-tasks@0.8.0` estão marcadas como filtradas. Isso evita comandos e hooks duplicados, mantendo os pacotes para rollback. `pi-agent-browser-native@0.9.3` foi removido da configuração e instalação. O CLI `agent-browser@0.38.2` continua separado.

O navegador selecionado é `@jkudish/jev-browser@0.8.4`, como servidor MCP oculto com `jev_navigate` exposto dentro do Code Mode. Chromium `156.0.8078.4` (revisão Playwright 1248) está instalado. O navegador Jev faz navegação por objetivo; não reproduz cada comando do `agent-browser`.

## Testes executados

| Área | Resultado | Alcance |
| --- | --- | --- |
| Ask + Code Mode | **126/126 passaram** | Cópia instalada, modos Code Mode `on` e `only`, ferramentas diretas/aninhadas, descoberta dinâmica, bloqueio de escrita e convivência com Plan |
| Background + Sandbox | **21/21 passaram** | Regressão via SDK real do Pi; processos, cancelamento, diretório, retomada/watch, política de rede, falha fechada, estado protegido e SSH remoto |
| Suíte do Sandbox | **50 passaram, 0 falharam, 3 pulados** | 53 testes da cópia local; os três casos pulados estão identificados na suíte |
| Jev Browser + Pi/MCP/Code Mode | **10/10 passaram** | Inicialização real do MCP no Pi, descoberta e exposição no Code Mode, bloqueio pelo Plan e falha sem chave antes de abrir o navegador |
| Jev Browser upstream | **78 passaram, 0 falharam** | Testes offline oficiais de unidade/transporte; requisições externas foram bloqueadas |
| Configuração global | **9/9 verificações SDK passaram** | Todas as extensões instaladas foram carregadas juntas; comandos Ask/Build/Plan exercitados, sem erros de carga ou runtime. `pi list` confirma separadamente as declarações. |
| Watch durante preparação | **4/4 passaram** | Cancelamento, suspensão/retomada, prazo e aviso de execução sem confinamento; processos e registro reais, com preparação pausada pela fixture. |

Não foram feitas chamadas a modelos, julgamentos Jev ou chamadas pagas. O teste Jev confirma integração offline; sem chave Jev, navegação pública real permanece pendente. O complemento visual do VS Code está instalado, mas uma conexão e aprovação/rejeição real de diff não foram exercitadas.

## Ask Mode e Sandbox em uso

Ask é compatível com Code Mode nesta configuração. Para entrar, desligue Plan com `/plan off` e depois use `/mode ask`. Ask mantém Code Mode e as ferramentas de leitura disponíveis, bloqueia Bash, escrita, edição e ferramentas não autorizadas; se Plan estiver ativo, Ask recusa a transição. Use `/mode build` para editar. O modo padrão permanece Build.

Background Tasks agora obtém a política do Sandbox em cada lançamento, watch e retomada local. Falha ou ausência do runtime nega a tarefa; com Sandbox explicitamente desligado, a execução sem confinamento é indicada. Escritas no registro de tarefas, fontes de Background/Sandbox e configuração do sandbox são negadas dentro do trabalho confinado. SSH estruturado é recusado enquanto o sandbox estiver ligado, pois a política local não confina o host remoto.

## Limitações que continuam

- **Sem chave Jev:** não foi validado julgamento real nem pesquisa pública. `jev_navigate` está oculto fora de Code Mode e o Ask estrito não permite esse MCP.
- **Sandbox não cobre o navegador MCP:** o processo Chromium iniciado pelo Jev fica fora do confinamento aplicado a Bash. As decisões do Plan/Ask limitam quem pode chamar a ferramenta; não equivalem a isolamento de filesystem/rede.
- **Rede em tarefas destacadas:** a política de proxy vale durante a sessão do Sandbox. Não há garantia de acesso restrito à rede para processos destacados depois que a sessão Pi fecha.
- **UI e chamadas autenticadas pendentes:** aprovação de diff no VS Code, diálogos visuais, chamadas reais de Usage, pesquisa Web autenticada, agentes reais e continuação Goal-X com modelo não foram simulados como se tivessem passado.
- **Advisory de dependência:** a cadeia do runtime do Sandbox inclui `node-forge@1.4.0`, afetado pelo advisory de severidade alta [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). O advisory não lista versão corrigida. Não foi forçado downgrade de dependências.

## Correções da revisão

A revisão nova encontrou seis problemas que os testes anteriores não cobriam. Todos foram reproduzidos com estado isolado e corrigidos nos forks instalados:

- Ask podia voltar a um Bash permissivo com configuração ausente/inválida; o próprio padrão do fork agora nega Bash e mantém Code Mode.
- Background perdia regras quando o arquivo de política ficava inválido; leitura de política inválida agora bloqueia a execução, e somente `enabled:false` é um opt-out.
- Uma preparação antiga podia sobreviver a uma troca de sessão ou reinicialização do sandbox; gerações e rechecagem da política agora a invalidam.
- Watch podia lançar outro processo depois de cancelado ou depois do prazo; seu estado é rechecado após a preparação assíncrona.
- Uma permissão de escrita em um subdiretório podia vencer a proteção do diretório pai; a ponte nega explicitamente as concessões que intersectam os caminhos de controle protegidos.
- Watch podia continuar sem confinamento mostrando o aviso antigo; cada mudança do aviso passa a ser persistida e registrada no log.

As novas regressões falharam antes das correções e passaram depois. A revisão independente subsequente não encontrou defeito concreto restante nesses seis caminhos. Os três grafos de fonte passaram na verificação estrita do TypeScript. Os helpers de verificação/reinstalação foram atualizados para Jev Browser e os forks locais; o reinstalador foi conferido por sintaxe, sem reinstalar novamente toda a stack.

## Backup e restauração

Backup antes das correções desta revisão: `/home/sll/.pi/backups/revision-review-20261008T140040Z`.

Backups das alterações anteriores:

- Navegador/MCP: `/home/sll/.pi/backups/replacements-20261008T124905Z`
- Ask, Background, configurações e perfis: `/home/sll/.pi/backups/replacements-ask-background-20261008T132426Z`

Feche o Pi antes de restaurar. Preserve as configurações atuais e copie de volta os arquivos correspondentes do backup. As cópias originais de Ask, Background e Sandbox continuam instaladas; remover as entradas locais e reativar as originais pode recuperar o comportamento anterior, inclusive as incompatibilidades já observadas.

Guia de operação: [INSTALACAO.md](../work/replacements/INSTALACAO.md). Fontes mantidas e evidências completas: [substituições locais](pi-stack-substituicoes.zip) e [testes atualizados](pi-stack-testes-atualizados.zip). A configuração detalhada e o resumo das suítes estão em [pi-stack-versoes.json](pi-stack-versoes.json).
