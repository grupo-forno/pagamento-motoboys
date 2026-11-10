const fs = require('fs');
let s = fs.readFileSync('server.js','utf8');
const replace = (a,b) => { if (!s.includes(a)) throw Error('Trecho ausente: '+a.slice(0,100)); s=s.replace(a,b); };
replace("const desp = u?.perfil === 'despachante';", "const desp = u?.perfil === 'despachante', financeiro = u?.perfil === 'financeiro' || o.financeiro || p === '/pagar';");
replace("${desp ? 'despachante' : ''}", "${desp ? 'despachante operacional' : financeiro ? 'financeiro operacional' : ''}");
// Agenda stays on the same service/calendar. Only the optional financial view changes its presentation.
replace('function cardAgenda(u, itens) {', 'function cardAgenda(u, itens, compacta = false) {');
replace('<div class="mut small">Filtro no Agilizone: ${filtroAgilizone(p)}</div>', '${compacta ? html`<details class="ag-filtro"><summary>Filtro do Agilizone</summary><span class="mut small">${filtroAgilizone(p)}</span></details>` : html`<div class="mut small">Filtro no Agilizone: ${filtroAgilizone(p)}</div>`}');
replace('${cardAgenda(u, ag)}</details>', '${cardAgenda(u, ag, true)}</details>');
replace("const aqui = qs(), filtrando = !!(loja || de || ate || busca)", "const aqui = qs(), filtrando = !!(loja || de || ate || busca || per.tipo !== 'semana')");
replace("sub: 'Confira cada fechamento enviado pelas lojas, aprove ou devolva para correção. O pagamento é registrado depois, em Pagamentos.'", "sub: 'Confira os valores e aprove ou devolva à loja. Registre transferências em Pagamentos.'");
replace('<dl class="resumo" aria-label="Indicadores${filtrando', '<p class="fin-escopo">Indicadores e contadores: ${loja ? lojaCurta(lojas.find((l) => l.id === loja).nome) : \'todas as lojas autorizadas\'} · filtros de envio e busca atuais · todas as situações. Aprovados: ${dataFmt(per.ini)} a ${dataFmt(per.fim)}.</p>\n<dl class="resumo fin-indicadores" aria-label="Indicadores${filtrando');
replace("${filtrando ? 'todas as situações, nos filtros atuais' : 'todas as situações e lojas'}", "nos filtros atuais, incluindo aprovações parciais");
const ls=s.indexOf('${lojas.length > 1 ? html`<nav class="pills fila-lojas"'), le=s.indexOf('<nav class="seg fila-abas"',ls);
if(ls<0||le<0)throw Error('Filtros fila não encontrados');
let period=s.slice(ls,le);period=period.slice(period.indexOf('${todos.some'));
period=period.replace("? barraPeriodo(", '? html`<details class="fin-periodo"><summary>Período dos aprovados · ${dataFmt(per.ini)} a ${dataFmt(per.fim)}</summary>${barraPeriodo(').replace("'vale para os aprovados; o que aguarda análise aparece sempre') : ''}", "'vale para os aprovados; o que aguarda análise aparece sempre')}</details>` : ''}");
s=s.slice(0,ls)+s.slice(le);
replace("${loja ? html`<input type=\"hidden\" name=\"loja\" value=\"${loja}\">` : ''}\n<div class=\"field\"><label for=\"f-de\">", "<div class=\"field\"><label for=\"f-loja\">Loja</label><select id=\"f-loja\" name=\"loja\"><option value=\"\">Todas as autorizadas</option>${lojas.map((l) => html`<option value=\"${l.id}\" ${l.id === loja ? 'selected' : ''}>${lojaCurta(l.nome)}</option>`)}</select></div>\n<div class=\"field\"><label for=\"f-de\">");
replace('</div></form></details>\n${lista.length', '</div></form></details>\n'+period+'${lista.length');
replace('<th scope="col">Período</th><th scope="col" class="opc">Recebido</th>', '<th scope="col">Período das entregas</th><th scope="col" class="opc">Data de envio</th>');
replace('pagamento ${diaLongo(f.pagamento)}', 'Pagamento previsto: ${diaLongo(f.pagamento)}');
replace("titulo: `Fechamento #${f.id}`, selo: seloFin", "titulo: `Fechamento #${f.id}`, financeiro: true, compacto: true, selo: seloFin");
replace('<dl class="resumo" aria-label="Valores do fechamento">','${nBloq ? html`<div class="alert bad" role="note"><div><b>${nBloq} entregador(es) bloqueado(s)</b>Sem Pix não é possível aprovar. Confira os itens e devolva para correção.</div></div>` : \'\'}\n<dl class="resumo" aria-label="Valores do fechamento">');
// Payment recipients live outside the main table and outside the payment form.
const la=s.indexOf('  const linhaF = (f, comCx) => { const its = aPagarDe(f);',s.indexOf("app.get('/pagar'"));
const lb=s.indexOf('  const lotes = new Map();',la);
if(la<0||lb<0)throw Error('Tabela pagamentos ausente');
s=s.slice(0,la)+`  const recebimentos = new Map(lista.map((f) => [f.id, aPagarDe(f)]));
  const linhaF = (f, comCx) => { const its = recebimentos.get(f.id) || aPagarDe(f);
    return html\`<tr>\${comCx ? html\`<td class="c-chk"><input type="checkbox" name="sel" value="\${f.id}:\${f.total}:\${assinaPag(its)}" data-v="\${f.total}" data-rot="#\${f.id} · \${lojaCurta(f.loja)}" data-n="\${its.length}" aria-label="Selecionar fechamento #\${f.id}, \${lojaCurta(f.loja)}, \${brl(f.total)}"></td>\` : ''}
<td class="c-fech"><a href="/fechamentos/\${f.id}"><b>#\${f.id}</b></a></td><td class="c-loja">\${lojaCurta(f.loja)}</td><td class="c-per">\${periodo(f)}</td>
<td class="c-pag">\${f.pagamento ? dataFmt(f.pagamento) : html\`<span title="Vencimento usa o fim do período">Sem data · referência \${dataFmt(f.data_fim)}</span>\`}\${!f.pago_em && prev(f) < hoje ? html\`<small class="bad-t">Vencido há \${atraso(f)} dia\${atraso(f) === 1 ? '' : 's'}</small>\` : ''}</td>
<td class="n c-ent">\${f.n}</td><td class="n b c-tot">\${brl(f.total)}</td><td class="n c-acao"><button type="button" class="btn btn-sec btn-sm" data-abre="recebe-\${f.id}">Quem recebe</button></td></tr>\`; };
  const cab = (cx) => html\`<thead><tr>\${cx ? html\`<th scope="col"><input type="checkbox" data-todos aria-label="Selecionar todos os \${lista.length} fechamentos desta fila filtrada" aria-describedby="pg-selecao-escopo"></th>\` : ''}<th scope="col">Fechamento</th><th scope="col">Loja</th><th scope="col">Período das entregas</th><th scope="col">Pagamento previsto</th><th scope="col" class="n">Entregadores</th><th scope="col" class="n">Total</th><th scope="col">Ação</th></tr></thead>\`;
  const paineis = lista.map((f) => html\`<dialog id="recebe-\${f.id}" class="dlg sheet side-panel" aria-labelledby="recebe-t-\${f.id}"><h2 id="recebe-t-\${f.id}">Quem recebe · fechamento #\${f.id}</h2><p><b>\${f.loja}</b> · \${periodo(f)}</p><p class="hint">Pix e valores registrados na aprovação. Total: <b>\${brl(f.total)}</b>.</p>
<div class="tw"><table class="pg-sub"><caption class="sr">Destinatários do fechamento #\${f.id}</caption><thead><tr><th scope="col">Entregador e Pix aprovado</th><th scope="col" class="n">Valor</th><th scope="col">Copiar</th></tr></thead><tbody>\${recebimentos.get(f.id).map((i) => html\`<tr><th scope="row">\${i.nome}<small class="pix-c">\${i.pix || 'Sem Pix'}</small></th><td class="n">\${brl(i.valor)}</td><td>\${i.pix ? html\`<button type="button" class="btn btn-sec btn-xs" data-copiar="\${i.pix}" data-copiar-nome="\${i.nome}" aria-label="Copiar Pix de \${i.nome}"><span data-copiar-tx>Copiar Pix</span></button>\` : ''}</td></tr>\`)}</tbody></table></div><div class="acoes-f"><button type="button" class="btn btn-sec" data-fecha>Fechar</button></div></dialog>\`);
`+s.slice(lb);
replace("largura: 'larga', compacto: false", "largura: 'larga', compacto: true, financeiro: true");
replace("sub: 'Aprovado ainda não é pago. Copie o PIX, faça a transferência no banco e registre o pagamento aqui.'", "sub: 'Consulte os destinatários, transfira no banco e registre a transferência feita.'");
replace('<div class="stats"><div class="card stat"><span class="hico bad">', '<div class="stats fin-indicadores"><div class="card stat"><span class="hico bad">');
const pls=s.indexOf('${lojas.length > 1 ? html`<nav class="pills lojas-pills"',s.indexOf("app.get('/pagar'")), ple=s.indexOf('<div class="card"><nav class="seg"',pls);
s=s.slice(0,pls)+s.slice(ple);
replace('<div class="card"><nav class="seg" style="padding:0 20px;margin:0" aria-label="Situação do pagamento">', '<section class="card fila pg-fila" aria-labelledby="pg-fila-t"><header class="fila-cab"><h2 id="pg-fila-t">Fila de pagamentos</h2><span class="mut small">${lista.length} fechamento(s) · ${brl(soma(lista))} nos filtros atuais</span></header><nav class="seg fila-abas" aria-label="Situação do pagamento">');
replace('</nav>\n<form method="get" action="/pagar"', '</nav><p class="fin-escopo">Contadores das abas: loja selecionada, sem filtro de datas. A lista e seu total seguem as datas abaixo.</p>\n<form method="get" action="/pagar"');
replace("${loja ? html`<input type=\"hidden\" name=\"loja\" value=\"${loja}\">` : ''}\n<div class=\"field\"><label for=\"p-de\">", "<div class=\"field\"><label for=\"p-loja\">Loja</label><select id=\"p-loja\" name=\"loja\"><option value=\"\">Todas as autorizadas</option>${lojas.map((l) => html`<option value=\"${l.id}\" ${l.id === loja ? 'selected' : ''}>${lojaCurta(l.nome)}</option>`)}</select></div>\n<div class=\"field\"><label for=\"p-de\">");
replace("'Pago de' : 'Pagamento previsto de'", "'Pagamento efetivo de' : 'Pagamento previsto de'");
replace("'Pago até' : 'Pagamento previsto até'", "'Pagamento efetivo até' : 'Pagamento previsto até'");
replace('<form method="post" action="/pagar" data-pagar data-carregando="Registrando o pagamento…">', '<form method="post" action="/pagar" data-pagar data-sem-carga data-usuario="${u.id}">');
const steps=s.indexOf('<ol class="pg-passos">',s.indexOf("app.get('/pagar'")), ste=s.indexOf('</ol>',steps)+5;
s=s.slice(0,steps)+`<p class="pg-instrucao" id="pg-selecao-escopo">Abra <b>Quem recebe</b> para consultar e copiar o Pix aprovado. Selecionar todos marca os <b>\${lista.length} fechamentos desta fila filtrada</b>.</p>`+s.slice(ste);
replace("${filtrando ? 'Nenhum fechamento neste período.' : aba === 'vencidos'", "${filtrando || loja ? 'Nenhum fechamento com estes filtros. Altere a loja ou as datas.' : aba === 'vencidos'");
replace('<button type="button" class="btn btn-ghost" data-limpar>Limpar</button><button class="btn btn-pri btn-lg" data-pagar-btn', '<span class="small pg-aviso-banco">Faça a transferência no banco antes de registrar o pagamento</span><button type="button" class="btn btn-ghost" data-limpar>Limpar</button><button class="btn btn-pri btn-lg" data-pagar-btn');
replace("</form>`}</div>`));\n});\n\napp.post('/pagar'", `</form>\`}</section>\${paineis}
<dialog id="dlg-pagamento" class="dlg" aria-labelledby="pg-confirmar-t" aria-describedby="pg-confirmar-hint"><h2 id="pg-confirmar-t">Registrar pagamento</h2><p id="pg-confirmar-hint">Faça a transferência no banco antes de registrar o pagamento</p><div data-pg-resumo></div><p class="hint" data-pg-total></p><p role="status" aria-live="polite" data-pg-status></p><div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha data-pg-cancelar>Cancelar</button><button type="button" class="btn btn-sec" data-pg-consultar hidden>Consultar estado registrado</button><a class="btn btn-sec" href="\${aqui}" data-pg-atualizar hidden>Atualizar fila</a><button type="button" class="btn btn-pri" data-pg-confirmar>Registrar pagamento</button></div></dialog>\`));
});

// Consulta somente de leitura, com as mesmas permissões e loja do registro.
// Usada para resolver resposta incerta antes de permitir nova tentativa.
app.get('/pagar/estado', soPagar, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number);
  if (!ids.length || ids.length > 300 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ erro: 'Seleção inválida.' });
  const fs = [...new Set(ids)].map(carregaF);
  if (fs.some((f) => !f || !podeVer(req.user, f))) return res.status(404).json({ erro: 'Fechamento não encontrado.' });
  res.json({ fechamentos: fs.map((f) => ({ id: f.id, loja: f.loja, valor: grade(f).total, registrado: !!f.pago_em, pago_em: f.pago_em, lote: f.lote })) });
});

app.post('/pagar'`);
fs.writeFileSync('server.js',s);
let css=fs.readFileSync('public/marca.css','utf8');css=css.replaceAll('.despachante','.operacional');
// The drawer geometry already used by the dispatcher's Pix editor is shared.
css=css.replaceAll('.ent-sheet', ':is(.ent-sheet,.side-panel)');fs.writeFileSync('public/marca.css',css);
