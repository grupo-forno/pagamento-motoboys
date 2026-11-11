# QA — módulo Despachante

**Data:** 2026-11-11 · **Commit base:** `3b6bbdd` (branch `teste`) · **Node:** v24.22.1 · **SO:** Windows 11
**Estado do código:** uma correção aplicada em `server.js` (BUG-1). Nada comitado.

## Ambiente e comandos
- Banco isolado em diretório temporário (`DATA_DIR`), usuários e entregadores fictícios, `EMAIL_SO_ARQUIVO=1`, `ALERTAS=0`.
- Agilizone simulado por servidor HTTP local (`AGILIZONE_URL`); e-mail com falha simulada por servidor SMTP em porta fechada.
- Base antes da rodada: `npm test` → 40 de 40.
- Agora: `npm test` → **54 testes, 54 passam, 0 falham, 0 pendências**.
- Só o arquivo novo: `node --test despachante.test.js` → 14 testes, rodado várias vezes, estável.
- Navegador: Playwright MCP (Chromium) contra servidor isolado na porta 3191. A skill `webapp-testing` foi instalada, mas exige Python, que não existe nesta máquina.
- Desempenho: `perf.cjs` (fora do repositório) com banco isolado de 400 fechamentos.

## Matriz de cenários
| # | Cenário | Resultado |
|---|---|---|
| D1 | Importação por arquivos: valores, pedido sem entregador descartado, rascunho da loja certa | Aprovado |
| D2 | Reimportar o mesmo arquivo (3 em paralelo) e 1 dia dentro de período importado: recusa, nada criado | Aprovado |
| D3 | Isolamento: outra loja não importa, abre nem altera (HTML, PDF, Excel, enviar, editar, entregadores) | Aprovado |
| D4 | Perfis e sessão: gestão/financeiro sem acesso; sem sessão vai ao login; despachante não aprova nem paga | Aprovado |
| D5 | Sem Pix bloqueia envio; Pix inválido não salva; envios paralelos geram uma transição | Aprovado |
| D5b | 5 envios simultâneos e 2 repetições depois do sucesso: um e-mail, uma versão, um registro de envio | Aprovado (era BUG-1) |
| D5c | Falha do e-mail (SMTP simulado): envio vale, 3 cliques paralelos geram uma tentativa, reenvio recupera sem duplicar fechamento | Aprovado |
| D6 | Pós-envio: despachante não edita; Financeiro vê os mesmos itens, valores e Pix | Aprovado |
| D7 | XSS em nome de entregador (Despachante e Financeiro) | Aprovado |
| D8 | Uploads inválidos e Resumo de 21 MB: erro claro, sem 500, nada criado | Aprovado |
| D9 | Devolução parcial: motivo visível, correção sem pedido duplicado, histórico preservado | Aprovado |
| D10 | Pix por identidade (API simulada): persiste por loja, reaproveitado, congelado no envio | Aprovado |
| D11 | Administração: usuário novo, calendário, renomear loja, mudar de loja, mudar perfil, desativar | Aprovado |
| D12 | Duas sessões no mesmo registro: edições simultâneas sem corrupção; edição de tela velha depois do envio recusada (403) | Aprovado |
| N1 | Telas em 1280 px e 390 px: sem rolagem horizontal, nome longo quebra, diferença com Resumo correta, console limpo | Aprovado |
| N2 | Upload pelo seletor de arquivos no navegador (xlsx + csv reais): fechamento criado, R$ 22,00, 2 entregadores | Aprovado |
| N3 | Sessão expirada durante preenchimento do Pix: volta ao login com aviso, nada salvo | Aprovado |
| N4 | Diálogo de envio: modal real, foco inicial em "Confirmar e enviar", Tab não chega à página de fundo, Esc e "Voltar e corrigir" devolvem o foco ao botão de envio | Aprovado |

## Bug corrigido

### BUG-1 — E-mail duplicado em envios simultâneos (corrigido)
- **Causa:** em `POST /fechamentos/:fid/enviar`, `solicitarPagamento` (e-mail) rodava antes da transação que confere status e versão.
- **Correção (`server.js`):** a transição para "enviado" é gravada primeiro, num passo síncrono; só quem a conclui notifica. Requisição repetida encontra o fechamento já enviado (403 em `podeEditar`, ou a checagem de versão) e não manda e-mail. O e-mail vem depois, com o fechamento já gravado.
- **Garantia alcançada:** no máximo uma notificação por transição de versão, mesmo com requisições simultâneas ou repetidas. Falha do e-mail não desfaz o envio: o financeiro já vê o fechamento e o histórico registra "E-mail (solicitação) falhou".
- **Recuperação:** "Reenviar e-mail" (`POST /fechamentos/:id/email`) refaz só o e-mail, sem mudar o fechamento (testado em D5c).
- **Limite conhecido:** se o processo cair entre a gravação e o e-mail, não há nova tentativa automática. O histórico mostra o envio sem "E-mail enviado" e o reenvio manual resolve. Retentativa automática exigiria uma marca persistente por versão (migração) e não foi feita.
- **Prova:** com o `server.js` original, D5b falha (5 ≠ 1) e D5c falha (3 ≠ 1); com a correção, passam.

