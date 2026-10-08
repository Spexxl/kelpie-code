# Jev Browser — substituição concluída

Instalado `@jkudish/jev-browser@0.8.4` no Node 24.21.0. Commit oficial: `e04be30575de055e7d99b2505d35a228cf190722`. Chromium 1248 / Playwright 1.64.0. Wrapper: `/home/sll/.local/bin/jev-browser`.

MCP Pi nativo em `/home/sll/.pi/agent/mcp.json`, tool `mcp__jev_browser__jev_navigate`. Exposição padrão hidden com override exato codemode para jev_navigate; timeout 610s. Nenhuma credencial injetada. O pacote desabilitado Browser Native foi removido após confirmar conexão e testes. CLI agent-browser preservado.

Validação: 10/10 checks Pi MCP/Code Mode; 78/78 testes oficiais unit/transport offline. Ambos modos on/only descobrem schema, reportam erro sem chave e Plan bloqueia antes da chamada ao servidor. Sentinel inalterado, zero requests HTTP e zero launches Chromium na falha sem chave. As respostas de assistant no harness e transportes do upstream são fixtures, não decisões reais Jev.

A substituição opera por objetivo+URL, não equivale a cada comando agent-browser. Sem chave Jev não há navegação real validada. O processo MCP e Chromium ficam fora do mecanismo bash do pi-sandbox; não foi concedido allowWrite/allowDomains mais amplo. Referências de cookies/senhas são consumidas pelo upstream antes da resolução do provider, portanto a propriedade de ausência de mutação foi testada sem esses argumentos.

Backup: `/home/sll/.pi/backups/replacements-20261008T124905Z`. Recuperação: remover entrada jev-browser de mcp.json, reinstalar `pi install npm:pi-agent-browser-native@0.9.3` e restaurar settings.json do backup (mantinha Browser Native desabilitado). Para API real, fornecer chave pelo ambiente do usuário (por exemplo TYPESAFE_API_KEY) e recarregar Pi; não escrever chave em relatório/argv.

Fontes: [Jev Browser oficial](https://github.com/jkudish/jev-browser), [source do release fixado](https://github.com/jkudish/jev-browser/tree/e04be30575de055e7d99b2505d35a228cf190722), [npm](https://www.npmjs.com/package/@jkudish/jev-browser). Esquema Pi confirmado em `/home/sll/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/mcp.md`.
