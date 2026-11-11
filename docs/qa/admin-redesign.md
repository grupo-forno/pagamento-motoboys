# Redesign do módulo Admin

**Data:** 2026-11-11 · **Base:** `3b6bbdd` (branch `teste`) · **Estado:** diff local, sem commit, push ou deploy.
**Referência visual:** tela atual do Despachante; Financeiro consultado para Pagamentos.

## Como revisar localmente
```bash
git diff -- server.js public/            # 4 arquivos de código
git status --short                       # inclui admin.test.js, despachante.test.js e docs/
npm test                                 # 66 testes
```
Servidor isolado (não toca em `data/`): `DATA_DIR=<pasta vazia> PORT=3191 EMAIL_SO_ARQUIVO=1 SYNC_ENTREGADORES=0 ALERTAS=0 node server.js`, depois criar um usuário admin pelo banco ou usar a senha mostrada no primeiro início.
Comparação visual: `docs/qa/evidencias/` (`antes-admin-*`, `final-admin-*`, `cmp-*`, `ref-despachante-1440.png`).

## Estratégia
O visual do Despachante e do Financeiro vem da classe `operacional` no `<body>` (tokens, cabeçalho compacto, cartões). O Admin e a Gestão não a recebiam. A mudança central é `page()` passar a aplicar `admin operacional` a esses dois perfis; as telas foram reorganizadas sobre isso.

## O que foi implementado

| Tela | Mudança |
|---|---|
| **Todas do Admin** | Classe `admin operacional`; cabeçalho compacto branco em vez da faixa escura com ilustração. Gestão recebe o mesmo (usa as mesmas telas). |
| **Fechamentos `/`** | Indicadores numa linha, primeiro indicador claro como o do Despachante, frase de escopo ("de todas as lojas e períodos, sem os filtros da lista"). Colunas "Pagamento previsto" e "Período das entregas"; pagamento efetivo aparece como "Transferência registrada em dd/mm". Filtros **"Aprovados, sem pagamento registrado"** e **"Pagos (registrados)"** separados. Configuração pendente só aparece quando falta algo e desceu para depois da lista. Agenda recolhível (abre sozinha com atrasos ou pelo link "Ver na agenda"). Tabela sobe de y=785 para y=623 em 1440 px. |
| **Importação `/fechamentos/novo`** | Aviso exclusivo do Admin: a loja vem do nome no arquivo e uma loja inexistente é **criada** com o calendário padrão. Correções de layout estreito compartilhadas (ver "Efeitos em outros perfis"). |
| **Detalhe `/fechamentos/:id`** | Confirmação de arquivamento reescrita para explicar os efeitos (pedidos livres para importar, nada apagado, recuperação em Arquivados). O restante já usa a estrutura do Despachante/Financeiro e não foi alterado. |
| **Pagamentos `/pagar`** | Sem alteração de código: já é a implementação do Financeiro e o Admin passa a usá-la com o mesmo visual (seleção com quantidade e total, confirmação com lista, escopo dos filtros, A pagar/Vencidos por pagamento previsto, Pagos por data efetiva). |
| **Usuários `/usuarios`** | Tabela no padrão do Despachante (Pessoa, Perfil, Loja/escopo com "Todas as lojas" explícito, Situação com texto, Editar). Busca por nome/login, filtro por perfil e situação (guardados na sessão), contador "n de total", estado de filtro sem resultados. Criar e editar em **painel lateral**; o texto de alcance muda ao escolher perfil e loja; loja desativada para Gestão/Admin; login imutável na edição; "Nova senha (opcional)" com explicação; validação **por campo** com valores preservados (a senha não volta), painel reaberto e foco no primeiro campo inválido; login duplicado. Alterações não salvas pedem confirmação. |
| **Configurações `/config`** | **E-mail:** faixa separando o que está *salvo* (servidor, destinatários) do *resultado real* (último teste registrado no histórico); o teste agora diz que usa as configurações salvas e que "aceito pelo servidor" não garante entrega; erros por campo (e-mail inválido, porta). **Alertas:** linha "Situação real" que distingue preferência desligada, bloqueio do servidor (`ALERTAS=0`) e dependência do SMTP. **Lojas:** tabela (nome, calendário legível, integração, fechamentos) e painel de edição; calendário mantém a sintaxe atual com exemplos, "Como o sistema lê" e erro por campo; aviso de que renomear exige ajustar as variáveis do Agilizone. **Entregadores:** aviso de que a aba é o cadastro legado. |
| **Entregadores `/entregadores`** | Sem alteração: já é a entrada principal, com loja em cada edição. |