## Corrigido depois das decisões do dono do sistema

| Achado | O que foi feito | Prova |
|---|---|---|
| **BUG-2** botão "Enviar para aprovação" desativado sem destinatário | O envio ao financeiro vale **sem e-mail** (rótulo "(sem e-mail)", aviso e texto na confirmação). O e-mail é reenviado depois, separado, em "Reenviar e-mail", onde dá para acrescentar destinatários; só o reenvio exige destinatário. | Navegador: enviado sem e-mail, depois reenviado para 2 destinatários; botão de reenvio desativado até haver destinatário. |
| **PERF-1** listas lentas | Índice `pedidos_fechamento` em `pedidos(fechamento_id)` (`db.js`, migração aditiva e reversível com `DROP INDEX`). | Ver "Desempenho medido": Pendências 84,7 s → 0,53 s. |
| **Edição simultânea do mesmo registro** | Cada tela de edição guarda a versão que o usuário viu; salvar com versão antiga é **recusado** ("foi alterado por outra pessoa… nada foi salvo"). Vale para o entregador do fechamento (edição individual e Chaves Pix, linha a linha), usuários e lojas. | D12 (duas sessões, simultâneo e sequencial), E1 (usuário e loja). |
| **Pix salvo some ao atualizar o Agilizone?** | Não some: atualizar só acrescenta quem é novo. Agora há teste. A edição de Pix e a importação CSV de *Configurações › Entregadores* (que gravavam num cadastro que os fechamentos não leem) foram **desativadas**. | D13; experimento anterior. |

Limite conhecido da versão por conteúdo: se duas edições deixam o registro com o mesmo conteúdo que tinha ao abrir (volta ao valor original), a segunda passa; não há perda de dado nesse caso.

## Ainda aberto
- **Pix na importação por arquivo** (ver investigação abaixo): aguardando decisão.
- **Fila do Financeiro** com 400 fechamentos: 21,3 s → 4,8 s com o índice; ainda lenta. O custo restante está em `grade()` por fechamento (consultas a `resumo`, `aprovacoes`, `edicoes`); não foi investigado a fundo.
- Importação de 6.000 pedidos (45,9 s antes): **não remedida** depois do índice.

## Desempenho medido
Cenário: 1 loja, 400 fechamentos pagos no histórico (8 meses), 960.000 pedidos, 3.000 entregadores cadastrados (80 MB). Máquina de desenvolvimento, servidor local, sem carga concorrente.

| Operação | Volume | Medido |
|---|---|---|
| Pendências (lista) | 400 fechamentos | **mediana 84,7 s** (máx 100,9 s) |
| Fila do Financeiro (todas as abas) | idem | **mediana 21,3 s** (máx 44,1 s) |
| Histórico (lista) | idem | 8 ms |
| Entregadores, 3.000 cadastrados (sem filtro / busca / só sem Pix) | 3.000 | 1,5 s / 1,3 s / 1,4 s |
| Importar 6.000 pedidos, 60 entregadores, 4 dias | xlsx 1,6 MB | **45,9 s** |
| Importar 30.000 pedidos, 200 entregadores, 4 dias | xlsx 8,2 MB | **63,2 s** |
| Reimportar o mesmo arquivo (recusa) | 6.000 / 30.000 | 0,9 s / 0,7 s |
| Abrir fechamento (6.000 / 30.000 pedidos) | | 0,8 s / 0,15 s |
| PDF / Excel (6.000 pedidos) | | 0,64 s / 0,39 s |
| Salvar Pix de 60 / 200 entregadores | | 0,4 s / 0,07 s |
| Enviar ao financeiro (PDF + Excel + e-mail, 6.000 pedidos) | | 3,0 s |

- A consulta de duplicidade é rápida (2 ms para 6.000 chaves em 960 mil pedidos): o índice `(loja_id, chave)` funciona. A lentidão vem da falta do índice por `fechamento_id`.
- O tempo de 6.000 pedidos (45,9 s) maior que o de abrir a tela sugere o mesmo custo dentro da importação (`vincula` e conferências consultam `pedidos` por fechamento). **Hipótese ainda não medida isoladamente**; a medição antes/depois do índice na importação fica como tarefa.
- **Depois do índice** (mesmo banco: 400 fechamentos, 960 mil pedidos; mediana de 3): Pendências **527 ms** (antes 84.668 ms), fila do Financeiro **4.813 ms** (antes 21.290 ms), abrir fechamento #401 **138 ms** (antes 799 ms). Criar o índice na primeira inicialização levou menos de 1 s.

