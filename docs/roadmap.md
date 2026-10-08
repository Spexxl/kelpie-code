# Evolução para harness próprio

1. Manter esta baseline versionada e exercitar restauração numa máquina limpa.
2. Extrair um controlador de sessões por cima do SDK Pi 1.1.0, com um contrato explícito de eventos, cancelamento, ferramentas, aprovações e tarefas.
3. Centralizar a decisão de permissão para chamadas diretas, CodeMode, MCP, subagentes e processos background; ampliar o confinamento do navegador.
4. Expor uma API local autenticada e uma interface para conversa, plano, tarefas, logs e aprovações. Definir stack de interface quando essa fase começar.
5. Migrar configurações e estado com versões, preservando sessões e possibilidade de rollback.
6. Validar provedores reais, reconexão, encerramento, retomada e comportamento das permissões antes de distribuir.

Este documento é direção futura, não uma implementação nem uma promessa de isolamento integral no estado atual.