## Componentes reutilizados
`.ph.compacto`, `.card`, `.tw table`, `.badge`, `.btn-*`, `.seg`/`.pills`, `dialog.dlg.sheet.ent-sheet` (painel lateral de "Editar Pix" do Despachante), `.erro-campo`, `.alert`, `.stats`, `data-abre`/`data-fecha` (marca.js), bloqueio de duplo envio global (ui.js). Código novo: `telaUsuarios`, `telaConfig`, `dadosUsuario`, `salvaLoja` em `server.js`; filtros, escopo e proteção de alterações em `public/admin.js`; estilos em `public/admin.css`.

## Efeitos em outros perfis (estilos compartilhados)
Três regras novas em `public/marca.css`: o painel de contexto da importação não força largura em janela estreita; a grade da importação usa `minmax(0,1fr)` abaixo de 1000 px; textos de `.alert` quebram identificadores longos. Verificado em 390 px: Despachante (Pendências, Entregadores, Importação, Detalhe) e Financeiro (fila, Pagamentos) sem rolagem horizontal e com as mesmas propriedades de antes.

## O que foi testado

**Automatizado (`npm test`: 66 de 66, sem pendências)** — `admin.test.js` (7 testes): validação por campo e valores preservados em usuário novo e edição; login imutável; senha vazia mantém a atual; perfil sem loja zera a loja; troca de senha derruba a sessão; Admin não remove o próprio acesso; e-mail e porta inválidos sem gravar; teste de envio com SMTP simulado registra "recusado pelo servidor"; nome de loja duplicado e calendário inválido sem gravar; renomear loja preserva fechamentos e usuários; rótulos de Fechamentos; classe do corpo por perfil; Despachante e Financeiro sem elementos do Admin; 403 para perfis sem permissão. `despachante.test.js` (D11) foi ajustado só para a nova mensagem "Loja X salva.".

**No navegador (Playwright, servidor isolado)**
- Usuários: filtro por texto, estado vazio e limpar; escopo dinâmico por perfil e loja; foco inicial no painel; erros por campo com valores preservados; recusar o descarte mantém painel e dados; aceitar fecha e **devolve o foco** ao botão "Novo usuário".
- Configurações: as 4 abas abrem; erros de e-mail/porta com valores preservados; painel de loja abre com foco no nome; erro de calendário reabre o painel na aba certa com o valor digitado.
- **Comparação Admin × Despachante** (estilos computados em 1440, 1280 e 390 px): fundo, fonte, cabeçalho (fundo, padding, tamanho e peso do título), botão primário (cor e altura), cabeçalho de tabela e largura do menu **idênticos**.
- **Rolagem horizontal da página** em 1440, 1280 e 390 px nas 10 telas do Admin: nenhuma. Tabelas largas rolam dentro do próprio quadro.
- Console: sem erros, exceto o registro do navegador para as respostas 422 de validação (esperado).

## O que foi implementado mas **não** testado
- Clique, teclado e retorno de foco nos painéis de **Lojas** (só abertura, foco inicial e reabertura com erro foram vistos; o mecanismo é o mesmo do painel de Usuários, que foi testado por inteiro).
- Botões de exemplo do calendário (`data-cal-ex`) e teste de conexão com o Agilizone no painel da loja.
- Estado salvo × resultado do teste de e-mail com **servidor real**: só a recusa foi exercitada (SMTP simulado); o caso "aceito" não foi.
- Linha "Situação real" dos alertas em cada combinação (só a de bloqueio `ALERTAS=0` apareceu no ambiente de teste).
- Aviso do Admin na importação e confirmação de arquivamento: texto conferido no código e no teste de rótulos, sem clique no navegador.
- Persistência de filtros de Usuários entre telas (guardada em `sessionStorage`; só o filtro foi exercitado).
- Zoom diferente de 100%. Janela de largura intermediária (entre 390 e 1280 px).