## Pix na importação por arquivo: investigação
**Pedido:** reaproveitar a chave digitada quando o entregador estiver identificado com segurança na loja.

**Identificadores que o arquivo oferece**
- Relatório de Pedidos (`.xlsx`): só o **nome** do entregador (mais número e horário do pedido). Nenhum id.
- Resumo (`.csv`): nome, **CPF** (quando preenchido), Chave Pix, data de nascimento e valores. Nenhum id do Agilizone.
- Só a **API** devolve o id estável do entregador; por isso só ela cria a identidade (`entregador_pix`, chave `(loja, agz_id)`).

**O que acontece hoje na importação por arquivo**
- `vincula()` cria um entregador novo por nome em cada fechamento e **não** cria identidade; `salvaPixCadastro` só atualiza quem já tem `entregador_pix`. Resultado: o Pix digitado vale só para aquele fechamento.
- A tabela **`apelidos`** `(loja_id, nome → motoboy_id)` é de uma tela antiga de vínculo manual (removida no commit `9b141f7`). Nenhum código a preenche hoje; só `registra()` ainda a consulta ao importar. No banco de desenvolvimento local há **44 linhas** legadas nela. Efeito: nome igual no arquivo pode ligar a um entregador antigo por apelido, o que a regra atual ("nome não herda Pix") quer evitar.
- Dados do banco local (140 linhas de Resumo): CPF em 33 (24%), Pix em 41 (29%). CPF **não** serve como identidade para todos.

**Proposta (não implementada, aguarda aprovação)**
1. **Vínculo explícito.** Na tela do fechamento, ao lado de cada entregador "identidade pendente", um controle "Vincular ao cadastro da loja" que lista os entregadores da loja com identidade confirmada (os da API). Quem confirma é o despachante da loja ou o Admin; o nome do arquivo nunca vincula sozinho.
2. **Onde guardar:** reaproveitar `apelidos` com colunas aditivas `criado_por`, `criado_em` e `origem` (`manual`). Ao importar, só vínculos `origem = 'manual'` valem; as 44 linhas legadas ficam inertes até revisão.
3. **Identidade para quem não vem da API:** CPF válido (11 dígitos, dígitos verificadores) pode propor o vínculo, mas a pessoa confirma; sem CPF, só o vínculo manual.
4. **Pix:** continua por loja (`entregador_pix`). Pix do Resumo diferente do cadastro segue marcado como divergência (regra existente `divergenciaPix`).
5. **Conflitos:** dois nomes do mesmo arquivo para o mesmo cadastro, ou um cadastro já vinculado a outro nome na loja, bloqueiam o vínculo e vão para revisão.
6. **Migração:** só `ALTER TABLE apelidos ADD COLUMN ...` (aditiva, sem apagar nada) e auditoria das 44 linhas antes de ativar. Fechamentos enviados mantêm o Pix congelado (`envio_pix`).

**Decisões necessárias:** (a) o CPF pode propor vínculo automático ou só sugerir? (b) quem pode vincular (despachante da loja, só Admin)? (c) o que fazer com os apelidos legados?

## Cobertura restante e limitações
- Cenários executados pela interface: importação por seletor de arquivos, sessão expirada, diálogo de envio (teclado e foco). Os demais foram exercitados por requisições HTTP reais contra o servidor, não por cliques.
- **Duas sessões editando na interface:** coberto só por requisições simultâneas (D12), não por duas janelas de navegador.
- **Textos longos** verificados na tela do fechamento (390 px e 1280 px); não nas demais telas.
- **Aprovação parcial, registro de pagamento e lotes:** cobertos por `financeiro.test.js`, não reexecutados no navegador.
- **Desempenho:** uma execução por cenário de importação (as demais medidas são medianas de 3 a 5). Sem medição depois de qualquer otimização.
- Python ausente: scripts da skill `webapp-testing` não usados.

## Arquivos e evidências
- Teste: `despachante.test.js` (14 testes)
- Alteração funcional: `server.js` (rota `POST /fechamentos/:fid/enviar`)
- Capturas: `docs/qa/evidencias/despachante-desktop.png`, `despachante-390px.png`, `despachante-upload-antes.png`, `despachante-dialogo-aberto.png`
- Arquivos de upload fictícios: `docs/qa/fixtures/pedidos-qa.xlsx`, `docs/qa/fixtures/resumo-qa.csv`
- Fora do escopo: `skills-lock.json` aparece modificado pela instalação das skills.
