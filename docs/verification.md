# Estado de verificação

Evidência da instalação revisada: Ask 126/126; Background 21/21; Watch 4/4; Sandbox 50 aprovados, 0 falhas, 3 pulados; stack completa 9/9. Jev: integração 10 checks e suíte upstream 78 checks offline. Três grafos fonte passaram na checagem TypeScript.

Esses números são evidências anteriores à criação do repositório, não prova de restauração em outra máquina. Os arquivos de resultados acompanham os forks e `outputs/pi-stack-versoes.json` preserva o inventário.

`work/tests/compatibility.mjs` e seu README são históricos: carregam plugins originais para reproduzir incompatibilidades anteriores. Para validar o estado atual, use as suítes de `work/replacements` listadas no README principal.

As verificações que exigem isolamento de processo/socket devem rodar fora de um sandbox hospedeiro adicional. Elas escrevem apenas em fixtures locais ou temporárias. Não faça chamadas pagas para considerar os testes offline concluídos.

Navegação real Jev, autenticação e interfaces interativas continuam pendentes. Há um advisory upstream documentado no inventário; ele não foi resolvido com downgrade forçado.

## Verificação ao preparar o repositório

Ask/CodeMode: 126/126 após executar fora do sandbox hospedeiro. Watch: 4/4. Carregamento da stack instalada: 9/9. Background: primeira execução 20/21, repetição 21/21; a falha inicial foi a asserção de escrita do caso explicit-off, que aguarda somente 400 ms. A fragilidade de tempo desse teste deve ser investigada antes de torná-lo uma barreira de CI. Nenhum código de produção foi alterado nesta preparação. Scripts copiados ganharam caminhos portáveis e links de dependências de desenvolvimento.

Os arquivos fonte dos três forks correspondem à baseline revisada; hashes em `locks/maintained-source-sha256.json`. A restauração completa em máquina limpa ainda não foi executada.
