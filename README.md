# Pi Harness

Base preservada da integração Pi Agent + CodeMode + extensões, preparada para evoluir para um harness próprio com interface. O estado atual é uma stack CLI; a interface ainda não foi implementada.

## O que está salvo

- Código-fonte completo do monorepo Pi 1.1.0 em `upstream/pi/`, tag e commit registrados.
- Pi 1.1.0 e Jev Browser 0.8.4: distribuição instalada em `vendor/`, com documentação e licenças upstream.
- Todos os 16 plugins npm declarados, incluindo 13 ativos e 3 originais filtrados, também em `vendor/`.
- Três forks mantidos em `work/replacements/`: Ask/CodeMode, Sandbox/Background e Background Tasks.
- Código fonte upstream de Jev em `work/replacements/browser-upstream/`.
- Templates de configuração, perfis de pesquisa, scripts de instalação, testes e evidências da revisão.
- Lock de dependências dos plugins em `locks/`; inventário e limitações em `outputs/`.

`vendor` preserva os arquivos publicados dos pacotes instalados, sem `node_modules`. O código-fonte do Pi também está preservado em `upstream/pi/`. As dependências transitivas são descritas no lock; runtimes Node, Chromium e dependências precisam ser instalados. As versões selecionadas são reinstaladas do npm pelo helper.

## Restaurar

Linux, Bash, Python 3, NVM instalado e acesso à rede são os requisitos do helper. Feche o Pi antes de executar:

```bash
bash work/reinstall-stack.sh
bash work/verify-install.sh
```

O script instala Node 24.21.0, Pi e os plugins fixados, preserva backups de configurações existentes, aplica os forks e filtra os três originais. Instala Chromium e tenta instalar o complemento IDE via `code`; se o editor estiver disponível. Não autentica provedores. Os templates em `config/` são referência, não devem ser copiados com placeholders sem expansão.

A política `config/sandbox.json` e os perfis `work/profiles/` são preservados separadamente: o reinstalador atual não os aplica automaticamente. Revise e copie para `~/.pi/agent/sandbox.json` e `~/.pi/agent/agents/` quando apropriado.

## Verificação offline

```bash
python3 scripts/link-test-dependencies.py
node work/replacements/ask-fork-test.mjs
node work/replacements/background-carderne/test/background-regression.mjs
node work/replacements/background-carderne/test/watch-preparation-regression.mjs
node work/replacements/final-installed-stack-smoke.mjs
node work/replacements/browser-tests.mjs
```

As suítes usam o SDK instalado e um provedor roteirizado, sem chamadas pagas. `PI_SDK_DIR` e `PI_PACKAGES_DIR` podem ajustar os caminhos. Consulte `docs/verification.md` para diferenciar testes atuais de evidências históricas.

## Próxima evolução

Separar um controlador de sessões, um contrato de eventos e uma interface de usuário, reutilizando o SDK do Pi. Os contratos e fronteiras atuais estão em `docs/integration.md`; o roadmap está em `docs/roadmap.md`.

## Créditos e licença

Os pacotes upstream mantêm autores e licenças próprias. Os forks locais derivam de projetos MIT e mantêm seus avisos. Consulte `vendor/manifest.json` e os arquivos LICENSE de cada pacote. Este repositório não assume autoria do Pi nem dos plugins de terceiros. Nenhuma credencial, conversa real ou estado pessoal do agente está incluído.