## Não feito (fora do que o contrato atual permitia, ou sem decisão)
- **Unificar Entregadores** em uma tela só (ver achado 1).
- **Mover as instruções de exportação** para junto de cada método na importação: a coluna lateral é compartilhada com o Despachante; ficou como está.
- **Diferenciar Pix ausente, inválido, repetido e divergente** na tela de detalhe: as regras existem, mas a tela não foi revisada nesta rodada.
- **Estados "carregando", lista vazia e erro** em todas as telas: mantidos como estavam; só foram acrescentados os de Usuários (filtro sem resultado) e os de erro por campo.
- Editor estruturado de calendário: não implementado de propósito. A sintaxe atual aceita qualquer combinação de ciclos; um editor só entra se cobrir todos os formatos sem perda.

## Componentes que quebravam com valores grandes ou texto longo (corrigido)
Reproduzido com valores de R$ 37 milhões, rótulos sem espaços e motivo de devolução de 260 caracteres.
- **Indicadores (`.stat`):** o valor dividia a largura com o ícone e saía do cartão (`R$ 37.037.03…`). Agora o valor ocupa a largura inteira do cartão, com ícone e rótulo embaixo, e a fonte diminui sozinha até caber (`public/marca.js`, mínimo 13 px; só em último caso corta com reticências e mostra o valor no `title`). Rótulos longos quebram linha.
- **Totais da conferência (`.resumo`)** e **total selecionado em Pagamentos:** mesma regra (o total grande quase encostava na borda no celular).
- **Aviso "o financeiro devolveu um fechamento":** motivo e título longos sem espaços saíam do cartão; agora quebram.
- **Cabeçalhos de cartão** passam a quebrar texto longo.
- **Tabelas largas:** o texto oculto das células alargava a página inteira em 390 px (apareceu com a fila do Financeiro); agora fica preso ao quadro de rolagem.
- Verificado em 1440, 1280 e 390 px em 15 telas dos três perfis: nenhuma com rolagem horizontal. Os cortes restantes apontados pela varredura são texto só para leitor de tela (`.sr`), cortado de propósito. Evidências: `docs/qa/evidencias/quebra-*`.
- Estes ajustes são no CSS compartilhado e valem para os três perfis.

## Decisões do dono do sistema e o que foi feito
1. **Aprovado e Pago são coisas diferentes; registrar pagamento é opcional.** O filtro único virou dois: "Aprovados, sem pagamento registrado" (`s=aprovado`) e "Pagos (registrados)" (`s=pago`). O indicador diz "Aprovado, sem pagamento registrado". A situação de um aprovado continua "Aprovado, a pagar" nas demais telas.
2. **Pix tem de persistir quando a lista do Agilizone é atualizada.** Já persistia (atualizar só acrescenta quem é novo); agora há teste (D13). *Configurações › Entregadores* deixou de editar Pix e importar CSV (gravavam no cadastro legado, que os fechamentos não leem) e aponta para *Entregadores*, que é por loja.
3. **Não renomear loja.** O campo do nome fica bloqueado para todo admin, com o alerta "NÃO RENOMEIE A LOJA"; só o **super administrador** (login `admin`, o usuário inicial) pode alterá-lo, e o servidor também recusa. Não existe um perfil "super administrador": adotei o login `admin`; se preferir outro critério, é um ponto único em `superAdmin()`.
4. **Enviar ao financeiro sem e-mail** e reenviar depois: feito (ver `despachante.md`).
5. **Índice**: aplicado (ver `despachante.md`).
6. **Edição simultânea**: bloqueada para entregador do fechamento, usuários e lojas.

## Ainda aberto
- **Pix na importação por arquivo:** aguardando decisão (investigação em `despachante.md`).
- **Importação do Admin cria loja sozinha** com um nome diferente no arquivo: só há o aviso na tela.
- O `confirm()` de "alterações não salvas" é simples do navegador; respostas de validação usam HTTP 422 (aparecem como erro no console).

## Arquivos
- Código: `server.js`, `public/admin.js`, `public/admin.css`, `public/marca.css`
- Testes: `admin.test.js`, `despachante.test.js`
- Relatórios: `docs/qa/admin-redesign.md`, `docs/qa/despachante.md`
- Evidências: `docs/qa/evidencias/` (62 imagens; as `antes-*` mostram o estado anterior), `docs/qa/fixtures/`
- Fora do escopo: `skills-lock.json` aparece modificado pela instalação das skills.
