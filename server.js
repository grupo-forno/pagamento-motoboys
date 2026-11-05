const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOADS, hashSenha, confereSenha, log, tx } = require('./db');
const XLSX = require('xlsx');
const { lerRelatorio, lerResumo, valorDigitado, pixValido } = require('./importar');
const AG = require('./agenda');
const { gerarPdf, enviarEmail, cfg, listaEmails, brl, diaFmt, dataFmt } = require('./relatorio');
const { Raw, html, esc, icone, iniciais, semAcento, CSS, JS } = require('./ui');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use('/marca', express.static(path.join(__dirname, 'public'), { maxAge: '7d' })); // logos do Grupo Forno

const PERFIS = { admin: 'TI / Admin', gestao: 'Gestão', financeiro: 'Financeiro', despachante: 'Despachante' };
const STATUS = { rascunho: 'Falta enviar', enviado: 'Aguardando aprovação', pago: 'Aprovado' }; // 'pago' no banco = aprovado pelo financeiro (não quer dizer pago)
// Situação mostrada ao usuário (texto sempre presente; a cor só reforça).
const filhoDe = (id) => db.prepare('SELECT id FROM fechamentos WHERE origem_id = ? ORDER BY id DESC').get(id)?.id;
const situacaoF = (f, devolvido) => f.arquivado_em ? ['nodot', 'Arquivado'] : devolvido && f.status === 'rascunho' ? ['bad', f.origem_id ? 'Devolvido · parte já aprovada' : 'Devolvido para correção']
  : f.status === 'pago' && filhoDe(f.id) ? ['ok', 'Aprovado em parte']
  : [{ rascunho: 'warn', enviado: 'info', pago: 'ok' }[f.status], STATUS[f.status]];
const selo = (f, devolvido) => { const [c, t] = situacaoF(f, devolvido); return html`<span class="badge ${c}">${t}</span>`; };
const quando = (q) => `${q.slice(8, 10)}/${q.slice(5, 7)}/${q.slice(0, 4)} às ${q.slice(11, 16)}`; // "AAAA-MM-DD HH:MM" → "DD/MM/AAAA às HH:MM"
const inicio = (u) => (u.perfil === 'despachante' ? 'Pendências' : 'Fechamentos');
const lojaCurta = (nome) => String(nome || '').replace(/^forno paulista\s+/i, '');
const periodo = (f) => `${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`;
const diasDoPeriodo = (f) => {
  const r = [];
  for (let x = new Date(f.data_ini + 'T12:00:00Z'); x.toISOString().slice(0, 10) <= f.data_fim; x.setUTCDate(x.getUTCDate() + 1)) r.push(x.toISOString().slice(0, 10));
  return r;
};
const badgeStatus = (s) => html`<span class="badge ${s}">${STATUS[s]}</span>`;
const avatar = (nome) => html`<span class="avatar">${iniciais(nome)}</span>`;
const campoValor = (name, value, extra = '') => html`<div class="money"><span>R$</span><input name="${name}" inputmode="decimal" placeholder="0,00" value="${value}" ${new Raw(extra)}></div>`;

// Símbolo do sol do Grupo Forno (raios), para espaços pequenos.
const SOL = `<svg viewBox="0 0 44 26" aria-hidden="true" width="34" height="20">${Array.from({ length: 13 }, (_, k) => { const a = Math.PI * (1 - k / 12), c = Math.cos(a), sn = Math.sin(a); return `<line x1="${(22 + 7 * c).toFixed(1)}" y1="${(24 - 7 * sn).toFixed(1)}" x2="${(22 + (k % 2 ? 19 : 21) * c).toFixed(1)}" y2="${(24 - (k % 2 ? 19 : 21) * sn).toFixed(1)}"/>`; }).join('')}</svg>`;

// ---------- Layout ----------
// o: { titulo, sub, trilha: [['Fechamentos', '/'], ['Loja']], acoes }
const versao = (u) => { try { return Math.trunc(fs.statSync(path.join(__dirname, 'public', u.replace('/marca/', ''))).mtimeMs); } catch { return 0; } };
function page(req, o, corpo) {
  if (typeof o === 'string') o = { titulo: o };
  const u = req.user, p = req.path, qq = req.query || {};
  const q = { ok: qq.ok && qq.k === assina('ok', qq.ok) ? qq.ok : '', erro: qq.erro && qq.k === assina('erro', qq.erro) ? qq.erro : '' };
  const aba = (href, ic, txt, on) => html`<a href="${href}" class="${on ? 'on' : ''}" title="${txt}" ${on ? new Raw('aria-current="page"') : ''}>${icone(ic)}<span class="tx">${txt}</span></a>`;
  const marca = html`<a class="brand" href="/" aria-label="Grupo Forno · Pagamento de motoboys"><img class="logo-h" src="/marca/grupo-forno.jpg" alt="Grupo Forno"><span class="logo-m">${new Raw(SOL)}</span><small>Pagamento de motoboys</small></a>`;
  // Sucesso de ação pontual: aviso temporário. Erro: fica na página (ou junto ao campo, quando a tela trata).
  const flash = html`${q.ok ? html`<div class="toast" role="status">${icone('ok')}<span>${q.ok}</span><button type="button" class="icon-btn" data-fecha-toast aria-label="Fechar aviso">${icone('erro', 'sm')}</button></div>` : ''}${q.erro && !o.erroNoCampo ? html`<div class="alert bad" role="alert">${icone('erro')}<div>${q.erro}</div></div>` : ''}`;
  const desp = u?.perfil === 'despachante';
  const emFech = desp ? p === '/' || (p.startsWith('/fechamentos') && o.trilha?.[0]?.[0] !== 'Histórico') : p === '/' || p.startsWith('/fechamentos');
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#df6d2a">
<title>${o.titulo} · Motoboys Forno Paulista</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${new Raw(CSS)}</style>${o.css ? html`<link rel="stylesheet" href="${o.css}?v=${versao(o.css)}">` : ''}</head>
${u ? html`<body class="${o.largura || ''}"><a class="pular" href="#conteudo">Pular para o conteúdo</a><div class="app"><aside class="side" id="menu-lateral"><div class="side-top">${marca}<button type="button" class="icon-btn recolher" data-recolher aria-label="Recolher ou expandir o menu" title="Recolher/expandir menu">${icone('painel')}</button></div>
<nav class="tabs" aria-label="Menu">${desp ? html`${aba('/', 'lista', 'Pendências', emFech)}${aba('/historico', 'historico', 'Histórico', p === '/historico' || (p.startsWith('/fechamentos') && !emFech))}`
    : aba('/', 'lista', 'Fechamentos', emFech)}
${u.perfil === 'admin' ? html`${aba('/usuarios', 'escudo', 'Usuários', p.startsWith('/usuarios'))}${aba('/config', 'ajustes', 'Configurações', p.startsWith('/config'))}` : ''}</nav>
<div class="side-user"><div class="who">${avatar(u.nome)}<div class="tx"><b>${u.nome}</b><small>${PERFIS[u.perfil]}${u.loja ? ` · ${lojaCurta(u.loja)}` : ''}</small></div></div>
<a href="/senha" class="${p === '/senha' ? 'on' : ''}" title="Minha conta e senha">${icone('chave', 'sm')}<span class="tx">Minha conta e senha</span></a>
<form method="post" action="/logout"><button title="Sair do sistema">${icone('sair', 'sm')}<span class="tx">Sair</span></button></form></div></aside>
<div class="veu" data-fecha-menu aria-hidden="true"></div>
<div class="main"><header class="top"><div class="top-in"><button type="button" class="icon-btn abre-menu" data-abre-menu aria-label="Abrir menu" aria-controls="menu-lateral">${icone('menu')}</button>
<nav class="crumbs" aria-label="Caminho"><a href="/" aria-label="Início">${icone('casa', 'sm')}</a>${(o.trilha?.length ? o.trilha : [[o.titulo]]).map(([t, h]) => html`${icone('chevron', 'sm')}${h ? html`<a href="${h}">${t}</a>` : html`<span aria-current="page">${t}</span>`}`)}</nav>
<span class="sp"></span>${u.loja ? html`<span class="loja-tag" title="${u.loja}">${icone('loja', 'sm')} ${lojaCurta(u.loja)}</span>` : ''}</div></header>
<main class="wrap" id="conteudo">
<div class="ph"><div><div class="ph-t"><h1>${o.titulo}</h1>${o.selo || ''}</div>${o.sub ? html`<p class="sub">${o.sub}</p>` : ''}</div>${o.acoes ? html`<div class="ph-actions">${o.acoes}</div>` : ''}</div>
${flash}${corpo}</main></div></div>`
    : html`<body class="auth"><main class="auth-box"><img class="logo-v" src="/marca/grupo-forno-vertical.jpg" alt="Grupo Forno"><p class="auth-sub">Pagamento de motoboys</p>${flash}${corpo}</main>`}
<script>${new Raw(JS)}</script>${o.js ? html`<script src="${o.js}?v=${versao(o.js)}" defer></script>` : ''}</body></html>`.s;
}
const SEGREDO_MSG = crypto.randomBytes(16);
const assina = (chave, msg) => crypto.createHmac('sha256', SEGREDO_MSG).update(`${chave}:${msg}`).digest('hex').slice(0, 16);
const volta = (res, url, chave, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${chave}=${encodeURIComponent(msg)}&k=${assina(chave, msg)}`);
const falha = (msg, status = 400) => Object.assign(new Error(msg), { publico: true, status });

// ---------- Login / sessão ----------
const tentativas = new Map(); // ponytail: em memória, zera ao reiniciar; suficiente para uma instância
app.get('/login', (req, res) => {
  const erro = req.query.erro && req.query.k === assina('erro', req.query.erro) ? req.query.erro : '';
  res.send(page(req, { titulo: 'Entrar', erroNoCampo: true }, html`<form method="post" class="card card-b login" novalidate>
<h1>Entrar</h1>
<div class="field"><label for="login">Login</label><input id="login" name="login" required autofocus autocomplete="username" autocapitalize="none" spellcheck="false" ${new Raw(erro ? 'aria-invalid="true" aria-describedby="erro-login"' : '')}></div>
<div class="field"><label for="senha">Senha</label><div class="senha"><input id="senha" name="senha" type="password" required autocomplete="current-password" ${new Raw(erro ? 'aria-invalid="true" aria-describedby="erro-login"' : '')}>
<button type="button" class="icon-btn" data-mostra-senha="senha" aria-pressed="false" aria-label="Mostrar senha">Mostrar</button></div>
${erro ? html`<p class="erro-campo" id="erro-login" role="alert">${icone('erro', 'sm')} ${erro}</p>` : ''}</div>
<button class="btn btn-pri btn-lg btn-block">Entrar</button>
<p class="mut small rodape">Esqueceu a senha? Fale com a TI.</p></form>`));
});
app.post('/login', (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase(), chave = `${login}|${req.ip}`;
  if (tentativas.size > 10000) tentativas.clear();
  const t = tentativas.get(chave);
  if (t && t.n >= 5 && t.ate > Date.now()) return volta(res, '/login', 'erro', 'Muitas tentativas. Aguarde 15 minutos.');
  const u = db.prepare("SELECT * FROM usuarios WHERE login = ? AND ativo = 1 AND perfil <> 'motoboy'").get(login);
  if (!u || !confereSenha(String(req.body.senha || ''), u.senha)) {
    tentativas.set(chave, { n: (t && t.ate > Date.now() ? t.n : 0) + 1, ate: Date.now() + 15 * 60e3 });
    return volta(res, '/login', 'erro', 'Login ou senha inválidos.');
  }
  tentativas.delete(chave);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessoes WHERE expira < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes VALUES (?,?,?)').run(token, u.id, Date.now() + 12 * 3600e3);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 12 * 3600e3 });
  res.redirect('/');
});

app.use((req, res, next) => {
  const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  if (sid) req.user = db.prepare('SELECT u.*, l.nome loja FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN lojas l ON l.id = u.loja_id WHERE s.token = ? AND s.expira > ? AND u.ativo = 1 AND u.perfil <> \'motoboy\'').get(sid, Date.now());
  if (!req.user) return res.redirect('/login');
  req.sid = sid;
  next();
});
app.post('/logout', (req, res) => { db.prepare('DELETE FROM sessoes WHERE token = ?').run(req.sid); res.clearCookie('sid'); res.redirect('/login'); });

app.get('/senha', (req, res) => res.send(page(req, { titulo: 'Minha conta', sub: `${req.user.nome} · login ${req.user.login}` }, html`
<form method="post" class="card" style="max-width:460px"><div class="card-h"><span class="hico pri">${icone('chave')}</span><div class="t"><h2>Trocar senha</h2><p>Use pelo menos 8 caracteres.</p></div></div>
<div class="card-b"><div class="field"><label for="atual">Senha atual</label><input id="atual" name="atual" type="password" required autocomplete="current-password"></div>
<div class="field"><label for="nova">Nova senha</label><input id="nova" name="nova" type="password" minlength="8" required autocomplete="new-password"></div></div>
<div class="card-f"><button class="btn btn-pri">Salvar nova senha</button><a class="btn btn-ghost" href="/">Cancelar</a></div></form>`)));
app.post('/senha', (req, res) => {
  const nova = String(req.body.nova || '');
  if (!confereSenha(String(req.body.atual || ''), req.user.senha)) return volta(res, '/senha', 'erro', 'Senha atual incorreta.');
  if (nova.length < 8) return volta(res, '/senha', 'erro', 'A nova senha precisa ter 8 caracteres ou mais.');
  db.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').run(hashSenha(nova), req.user.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token <> ?').run(req.user.id, req.sid);
  volta(res, '/', 'ok', 'Senha alterada.');
});

// ---------- Permissões ----------
const veTudo = (u) => ['admin', 'gestao', 'financeiro'].includes(u.perfil);
// Financeiro: só fechamentos já enviados ao menos uma vez (versao > 0) e da loja dele (sem loja no cadastro = todas).
const podeVer = (u, f) => (u.perfil === 'financeiro' ? f.versao > 0 && (!u.loja_id || u.loja_id === f.loja_id)
  : veTudo(u) || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const podeEditar = (u, f) => f.status === 'rascunho' && !f.arquivado_em && (u.perfil === 'admin' || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const decideFin = (u) => ['admin', 'financeiro'].includes(u.perfil); // aprova/devolve (o estado do fechamento é conferido na ação)
const podeDevolver = (u, f) => f.status === 'enviado' && decideFin(u);
const podeReenviar = (u, f) => f.status !== 'rascunho' && (['admin', 'financeiro'].includes(u.perfil) || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const editaMotoboy = (u) => ['admin', 'despachante'].includes(u.perfil);
const so = (cond) => (req, res, next) => (cond(req) ? next() : next(falha('Sem permissão para esta ação.', 403)));

const carregaF = (id) => db.prepare(`SELECT f.*, l.nome loja, u.nome autor, ue.nome enviou FROM fechamentos f JOIN lojas l ON l.id = f.loja_id
  LEFT JOIN usuarios u ON u.id = f.criado_por LEFT JOIN usuarios ue ON ue.id = f.enviado_por WHERE f.id = ?`).get(Number(id));
app.param('fid', (req, res, next, id) => {
  const f = carregaF(id);
  if (!f || !podeVer(req.user, f)) return next(falha('Fechamento não encontrado.', 404));
  req.f = f;
  next();
});

// ---------- Cálculo ----------
// Valor por motoboy/dia = soma da "Taxa do Entregador" dos pedidos. Fechamento de 1 dia (so_resumo): o total do Resumo é o valor do dia.
function grade(f) {
  const cels = new Map(), dias = new Set();
  const cel = (m, d) => {
    dias.add(d);
    if (!cels.has(m)) cels.set(m, {});
    return (cels.get(m)[d] ??= { agil: 0, n: 0, final: 0 });
  };
  for (const p of db.prepare('SELECT motoboy_id m, dia, SUM(taxa) v, COUNT(*) n FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NOT NULL GROUP BY 1, 2').all(f.id))
    Object.assign(cel(p.m, p.dia), { agil: p.v, final: p.v, n: p.n });
  if (f.so_resumo) for (const r of db.prepare('SELECT motoboy_id m, SUM(total) v, SUM(pedidos) n FROM resumo WHERE fechamento_id = ? AND motoboy_id IS NOT NULL GROUP BY 1').all(f.id))
    Object.assign(cel(r.m, f.data_ini), { agil: r.v, final: r.v, n: r.n });
  // Resumo do Agilizone (quando enviado): total confiável por motoboy. Quem só aparece no Resumo também entra na grade.
  const temResumo = !!db.prepare('SELECT 1 FROM resumo WHERE fechamento_id = ?').get(f.id);
  const resumoL = db.prepare('SELECT motoboy_id m, SUM(total) t, SUM(ocorrencias) oc, SUM(qtd_oc) q, SUM(pago) p FROM resumo WHERE fechamento_id = ? AND motoboy_id IS NOT NULL GROUP BY 1').all(f.id);
  const resumo = new Map(resumoL.map((r) => [r.m, r.t])), extra = new Map(resumoL.map((r) => [r.m, r]));
  const aprov = new Map(db.prepare('SELECT a.*, u.nome por FROM aprovacoes a LEFT JOIN usuarios u ON u.id = a.aprovado_por WHERE fechamento_id = ?').all(f.id).map((x) => [x.motoboy_id, x]));
  // Depois do envio, o PIX é o que foi enviado ao financeiro (não muda se o cadastro mudar).
  // PIX do fechamento: digitado pelo despachante (ou congelado no envio) > Resumo do Agilizone > cadastro antigo.
  const pixF = new Map(db.prepare('SELECT motoboy_id, pix FROM envio_pix WHERE fechamento_id = ? AND pix IS NOT NULL').all(f.id).map((x) => [x.motoboy_id, x.pix]));
  const pixR = new Map(db.prepare('SELECT motoboy_id, MAX(pix) pix FROM resumo WHERE fechamento_id = ? AND motoboy_id IS NOT NULL AND pix IS NOT NULL GROUP BY 1').all(f.id).map((x) => [x.motoboy_id, x.pix]));
  const ed = new Map(db.prepare('SELECT * FROM edicoes WHERE fechamento_id = ?').all(f.id).map((x) => [x.motoboy_id, x]));
  for (const m of resumo.keys()) if (!cels.has(m)) cels.set(m, {});
  const ids = [...cels.keys()];
  const linhas = db.prepare(`SELECT id, nome, pix FROM motoboys WHERE id IN (${ids.map(Number).join(',') || 0})`).all()
    .map((m) => {
      const e = ed.get(m.id);
      if (e?.nome) m = { ...m, nome: e.nome, nomeAgil: m.nome };
      if (e?.pix) pixF.set(m.id, e.pix), pixR.delete(m.id);
      const c = cels.get(m.id);
      // bruto = soma dos dias (taxas); total a pagar = bruto + ocorrências do Agilizone - o que já foi pago lá.
      const bruto = Object.values(c).reduce((s, x) => s + x.final, 0), res = temResumo ? (resumo.get(m.id) ?? 0) : null;
      const ex = extra.get(m.id), oc = ex?.oc ?? 0, qtdOc = ex?.q ?? 0, pago = ex?.p ?? 0, total = bruto + oc - pago;
      // ok: bate com o Resumo · pendente: a soma dos dias difere do Resumo (aviso; o Agilizone é a referência)
      const confere = res == null || bruto === res ? 'ok' : 'pendente';
      const pix = pixF.get(m.id) ?? pixR.get(m.id) ?? m.pix, ap = aprov.get(m.id);
      // A aprovação vale para o valor e o PIX aprovados; se mudarem (reenvio), o item volta para análise.
      const aprovado = ap ? ap.valor == null || (ap.valor === total && ap.pix === pix) : f.status === 'pago';
      return { ...m, aprovado, aprovacao: ap, alterado: !!ap && !aprovado, pix, pixDigitado: f.status === 'rascunho' && pixF.has(m.id) && !pixR.has(m.id), dias: c, bruto, oc, qtdOc, pago, total, resumo: res, noResumo: temResumo && !resumo.has(m.id), confere };
    }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const diasArr = [...dias].sort();
  const totDia = Object.fromEntries(diasArr.map((d) => [d, linhas.reduce((s, l) => s + (l.dias[d]?.final || 0), 0)]));
  const soma = (k) => linhas.reduce((s, l) => s + l[k], 0);
  return { dias: diasArr, linhas, totDia, total: soma('total'), totOc: soma('oc'), totPago: soma('pago'), temOc: linhas.some((l) => l.oc || l.qtdOc), temPago: linhas.some((l) => l.pago), temResumo };
}

// Motoboy = nome do Agilizone (vem certo de lá): liga automaticamente, criando o registro interno na primeira vez.
function vincula(fid) {
  const nomes = db.prepare('SELECT entregador FROM pedidos WHERE fechamento_id = ?1 AND motoboy_id IS NULL AND entregador IS NOT NULL UNION SELECT entregador FROM resumo WHERE fechamento_id = ?1 AND motoboy_id IS NULL').all(fid);
  for (const { entregador: n } of nomes) {
    const id = db.prepare('SELECT id FROM motoboys WHERE nome = ? COLLATE NOCASE').get(n)?.id ?? Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(n).lastInsertRowid);
    db.prepare('UPDATE pedidos SET motoboy_id = ? WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NULL').run(id, fid, n);
    db.prepare('UPDATE resumo SET motoboy_id = ? WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NULL').run(id, fid, n);
  }
}
const aplicaResumo = (f) => vincula(f.id);
for (const { id } of db.prepare("SELECT id FROM fechamentos WHERE status = 'rascunho'").all()) vincula(id); // fechamentos de antes da mudança

function gravaResumo(f, rows, uid, arquivo) {
  db.prepare('DELETE FROM resumo WHERE fechamento_id = ?').run(f.id);
  const ins = db.prepare('INSERT INTO resumo (fechamento_id, entregador, pedidos, total, cpf, pix, pago, ocorrencias, qtd_oc) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET pedidos = pedidos + excluded.pedidos, total = total + excluded.total, pago = pago + excluded.pago, ocorrencias = ocorrencias + excluded.ocorrencias, qtd_oc = qtd_oc + excluded.qtd_oc');
  for (const r of rows) ins.run(f.id, r.entregador, r.pedidos, r.total, r.cpf, r.pix, r.pago, r.ocorrencias, r.qtdOc);
  aplicaResumo(f, uid);
  log(uid, `f:${f.id}`, `Anexou o Resumo de entregas ${arquivo}: ${rows.length} entregadores, ${brl(rows.reduce((s, r) => s + r.total, 0))}`);
}

// O Resumo precisa ser do mesmo período/loja: pelo menos metade dos entregadores dele deve aparecer no Relatório de Pedidos.
function confereMesmoPeriodo(f, rows) {
  const nomes = new Set(db.prepare('SELECT DISTINCT entregador FROM pedidos WHERE fechamento_id = ? AND entregador IS NOT NULL').all(f.id).map((x) => semAcento(x.entregador)));
  const achados = rows.filter((r) => nomes.has(semAcento(r.entregador))).length;
  if (achados < rows.length / 2) throw falha(`O Resumo enviado não parece ser da mesma loja e período do Relatório de Pedidos (só ${achados} de ${rows.length} entregadores aparecem nos dois). Exporte os dois da mesma tela, com o mesmo filtro.`);
}

// ---------- Fechamentos ----------
const COMO_EXPORTAR = html`<div class="passos">
<div class="passo"><span class="n">1</span><p>No <b>Agilizone</b>, escolha a loja e abra <b>Relatório de Pedidos</b>.</p></div>
<div class="passo"><span class="n">2</span><p>Preencha <b>Data inicial</b> e <b>Data final</b> do período a pagar e clique em <b>Aplicar filtros</b>.</p></div>
<div class="passo"><span class="n">3</span><p>Clique em <b>Exportar Pedidos</b>: baixa o <b>.xlsx</b> com os pedidos de cada dia.</p></div>
<div class="passo"><span class="n">4</span><p>Na mesma tela, clique no botão verde <b>Resumo de entregas por entregador</b> e depois em <b>Exportar Resumo</b>: baixa o <b>.csv</b> com o total certo de cada motoboy.</p></div></div>`;

// ---------- Calendário de pagamento ----------
const TZ = process.env.TZ_ALERTAS || 'America/Fortaleza'; // Teresina
function agora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
const calendarioDa = (l) => { try { return AG.lerCalendario(l.calendario || AG.PADRAO); } catch { return AG.lerCalendario(AG.PADRAO); } };
const diaLongo = (d) => `${AG.NOMES[AG.semana(d)].toLowerCase()} ${dataFmt(d).slice(0, 5)}`;
// Filtro sugerido para o Agilizone: do 1º dia às 06:00 até o dia seguinte ao último às 06:00 (o dia vira às 05:00).
const filtroAgilizone = (p) => `${dataFmt(p.ini)} 06:00 até ${dataFmt(AG.soma(p.fim, 1))} 06:00`;

// Pagamentos de cada loja entre ini e fim, com a situação do fechamento correspondente.
function agenda(lojas, ini, fim) {
  const hoje = agora().data;
  return lojas.flatMap((l) => AG.pagamentosEntre(calendarioDa(l), ini, fim).map((p) => {
    const f = db.prepare('SELECT id, status FROM fechamentos WHERE loja_id = ? AND pagamento = ? AND arquivado_em IS NULL ORDER BY id DESC').get(l.id, p.pagamento);
    const enviado = f && f.status !== 'rascunho';
    const situacao = enviado ? 'enviado' : f ? (p.pagamento < hoje ? 'atrasado' : 'conferencia') : p.pagamento < hoje ? 'atrasado' : p.pagamento === hoje ? 'hoje' : 'futuro';
    return { ...p, loja: l, f, situacao, aprovado: f?.status === 'pago' };
  })).sort((a, b) => a.pagamento.localeCompare(b.pagamento) || a.loja.nome.localeCompare(b.loja.nome));
}
const SITUACAO = {
  enviado: ['info', 'Aguardando aprovação'], conferencia: ['warn', 'Em conferência'], hoje: ['warn', 'Importar hoje'],
  atrasado: ['bad', 'Atrasado'], futuro: ['nodot', 'Aguardando o período'],
};

function cardAgenda(u, itens) {
  const pode = (p) => editaMotoboy(u) && (u.perfil === 'admin' || u.loja_id === p.loja.id);
  return html`<div class="card" style="margin-bottom:20px"><div class="card-h"><span class="hico pri">${icone('calendario')}</span><div class="t"><h2>Agenda de pagamentos</h2>
<p>Segunda paga sexta a domingo; sexta paga segunda a quinta${u.perfil === 'despachante' && !/dirceu/i.test(u.loja || '') ? '' : ' (DIRCEU: quarta paga seg/ter e sexta paga qua/qui)'}. Datas no fuso de Teresina.</p></div></div>
${itens.length ? html`<div class="tw"><table><tr><th>Pagamento</th><th>Loja</th><th>Referente a</th><th>Situação</th><th></th></tr>
${itens.map((p) => { const [cor, txt] = p.aprovado ? ['ok', 'Aprovado'] : SITUACAO[p.situacao]; return html`<tr${p.f ? new Raw(` data-href="/fechamentos/${p.f.id}"`) : ''}>
<td><b>${diaLongo(p.pagamento)}</b></td><td>${p.loja.nome}</td><td>${p.dias.map(diaLongo).join(', ')}<div class="mut small">Filtro no Agilizone: ${filtroAgilizone(p)}</div></td>
<td><span class="badge ${cor}">${txt}</span></td>
<td class="n">${p.f ? html`<a class="btn btn-ghost btn-sm" href="/fechamentos/${p.f.id}">Abrir ${icone('chevron', 'sm')}</a>`
      : p.situacao !== 'futuro' && pode(p) ? html`<a class="btn btn-pri btn-sm" href="/fechamentos/novo">${icone('subir', 'sm')} Importar</a>` : ''}</td></tr>`; })}</table></div>`
    : html`<div class="card-b mut">Nenhum pagamento nos próximos dias.</div>`}</div>`;
}

// Fechamentos que o usuário pode ver, com total e se está devolvido (último evento é a devolução).
const fechamentosDe = (u) => db.prepare(`SELECT f.*, l.nome loja, u.nome autor,
    (SELECT MAX(id) FROM log WHERE ref = 'f:' || f.id AND acao LIKE 'Devolveu%') > COALESCE((SELECT MAX(id) FROM log WHERE ref = 'f:' || f.id AND acao LIKE 'Enviou%'), 0) devolvido FROM fechamentos f JOIN lojas l ON l.id = f.loja_id LEFT JOIN usuarios u ON u.id = f.criado_por
    WHERE ? OR f.loja_id = ? ORDER BY f.data_fim DESC, f.id DESC LIMIT 300`).all(veTudo(u) ? 1 : 0, u.loja_id ?? -1)
  .filter((f) => podeVer(u, f))
  .map((f) => { const g = grade(f), ap = g.linhas.filter((l) => l.total > 0 && l.aprovado);
    return { ...f, enviou: f.enviado_por && db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(f.enviado_por)?.nome, total: g.total, n: g.linhas.filter((l) => l.total > 0).length, nAprov: ap.length, aprovado: ap.reduce((t, l) => t + l.total, 0) }; });
const motivoDevolucao = (f) => db.prepare("SELECT l.acao, l.quando, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? AND acao LIKE 'Devolveu%' ORDER BY l.id DESC").get(`f:${f.id}`);

// Despachante: a página inicial responde "o que preciso fazer agora?".
function pendenciasDespachante(req, res) {
  const u = req.user, hoje = agora().data, amanha = AG.soma(hoje, 1);
  const ativos = fechamentosDe(u).filter((f) => !f.arquivado_em);
  const ag = agenda(db.prepare('SELECT * FROM lojas WHERE id = ?').all(u.loja_id ?? -1), AG.soma(hoje, -14), AG.soma(hoje, 14));
  const atrasadoF = (f) => f.pagamento && f.pagamento < hoje;
  const tarefas = [
    ...ativos.filter((f) => f.status === 'rascunho' && f.devolvido).map((f) => ({ ordem: 0, f, sit: ['bad', 'Devolvido para correção'], acao: 'Corrigir fechamento', motivo: motivoDevolucao(f) })),
    ...ag.filter((p) => !p.f && p.situacao === 'atrasado').map((p) => ({ ordem: 1, p, sit: ['bad', 'Envio do fechamento atrasado'], acao: 'Importar arquivos' })),
    ...ativos.filter((f) => f.status === 'rascunho' && !f.devolvido).map((f) => ({ ordem: atrasadoF(f) ? 1 : 2, f, sit: atrasadoF(f) ? ['bad', 'Envio do fechamento atrasado'] : ['warn', 'Falta enviar'], acao: 'Continuar revisão' })),
    ...ag.filter((p) => !p.f && p.situacao === 'hoje').map((p) => ({ ordem: 3, p, sit: ['warn', 'Importar hoje'], acao: 'Importar arquivos' })),
  ].sort((a, b) => a.ordem - b.ordem || ((a.f || a.p).pagamento || '').localeCompare((b.f || b.p).pagamento || ''));
  const aguardando = ativos.filter((f) => f.status === 'enviado');
  const proximos = ag.filter((p) => !p.f && p.situacao === 'futuro').slice(0, 2);
  const periodoP = (p) => `${dataFmt(p.ini)} a ${dataFmt(p.fim)}`;

  const linha = (t, i) => { const pag = (t.f || t.p).pagamento, href = t.f ? `/fechamentos/${t.f.id}` : `/fechamentos/novo?p=${t.p.pagamento}`;
    return html`<li class="tarefa">
<div class="t-quando"><span class="mut small">Pagamento previsto</span><b>${pag ? diaLongo(pag) : 'sem data'}</b></div>
<div class="t-info"><span class="badge ${t.sit[0]}">${t.sit[1]}</span><span class="small">Período ${t.f ? periodo(t.f) : periodoP(t.p)}${t.f ? html` · <b>${brl(t.f.total)}</b>` : ''}</span>
${t.motivo ? html`<p class="quote">${t.motivo.acao.replace(/^Devolveu para correção: /, '')}</p>` : ''}</div>
<a class="btn ${i ? 'btn-sec' : 'btn-pri'}" href="${href}">${t.acao}</a></li>`; };

  res.send(page(req, { titulo: 'Pendências' }, html`
<section aria-labelledby="h-agora"><h2 id="h-agora" class="sec-t">O que fazer agora</h2>
${tarefas.length ? html`<ol class="tarefas">${tarefas.map(linha)}</ol>`
    : html`<div class="nada"><b>Nada pendente agora.</b>${proximos[0] ? html`<span>Próximo pagamento: ${diaLongo(proximos[0].pagamento)}${proximos[0].pagamento === amanha ? ' (amanhã)' : ''}, período ${periodoP(proximos[0])}. Importe quando o período terminar.</span>` : ''}</div>`}
<p class="outro"><a href="/fechamentos/novo">${icone('subir', 'sm')} Importar outro período</a></p></section>

${aguardando.length || proximos.length ? html`<section aria-labelledby="h-acomp" class="acomp"><h2 id="h-acomp" class="sec-t">Acompanhamento</h2>
<div class="tw card"><table><thead><tr><th scope="col">Pagamento previsto</th><th scope="col">Período</th><th scope="col">Situação</th><th scope="col" class="n">Total</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${aguardando.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td><b>${f.pagamento ? diaLongo(f.pagamento) : '—'}</b></td><td>${periodo(f)}</td><td>${selo(f)}</td><td class="n">${brl(f.total)}</td><td class="n"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir</a></td></tr>`)}
${proximos.map((p) => html`<tr><td><b>${diaLongo(p.pagamento)}</b></td><td>${periodoP(p)}</td><td><span class="badge nodot">Período em andamento</span></td><td class="n mut">—</td><td></td></tr>`)}</tbody></table></div></section>` : ''}
<p class="outro"><a href="/historico">Ver todos os fechamentos no Histórico</a></p>`));
}

// ---------- Financeiro: fila e conferência ----------
const FIN_ABAS = { aguardando: 'Aguardando análise', parcial: 'Parcialmente aprovados', devolvidos: 'Devolvidos', aprovados: 'Aprovados', todos: 'Todos' };
const abaFin = (f) => (f.status === 'pago' ? 'aprovados' : f.status === 'rascunho' ? 'devolvidos' : f.nAprov ? 'parcial' : 'aguardando');
const SELO_FIN = { aguardando: ['info', 'Aguardando análise'], parcial: ['warn', 'Parcialmente aprovado'], devolvidos: ['bad', 'Devolvido à loja'], aprovados: ['ok', 'Aprovado'] };
const vinculo = (f) => { const filho = filhoDe(f.id);
  return html`${f.origem_id ? html`<div class="alert info">${icone('link')}<div><b>Restante do fechamento #${f.origem_id}</b>Os entregadores aprovados ficaram fechados no <a href="/fechamentos/${f.origem_id}">fechamento #${f.origem_id}</a>. Aqui estão só os que não foram aprovados.</div></div>` : ''}${filho ? html`<div class="alert info">${icone('link')}<div><b>Aprovado em parte</b>Aqui ficaram só os entregadores aprovados. Os demais foram devolvidos à loja no <a href="/fechamentos/${filho}">fechamento #${filho}</a>.</div></div>` : ''}`; };
const seloFin = (f) => { const [c, t] = f.arquivado_em ? ['nodot', 'Arquivado pela loja'] : f.status === 'pago' && filhoDe(f.id) ? ['ok', 'Aprovado em parte'] : f.status === 'rascunho' && f.origem_id ? ['bad', 'Devolvido · parte já aprovada'] : SELO_FIN[abaFin(f)]; return html`<span class="badge ${c}">${t}</span>`; };
// Volta à fila com os mesmos filtros e página (só aceita endereço da própria fila).
const voltaFila = (v) => (typeof v === 'string' && /^\/(\?[\w=&%.+-]*)?$/.test(v) ? v : '/');
const detalheFin = (f, v) => `/fechamentos/${f.id}${voltaFila(v) === '/' ? '' : `?volta=${encodeURIComponent(voltaFila(v))}`}`;
const SIT_ITEM = { aprovado: ['ok', 'Aprovado'], aguardando: ['info', 'Aguardando análise'], alterado: ['warn', 'Mudou após aprovação'], bloqueado: ['bad', 'Bloqueado'], devolvido: ['bad', 'Devolvido'], semvalor: ['nodot', 'Sem valor'] };

// Situação de cada entregador para o financeiro. Cada um cai em uma só situação (sem dupla contagem nos totais).
function itensFin(f, g) {
  const dev = new Map(db.prepare('SELECT d.*, u.nome por FROM devolucoes d LEFT JOIN usuarios u ON u.id = d.devolvido_por WHERE fechamento_id = ? ORDER BY d.id').all(f.id).map((d) => [d.motoboy_id, d]));
  const usos = {};
  for (const l of g.linhas) if (l.pix && l.total > 0) usos[l.pix.toLowerCase()] = (usos[l.pix.toLowerCase()] || 0) + 1;
  return g.linhas.map((l) => {
    const d = dev.get(l.id), devolvido = !!d && d.versao === f.versao && f.status === 'rascunho';
    const bloq = l.total <= 0 ? 'sem valor a pagar' : !l.pix ? 'sem chave PIX' : '';
    const sit = l.aprovado ? 'aprovado' : devolvido ? 'devolvido' : l.total <= 0 && !l.resumo ? 'semvalor' : bloq ? 'bloqueado' : l.alterado ? 'alterado' : 'aguardando';
    const avisoPix = !l.pix ? '' : !pixValido(l.pix) ? 'Formato de chave PIX não reconhecido' : usos[l.pix.toLowerCase()] > 1 ? 'Mesma chave PIX de outro entregador' : '';
    return { ...l, dev: d, sit, bloq, avisoPix };
  });
}

function filaFinanceiro(req, res) {
  const u = req.user, q = req.query, hoje = agora().data;
  const todos = fechamentosDe(u);
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all().filter((l) => !u.loja_id || l.id === u.loja_id);
  const loja = lojas.some((l) => l.id === Number(q.loja)) ? Number(q.loja) : 0;
  const data = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : '');
  const de = data(q.de), ate = data(q.ate), busca = String(q.q || '').trim().slice(0, 60), termo = semAcento(busca.replace(/^#/, ''));
  const env = (f) => (f.enviado_em || '').slice(0, 10);
  const filtrados = todos.filter((f) => (!loja || f.loja_id === loja) && (!de || env(f) >= de) && (!ate || env(f) <= ate)
    && (!termo || semAcento(`${f.id} ${f.loja} ${periodo(f)} ${f.enviou || ''} ${f.autor || ''}`).includes(termo)));
  const daAba = (k) => filtrados.filter((f) => k === 'todos' || (!f.arquivado_em && abaFin(f) === k));
  const aba = q.aba in FIN_ABAS ? q.aba : 'aguardando', pendente = ['aguardando', 'parcial'].includes(aba);
  // Pendentes: os mais antigos primeiro, para nada ficar esquecido. Os demais: os mais recentes primeiro.
  const lista = daAba(aba).sort((a, b) => (pendente ? (a.enviado_em || '').localeCompare(b.enviado_em || '') : (b.enviado_em || '').localeCompare(a.enviado_em || '')) || b.id - a.id);
  const POR = 20, pags = Math.max(1, Math.ceil(lista.length / POR)), pag = Math.min(pags, Math.max(1, Math.trunc(Number(q.p)) || 1));
  const qs = (mud = {}) => { const p = new URLSearchParams(), v = { aba, loja: loja || '', de, ate, q: busca, p: pag, ...mud };
    for (const [k, x] of Object.entries(v)) if (x && !(k === 'aba' && x === 'aguardando') && !(k === 'p' && x === 1)) p.set(k, x);
    return p.size ? `/?${p}` : '/'; };
  const aqui = qs(), filtrando = !!(loja || de || ate || busca), limpar = aba === 'aguardando' ? '/' : `/?aba=${aba}`;
  const link = (f) => detalheFin(f, aqui);
  const ativos = filtrados.filter((f) => !f.arquivado_em), emAnalise = ativos.filter((f) => f.status === 'enviado');
  const antigo = emAnalise.map((f) => f.enviado_em).filter(Boolean).sort()[0];
  const dias = antigo ? Math.round((Date.parse(hoje) - Date.parse(antigo.slice(0, 10))) / 864e5) : 0;
  const ag = agenda(lojas, AG.soma(hoje, -7), AG.soma(hoje, 7)).filter((p) => p.pagamento >= hoje || p.situacao !== 'enviado');
  const VAZIO = { aguardando: 'Nada aguardando análise. Quando uma loja enviar, aparece aqui.', parcial: 'Nenhum fechamento parcialmente aprovado.', devolvidos: 'Nenhum fechamento devolvido aguardando correção da loja.', aprovados: 'Nenhum fechamento aprovado ainda.', todos: 'Nenhuma solicitação recebida ainda.' };
  res.send(page(req, { titulo: 'Fila do financeiro', sub: 'Solicitações de pagamento enviadas pelas lojas. Confira, aprove por entregador ou devolva para correção.' }, html`
<dl class="resumo" aria-label="Indicadores${filtrando ? ' (com os filtros atuais)' : ''}">
<div class="destaque"><dt>Aguardando sua análise</dt><dd>${brl(emAnalise.reduce((t, f) => t + f.total - f.aprovado, 0))}</dd><dd>${emAnalise.length} fechamento(s)</dd></div>
<div><dt>Envio pendente mais antigo</dt><dd>${antigo ? dataFmt(antigo.slice(0, 10)) : '—'}</dd><dd class="${dias > 2 ? 'bad-t' : ''}">${antigo ? (dias ? `há ${dias} dia(s)` : 'hoje') : 'nada pendente'}</dd></div>
<div><dt>Devolvidos à loja</dt><dd>${daAba('devolvidos').length}</dd><dd>aguardando correção</dd></div>
<div><dt>Já aprovado</dt><dd>${brl(ativos.reduce((t, f) => t + f.aprovado, 0))}</dd><dd>${filtrando ? 'nos filtros atuais' : 'em todos os fechamentos'}</dd></div></dl>
<section class="card fila" aria-label="Fechamentos recebidos">
<nav class="seg fila-abas" aria-label="Situação">${Object.entries(FIN_ABAS).map(([k, t]) => html`<a href="${qs({ aba: k, p: 1 })}" class="${aba === k ? 'on' : ''}" ${aba === k ? new Raw('aria-current="page"') : ''}>${t}<span class="c">${daAba(k).length}</span></a>`)}</nav>
<form method="get" action="/" class="filtros" role="search" aria-label="Filtrar fechamentos">${aba !== 'aguardando' ? html`<input type="hidden" name="aba" value="${aba}">` : ''}
${lojas.length > 1 ? html`<div class="field"><label for="f-loja">Loja</label><select id="f-loja" name="loja"><option value="">Todas as lojas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === loja ? 'selected' : ''}>${l.nome}</option>`)}</select></div>` : ''}
<div class="field"><label for="f-de">Enviado de</label><input id="f-de" type="date" name="de" value="${de}"></div>
<div class="field"><label for="f-ate">Enviado até</label><input id="f-ate" type="date" name="ate" value="${ate}"></div>
<div class="field grow"><label for="f-q">Buscar</label><input id="f-q" type="search" name="q" value="${busca}" placeholder="Código, loja, período ou quem enviou"></div>
<div class="filtros-b"><button class="btn btn-sec">${icone('busca', 'sm')} Filtrar</button>${filtrando ? html`<a class="btn btn-ghost" href="${limpar}">Limpar filtros</a>` : ''}</div></form>
${lista.length ? html`<div class="tw"><table class="tab-fila"><thead><tr><th scope="col">Código</th><th scope="col">Loja</th><th scope="col">Período</th><th scope="col" class="opc">Recebido</th><th scope="col">Situação</th><th scope="col" class="n opc">Entregadores</th><th scope="col" class="n">Total solicitado</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${lista.slice((pag - 1) * POR, pag * POR).map((f) => { const pend = !f.arquivado_em && f.status === 'enviado';
    return html`<tr data-href="${link(f)}"><td><b>#${f.id}</b><div class="mut small">versão ${f.versao}</div></td><td>${lojaCurta(f.loja)}</td>
<td>${periodo(f)}${f.pagamento ? html`<div class="mut small">pagamento ${diaLongo(f.pagamento)}</div>` : ''}</td>
<td class="opc">${f.enviado_em ? quando(f.enviado_em) : '—'}${f.enviou ? html`<div class="mut small">por ${f.enviou}</div>` : ''}</td>
<td>${seloFin(f)}${abaFin(f) === 'parcial' && !f.arquivado_em ? html`<div class="mut small">${f.nAprov} de ${f.n} aprovados · ${brl(f.aprovado)}</div>` : ''}</td>
<td class="n opc">${f.n}</td><td class="n b">${brl(f.total)}</td>
<td class="n">${pend ? html`<a class="btn btn-pri btn-sm" href="${link(f)}">Conferir</a>` : html`<a class="btn btn-sec btn-sm" href="${link(f)}">Ver detalhes</a>`}</td></tr>`; })}</tbody></table></div>
${pags > 1 ? html`<nav class="pag" aria-label="Paginação"><span class="mut small">${(pag - 1) * POR + 1}–${Math.min(pag * POR, lista.length)} de ${lista.length}</span>
${pag > 1 ? html`<a class="btn btn-sec btn-sm" href="${qs({ p: pag - 1 })}" rel="prev">${icone('voltar', 'sm')} Anterior</a>` : ''}<span class="small">Página ${pag} de ${pags}</span>${pag < pags ? html`<a class="btn btn-sec btn-sm" href="${qs({ p: pag + 1 })}" rel="next">Próxima ${icone('chevron', 'sm')}</a>` : ''}</nav>` : ''}`
    : html`<p class="vazio-p">${filtrando ? html`Nenhum fechamento em "${FIN_ABAS[aba]}" com estes filtros. <a href="${limpar}">Limpar filtros</a>` : VAZIO[aba]}</p>`}
</section>
<details class="fold sec-agenda"><summary>${icone('chevron', 'chev')} Agenda de pagamentos das lojas</summary>${cardAgenda(u, ag)}</details>`));
}

// Bloco da tela de conferência (Resumo, Por dia, Histórico e detalhe). Financeiro: decide. Despachante: edita nome e PIX.
function blocoConferencia(o) {
  const { f, g, itens, decide, edita, modo, decisoes, hist, nomeDe, avisados, voltar } = o;
  const ehAp = (i) => i.sit === 'aprovado', ehDev = (i) => i.sit === 'devolvido', ehPend = (i) => !ehAp(i) && !ehDev(i);
  const conta = (fn) => itens.filter((i) => i.total > 0 && fn(i)).length;
  const nBloq = conta((i) => i.sit === 'bloqueado'), nAprov = conta(ehAp);
  const filtro = modo === 'desp'
    ? [['todos', 'Todos', itens.length], ['semp', 'Falta PIX', itens.filter((i) => !i.pix && i.total > 0).length], ['oc', 'Com ajuste', itens.filter((i) => i.oc || i.qtdOc || i.pago).length], ['dif', 'Difere do Resumo', itens.filter((i) => g.temResumo && !i.noResumo && i.bruto !== (i.resumo || 0)).length]]
    : [['todos', 'Todos', itens.length], ['pendente', 'Aguardando', itens.filter(ehPend).filter((i) => i.sit !== 'semvalor').length], ['bloqueado', 'Bloqueados', nBloq], ['aprovado', 'Aprovados', nAprov], ['devolvido', 'Devolvidos', conta(ehDev)], ['oc', 'Com ajuste', itens.filter((i) => i.oc || i.qtdOc || i.pago).length]];
  const detalheSit = (i) => (i.sit === 'aprovado' ? (i.aprovacao ? `Por ${i.aprovacao.por || '—'} em ${quando(i.aprovacao.aprovado_em)}${i.aprovacao.versao ? ` (versão ${i.aprovacao.versao})` : ''}` : '')
    : i.sit === 'devolvido' ? `Motivo: ${i.dev.motivo}`
    : i.sit === 'bloqueado' ? `Não pode ser aprovado: ${i.bloq}.${i.alterado ? ' Também mudou depois de aprovado.' : ''}`
    : i.sit === 'alterado' ? `Aprovado antes com ${brl(i.aprovacao.valor)} (PIX ${i.aprovacao.pix}); a loja mudou. Confira de novo.`
    : i.dev ? `Devolvido na versão ${i.dev.versao}; a loja corrigiu e reenviou.` : '');
  const temAj = (i) => !!(i.oc || i.qtdOc || i.pago);
  const grupoDe = (i) => (['aguardando', 'alterado'].includes(i.sit) ? 'pendente' : i.sit === 'bloqueado' ? 'pendente bloqueado' : i.sit) + (temAj(i) ? ' oc' : '') + (difDe(i) ? ' dif' : '') + (!i.pix && i.total > 0 ? ' semp' : '');
  const podeSelDe = (i) => decide && !['aprovado', 'semvalor'].includes(i.sit);
  const difDe = (i) => (g.temResumo && !i.noResumo ? i.bruto - (i.resumo || 0) : 0);
  // Despachante, antes de enviar: o que importa é se falta algo (PIX) ou se há diferença; o financeiro decide depois.
  const sitDe = (i) => {
    if (modo === 'desp' && f.status === 'rascunho') {
      if (i.sit === 'bloqueado') return ['bad', i.bloq === 'sem chave PIX' ? 'Falta chave PIX' : 'Atenção'];
      if (i.sit === 'aguardando') return difDe(i) ? ['warn', 'Confira a diferença'] : ['ok', 'Pronto'];
    }
    return SIT_ITEM[i.sit];
  };
  const detSit = (i) => (modo === 'desp' && f.status === 'rascunho' ? (i.sit === 'bloqueado' ? (i.bloq === 'sem chave PIX' ? 'Informe a chave PIX (botão Editar).' : `Atenção: ${i.bloq}.`) : '') : detalheSit(i));
  const semanas = Math.ceil(g.dias.length / 7);
  // Uma só fonte de dados: a tabela, a lista do celular e o detalhe leem este mesmo objeto.
  const dados = {
    decide, edit: edita ? `/fechamentos/${f.id}/motoboy/` : '', temResumo: g.temResumo, dias: g.dias.map((d, k) => ({ d, rot: diaFmt(d), sem: Math.floor(k / 7) })),
    itens: itens.map((i) => ({ id: i.id, nome: i.nome, pix: i.pix || '', aviso: i.avisoPix, bruto: i.bruto, oc: i.oc, qtdOc: i.qtdOc, pago: i.pago, total: i.total, resumo: i.resumo, noResumo: !!i.noResumo, dif: difDe(i),
      sit: i.sit, sitTxt: sitDe(i)[1], sitCor: sitDe(i)[0], det: detSit(i), bloq: i.bloq, pode: podeSelDe(i), dias: g.dias.map((d) => (i.dias[d] ? [i.dias[d].final, i.dias[d].n] : null)) })),
  };
  const json = new Raw(JSON.stringify(dados).replace(/</g, '\\u003c'));
  const linhaResumo = (i) => {
    const [cor, txt] = sitDe(i), pode = podeSelDe(i), d = difDe(i), aj = i.oc - i.pago;
    return html`<tr class="${temAj(i) ? 'tem-oc' : ''}" data-id="${i.id}" data-q="${semAcento(i.nome)}" data-sit="${grupoDe(i)}" data-base="${i.bruto}" data-aj="${aj}" data-valor="${i.total}" ${i.bloq ? new Raw('data-bloq="1"') : ''}>
${decide ? html`<td class="c-sel">${pode ? html`<label class="alvo"><input type="checkbox" name="m" value="${i.id}" aria-label="Selecionar ${i.nome}, ${brl(i.total)}"></label>` : ''}</td>` : ''}
<th scope="row" class="c-nome"><button type="button" class="nm" data-det="${i.id}" title="Ver detalhes de ${i.nome}"><span>${i.nome}</span></button>
${i.pix ? html`<div class="pix-sub so-medio"><span class="rot-pix">PIX</span><span>${i.pix}</span><button type="button" class="icon-btn" data-copiar="${i.pix}" title="Copiar chave PIX" aria-label="Copiar chave PIX de ${i.nome}">${icone('copiar', 'sm')}</button></div>` : ''}
<div class="meta"><span class="badge ${cor} so-estreito">${txt}</span>${!i.pix && sitDe(i)[1] !== 'Falta chave PIX' ? html`<span class="badge bad so-medio">Sem PIX</span>` : ''}${temAj(i) ? html`<span class="badge warn nodot so-estreito">${icone('alerta', 'sm')} Ajuste ${aj > 0 ? '+' : ''}${brl(aj)}</span>` : ''}${d ? html`<span class="badge bad nodot" title="Soma dos dias diferente da soma das taxas do Resumo">${icone('alerta', 'sm')} Difere do Resumo ${d > 0 ? '+' : ''}${brl(d)}</span>` : ''}${i.avisoPix ? html`<span class="badge warn nodot" title="${i.avisoPix}">${i.avisoPix.startsWith('Mesma') ? 'PIX repetido' : 'PIX fora do padrão'}</span>` : ''}</div></th>
<td class="c-pix">${i.pix ? html`<span class="pix">${i.pix}<button type="button" class="icon-btn" data-copiar="${i.pix}" title="Copiar chave PIX" aria-label="Copiar chave PIX de ${i.nome}">${icone('copiar', 'sm')}</button></span>` : html`<span class="badge bad">Sem chave PIX</span>`}</td>
<td class="n c-base">${brl(i.bruto)}</td>
<td class="n c-aj">${temAj(i) ? html`<b class="${aj < 0 ? 'bad-t' : ''}">${aj > 0 ? '+' : ''}${brl(aj)}</b><small>${[i.oc || i.qtdOc ? `${i.qtdOc} ocorrência(s)` : '', i.pago ? `já pago ${brl(i.pago)}` : ''].filter(Boolean).join(' · ')}</small>` : html`<span class="mut">–<span class="sr">sem ajustes</span></span>`}</td>
<td class="n c-tot"><b>${brl(i.total)}</b></td>
<td class="c-sit"><span class="badge ${cor}">${txt}</span>${detSit(i) ? html`<span class="sit-d" id="sit-${i.id}">${detSit(i)}</span>` : ''}</td>
${decide || edita ? html`<td class="n c-acoes"><div class="acoes-c">${edita ? html`<a class="btn btn-ghost btn-xs" href="/fechamentos/${f.id}/motoboy/${i.id}" aria-label="Editar nome e PIX de ${i.nome}">${icone('lapis', 'sm')} Editar</a>` : ''}${pode ? html`<button type="button" class="btn btn-ok btn-xs" data-linha="aprovar" data-id="${i.id}" aria-label="Aprovar ${i.nome}" ${i.bloq ? new Raw('disabled') : ''}>Aprovar</button><button type="button" class="btn btn-sec btn-xs so-largo" data-linha="devolver" data-id="${i.id}" aria-label="Devolver ${i.nome}">Devolver</button>` : ''}</div></td>` : ''}</tr>`;
  };
  const linhaDia = (i) => html`<tr data-q="${semAcento(i.nome)}" data-sit="${grupoDe(i)}">
<th scope="row" class="c-nome"><button type="button" class="nm" data-det="${i.id}" title="Ver detalhes de ${i.nome}"><span>${i.nome}</span></button></th>
${g.dias.map((d, k) => { const c = i.dias[d]; return html`<td class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}" data-v="${c ? c.final : 0}">${c ? brl(c.final) : html`<span class="mut" title="Sem entregas no dia">–<span class="sr">sem entregas</span></span>`}</td>`; })}
<td class="n c-int"><b data-int>${brl(0)}</b></td></tr>`;
  return html`<div class="fc" id="fc" data-w="largo">
<div class="abas" role="tablist" aria-label="Seções do fechamento">
<button type="button" role="tab" id="t-conf" aria-controls="conf" aria-selected="true">Resumo</button>
<button type="button" role="tab" id="t-dia" aria-controls="pordia" aria-selected="false" tabindex="-1">Por dia</button>
<button type="button" role="tab" id="t-hist" aria-controls="hist" aria-selected="false" tabindex="-1">Histórico <span class="c">${modo === 'desp' ? hist.length : decisoes.length}</span></button></div>
<div class="fc-bar" role="search" aria-label="Buscar e filtrar entregadores">
<div class="search">${icone('busca', 'sm')}<input type="search" id="fc-q" placeholder="Buscar entregador" aria-label="Buscar entregador" autocomplete="off"></div>
<button type="button" class="btn btn-sec fc-filtros" id="fc-filtros-btn" aria-expanded="false" aria-controls="fc-seg">${icone('ajustes', 'sm')} Filtros <span class="c" data-fc-nfiltros>0</span></button>
<div class="seg fc-seg" id="fc-seg" role="group" aria-label="Mostrar por situação">${filtro.filter(([k, , n]) => k === 'todos' || n).map(([k, t, n]) => html`<button type="button" data-f="${k}" class="${k === 'todos' ? 'on' : ''}" aria-pressed="${k === 'todos'}">${t}<span class="c">${n}</span></button>`)}</div>
${decide ? html`<label class="sel-todos"><input type="checkbox" id="sel-todos"> Selecionar todos os visíveis</label>` : ''}</div>
<form id="dec" method="post" action="/fechamentos/${f.id}/aprovar" data-aprovar="/fechamentos/${f.id}/aprovar" data-devolver="/fechamentos/${f.id}/devolver">
<input type="hidden" name="versao" value="${f.versao}"><input type="hidden" name="volta" value="${voltar}"><input type="hidden" name="uma" value="">
<section class="card painel" id="conf" role="tabpanel" aria-labelledby="t-conf">
<div class="tw fc-tw"><table class="fc-t ${decide ? 'com-sel' : ''}" id="fc-resumo"><caption class="sr">Resumo por entregador</caption>
<thead><tr>${decide ? html`<th scope="col" class="c-sel"><span class="sr">Selecionar</span></th>` : ''}<th scope="col" class="c-nome">Entregador</th><th scope="col" class="c-pix">PIX</th><th scope="col" class="n c-base">Valor base</th><th scope="col" class="n c-aj" title="Ocorrências do Agilizone (acréscimo ou desconto, sem data) e valor já pago no Agilizone">Ajustes</th><th scope="col" class="n c-tot">Total do fechamento</th><th scope="col" class="c-sit">Situação</th>${decide || edita ? html`<th scope="col" class="n c-acoes">Ações</th>` : ''}</tr></thead>
<tbody>${itens.map(linhaResumo)}</tbody>
<tfoot><tr class="tot">${decide ? html`<td class="c-sel"></td>` : ''}<th scope="row" class="c-nome"><span data-esc>Total do fechamento</span><small data-esc-n></small></th><td class="c-pix"></td><td class="n c-base" data-t="base">${brl(g.linhas.reduce((t, l) => t + l.bruto, 0))}</td><td class="n c-aj" data-t="aj">${brl(g.totOc - g.totPago)}</td><td class="n c-tot" data-t="tot">${brl(g.total)}</td><td class="c-sit"></td>${decide || edita ? html`<td class="c-acoes"></td>` : ''}</tr></tfoot></table></div>
<p class="fc-vazio" data-vazio hidden>Nenhum entregador com esta busca ou filtro. <button type="button" class="btn btn-sec btn-sm" data-limpar-filtros>Limpar busca e filtros</button></p>
<p class="fin-legenda">Valor base: Relatório de Pedidos do Agilizone. Ajustes: ocorrências do Agilizone (acréscimo ou desconto, sem data) e o que já foi pago lá; já estão no total. "Difere do Resumo": a soma dos dias não bate com o Resumo de entregas do Agilizone.${decide ? ' "Selecionar todos os visíveis" marca só as linhas que a busca e o filtro mostram.' : ''}</p>
${decide ? html`<div class="barra" role="region" aria-label="Decisão sobre os selecionados"><div class="barra-in">
<div><span class="mut small" data-sel-n aria-live="polite">Nenhum entregador selecionado</span><b data-sel-v>${brl(0)}</b></div>
<span class="small bad-t" data-sel-bloq hidden></span>
<button type="button" class="btn btn-ghost" data-limpar>Limpar</button>
<button type="button" class="btn btn-sec" data-dec="devolver">${icone('desfazer', 'sm')} Devolver selecionados</button>
<button type="button" class="btn btn-ok" data-dec="aprovar">${icone('check', 'sm')} Aprovar selecionados</button></div></div>
<dialog id="dlg-dec" class="dlg" aria-labelledby="dlg-dec-t" aria-describedby="dlg-dec-r"><h2 id="dlg-dec-t">Confirmar decisão</h2><p id="dlg-dec-r"></p><ul class="dlg-l" data-dlg-lista></ul>
<div class="field" data-dlg-motivo hidden style="margin-top:12px"><label for="motivo">Motivo da devolução <span class="req" aria-hidden="true">*</span></label><textarea id="motivo" name="motivo" minlength="5" maxlength="2000" aria-describedby="dica-motivo"></textarea>
<p class="hint" id="dica-motivo">Vai para ${avisados.length ? avisados.map((a) => `${a.nome}${a.email ? ` (${a.email})` : ' (sem e-mail: vê no sistema)'}`).join(', ') : 'ninguém: a loja não tem despachante cadastrado'}. Entregadores já aprovados continuam aprovados.</p></div>
<div class="acoes-f"><button class="btn btn-ok" data-dlg-ok>Confirmar</button><button type="button" class="btn btn-ghost" data-dlg-cancela>Cancelar</button></div></dialog>` : ''}
</section>
<section class="card painel" id="pordia" role="tabpanel" aria-labelledby="t-dia" hidden>
<div class="dia-ctrl">${semanas > 1 ? html`<div class="seg dia-sem" role="group" aria-label="Semana">${Array.from({ length: semanas }, (_, k) => { const a = g.dias[k * 7], b = g.dias[Math.min(g.dias.length, k * 7 + 7) - 1]; return html`<button type="button" data-sem="${k}" class="${k === 0 ? 'on' : ''}" aria-pressed="${k === 0}">${diaFmt(a).slice(0, 5)} a ${diaFmt(b).slice(0, 5)}</button>`; })}</div>` : ''}
<div class="field dia-sel"><label for="dia-sel">Dia</label><select id="dia-sel">${g.dias.map((d) => html`<option value="${d}">${diaFmt(d)}</option>`)}</select></div></div>
<div class="tw fc-tw"><table class="fc-t fc-dia" id="fc-dia"><caption class="sr">Valores por dia e entregador</caption>
<thead><tr><th scope="col" class="c-nome">Entregador</th>${g.dias.map((d, k) => html`<th scope="col" class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}">${diaFmt(d)}</th>`)}<th scope="col" class="n c-int">Total do intervalo</th></tr></thead>
<tbody>${itens.map(linhaDia)}</tbody>
<tfoot><tr class="tot"><th scope="row" class="c-nome"><span data-esc>Total do intervalo</span><small data-esc-n></small></th>${g.dias.map((d, k) => html`<td class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}" data-tdia="${d}">${brl(g.totDia[d])}</td>`)}<td class="n c-int" data-tint>${brl(0)}</td></tr></tfoot></table></div>
<p class="fc-vazio" data-vazio hidden>Nenhum entregador com esta busca ou filtro. <button type="button" class="btn btn-sec btn-sm" data-limpar-filtros>Limpar busca e filtros</button></p>
<p class="fin-legenda">Valores do Relatório de Pedidos do Agilizone (taxa do entregador) por dia. Ajustes (ocorrências e já pago) não têm data: aparecem só no Resumo, por isso o total do intervalo não inclui ajustes.</p>
</section></form>
<section class="card painel" id="hist" role="tabpanel" aria-labelledby="t-hist" hidden>
${decisoes.length ? html`<div class="tw"><table><caption class="sr">Decisões do financeiro</caption><thead><tr><th scope="col">Quando</th><th scope="col">Decisão</th><th scope="col">Entregador</th><th scope="col" class="n">Valor</th><th scope="col">PIX considerado</th><th scope="col" class="n">Versão</th><th scope="col">Responsável</th></tr></thead><tbody>
${decisoes.map((d) => html`<tr><td>${quando(d.quando)}</td><td><span class="badge ${d.tipo === 'Aprovado' ? 'ok' : 'bad'}">${d.tipo}</span>${d.motivo ? html`<div class="quote">${d.motivo}</div>` : ''}${d.para ? html`<div class="mut small">Avisados: ${d.para}</div>` : ''}</td>
<td>${nomeDe(d.motoboy_id, d.entregador)}</td><td class="n">${d.valor == null ? '—' : brl(d.valor)}</td><td>${d.pix || '—'}</td><td class="n">${d.versao ?? '—'}</td><td>${d.por || '—'}</td></tr>`)}</tbody></table></div>`
    : html`<p class="vazio-p">Nenhuma decisão registrada ainda.</p>`}
<div class="card-b"><h3 class="sec-t">Linha do tempo</h3><ul class="timeline">${hist.map((h) => html`<li>${h.acao}<small>${quando(h.quando)} · ${h.nome || 'Sistema'}</small></li>`)}</ul></div></section></div>
<script type="application/json" id="fc-dados">${json}</script>
<dialog id="dlg-det" class="dlg sheet" aria-labelledby="det-t"><div class="sheet-h"><div><h2 id="det-t"></h2><span class="badge" id="det-sit"></span></div><button type="button" class="icon-btn alvo-ic" data-det-fecha aria-label="Fechar detalhe">${icone('erro')}</button></div>
<div class="sheet-b" id="det-corpo"></div><div class="sheet-f" id="det-acoes"></div></dialog>`;
}

function conferenciaFin(req, res) {
  const f = req.f, u = req.user, g = grade(f), itens = itensFin(f, g), decide = podeDevolver(u, f);
  const voltar = voltaFila(req.query.volta);
  const hist = db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`f:${f.id}`);
  const nomeDe = (id, alt) => itens.find((i) => i.id === id)?.nome ?? alt;
  const decisoes = [
    ...db.prepare('SELECT a.*, m.nome entregador, u.nome por FROM aprovacoes a JOIN motoboys m ON m.id = a.motoboy_id LEFT JOIN usuarios u ON u.id = a.aprovado_por WHERE fechamento_id = ?').all(f.id).map((a) => ({ ...a, tipo: 'Aprovado', quando: a.aprovado_em })),
    ...db.prepare('SELECT d.*, m.nome entregador, u.nome por FROM devolucoes d JOIN motoboys m ON m.id = d.motoboy_id LEFT JOIN usuarios u ON u.id = d.devolvido_por WHERE fechamento_id = ?').all(f.id).map((d) => ({ ...d, tipo: 'Devolvido', quando: d.devolvido_em })),
  ].sort((a, b) => b.quando.localeCompare(a.quando));
  const ehAp = (i) => i.sit === 'aprovado', ehDev = (i) => i.sit === 'devolvido', ehPend = (i) => !ehAp(i) && !ehDev(i);
  const soma = (fn) => itens.filter(fn).reduce((t, i) => t + i.total, 0), conta = (fn) => itens.filter((i) => i.total > 0 && fn(i)).length;
  const nAprov = conta(ehAp), nBloq = conta((i) => i.sit === 'bloqueado');
  const devolucao = hist.find((h) => /^Devolveu para correção/.test(h.acao));
  const alterados = itens.filter((i) => i.alterado && !ehAp(i));
  const totResumo = g.linhas.reduce((s, l) => s + (l.resumo || 0), 0);
  const avisados = avisadosDevolucao(f);
  const aviso = f.arquivado_em ? html`<div class="alert">${icone('arquivo')}<div><b>Arquivado pela loja em ${dataFmt(f.arquivado_em.slice(0, 10))}</b>Não conta como solicitação válida.</div></div>`
    : f.status === 'rascunho' ? html`<div class="alert warn" role="note">${icone('desfazer')}<div><b>Devolvido à loja${devolucao ? ` por ${devolucao.nome || '—'} em ${quando(devolucao.quando)}` : ''}</b>${devolucao ? devolucao.acao.replace(/^Devolveu para correção: /, '') : ''}<div class="small">A loja está corrigindo: os valores podem mudar até o reenvio. As aprovações já feitas continuam valendo.</div></div></div>`
    : f.status === 'pago' ? html`<div class="alert ok">${icone('check')}<div><b>${filhoDe(f.id) ? 'Os entregadores deste fechamento foram aprovados.' : 'Todos os entregadores aprovados.'}</b>Aprovação não é pagamento: o pagamento é feito fora do sistema, com as chaves PIX abaixo.</div></div>`
    : !decide ? html`<div class="alert info">${icone('info')}<div><b>Somente leitura.</b>Quem aprova ou devolve é o financeiro.</div></div>`
    : alterados.length ? html`<div class="alert warn">${icone('alerta')}<div><b>${alterados.length} entregador(es) mudaram depois de aprovados</b>${nomes(alterados)} voltaram para análise. Confira os novos valores e PIX.</div></div>` : '';
  res.send(page(req, {
    titulo: `Fechamento #${f.id}`, selo: seloFin({ ...f, nAprov }), largura: 'larga', css: '/marca/conferencia.css', js: '/marca/conferencia.js',
    sub: html`<b>${f.loja}</b> · período ${periodo(f)}${f.pagamento ? html` · pagamento previsto <b>${diaLongo(f.pagamento)}</b>` : ''}<br><span class="mut">Enviado por ${f.enviou || f.autor}${f.enviado_em ? ` em ${quando(f.enviado_em)}` : ''} · versão ${f.versao}${f.arquivo ? ` · arquivo ${f.arquivo}` : ''}</span>`,
    trilha: [[u.perfil === 'financeiro' ? 'Fila do financeiro' : inicio(u), voltar], [`#${f.id} · ${lojaCurta(f.loja)}`]],
    acoes: html`<a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/pdf" target="_blank">${icone('arquivo', 'sm')} Baixar PDF</a><a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/xlsx">${icone('baixar', 'sm')} Baixar Excel</a>`,
  }, html`${aviso}${vinculo(f)}
<dl class="resumo" aria-label="Valores do fechamento">
<div><dt>Total solicitado</dt><dd>${brl(g.total)}</dd><dd>${conta(() => true)} entregador(es)${g.temOc ? html` · inclui ${g.totOc > 0 ? '+' : ''}${brl(g.totOc)} de ocorrências` : ''}</dd></div>
<div><dt>Aprovado</dt><dd class="${nAprov ? 'ok-t' : ''}">${brl(soma(ehAp))}</dd><dd>${nAprov} entregador(es)</dd></div>
<div class="destaque"><dt>Aguardando análise</dt><dd>${brl(soma(ehPend))}</dd><dd>${conta(ehPend)} entregador(es)${nBloq ? ` · ${nBloq} bloqueado(s)` : ''}</dd></div>
<div><dt>Devolvido</dt><dd class="${conta(ehDev) ? 'bad-t' : ''}">${brl(soma(ehDev))}</dd><dd>${conta(ehDev)} entregador(es)</dd></div></dl>
${blocoConferencia({ f, g, itens, decide, edita: false, modo: 'fin', decisoes, hist, nomeDe, avisados, voltar })}`));
}

// Histórico: consulta com um filtro de situação e um de mês.
app.get('/historico', (req, res) => {
  const u = req.user, todos = fechamentosDe(u);
  const SIT = { '': 'Todos', rascunho: 'Falta enviar', enviado: 'Aguardando aprovação', pago: 'Aprovados', arquivado: 'Arquivados' };
  const s = req.query.s in SIT ? req.query.s : '';
  const mesDe = (f) => (f.pagamento || f.data_fim).slice(0, 7);
  const meses = [...new Set(todos.map(mesDe))].sort().reverse();
  const m = meses.includes(req.query.m) ? req.query.m : '';
  const daSit = (k) => todos.filter((f) => (k === 'arquivado' ? !!f.arquivado_em : !f.arquivado_em && (!k || f.status === k)) && (!m || mesDe(f) === m));
  const lista = daSit(s);
  const qs = (k) => { const p = new URLSearchParams(); if (k) p.set('s', k); if (m) p.set('m', m); return p.size ? `/historico?${p}` : '/historico'; };
  const nomeMes = (x) => new Date(x + '-15T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  res.send(page(req, { titulo: 'Histórico' }, html`
<div class="ferramentas"><nav class="seg" aria-label="Situação">${Object.entries(SIT).map(([k, t]) => html`<a href="${qs(k)}" class="${s === k ? 'on' : ''}" ${s === k ? new Raw('aria-current="page"') : ''}>${t}<span class="c">${daSit(k).length}</span></a>`)}</nav>
<form method="get" action="/historico">${s ? html`<input type="hidden" name="s" value="${s}">` : ''}<label class="sr" for="mes">Mês</label><select id="mes" name="m" onchange="this.form.submit()"><option value="">Todos os meses</option>${meses.map((x) => html`<option value="${x}" ${x === m ? 'selected' : ''}>${nomeMes(x)}</option>`)}</select><noscript><button class="btn btn-sec btn-sm">Filtrar</button></noscript></form></div>
<div class="tw card"><table><thead><tr><th scope="col">Pagamento previsto</th><th scope="col">Período</th>${veTudo(u) ? html`<th scope="col">Loja</th>` : ''}<th scope="col">Situação</th><th scope="col" class="n">Total</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${lista.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td><b>${f.pagamento ? diaLongo(f.pagamento) : '—'}</b><span class="mut small"> ${f.pagamento ? dataFmt(f.pagamento).slice(6) : ''}</span></td><td>${periodo(f)}</td>${veTudo(u) ? html`<td>${f.loja}</td>` : ''}<td>${selo(f, f.devolvido)}</td><td class="n">${brl(f.total)}</td><td class="n"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir</a></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="6" class="vazio-p">Nenhum fechamento ${s ? `com a situação "${SIT[s].toLowerCase()}"` : ''}${m ? ` em ${nomeMes(m)}` : ''}.</td></tr>`}</tbody></table></div>`));
});

app.get('/', (req, res) => {
  if (req.user.perfil === 'despachante') return pendenciasDespachante(req, res);
  if (req.user.perfil === 'financeiro') return filaFinanceiro(req, res);
  const u = req.user, hoje = agora().data;
  const doUsuario = fechamentosDe(u);
  const todos = doUsuario.filter((f) => !f.arquivado_em), arquivados = doUsuario.filter((f) => f.arquivado_em);
  const verArq = req.query.arq === '1';
  // Aviso no sistema (além do e-mail): fechamentos devolvidos pelo financeiro, com o motivo.
  const devolvidos = editaMotoboy(u) ? todos.filter((f) => f.devolvido && f.status === 'rascunho').map((f) => ({ ...f,
    motivo: motivoDevolucao(f) })) : [];
  const lojasVis = veTudo(u) || u.perfil === 'admin' ? db.prepare('SELECT * FROM lojas ORDER BY nome').all() : db.prepare('SELECT * FROM lojas WHERE id = ?').all(u.loja_id ?? -1);
  // Agenda: pendências dos últimos 7 dias + próximos 7 dias.
  const itens = agenda(lojasVis, AG.soma(hoje, -7), AG.soma(hoje, 7)).filter((p) => p.pagamento >= hoje || p.situacao !== 'enviado');
  const atrasados = itens.filter((p) => p.situacao === 'atrasado').length;
  const lojas = veTudo(u) ? lojasVis : [];
  const lojaF = lojas.some((l) => l.id === Number(req.query.loja)) ? Number(req.query.loja) : 0;
  const filtro = ['rascunho', 'enviado', 'pago'].includes(req.query.s) ? req.query.s : '';
  const mes0 = hoje.slice(0, 7), ant = req.query.m === 'ant', mesDe = (f) => (f.pagamento || f.data_fim).slice(0, 7);
  const doMes = verArq ? arquivados : todos.filter((f) => (mesDe(f) === mes0) !== ant);
  const daLoja = lojaF ? doMes.filter((f) => f.loja_id === lojaF) : doMes;
  const lista = filtro ? daLoja.filter((f) => f.status === filtro) : daLoja;
  const conta = (s) => todos.filter((f) => f.status === s);
  const mes = AG.soma(hoje, -30);
  const sub = { despachante: 'Importe o relatório do Agilizone no dia do pagamento, confira e envie ao financeiro.', financeiro: 'Solicitações de pagamento enviadas pelas lojas.', gestao: 'Acompanhe as solicitações de pagamento de todas as lojas.', admin: 'Solicitações de pagamento de motoboys de todas as lojas.' }[u.perfil];
  const qs = (st) => { const p = new URLSearchParams(); if (st) p.set('s', st); if (lojaF) p.set('loja', lojaF); if (ant) p.set('m', 'ant'); if (verArq) p.set('arq', '1'); return p.size ? `/?${p}` : '/'; };
  const seg = (st, txt, n) => html`<a href="${qs(st)}" class="${filtro === st ? 'on' : ''}">${txt}<span class="c">${n}</span></a>`;
  const contaL = (st) => daLoja.filter((f) => f.status === st).length;

  res.send(page(req, { titulo: 'Fechamentos', sub, acoes: editaMotoboy(u) ? html`<a class="btn btn-pri" href="/fechamentos/novo">${icone('mais')} Novo fechamento</a>` : '' }, html`
${devolvidos.length ? html`<section class="aviso-dev" aria-label="Devolvidos para correção"><h2>${devolvidos.length === 1 ? 'O financeiro devolveu um fechamento' : `O financeiro devolveu ${devolvidos.length} fechamentos`}</h2>
${devolvidos.map((f) => html`<a class="aviso-item" href="/fechamentos/${f.id}"><span><b>${f.loja} · ${f.pagamento ? `pagamento de ${diaLongo(f.pagamento)}` : periodo(f)}</b>
<span class="quote">${f.motivo ? f.motivo.acao.replace(/^Devolveu para correção: /, '') : ''}</span><small class="mut">${f.motivo ? `${f.motivo.nome || ''}, ${f.motivo.quando.slice(0, 16)}` : ''}</small></span><span class="btn btn-pri btn-sm">Corrigir</span></a>`)}</section>` : ''}
${editaMotoboy(u) ? (() => { const amanha = AG.soma(hoje, 1), fazer = itens.filter((p) => !p.f && (['hoje', 'atrasado'].includes(p.situacao) || p.pagamento === amanha)); return fazer.length ? html`<div class="next"><span class="hico pri">${icone('calendario')}</span><div class="t"><b>Pagamento para importar</b><ul>${fazer.map((p) => html`<li>${icone(p.situacao === 'atrasado' ? 'alerta' : 'calendario', 'sm')}<span>${p.loja.nome}: ${diaLongo(p.pagamento)}${p.situacao === 'atrasado' ? ' (atrasado)' : p.pagamento === amanha ? ' (amanhã: importe quando o período terminar)' : ' (hoje)'}, referente a ${p.dias.map(diaLongo).join(', ')}</span></li>`)}</ul></div><a class="btn btn-pri btn-lg" href="/fechamentos/novo">${icone('subir')} Importar</a></div>` : ''; })() : ''}
${doUsuario.length ? html`<div class="card"><div class="card-h"><div class="t"><h2>${verArq ? 'Fechamentos arquivados' : ant ? 'Meses anteriores' : `Fechamentos de ${new Date(hoje + 'T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`}</h2>
<p>${verArq ? 'Não contam como fechamento válido. Abra um para ver ou recuperar.' : 'Clique em uma linha para abrir.'}</p>
<nav class="seg" style="margin-top:8px" aria-label="Período"><a href="/" class="${ant || verArq ? '' : 'on'}">Este mês<span class="c">${todos.filter((f) => mesDe(f) === mes0).length}</span></a><a href="/?m=ant" class="${ant && !verArq ? 'on' : ''}">Meses anteriores<span class="c">${todos.filter((f) => mesDe(f) !== mes0).length}</span></a><a href="/?arq=1" class="${verArq ? 'on' : ''}">Arquivados<span class="c">${arquivados.length}</span></a></nav></div>
${lojas.length ? html`<form method="get" action="/" style="min-width:220px">${filtro ? html`<input type="hidden" name="s" value="${filtro}">` : ''}${ant ? html`<input type="hidden" name="m" value="ant">` : ''}${verArq ? html`<input type="hidden" name="arq" value="1">` : ''}<select name="loja" onchange="this.form.submit()" aria-label="Filtrar por loja"><option value="">Todas as lojas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === lojaF ? 'selected' : ''}>${l.nome}</option>`)}</select></form>` : ''}
${u.perfil === 'despachante' ? '' : html`<nav class="seg" aria-label="Filtrar por situação">${seg('', 'Todos', daLoja.length)}${seg('rascunho', 'Em conferência', contaL('rascunho'))}${seg('enviado', 'Aguardando aprovação', contaL('enviado'))}${seg('pago', 'Aprovados', contaL('pago'))}</nav>`}</div>
<div class="tw"><table><tr><th>Pagamento</th><th>Loja</th><th>Período</th><th>Situação</th><th class="n">Motoboys</th><th class="n">Total</th><th></th></tr>
${lista.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td><b>${f.pagamento ? diaLongo(f.pagamento) : '—'}</b></td><td>${f.loja}</td><td>${periodo(f)}<div class="mut small">por ${f.autor}</div></td><td>${f.arquivado_em ? html`<span class="badge nodot">Arquivado em ${dataFmt(f.arquivado_em.slice(0, 10))}</span>` : f.devolvido && f.status === 'rascunho' ? html`<span class="badge bad">Devolvido para correção</span>` : badgeStatus(f.status)}</td>
<td class="n">${f.n}</td><td class="n b">${brl(f.total)}</td><td class="n"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir ${icone('chevron', 'sm')}</a></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="7" class="mut" style="text-align:center;padding:32px">Nenhum fechamento nesta situação.</td></tr>`}</table></div></div>`
    : html`<div class="card empty"><div class="hico pri">${icone('lista', 'lg')}</div><h2>Nenhum fechamento ainda</h2>
<p>${editaMotoboy(u) ? 'No dia do pagamento, exporte os dois arquivos do Agilizone e importe aqui. O sistema calcula quanto cada motoboy recebe por dia.' : 'Quando as lojas enviarem as solicitações de pagamento, elas aparecem aqui.'}</p>
${editaMotoboy(u) ? html`<div style="max-width:820px;margin:0 auto 20px">${COMO_EXPORTAR}</div><a class="btn btn-pri btn-lg" href="/fechamentos/novo">${icone('subir')} Importar primeiro relatório</a>` : ''}</div>`}
${u.perfil === 'despachante' ? '' : html`<div class="stats" style="margin-top:20px">
<div class="card stat"><span class="hico ${atrasados ? 'warn' : 'ok'}">${icone(atrasados ? 'alerta' : 'check')}</span><div><div class="v">${atrasados}</div><div class="l">Pagamento(s) atrasado(s)</div></div></div>
<div class="card stat"><span class="hico warn">${icone('lapis')}</span><div><div class="v">${conta('rascunho').length}</div><div class="l">Em conferência nas lojas</div></div></div>
<div class="card stat"><span class="hico info">${icone('relogio')}</span><div><div class="v">${brl(conta('enviado').reduce((t, f) => t + f.total, 0))}</div><div class="l">${conta('enviado').length} aguardando aprovação</div></div></div>
<div class="card stat"><span class="hico ok">${icone('check')}</span><div><div class="v">${brl(todos.filter((f) => f.status === 'pago' && mesDe(f) === mes0).reduce((t, f) => t + f.total, 0))}</div><div class="l">Aprovado este mês</div></div></div></div>`}
${cardAgenda(u, itens)}
`));
});

app.get('/fechamentos/novo', so((r) => editaMotoboy(r.user)), (req, res) => {
  const u = req.user, hoje = agora().data;
  const lojas = u.perfil === 'admin' ? db.prepare('SELECT * FROM lojas ORDER BY nome').all() : db.prepare('SELECT * FROM lojas WHERE id = ?').all(u.loja_id);
  // O que importar agora: pagamentos de hoje ou atrasados, ainda sem fechamento enviado.
  // Períodos a importar (hoje ou atrasados) e, se não houver, o próximo. A escolha só muda o filtro mostrado:
  // o sistema descobre loja e período pelos próprios arquivos.
  const aImportar = agenda(lojas, AG.soma(hoje, -14), hoje).filter((p) => !p.f);
  const opcoes = aImportar.length ? aImportar : agenda(lojas, AG.soma(hoje, 1), AG.soma(hoje, 7)).slice(0, 1);
  const p = opcoes.find((x) => x.pagamento === req.query.p && (!req.query.l || x.loja.id === Number(req.query.l))) || opcoes[0];
  const erro = req.query.erro && req.query.k === assina('erro', req.query.erro) ? req.query.erro : '', campo = req.query.campo === 'resumo' ? 'resumo' : 'arquivo', modoDia = req.query.modo === 'dia';
  const erroDe = (c) => (erro && campo === c ? html`<p class="erro-campo" id="erro-${c}" role="alert">${icone('erro', 'sm')} ${erro}</p>` : '');
  const upload = (n, name, accept, titulo, ext) => html`<li class="upload"><span class="num" aria-hidden="true">${n}</span><div class="field">
<label for="f-${name}">${titulo} <span class="mut">(${ext})</span></label>
<label class="drop ${erro && campo === name ? 'erro' : ''}">${icone('subir')}<b class="drop-t">Escolher arquivo</b><span class="fname" aria-live="polite"></span>
<input id="f-${name}" type="file" name="${name}" accept="${accept}" required ${new Raw(erro && campo === name ? `aria-invalid="true" aria-describedby="erro-${name}"` : '')}></label>${erroDe(name)}</div></li>`;
  res.send(page(req, { titulo: 'Importar arquivos', trilha: [[inicio(u), '/'], ['Importar arquivos']], erroNoCampo: true, sub: 'Envie os arquivos exportados do Agilizone: os dois, ou só o Resumo se for pagar 1 dia. O sistema confere tudo e mostra o fechamento para você revisar antes de enviar ao financeiro.' }, html`<div class="split imp"><div class="stack">
${p ? html`<section class="contexto" aria-label="Período a importar">
<div><span class="mut small">${p.situacao === 'atrasado' ? 'Envio atrasado · pagamento previsto' : p.situacao === 'futuro' ? 'Próximo pagamento previsto' : 'Pagamento previsto'}</span><b>${diaLongo(p.pagamento)}</b>${lojas.length > 1 ? html`<span class="small">${p.loja.nome}</span>` : ''}</div>
<div class="filtro"><span class="mut small">Filtro no Agilizone</span><dl><div><dt>Data inicial</dt><dd>${dataFmt(p.ini)} 06:00</dd></div><div><dt>Data final</dt><dd>${dataFmt(AG.soma(p.fim, 1))} 06:00</dd></div></dl></div>
${opcoes.length > 1 ? html`<nav class="outros" aria-label="Outros períodos pendentes"><span class="mut small">Outro período pendente:</span>${opcoes.filter((x) => x !== p).map((x) => html`<a href="/fechamentos/novo?p=${x.pagamento}&l=${x.loja.id}">${diaLongo(x.pagamento)}${lojas.length > 1 ? ` · ${lojaCurta(x.loja.nome)}` : ''}</a>`)}</nav>` : ''}
</section>` : ''}
<form method="post" enctype="multipart/form-data" class="card importar" data-modo><div class="card-b">
<fieldset class="modo"><legend>O que você vai pagar?</legend><div class="modo-op">
<label><input type="radio" name="modo" value="periodo" ${modoDia ? '' : new Raw('checked')}><span><b>Vários dias</b><small>Relatório de Pedidos + Resumo: mostra o valor de cada dia</small></span></label>
<label><input type="radio" name="modo" value="dia" ${modoDia ? new Raw('checked') : ''}><span><b>Só 1 dia</b><small>Só o Resumo de entregas</small></span></label></div></fieldset>
<div class="field dia-campo" data-so-dia ${modoDia ? '' : new Raw('hidden')}>${u.perfil === 'admin' ? html`<label for="f-loja">Loja</label><select id="f-loja" name="loja"><option value="">Escolha a loja</option>${lojas.map((x) => html`<option value="${x.id}">${x.nome}</option>`)}</select>` : ''}
<label for="f-dia">Dia das entregas</label><input id="f-dia" type="date" name="dia" max="${hoje}"><p class="hint">No Agilizone, filtre do dia escolhido às 06:00 até o dia seguinte às 06:00 e exporte só o Resumo.</p></div>
<ol class="uploads">${upload(1, 'arquivo', '.xlsx,.xls', 'Relatório de Pedidos', '.xlsx')}${upload(2, 'resumo', '.csv,text/csv', 'Resumo de entregas por entregador', '.csv')}</ol>
</div>
<div class="card-f"><button class="btn btn-pri btn-lg">Importar e revisar</button><a class="btn btn-ghost" href="/">Cancelar</a></div></form></div>
<aside class="card guia" aria-label="Como exportar no Agilizone"><div class="card-h"><span class="hico pri">${icone('info')}</span><div class="t"><h2>Como exportar no Agilizone</h2><p>Leva 1 minuto. Use o filtro de datas mostrado ao lado.</p></div></div><div class="card-b">${COMO_EXPORTAR}
<ul class="regras"><li>${icone('check', 'sm')} <span>Exporte os dois arquivos da <b>mesma tela</b>, com o <b>mesmo filtro</b>. Para <b>1 dia</b>, só o Resumo.</span></li><li>${icone('check', 'sm')} <span>Pedidos sem motoboy são descartados automaticamente.</span></li><li>${icone('alerta', 'sm')} <span>Se algum pedido já estiver em outro fechamento, a importação é recusada (ninguém recebe duas vezes).</span></li></ul></div></aside></div>`));
});

const doisArquivos = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20e6, files: 2 } }).fields([{ name: 'arquivo', maxCount: 1 }, { name: 'resumo', maxCount: 1 }]);
// Erro de validação da importação volta para o formulário, junto ao arquivo correspondente.
app.post('/fechamentos/novo', so((r) => editaMotoboy(r.user)), doisArquivos, (req, res, next) => {
  try { importar(req, res); } catch (e) {
    if (!e.publico) return next(e);
    const dia = req.body?.modo === 'dia', campo = dia || /resumo|\.csv/i.test(e.message) ? 'resumo' : 'arquivo';
    volta(res, `/fechamentos/novo?campo=${campo}${dia ? '&modo=dia' : ''}`, 'erro', e.message);
  }
});
// Fechamento de 1 dia: só o Resumo (o total do dia de cada motoboy), sem o Relatório de Pedidos.
function importarDia(req, res, arq) {
  if (!arq) throw falha('Escolha o Resumo de entregas por entregador (.csv) do dia.');
  const dia = String(req.body.dia || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia > agora().data) throw falha('Escolha o dia das entregas (não pode ser no futuro).');
  const l = db.prepare('SELECT * FROM lojas WHERE id = ?').get(req.user.perfil === 'admin' ? Number(req.body.loja) : req.user.loja_id);
  if (!l) throw falha('Escolha a loja.');
  const resumo = lerResumo(arq.buffer);
  const x = db.prepare('SELECT data_ini, data_fim FROM fechamentos WHERE loja_id = ? AND arquivado_em IS NULL AND data_ini <= ? AND data_fim >= ?').get(l.id, dia, dia);
  if (x) throw falha(`Já existe um fechamento desta loja (${periodo(x)}) que inclui ${dataFmt(dia)}. Se ele estava errado, arquive-o antes.`);
  const pagamento = AG.pagamentoDoDia(calendarioDa(l), dia);
  const fid = tx(() => {
    const fid = Number(db.prepare('INSERT INTO fechamentos (loja_id, data_ini, data_fim, criado_por, arquivo, pagamento, so_resumo) VALUES (?,?,?,?,?,?,1)')
      .run(l.id, dia, dia, req.user.id, arq.originalname, pagamento).lastInsertRowid);
    log(req.user.id, `f:${fid}`, `Importou o Resumo de ${dataFmt(dia)} (fechamento de 1 dia): ${resumo.length} entregadores`);
    gravaResumo({ id: fid }, resumo, req.user.id, arq.originalname);
    return fid;
  });
  volta(res, `/fechamentos/${fid}`, 'ok', `Importado: ${diaLongo(dia)}. Agora revise e envie ao financeiro.`);
}
function importar(req, res) {
  req.file = req.files?.arquivo?.[0];
  const arqResumo = req.files?.resumo?.[0];
  if (req.body.modo === 'dia') return importarDia(req, res, arqResumo);
  if (!req.file) throw falha('Escolha o Relatório de Pedidos (.xlsx).');
  if (!arqResumo) throw falha('Escolha também o Resumo de entregas por entregador (.csv). Ele traz o total certo de cada motoboy.');
  const { loja, pedidos } = lerRelatorio(req.file.buffer);
  const resumo = lerResumo(arqResumo.buffer);
  let l = db.prepare('SELECT * FROM lojas WHERE nome = ?').get(loja);
  if (!l && req.user.perfil === 'admin') {
    db.prepare('INSERT INTO lojas (nome, calendario) VALUES (?, ?)').run(loja, AG.PADRAO);
    l = db.prepare('SELECT * FROM lojas WHERE nome = ?').get(loja);
  }
  if (!l) throw falha(`A loja "${loja}" não está cadastrada. Peça para a TI cadastrar em Configurações (o nome tem que ser igual ao do Agilizone).`);
  if (req.user.perfil === 'despachante' && req.user.loja_id !== l.id) throw falha(`Este arquivo é da loja "${loja}", que não é a sua.`, 403);
  const comMotoboy = pedidos.filter((p) => p.entregador), semMotoboy = pedidos.length - comMotoboy.length;
  if (!comMotoboy.length) throw falha('O arquivo não tem nenhum pedido com motoboy atrelado.');

  // Pedido que já está em outro fechamento: recusa tudo. O Resumo do período conta esses pedidos,
  // então importar "o resto" faria a tela sugerir repor um valor que já foi pago.
  const repetidos = db.prepare(`SELECT p.fechamento_id id, COUNT(*) n, f.data_ini, f.data_fim FROM pedidos p JOIN fechamentos f ON f.id = p.fechamento_id
    WHERE p.loja_id = ? AND p.ativo = 1 AND p.chave IN (SELECT value FROM json_each(?)) GROUP BY 1`).all(l.id, JSON.stringify(comMotoboy.map((p) => p.chave)));
  if (repetidos.length) throw falha(`O período exportado se sobrepõe a fechamento(s) já importado(s): ${repetidos.map((x) => `${periodo(x)} (${x.n} pedidos em comum)`).join('; ')}. Exporte só os dias que ainda não foram pagos, ou arquive o fechamento anterior se ele estava errado.`);

  const cal = calendarioDa(l);
  const dias = [...new Set(comMotoboy.map((p) => p.dia))].sort();
  const umDia = db.prepare('SELECT data_ini FROM fechamentos WHERE loja_id = ? AND so_resumo = 1 AND arquivado_em IS NULL AND data_ini BETWEEN ? AND ?').all(l.id, dias[0], dias[dias.length - 1]);
  if (umDia.length) throw falha(`O período exportado inclui ${umDia.map((x) => dataFmt(x.data_ini)).join(', ')}, que já foi importado como fechamento de 1 dia. Exporte só os dias que ainda não foram importados.`);
  const pagamento = AG.pagamentoDoDia(cal, dias[dias.length - 1]);
  const ref = pagamento ? AG.diasReferencia(cal, pagamento) : [];
  const fora = pagamento ? dias.filter((d) => !ref.includes(d)) : [];

  const fid = tx(() => {
    const fid = Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, criado_por, arquivo, pagamento) VALUES (?, ?, ?, ?, ?, ?)")
      .run(l.id, dias[0], dias[dias.length - 1], req.user.id, req.file.originalname, pagamento).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO pedidos (fechamento_id, loja_id, chave, numero, dia, entregador, motoboy_id, taxa, status)
      VALUES (?,?,?,?,?,?,(SELECT motoboy_id FROM apelidos WHERE loja_id = ? AND nome = ?),?,?)`);
    const vistos = new Set();
    for (const p of comMotoboy) {
      if (vistos.has(p.chave)) throw falha(`O pedido ${p.numero} aparece duas vezes no arquivo com o mesmo horário. Exporte de novo do Agilizone.`);
      vistos.add(p.chave);
      ins.run(fid, l.id, p.chave, p.numero, p.dia, p.entregador, l.id, p.entregador, p.taxa, p.status);
    }
    log(req.user.id, `f:${fid}`, `Importou ${req.file.originalname}: ${comMotoboy.length} pedidos com motoboy` + (semMotoboy ? `; ${semMotoboy} sem motoboy descartados` : ''));
    if (pagamento) log(req.user.id, `f:${fid}`, `Pagamento de ${diaLongo(pagamento)} (referente a ${ref.map(diaLongo).join(', ')})`);
    if (fora.length) log(req.user.id, `f:${fid}`, `Atenção: dias fora do período desse pagamento: ${fora.map(diaLongo).join(', ')}`);
    const f = { id: fid, loja_id: l.id, loja };
    confereMesmoPeriodo(f, resumo);
    gravaResumo(f, resumo, req.user.id, arqResumo.originalname);
    return fid;
  });
  fora.length ? volta(res, `/fechamentos/${fid}`, 'erro', `Importado, mas o arquivo tem dias fora do período do pagamento de ${diaLongo(pagamento)}: ${fora.map(diaLongo).join(', ')}. Confira o filtro de datas no Agilizone.`)
    : volta(res, `/fechamentos/${fid}`, 'ok', pagamento ? `Importado: pagamento de ${diaLongo(pagamento)}. Agora revise os valores.` : 'Importado. Agora revise os valores.');
}

const celOc = (l) => html`<td class="n oc-c">${l.oc || l.qtdOc ? html`<span class="${l.oc < 0 ? 'bad-t' : ''}">${l.oc > 0 ? '+' : ''}${brl(l.oc)}</span><small class="mut"> ${l.qtdOc} ocorr.</small>` : html`<span class="mut">–</span>`}</td>`;
const celPago = (l) => html`<td class="n">${l.pago ? html`<span class="bad-t">−${brl(l.pago)}</span>` : html`<span class="mut">–</span>`}</td>`;
const thOc = (g) => html`${g.temOc ? html`<th scope="col" class="n" title="Ocorrências do Agilizone: acréscimo ou desconto, sem data. Entram no total.">Ocorrências</th>` : ''}${g.temPago ? html`<th scope="col" class="n" title="Acerto já feito no Agilizone: descontado do total">Já pago</th>` : ''}`;
const diferenca = (v) => html`<span class="${v > 0 ? 'ok-t' : v < 0 ? 'bad-t' : 'mut'} b">(${v > 0 ? '+' : ''}${brl(v)})</span>`;

app.get('/fechamentos/:fid', (req, res) => {
  const f = req.f, u = req.user;
  // Financeiro (e admin/gestão depois do envio) conferem na tela própria; esta é a do despachante.
  if (u.perfil === 'financeiro' || (['admin', 'gestao'].includes(u.perfil) && f.status !== 'rascunho')) return conferenciaFin(req, res);
  const g = grade(f), edita = podeEditar(u, f);
  const enviado = f.status !== 'rascunho';
  const jaPago = db.prepare('SELECT r.entregador, r.pago, m.nome FROM resumo r LEFT JOIN motoboys m ON m.id = r.motoboy_id WHERE r.fechamento_id = ? AND r.pago > 0 ORDER BY 1').all(f.id);
  const hist = db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`f:${f.id}`);
  const ultimo = (re) => hist.find((h) => re.test(h.acao));
  const envio = ultimo(/^Enviou ao financeiro/), devolucao = ultimo(/^Devolveu para correção/);
  const devolvido = !enviado && devolucao && (!envio || devolucao.id > envio.id);
  const fora = ultimo(/^Atenção: dias fora/);
  const semPix = g.linhas.filter((l) => l.total > 0 && !l.pix);
  const pend = g.linhas.filter((l) => l.confere === 'pendente');
  const totResumo = g.linhas.reduce((s, l) => s + (l.resumo || 0), 0);

  const colAprov = f.status === 'pago' || g.linhas.some((l) => l.aprovacao); // aprovar/devolver é na tela do financeiro
  const entregas = db.prepare(f.so_resumo ? 'SELECT COALESCE(SUM(pedidos), 0) n FROM resumo WHERE fechamento_id = ?' : 'SELECT COUNT(*) n FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NOT NULL').get(f.id).n;
  const aprovou = ultimo(/^Aprovou a solicitação/);

  // Estado atual: um bloco só, com a ação permitida.
  let estado = '';
  if (f.arquivado_em) estado = html`<div class="estado" id="arquivado"><div><b>Fechamento arquivado em ${dataFmt(f.arquivado_em.slice(0, 10))}</b><p>Não conta como fechamento válido e os pedidos dele podem entrar em outro fechamento. Nada foi apagado.</p></div>
${podeRecuperar(u, f) ? html`<form method="post" action="/fechamentos/${f.id}/recuperar" class="in"><button class="btn btn-sec">${icone('desfazer', 'sm')} Recuperar</button></form>` : ''}</div>`;
  else if (!enviado && edita) {
    const passos = [
      ['Arquivos do Agilizone', g.temResumo ? ['ok', f.so_resumo ? 'Resumo do dia importado' : 'Relatório de Pedidos e Resumo importados'] : ['warn', 'Falta o Resumo de entregas'], '#conferencia'],
      ['Chaves PIX', semPix.length ? ['bad', `Falta a chave de ${semPix.length} motoboy(s)`] : ['ok', g.linhas.some((l) => l.pixDigitado) ? 'Completas, algumas digitadas por você' : 'Completas'], semPix.length ? '#pix' : '#conf'],
      ['Conferência com o Resumo', !g.temResumo ? ['nodot', 'Sem Resumo para comparar'] : pend.length ? ['warn', `${pend.length} motoboy(s) com diferença`] : ['ok', 'Bate com o Resumo'], pend.length ? '#conferencia' : '#conf'],
    ];
    estado = html`<section class="conferencia" aria-labelledby="conf-t"><h2 id="conf-t">${semPix.length ? 'Antes de enviar, preencha o que falta' : 'Revise e envie ao financeiro'}</h2><ol>
${passos.map(([t, [cor, txt], href]) => html`<li class="${cor}"><a href="${href}"><span class="marca" aria-hidden="true">${icone(cor === 'ok' ? 'check' : cor === 'nodot' || cor === 'info' ? 'info' : 'alerta', 'sm')}</span><span><b>${t}</b><span>${txt}</span></span></a></li>`)}</ol></section>`;
  } else if (!enviado) estado = html`<div class="estado"><div><b>Ainda não enviado ao financeiro</b><p>Quando o despachante enviar, o financeiro recebe o e-mail com o PDF.</p></div></div>`;
  else if (f.status === 'pago') estado = html`<div class="estado ok"><div><b>Aprovado pelo financeiro${aprovou ? ` em ${quando(aprovou.quando)}` : ''}${aprovou?.nome ? `, por ${aprovou.nome}` : ''}</b><p>O pagamento é feito fora do sistema, com o PDF e as chaves PIX deste fechamento.</p></div></div>`;
  else estado = html`<div class="estado"><div><b>Aguardando aprovação do financeiro${envio ? ` · enviado em ${quando(envio.quando)}` : ''}</b><p>O fechamento fica travado para edição; só o financeiro pode devolver para correção.</p></div></div>`;

  // Situação do e-mail: secundária, abaixo do estado.
  const email = enviado && ['admin', 'despachante'].includes(u.perfil) ? (() => {
    const e = db.prepare("SELECT acao, quando FROM log WHERE ref = ? AND acao LIKE 'E-mail (solicitação)%' ORDER BY id DESC").get(`f:${f.id}`);
    const ok = e && e.acao.includes(' enviado para ');
    return html`<p class="linha-email ${ok ? '' : 'bad-t'}" id="email">${icone(ok ? 'email' : 'alerta', 'sm')} ${ok ? `E-mail ${e.acao.replace(/^E-mail \(solicitação\) /, '')}, ${quando(e.quando)}.` : `O e-mail com o PDF não foi enviado${e ? `: ${e.acao.replace(/^E-mail \(solicitação\) (não enviado: |falhou: )?/, '')}` : ''}.`}
${podeReenviar(u, f) ? html` <a href="/fechamentos/${f.id}/enviar">Reenviar e-mail</a>` : ''}${!ok && u.perfil === 'admin' ? html` · <a href="/config">Configurações</a>` : ''}</p>`; })() : '';

  const sub = html`${f.pagamento ? html`Pagamento previsto: <b>${diaLongo(f.pagamento)}</b>` : 'Sem data de pagamento no calendário'}${veTudo(u) ? html` · ${f.loja}` : ''} · <span class="mut">importado por ${f.autor}, ${quando(f.criado_em)}</span>`;
  res.send(page(req, {
    titulo: `Fechamento de ${periodo(f)}`, selo: selo(f, devolvido), sub, largura: 'larga', css: '/marca/conferencia.css', js: '/marca/conferencia.js', trilha: [[inicio(u), '/'], [periodo(f)]],
    acoes: html`<a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/pdf" target="_blank">${icone('arquivo', 'sm')} Baixar PDF</a><a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/xlsx">${icone('baixar', 'sm')} Baixar Excel</a>`,
  }, html`
${devolvido ? html`<div class="motivo" role="note" id="devolvido"><b>Devolvido pelo financeiro${devolucao.nome ? ` (${devolucao.nome})` : ''} em ${quando(devolucao.quando)}</b>
<p>${devolucao.acao.replace(/^Devolveu para correção: /, '')}</p>${(() => { const d = db.prepare('SELECT motoboy_id FROM devolucoes WHERE fechamento_id = ? AND versao = ?').all(f.id, f.versao).map((x) => g.linhas.find((l) => l.id === x.motoboy_id)?.nome).filter(Boolean); return d.length ? html`<p class="small"><b>Entregadores devolvidos:</b> ${d.join(', ')}</p>` : ''; })()}${edita ? html`<span class="small">Corrija abaixo e envie de novo.</span>` : ''}</div>` : ''}
${estado}${vinculo(f)}${email}
<dl class="resumo">
<div class="destaque"><dt>Total a pagar</dt><dd>${brl(g.total)}</dd></div>
<div><dt>Motoboys</dt><dd>${g.linhas.filter((l) => l.total > 0).length}</dd></div>
<div><dt>Entregas</dt><dd>${entregas}</dd></div>${g.temOc ? html`<div><dt>Ocorrências</dt><dd class="${g.totOc < 0 ? 'bad-t' : ''}">${g.totOc > 0 ? '+' : ''}${brl(g.totOc)}</dd><dd>${g.linhas.reduce((t, l) => t + l.qtdOc, 0)} no período, já no total</dd></div>` : ''}</dl>
${fora ? html`<div class="alert warn">${icone('calendario')}<div><b>Dias fora do período do pagamento</b>${(() => { const d = fora.acao.replace(/^Atenção: dias fora do período desse pagamento: /, '').split(', '); return d.length > 4 ? `${d.length} dias (de ${d[0]} a ${d[d.length - 1]})` : d.join(', '); })()}. Confira o filtro de datas no Agilizone.</div></div>` : ''}
${jaPago.length ? html`<div class="alert bad">${icone('alerta')}<div><b>Acerto já feito no Agilizone para ${jaPago.length} motoboy(s)</b>O valor já foi descontado do total a pagar: ${jaPago.map((r, i) => html`${i ? ', ' : ''}<b>${r.nome || r.entregador}</b> (${brl(r.pago)})`)}.</div></div>` : ''}

${semPix.length ? html`<form method="post" action="/fechamentos/${f.id}/pix" class="card bloco pede pix-bloco" id="pix">
<div class="card-h"><span class="hico warn">${icone('chave')}</span><div class="t"><h2>Informe a chave PIX de ${semPix.length} motoboy${semPix.length > 1 ? 's' : ''}</h2>
<p>${edita ? 'O Agilizone não trouxe a chave deles, e sem ela o financeiro não consegue pagar. Peça ao motoboy e cole aqui: vale CPF, telefone, e-mail ou chave aleatória. Vale só para este fechamento.' : 'O Agilizone não trouxe a chave deles. O despachante precisa informar.'}</p></div>
${edita ? html`<span class="pix-cont" data-pix-cont aria-live="polite">0 de ${semPix.length} preenchidas</span>` : ''}</div>
<div class="pix-lista">${edita ? html`<div class="pix-cab" aria-hidden="true"><span>Motoboy</span><span>Chave PIX</span></div>` : ''}${semPix.map((l) => html`<div class="pix-item"><div class="pix-quem"><b>${l.nome}</b><span>Vai receber <b>${brl(l.total)}</b></span></div>
${edita ? html`<div class="field pix-campo"><label for="pix_${l.id}" class="sr">Chave PIX de ${l.nome}</label><input id="pix_${l.id}" name="pix_${l.id}" value="${l.pix}" placeholder="Cole aqui: CPF, telefone, e-mail ou chave aleatória" autocomplete="off" maxlength="120" data-pix aria-describedby="tipo_${l.id}"><span class="pix-tipo" id="tipo_${l.id}" data-pix-tipo></span></div>` : html`<span class="badge bad">Sem PIX</span>`}</div>`)}</div>
${edita ? html`<div class="card-f"><button class="btn btn-pri">${icone('check', 'sm')} Salvar chaves PIX</button><span class="small mut">Pode salvar só algumas agora e completar o resto depois.</span></div>` : ''}</form>` : ''}

${g.temResumo ? (pend.length ? html`<div class="alert warn" id="conferencia">${icone('alerta')}<div><b>Diferença com o Resumo do Agilizone (${pend.length})</b>${pend.map((l, i) => html`${i ? '; ' : ' '}${l.nome}: soma ${brl(l.bruto)}, Resumo ${brl(l.resumo)}`)}. O Agilizone é a referência: confira se os dois arquivos saíram da mesma tela, com o mesmo filtro. Se não, arquive este fechamento e importe de novo.</div></div>` : '')
  : html`<div class="alert warn" id="conferencia">${icone('alerta')}<div><b>Sem o Resumo de entregas</b>Os totais não foram conferidos com o Agilizone.${edita ? html`
<form method="post" action="/fechamentos/${f.id}/resumo" enctype="multipart/form-data" class="linha-form"><input type="file" name="resumo" accept=".csv,text/csv" required aria-label="Resumo de entregas (.csv)"><button class="btn btn-sec btn-sm">Anexar Resumo</button></form>` : ' O despachante precisa anexar.'}</div></div>`}

${blocoConferencia({ f, g, itens: itensFin(f, g), decide: false, edita, modo: 'desp', decisoes: [], hist, nomeDe: () => '', avisados: [], voltar: '/' })}


${edita ? html`<details class="fold mais-acoes"><summary class="small">${icone('chevron', 'chev')} Importou o arquivo errado?</summary>
<form method="post" action="/fechamentos/${f.id}/arquivar" onsubmit="return confirm('Arquivar este fechamento? Ele sai da lista, mas pode ser recuperado na aba Arquivados do Histórico.')"><p class="small mut">Arquivar tira o fechamento da lista e libera os pedidos para importar de novo. Nada é apagado.</p><button class="btn btn-sec btn-sm">${icone('arquivo', 'sm')} Arquivar fechamento</button></form></details>
<div class="barra" role="region" aria-label="Enviar ao financeiro"><div class="barra-in"><div><span class="mut small">Total a pagar</span><b>${brl(g.total)}</b></div>
${semPix.length ? html`<span class="small bad-t" id="barra-motivo">Preencha ${semPix.length} chave(s) PIX para enviar</span><button class="btn btn-pri btn-lg" disabled aria-describedby="barra-motivo">${icone('enviar')} Enviar ao financeiro</button>`
      : html`<a class="btn btn-pri btn-lg" href="/fechamentos/${f.id}/enviar">${icone('enviar')} Enviar ao financeiro</a>`}</div></div>` : ''}`));
});

const editaPix = db.prepare('INSERT INTO edicoes (fechamento_id, motoboy_id, pix) VALUES (?,?,?) ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET pix = excluded.pix');

// Nome e PIX corrigidos pelo despachante: valem só neste fechamento (o Agilizone continua sendo a fonte).
app.get('/fechamentos/:fid/motoboy/:m', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f, l = grade(f).linhas.find((x) => x.id === Number(req.params.m));
  if (!l) throw falha('Motoboy não está neste fechamento.', 404);
  const voltar = `/fechamentos/${f.id}#conf`;
  res.send(page(req, { titulo: 'Editar motoboy', sub: html`Vale só para o fechamento de <b>${periodo(f)}</b>. Para corrigir de vez, ajuste o cadastro no Agilizone.`, trilha: [[inicio(req.user), '/'], [periodo(f), voltar], ['Editar motoboy']], largura: 'estreita' }, html`
<form method="post" class="card"><div class="card-b fgrid">
<div class="field" style="grid-column:1/-1"><label for="nome">Nome <span class="req" aria-hidden="true">*</span></label><input id="nome" name="nome" value="${l.nome}" required minlength="3" maxlength="120" autocomplete="off">${l.nomeAgil ? html`<p class="hint">No Agilizone: ${l.nomeAgil}</p>` : ''}</div>
<div class="field" style="grid-column:1/-1"><label for="pix">Chave PIX <span class="req" aria-hidden="true">*</span></label><input id="pix" name="pix" value="${l.pix}" required maxlength="120" autocomplete="off" placeholder="CPF, telefone, e-mail ou chave aleatória"><p class="hint">Confira com o motoboy. É para essa chave que o financeiro vai pagar.</p></div></div>
<div class="card-f"><button class="btn btn-pri">Salvar</button><a class="btn btn-ghost" href="${voltar}">Cancelar</a></div></form>`));
});

app.post('/fechamentos/:fid/motoboy/:m', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f, l = grade(f).linhas.find((x) => x.id === Number(req.params.m));
  if (!l) throw falha('Motoboy não está neste fechamento.', 404);
  const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120), pix = String(req.body.pix || '').trim().slice(0, 120);
  if (nome.length < 3) throw falha('Digite o nome do motoboy.');
  if (!pix) throw falha('Digite a chave PIX.');
  if (nome === l.nome && pix === l.pix) return volta(res, `/fechamentos/${f.id}`, 'ok', 'Nada mudou.');
  const agil = l.nomeAgil || l.nome;
  db.prepare('INSERT INTO edicoes (fechamento_id, motoboy_id, nome, pix) VALUES (?,?,?,?) ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET nome = excluded.nome, pix = excluded.pix')
    .run(f.id, l.id, nome === agil ? null : nome, pix);
  log(req.user.id, `f:${f.id}`, `Editou motoboy ${l.nome}: ${nome !== l.nome ? `nome → ${nome}; ` : ''}${pix !== l.pix ? `PIX ${l.pix || '(vazio)'} → ${pix}` : ''}`);
  volta(res, `/fechamentos/${f.id}`, 'ok', `${nome} atualizado neste fechamento.`);
});

app.post('/fechamentos/:fid/pix', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const linhas = new Map(grade(req.f).linhas.map((l) => [l.id, l]));
  let n = 0;
  tx(() => {
    for (const [k, v] of Object.entries(req.body)) {
      const l = linhas.get(Number(k.replace(/^pix_/, ''))), pix = String(v || '').trim().slice(0, 120);
      if (!k.startsWith('pix_') || !l || !pix || l.pix === pix) continue;
      editaPix.run(req.f.id, l.id, pix);
      log(req.user.id, `f:${req.f.id}`, `PIX de ${l.nome} digitado: ${pix}`);
      n++;
    }
  });
  volta(res, `/fechamentos/${req.f.id}`, n ? 'ok' : 'erro', n ? `${n} chave(s) PIX salva(s).` : 'Nenhuma chave PIX preenchida.');
});

// Anexa (ou troca) o Resumo de um fechamento já importado.
const umResumo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5e6, files: 1 } }).single('resumo');
app.post('/fechamentos/:fid/resumo', so((r) => podeEditar(r.user, r.f)), umResumo, (req, res) => {
  if (!req.file) throw falha('Escolha o arquivo do Resumo (.csv).');
  const rows = lerResumo(req.file.buffer);
  tx(() => { confereMesmoPeriodo(req.f, rows); gravaResumo(req.f, rows, req.user.id, req.file.originalname); });
  volta(res, `/fechamentos/${req.f.id}`, 'ok', 'Resumo anexado. Os totais agora são conferidos com ele.');
});

// ---------- Fluxo ----------
// Destinatários padrão da solicitação (Configurações) + cópia para quem envia, se ativada.
function destinatariosPadrao(autor) {
  const para = listaEmails(cfg('email_para'));
  if (cfg('email_copia') === '1' && autor.email && !para.includes(autor.email)) para.push(autor.email);
  return para;
}
// Destinatários digitados na confirmação (valem só para este envio).
function destinatariosDigitados(txt) {
  const para = [...new Set(listaEmails(txt).map((e) => e.toLowerCase()))];
  const ruim = para.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (ruim) throw falha(`E-mail inválido: ${ruim}`);
  if (!para.length) throw falha('Informe pelo menos um destinatário.');
  if (para.length > 20) throw falha('No máximo 20 destinatários.');
  return para;
}
function pendenciasEnvio(f) {
  const g = grade(f), pend = g.linhas.filter((l) => l.confere === 'pendente'), semPix = g.linhas.filter((l) => l.total > 0 && !l.pix);
  if (semPix.length) return `Cadastre a chave PIX de: ${semPix.map((l) => l.nome).join(', ')}.`;
  return null;
}

// Tela de confirmação do envio (e do reenvio): resumo + destinatários editáveis só para este envio.
app.get('/fechamentos/:fid/enviar', so((r) => podeEditar(r.user, r.f) || podeReenviar(r.user, r.f)), (req, res) => {
  const f = req.f, reenvio = f.status !== 'rascunho', g = grade(f);
  if (!reenvio) { const p = pendenciasEnvio(f); if (p) return volta(res, `/fechamentos/${f.id}`, 'erro', p); }
  const padrao = destinatariosPadrao(req.user), aPagar = g.linhas.filter((l) => l.total > 0), pend = g.linhas.filter((l) => l.confere === 'pendente');
  const alterados = g.linhas.filter((l) => l.alterado);
  const titulo = reenvio ? 'Reenviar e-mail ao financeiro' : 'Enviar ao financeiro';
  const rotulo = reenvio ? 'Reenviar e-mail' : 'Confirmar envio';
  // Há algo para o despachante conferir antes de enviar? (não bloqueia o envio)
  const conferir = !reenvio && pend.length;
  res.send(page(req, { titulo, css: '/marca/envio.css', js: '/marca/envio.js', trilha: [[inicio(req.user), '/'], [periodo(f), `/fechamentos/${f.id}`], [titulo]],
    sub: reenvio ? 'O fechamento já foi enviado. Isto manda o e-mail com o PDF de novo.' : 'Confira o resumo e escolha quem recebe o e-mail com o PDF. Depois é só confirmar.' }, html`
<form method="post" action="/fechamentos/${f.id}/${reenvio ? 'email' : 'enviar'}" id="form-envio" ${new Raw(conferir ? 'data-confirma="dlg-div"' : '')}>
<div class="envio-grid">
<section class="card envio-card" aria-labelledby="env-h1">
<div class="card-h"><span class="hico pri">${icone('lista')}</span><div class="t"><h2 id="env-h1">1. O que será enviado</h2><p>${f.loja}</p></div></div>
<div class="card-b">
<dl class="envio-dl">
<div><dt>Período</dt><dd>${dataFmt(f.data_ini).slice(0, 5)} a ${dataFmt(f.data_fim).slice(0, 5)}</dd></div>
<div><dt>Pagamento previsto</dt><dd>${f.pagamento ? diaLongo(f.pagamento) : '—'}</dd></div>
<div><dt>Motoboys a pagar</dt><dd>${aPagar.length}</dd></div>
<div class="envio-total"><dt>Total</dt><dd>${brl(g.total)}</dd></div></dl>
${pend.length && !reenvio ? html`<div class="alert warn">${icone('alerta')}<div><b>${pend.length} motoboy(s) com diferença com o Resumo do Agilizone</b>${pend.map((l) => l.nome).join(', ')}. <a href="/fechamentos/${f.id}#conferencia">Revisar antes de enviar</a></div></div>` : ''}
<div class="anexos"><p class="anexos-t">Anexos do e-mail (vão juntos, nesta ordem)</p>
<a class="anexo" href="/fechamentos/${f.id}/xlsx"><span class="hico">${icone('baixar')}</span><span class="anexo-t"><b>1. Planilha (Excel)</b><small>Valores por motoboy e por dia, ocorrências, chaves PIX e total.</small></span><span class="btn btn-sec btn-sm">Baixar Excel</span></a>
<a class="anexo" href="/fechamentos/${f.id}/pdf" target="_blank" rel="noopener"><span class="hico">${icone('arquivo')}</span><span class="anexo-t"><b>2. Solicitação de pagamento (PDF)</b><small>Resumo, tabela por motoboy, chaves PIX e assinaturas.</small></span><span class="btn btn-sec btn-sm">Ver o PDF</span></a></div>
</div></section>
<section class="card envio-card" aria-labelledby="env-h2">
<div class="card-h"><span class="hico pri">${icone('email')}</span><div class="t"><h2 id="env-h2">2. Para quem enviar</h2><p>Todos desta lista recebem o e-mail com o PDF. Vale só para este envio.</p></div></div>
<div class="card-b">
<label class="para-rot" for="para-novo">Destinatários <span class="req" aria-hidden="true">*</span> <span class="para-n" data-para-n></span></label>
<div class="para-box" data-para>
<ul class="para-chips" aria-label="Destinatários do e-mail"></ul>
<div class="para-add"><input id="para-novo" type="email" inputmode="email" autocomplete="off" placeholder="Digite um e-mail" aria-describedby="para-dica para-erro"><button type="button" class="btn btn-sec" data-para-add>${icone('mais', 'sm')} Adicionar</button></div></div>
<p class="para-erro" id="para-erro" role="alert" hidden></p>
<p class="hint" id="para-dica">Para incluir mais gente: digite o e-mail e aperte <b>Enter</b> (ou vírgula), ou clique em Adicionar. Para tirar alguém, clique no <b>×</b>.</p>
<button type="button" class="btn btn-ghost btn-sm" data-para-padrao hidden>Voltar para a lista padrão</button>
<textarea id="para" name="para" required class="para-txt" aria-label="Destinatários, um por linha" placeholder="financeiro@grupofornopaulista.com">${padrao.join('\n')}</textarea>
</div></section>
</div>
${!reenvio && alterados.length ? html`<div class="alert warn">${icone('alerta')}<div><b>Entregadores já aprovados que mudaram</b>O financeiro vai precisar aprovar de novo:
<ul>${alterados.map((l) => html`<li>${l.nome}: aprovado ${brl(l.aprovacao.valor)} (PIX ${l.aprovacao.pix}) → agora ${brl(l.total)} (PIX ${l.pix})</li>`)}</ul>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" name="revisei" value="1" required> Revisei essas mudanças</label></div></div>` : ''}
<div class="envio-fim">
${reenvio ? '' : html`<p class="small mut">${icone('info', 'sm')} Depois de enviar, o fechamento fica travado para edição até o financeiro aprovar ou devolver. Entregadores já aprovados continuam aprovados.</p>`}
<div class="acoes-f"><button class="btn btn-pri btn-lg" data-envio>${icone('enviar')} <span class="lbl" data-rotulo="${rotulo}">${rotulo}</span></button><a class="btn btn-ghost" href="/fechamentos/${f.id}">Voltar</a></div></div>
${conferir ? html`<dialog id="dlg-div" class="dlg" aria-labelledby="dlg-t"><h2 id="dlg-t">Há diferença com o Resumo. Enviar mesmo assim?</h2>
<ul class="dlg-l">${pend.map((l) => html`<li class="bad"><b>${l.nome}</b>: soma dos dias ${brl(l.bruto)} · Resumo ${brl(l.resumo)}</li>`)}</ul>
<div class="acoes-f"><button type="submit" class="btn btn-pri" data-confirmado>Enviar mesmo assim</button><button type="button" class="btn btn-ghost" data-fecha-dlg>Voltar e corrigir</button></div></dialog>` : ''}
</form>`));
});

app.post('/fechamentos/:fid/enviar', so((r) => podeEditar(r.user, r.f)), async (req, res) => {
  const f = req.f, para = destinatariosDigitados(req.body.para);
  const p = pendenciasEnvio(f);
  if (p) return volta(res, `/fechamentos/${f.id}`, 'erro', p);
  // Reenvio: entregador já aprovado que mudou (valor ou PIX) exige revisão explícita do despachante.
  const alterados = grade(f).linhas.filter((l) => l.alterado);
  if (alterados.length && req.body.revisei !== '1') return volta(res, `/fechamentos/${f.id}/enviar`, 'erro', `Marque que revisou as mudanças em ${alterados.map((l) => l.nome).join(', ')} (já aprovados pelo financeiro).`);
  tx(() => {
    db.prepare("UPDATE fechamentos SET status = 'enviado', versao = versao + 1, enviado_em = datetime('now','localtime'), enviado_por = ? WHERE id = ?").run(req.user.id, f.id);
    // Congela o PIX de cada motoboy como foi enviado ao financeiro.
    const ls = grade(f).linhas;
    db.prepare('DELETE FROM envio_pix WHERE fechamento_id = ?').run(f.id);
    for (const l of ls) db.prepare('INSERT INTO envio_pix (fechamento_id, motoboy_id, pix) VALUES (?,?,?)').run(f.id, l.id, l.pix);
    const g = grade({ ...f, status: 'enviado' });
    log(req.user.id, `f:${f.id}`, `Enviou ao financeiro (versão ${f.versao + 1}, total ${brl(g.total)}${alterados.length ? `; revisou mudanças em itens já aprovados: ${alterados.map((l) => l.nome).join(', ')}` : ''})`);
    // Reenvio em que tudo já estava aprovado (aprovações preservadas): conclui direto.
    if (!g.linhas.some((l) => l.total > 0 && !l.aprovado)) { db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id); log(null, `f:${f.id}`, 'Aprovou a solicitação de pagamento (todos já estavam aprovados)'); }
  });
  const erro = await solicitarPagamento({ ...f, status: 'enviado' }, req.user, para);
  erro ? volta(res, `/fechamentos/${f.id}`, 'erro', `Enviado ao financeiro, mas o e-mail não saiu: ${erro}. Use "Reenviar e-mail" depois de corrigir.`)
    : volta(res, `/fechamentos/${f.id}`, 'ok', `Enviado ao financeiro. E-mail com o PDF enviado para ${para.join(', ')}.`);
});

// Envia e registra no histórico do fechamento. Devolve null se enviou, ou o motivo de não ter enviado.
async function enviaELoga(f, rotulo, para, msg) {
  if (!para.length) { log(null, `f:${f.id}`, `E-mail (${rotulo}) não enviado: nenhum destinatário configurado`); return 'nenhum destinatário configurado em Configurações'; }
  try {
    const r = await enviarEmail({ to: para.join(', '), ...msg });
    if (r.salvo) { log(null, `f:${f.id}`, `E-mail (${rotulo}) não enviado: servidor de e-mail não configurado (cópia salva no servidor)`); return 'servidor de e-mail não configurado em Configurações'; }
    log(null, `f:${f.id}`, `E-mail (${rotulo}) enviado para ${para.join(', ')}`);
    return null;
  } catch (e) {
    console.error(e);
    log(null, `f:${f.id}`, `E-mail (${rotulo}) falhou: ${e.message}`);
    return `falha no servidor de e-mail (${e.message})`;
  }
}

async function solicitarPagamento(f, autor, para = destinatariosPadrao(autor)) {
  const g = grade(f), url = cfg('app_url').replace(/\/$/, ''), link = url ? `${url}/fechamentos/${f.id}` : '';
  const pagar = g.linhas.filter((l) => l.total > 0), nome = f.loja.replace(/\W+/g, '_'), ref = f.pagamento || f.data_ini;
  const quem = f.pagamento ? `pagamento de ${diaLongo(f.pagamento)}` : '';
  const resumo = [['Loja', f.loja], ['Período das entregas', periodo(f)], ['Pagamento previsto', f.pagamento ? diaLongo(f.pagamento) : '—'], ['Motoboys a pagar', String(pagar.length)],
    ...(g.temOc ? [['Ocorrências do Agilizone (já no total)', `${g.totOc > 0 ? '+' : ''}${brl(g.totOc)}`]] : []), ...(g.temPago ? [['Já pago no Agilizone (descontado)', `-${brl(g.totPago)}`]] : [])];
  const td = 'padding:8px 12px;border-bottom:1px solid #e7e2df;font-size:14px;color:#140a08';
  const corpoHtml = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f8f7f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #e7e2df;border-radius:10px;overflow:hidden">
<tr><td style="border-top:6px solid #df6d2a;padding:24px 24px 8px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b6360">Grupo Forno · Pagamento de motoboys</div>
<h1 style="margin:8px 0 0;font-size:22px;color:#140a08">Solicitação de pagamento</h1></td></tr>
<tr><td style="padding:8px 24px 16px;font-size:14px;line-height:1.55;color:#140a08">Olá,<br>${esc(autor.nome)} enviou a solicitação de pagamento dos motoboys da loja <b>${esc(f.loja)}</b>${quem ? `, ${esc(quem)}` : ''}. Confira os valores e as chaves PIX e aprove no sistema.</td></tr>
<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f7;border:1px solid #e7e2df;border-radius:8px">
${resumo.map(([k, v]) => `<tr><td style="${td};color:#6b6360;width:55%">${esc(k)}</td><td style="${td};text-align:right;font-weight:bold">${esc(v)}</td></tr>`).join('')}
<tr><td style="padding:14px 12px;font-size:14px;color:#6b6360">Total a pagar</td><td style="padding:14px 12px;text-align:right;font-size:24px;font-weight:bold;color:#c2521a">${esc(brl(g.total))}</td></tr></table></td></tr>
${link ? `<tr><td style="padding:20px 24px 4px"><a href="${esc(link)}" style="display:inline-block;background:#c2521a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:8px">Abrir no sistema e aprovar</a></td></tr>` : ''}
<tr><td style="padding:20px 24px 4px;font-size:15px;font-weight:bold;color:#140a08">Anexos neste e-mail</td></tr>
<tr><td style="padding:0 24px 8px;font-size:14px;line-height:1.6;color:#140a08">1. <b>Planilha (Excel)</b>: valores por motoboy e por dia, ocorrências, chaves PIX e total.<br>2. <b>PDF</b>: a mesma solicitação para conferência e assinatura.</td></tr>
<tr><td style="padding:12px 24px 4px;font-size:15px;font-weight:bold;color:#140a08">Motoboys a pagar (${pagar.length})</td></tr>
<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e2df;border-radius:8px;border-collapse:separate">
<tr style="background:#140a08"><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold">Motoboy</td><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold">Chave PIX</td><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold;text-align:right">Total</td></tr>
${pagar.map((l, i) => `<tr style="background:${i % 2 ? '#faf8f7' : '#ffffff'}"><td style="${td}"><b>${esc(l.nome)}</b>${l.oc || l.qtdOc ? `<br><span style="font-size:12px;color:#b8501a">inclui ocorrência ${l.oc > 0 ? '+' : ''}${esc(brl(l.oc))}</span>` : ''}</td><td style="${td};word-break:break-all">${esc(l.pix || '—')}</td><td style="${td};text-align:right;font-weight:bold;white-space:nowrap">${esc(brl(l.total))}</td></tr>`).join('')}
</table></td></tr>
<tr><td style="padding:8px 24px 24px;font-size:12.5px;line-height:1.5;color:#6b6360">Aprovar no sistema não é pagar: o pagamento é feito fora do sistema, com as chaves PIX acima. Este e-mail foi enviado automaticamente pelo sistema Pagamento de motoboys.</td></tr>
</table></td></tr></table></body></html>`;
  const texto = `Olá,\n\n${autor.nome} enviou a solicitação de pagamento dos motoboys da loja ${f.loja}${quem ? `, ${quem}` : ''}.\n\n` +
    resumo.map(([k, v]) => `${k}: ${v}`).join('\n') + `\nTOTAL A PAGAR: ${brl(g.total)}\n\n` +
    'Motoboys a pagar:\n' + pagar.map((l) => `• ${l.nome}: ${brl(l.total)} · PIX ${l.pix || '—'}`).join('\n') +
    '\n\nAnexos: 1) planilha em Excel com os valores por dia; 2) PDF da solicitação.' + (link ? `\nAbrir no sistema e aprovar: ${link}` : '') +
    '\n\nAprovar no sistema não é pagar: o pagamento é feito fora do sistema.';
  return enviaELoga(f, 'solicitação', para, {
    subject: `Solicitação de pagamento · Motoboys · ${f.loja} · ${f.pagamento ? `pagamento ${dataFmt(f.pagamento)} · ` : ''}${brl(g.total)}`,
    text: texto, html: corpoHtml,
    // Os dois anexos vão juntos, na ordem: planilha e depois o PDF.
    attachments: [
      { filename: `planilha-motoboys-${nome}-${ref}.xlsx`, content: xlsxFechamento(f, g), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { filename: `solicitacao-pagamento-motoboys-${nome}-${ref}.pdf`, content: await gerarPdf(f, g), contentType: 'application/pdf' },
    ],
  });
}

app.post('/fechamentos/:fid/email', so((r) => podeReenviar(r.user, r.f)), async (req, res) => {
  const para = req.body.para != null ? destinatariosDigitados(req.body.para) : destinatariosPadrao(req.user);
  const erro = await solicitarPagamento(req.f, req.user, para);
  volta(res, `/fechamentos/${req.f.id}`, erro ? 'erro' : 'ok', erro ? `E-mail não enviado: ${erro}.` : `E-mail da solicitação de pagamento reenviado para ${para.join(', ')}.`);
});

app.get('/fechamentos/:fid/pdf', async (req, res) => {
  const g = grade(req.f);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="motoboys-${req.f.loja.replace(/\W+/g, '_')}-${req.f.data_ini}.pdf"`);
  res.send(await gerarPdf(req.f, g));
});

// ---------- Decisões do financeiro ----------
// Cada decisão confere, dentro da transação, se a tela ainda mostra a versão atual e se o fechamento aguarda análise.
// Assim um clique repetido, duas pessoas decidindo juntas ou um reenvio da loja no meio não geram decisão errada.
const recusa = (msg, url) => { throw Object.assign(falha(msg, 409), { volta: url }); };
function decisao(req) {
  const url = detalheFin(req.f, req.body.volta), f = carregaF(req.f.id);
  if (f.status !== 'enviado' || String(f.versao) !== String(req.body.versao))
    recusa(`Este fechamento mudou desde que você abriu a tela (${f.status === 'enviado' ? `a loja reenviou: agora é a versão ${f.versao}` : f.status === 'pago' ? 'já foi aprovado' : 'já foi devolvido à loja'}). Nada foi alterado. Confira e decida de novo.`, url);
  const itens = itensFin(f, grade(f));
  const uma = [].concat(req.body.uma ?? []).map(Number).find(Boolean);
  const ids = uma ? [uma] : [...new Set([].concat(req.body.m ?? []).map(Number))];
  const sel = itens.filter((i) => ids.includes(i.id));
  if (!sel.length || sel.length !== ids.length) recusa('Selecione pelo menos um entregador deste fechamento.', url);
  return { f, url, sel, itens, total: sel.reduce((t, i) => t + i.total, 0) };
}
const nomes = (xs) => xs.map((i) => i.nome).join(', ');

app.post('/fechamentos/:fid/aprovar', so((r) => decideFin(r.user)), (req, res) => {
  const r = tx(() => {
    const { f, url, sel, total } = decisao(req);
    const ja = sel.filter((i) => i.sit === 'aprovado');
    if (ja.length) recusa(`${nomes(ja)} já ${ja.length > 1 ? 'estavam aprovados' : 'estava aprovado'}. Nada foi alterado.`, url);
    const bloq = sel.filter((i) => i.bloq);
    if (bloq.length) recusa(`Não dá para aprovar ${bloq.map((i) => `${i.nome} (${i.bloq})`).join('; ')}. Os demais podem ser aprovados.`, url);
    const ins = db.prepare(`INSERT INTO aprovacoes (fechamento_id, motoboy_id, aprovado_por, valor, pix, versao) VALUES (?,?,?,?,?,?)
      ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET aprovado_por = excluded.aprovado_por, aprovado_em = datetime('now','localtime'), valor = excluded.valor, pix = excluded.pix, versao = excluded.versao`);
    for (const i of sel) ins.run(f.id, i.id, req.user.id, i.total, i.pix, f.versao);
    log(req.user.id, `f:${f.id}`, `Aprovou ${sel.length} entregador(es) da versão ${f.versao}, total ${brl(total)}: ${sel.map((i) => `${i.nome} ${brl(i.total)} (PIX ${i.pix})`).join('; ')}`);
    const faltam = grade(f).linhas.filter((l) => l.total > 0 && !l.aprovado).length;
    if (!faltam) { db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id); log(req.user.id, `f:${f.id}`, 'Aprovou a solicitação de pagamento (todos os entregadores)'); }
    return { url, n: sel.length, total, faltam, loja: f.loja };
  });
  volta(res, r.url, 'ok', r.faltam ? `${r.n} aprovado(s), ${brl(r.total)}. Faltam ${r.faltam} entregador(es).`
    : `Solicitação de ${r.loja} aprovada por completo. Lembrete: aprovar não é pagar; o pagamento é feito fora do sistema.`);
});

// Quem recebe o aviso de devolução: quem importou e os despachantes da loja.
const avisadosDevolucao = (f) => db.prepare("SELECT nome, email FROM usuarios WHERE ativo = 1 AND (id = ? OR (perfil = 'despachante' AND loja_id = ?)) ORDER BY nome").all(f.criado_por, f.loja_id);

app.post('/fechamentos/:fid/devolver', so((r) => decideFin(r.user)), async (req, res) => {
  const motivo = String(req.body.motivo || '').trim().slice(0, 2000);
  if (motivo.length < 5) recusa('Escreva o motivo da devolução (mínimo 5 caracteres). Nada foi alterado.', detalheFin(req.f, req.body.volta));
  const avisados = avisadosDevolucao(req.f), para = [...new Set(avisados.map((a) => a.email).filter(Boolean))];
  const r = tx(() => {
    const { f, url, sel, total, itens } = decisao(req);
    const apr = sel.filter((i) => i.sit === 'aprovado');
    if (apr.length) recusa(`${nomes(apr)} já foi aprovado e não pode ser devolvido. Nada foi alterado.`, url);
    const ins = db.prepare('INSERT INTO devolucoes (fechamento_id, motoboy_id, versao, valor, pix, motivo, devolvido_por, para) VALUES (?,?,?,?,?,?,?,?)');
    for (const i of sel) ins.run(f.id, i.id, f.versao, i.total, i.pix, motivo, req.user.id, avisados.map((a) => a.nome).join(', '));
    const quais = `${sel.map((i) => `${i.nome} ${brl(i.total)}`).join('; ')}. Avisados: ${avisados.map((a) => a.nome).join(', ') || 'ninguém cadastrado'}`;
    // Aprovado em parte: os aprovados ficam fechados aqui e os não aprovados vão para um novo fechamento devolvido à loja.
    const aprovados = itens.filter((i) => i.sit === 'aprovado'), resto = itens.filter((i) => i.sit !== 'aprovado').map((i) => i.id);
    let alvo = f;
    if (aprovados.length) {
      const novo = Number(db.prepare(`INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, criado_por, criado_em, arquivo, pagamento, versao, enviado_em, enviado_por, origem_id)
        SELECT loja_id, data_ini, data_fim, 'rascunho', criado_por, criado_em, arquivo, pagamento, versao, enviado_em, enviado_por, id FROM fechamentos WHERE id = ?`).run(f.id).lastInsertRowid);
      const lista = resto.map(Number).join(',') || '0';
      for (const t of ['pedidos', 'resumo', 'edicoes', 'envio_pix'])
        db.prepare(`UPDATE ${t} SET fechamento_id = ? WHERE fechamento_id = ? AND motoboy_id IN (${lista})`).run(novo, f.id);
      db.prepare(`INSERT INTO devolucoes (fechamento_id, motoboy_id, versao, valor, pix, motivo, devolvido_por, devolvido_em, para)
        SELECT ?, motoboy_id, versao, valor, pix, motivo, devolvido_por, devolvido_em, para FROM devolucoes WHERE fechamento_id = ? AND versao = ?`).run(novo, f.id, f.versao);
      db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id);
      const valorAp = aprovados.reduce((t, i) => t + i.total, 0);
      log(req.user.id, `f:${f.id}`, `Devolveu ${resto.length} entregador(es) não aprovado(s) para o fechamento #${novo}: ${motivo}`);
      log(req.user.id, `f:${f.id}`, `Aprovou a solicitação de pagamento em parte: ${aprovados.length} entregador(es), ${brl(valorAp)}`);
      log(req.user.id, `f:${novo}`, `Criado a partir do fechamento #${f.id}: entregadores não aprovados (os aprovados, ${brl(valorAp)}, ficaram no #${f.id})`);
      alvo = carregaF(novo);
    }
    db.prepare("UPDATE fechamentos SET status = 'rascunho' WHERE id = ?").run(alvo.id);
    // Descongela o PIX que veio do Agilizone (pode mudar se o Resumo for anexado de novo); o digitado continua.
    db.prepare('DELETE FROM envio_pix WHERE fechamento_id = ?1 AND motoboy_id IN (SELECT motoboy_id FROM resumo WHERE fechamento_id = ?1 AND pix IS NOT NULL)').run(alvo.id);
    log(req.user.id, `f:${alvo.id}`, `Devolveu para correção: ${motivo}`);
    log(req.user.id, `f:${alvo.id}`, `Entregadores devolvidos (versão ${f.versao}, ${brl(total)}): ${quais}`);
    return { f: alvo, url: alvo.id === f.id ? url : detalheFin(alvo, req.body.volta), sel, total, separado: alvo.id !== f.id, origem: f };
  });
  const app_url = cfg('app_url').replace(/\/$/, '');
  const erro = await enviaELoga(r.f, 'devolução', para, {
    subject: `Fechamento devolvido para correção · ${r.f.loja} · ${periodo(r.f)}`,
    text: `${req.user.nome} (financeiro) devolveu o fechamento de ${r.f.loja}, período ${periodo(r.f)}, para correção.\n\nMotivo:\n${motivo}\n\nEntregadores devolvidos:\n${r.sel.map((i) => `• ${i.nome}: ${brl(i.total)}`).join('\n')}\n\n${r.separado ? `Os entregadores já aprovados ficaram fechados no fechamento #${r.origem.id}. Este novo fechamento (#${r.f.id}) tem só os que não foram aprovados: corrija e envie de novo.` : 'Nenhum entregador tinha sido aprovado; corrija e envie de novo.'}` + (app_url ? `\n\nAbrir no sistema: ${app_url}/fechamentos/${r.f.id}` : ''),
  });
  const sep = r.separado ? ` Os aprovados ficaram fechados no #${r.origem.id}; os não aprovados estão neste novo fechamento #${r.f.id}.` : '';
  volta(res, r.url, erro ? 'erro' : 'ok', (erro ? `Devolvido à loja (${r.sel.length} entregador(es)), mas o e-mail não saiu: ${erro}. A loja vê a devolução ao entrar no sistema.`
    : `Devolvido à loja (${r.sel.length} entregador(es), ${brl(r.total)}). Aviso enviado para ${para.join(', ')}.`) + sep);
});

// Arquivar (no lugar de excluir): sai da lista, deixa de ser válido e libera os pedidos para outro fechamento. Nada é apagado.
app.post('/fechamentos/:fid/arquivar', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  tx(() => {
    db.prepare("UPDATE fechamentos SET arquivado_em = datetime('now','localtime') WHERE id = ?").run(req.f.id);
    db.prepare('UPDATE pedidos SET ativo = 0 WHERE fechamento_id = ?').run(req.f.id);
    log(req.user.id, `f:${req.f.id}`, 'Arquivou o fechamento');
  });
  volta(res, '/', 'ok', `Fechamento de ${periodo(req.f)} arquivado. Ele fica na aba Arquivados.`);
});
const podeRecuperar = (u, f) => !!f.arquivado_em && (u.perfil === 'admin' || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
app.post('/fechamentos/:fid/recuperar', so((r) => podeRecuperar(r.user, r.f)), (req, res) => {
  const f = req.f;
  // Recusa se algum pedido já entrou em outro fechamento válido depois do arquivamento.
  const conflito = db.prepare(`SELECT o.fechamento_id id, COUNT(*) n, x.data_ini, x.data_fim FROM pedidos p
    JOIN pedidos o ON o.loja_id = p.loja_id AND o.chave = p.chave AND o.ativo = 1 JOIN fechamentos x ON x.id = o.fechamento_id
    WHERE p.fechamento_id = ? GROUP BY 1`).all(f.id);
  if (conflito.length) throw falha(`Não dá para recuperar: ${conflito.map((x) => `${x.n} pedido(s) já estão no fechamento de ${periodo(x)}`).join('; ')}. Arquive esse outro antes, se for o caso.`);
  tx(() => {
    db.prepare('UPDATE fechamentos SET arquivado_em = NULL WHERE id = ?').run(f.id);
    db.prepare('UPDATE pedidos SET ativo = 1 WHERE fechamento_id = ?').run(f.id);
    log(req.user.id, `f:${f.id}`, 'Recuperou o fechamento do arquivo');
  });
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Fechamento recuperado.');
});

// Planilha do fechamento em Excel (.xlsx): valores como número (somam no Excel), uma aba com os dados e outra com o resumo.
function xlsxFechamento(f, g) {
  const R = (c) => c / 100;
  const cab = ['Motoboy', 'Chave PIX', ...g.dias.map(diaFmt), ...(g.temOc ? ['Ocorrências'] : []), ...(g.temPago ? ['Já pago'] : []), 'Total a pagar'];
  const linhas = g.linhas.map((l) => [l.nome, l.pix || '', ...g.dias.map((d) => R(l.dias[d]?.final || 0)), ...(g.temOc ? [R(l.oc)] : []), ...(g.temPago ? [R(-l.pago)] : []), R(l.total)]);
  const tot = ['TOTAL', '', ...g.dias.map((d) => R(g.totDia[d])), ...(g.temOc ? [R(g.totOc)] : []), ...(g.temPago ? [R(-g.totPago)] : []), R(g.total)];
  const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas, tot]);
  const ref = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= ref.e.r; r++) for (let c = 2; c <= ref.e.c; c++) { const cel = ws[XLSX.utils.encode_cell({ r, c })]; if (cel) { cel.t = 'n'; cel.z = '#,##0.00'; } }
  ws['!cols'] = [{ wch: 36 }, { wch: 34 }, ...Array(ref.e.c - 1).fill({ wch: 13 })];
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  const info = XLSX.utils.aoa_to_sheet([['Loja', f.loja], ['Período das entregas', periodo(f)], ['Pagamento previsto', f.pagamento ? diaLongo(f.pagamento) : '—'], ['Motoboys a pagar', g.linhas.filter((l) => l.total > 0).length],
    ['Total a pagar', R(g.total)], ...(g.temOc ? [['Ocorrências do Agilizone (já no total)', R(g.totOc)]] : []), ['Gerado em', new Date().toLocaleString('pt-BR', { timeZone: TZ })]]);
  info['!cols'] = [{ wch: 38 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pagamento'); XLSX.utils.book_append_sheet(wb, info, 'Dados do fechamento');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const nomeArquivo = (f) => `${f.loja.replace(/\W+/g, '_')}-${f.data_ini}-a-${f.data_fim}`;
app.get('/fechamentos/:fid/xlsx', (req, res) => {
  const f = req.f;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="motoboys-${nomeArquivo(f)}.xlsx"`);
  res.send(xlsxFechamento(f, grade(f)));
});

// ---------- Usuários (admin) ----------
const soAdmin = so((r) => r.user.perfil === 'admin');
app.get('/usuarios', soAdmin, (req, res) => {
  const us = db.prepare("SELECT u.*, l.nome loja FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id WHERE u.perfil <> 'motoboy' ORDER BY u.ativo DESC, u.nome").all();
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all();
  const campos = (u = {}) => html`<div class="field"><label>Nome <span class="req">*</span></label><input name="nome" required value="${u.nome}"></div>
<div class="field"><label>E-mail</label><input name="email" type="email" value="${u.email}" placeholder="nome@grupofornopaulista.com"><p class="hint">Para avisos do sistema (ex.: o despachante recebe quando o financeiro devolve um fechamento).</p></div>
<div class="fgrid"><div class="field"><label>Perfil</label><select name="perfil">${Object.entries(PERFIS).map(([k, v]) => html`<option value="${k}" ${u.perfil === k ? 'selected' : ''}>${v}</option>`)}</select></div>
<div class="field"><label>Loja</label><select name="loja"><option value="">—</option>${lojas.map((l) => html`<option value="${l.id}" ${u.loja_id === l.id ? 'selected' : ''}>${l.nome}</option>`)}</select><p class="hint">Obrigatória para despachante. No financeiro, vazia = vê todas as lojas.</p></div></div>`;
  res.send(page(req, { titulo: 'Usuários', sub: 'Quem acessa o sistema: despachantes, financeiro, gestão e TI.' }, html`<div class="split">
<div class="card"><div class="card-h"><div class="t"><h2>Equipe (${us.length})</h2><p>Clique em uma pessoa para editar.</p></div></div><div class="items">
${us.map((u) => html`<details class="fold"><summary><div class="who" style="flex:1">${avatar(u.nome)}<div><b>${u.nome}</b><div class="mut small">${u.login}${u.email ? ` · ${u.email}` : ''}</div></div></div>
<span class="badge nodot">${PERFIS[u.perfil]}${u.loja ? ` · ${u.loja}` : ''}</span>${u.ativo ? '' : html`<span class="badge bad">inativo</span>`}${icone('chevron', 'chev')}</summary>
<form method="post" action="/usuarios/${u.id}" style="margin-top:16px">${campos(u)}<div class="fgrid"><div class="field"><label>Nova senha</label><input name="senha" type="password" minlength="8" placeholder="Deixe vazio para manter" autocomplete="new-password"></div></div>
<label class="check"><input type="checkbox" name="ativo" value="1" ${u.ativo ? 'checked' : ''}> Ativo</label><button class="btn btn-pri btn-sm">${icone('check', 'sm')} Salvar</button></form></details>`)}</div></div>
<form method="post" class="card"><div class="card-h"><span class="hico pri">${icone('mais')}</span><div class="t"><h2>Novo usuário</h2></div></div><div class="card-b">
<div class="field"><label>Login <span class="req">*</span></label><input name="login" required autocapitalize="none"></div>${campos({ perfil: 'despachante' })}
<div class="field"><label>Senha inicial <span class="req">*</span></label><input name="senha" type="password" minlength="8" required autocomplete="new-password"><p class="hint">Mínimo 8 caracteres. A pessoa pode trocar em "Minha conta".</p></div></div>
<div class="card-f"><button class="btn btn-pri">${icone('mais')} Criar usuário</button></div></form></div>`));
});
function dadosUsuario(b) {
  const v = { nome: String(b.nome || '').trim(), perfil: String(b.perfil), loja_id: Number(b.loja) || null, email: String(b.email || '').trim() || null };
  if (!v.nome || !PERFIS[v.perfil]) throw falha('Dados inválidos.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) throw falha('E-mail inválido.');
  if (v.perfil === 'despachante' && !v.loja_id) throw falha('Despachante precisa ter loja.');
  if (v.loja_id && !db.prepare('SELECT 1 FROM lojas WHERE id = ?').get(v.loja_id)) throw falha('Loja inválida.');
  if (!['despachante', 'financeiro'].includes(v.perfil)) v.loja_id = null; // financeiro com loja só vê essa loja
  if (b.senha && String(b.senha).length < 8) throw falha('Senha precisa ter 8 caracteres ou mais.');
  return v;
}
app.post('/usuarios', soAdmin, (req, res) => {
  const v = dadosUsuario(req.body), login = String(req.body.login || '').trim().toLowerCase();
  if (!login || !req.body.senha) throw falha('Informe login e senha.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(login)) throw falha('Login já existe.');
  db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id, email) VALUES (?,?,?,?,?,?)').run(v.nome, login, hashSenha(String(req.body.senha)), v.perfil, v.loja_id, v.email);
  log(req.user.id, 'usuarios', `Criou usuário ${login} (${v.perfil})`);
  volta(res, '/usuarios', 'ok', 'Usuário criado.');
});
app.post('/usuarios/:id', soAdmin, (req, res) => {
  const id = Number(req.params.id), v = dadosUsuario(req.body), ativo = req.body.ativo ? 1 : 0;
  if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(id)) throw falha('Usuário não encontrado.', 404);
  if (id === req.user.id && (!ativo || v.perfil !== 'admin')) throw falha('Você não pode remover seu próprio acesso de admin.');
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, loja_id = ?, email = ?, ativo = ? WHERE id = ?').run(v.nome, v.perfil, v.loja_id, v.email, ativo, id);
  if (req.body.senha) db.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').run(hashSenha(String(req.body.senha)), id);
  if (req.body.senha || !ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  log(req.user.id, 'usuarios', `Alterou usuário #${id}${req.body.senha ? ' (senha redefinida)' : ''}`);
  volta(res, '/usuarios', 'ok', 'Salvo.');
});

// ---------- Configurações (TI) ----------
app.get('/config', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const v = (k) => cfg(k), lojas = db.prepare('SELECT l.*, (SELECT COUNT(*) FROM fechamentos WHERE loja_id = l.id) n FROM lojas l ORDER BY nome').all();
  const ultimosAlertas = db.prepare("SELECT acao, quando FROM log WHERE ref = 'alertas' ORDER BY id DESC LIMIT 15").all();
  const temSenha = !!v('smtp_pass');
  res.send(page(req, { titulo: 'Configurações', sub: 'E-mail da solicitação de pagamento e lojas. Só a TI vê esta tela.' }, html`<div class="split">
<form method="post" action="/config" class="stack">
${v('smtp_host') ? '' : html`<div class="alert warn">${icone('alerta')}<div><b>Servidor de e-mail ainda não configurado</b>Enquanto isso, os e-mails não saem: ficam salvos no servidor (pasta data/emails) e o fechamento mostra o aviso.</div></div>`}
<div class="card"><div class="card-h"><span class="hico pri">${icone('email')}</span><div class="t"><h2>Solicitação de pagamento</h2><p>Quando o despachante clica em "Enviar ao financeiro", sai um e-mail com o PDF em anexo.</p></div></div><div class="card-b">
<div class="field"><label for="email_para">Enviar para <span class="req">*</span></label><textarea id="email_para" name="email_para" style="min-height:80px" placeholder="financeiro@grupofornopaulista.com">${v('email_para')}</textarea><p class="hint">Um ou mais e-mails, um por linha ou separados por vírgula.</p></div>
<label class="check"><input type="checkbox" name="email_copia" value="1" ${v('email_copia') === '1' ? 'checked' : ''}> Enviar cópia para quem enviou o fechamento (se tiver e-mail no cadastro)</label>
<div class="field"><label for="app_url">Endereço do sistema</label><input id="app_url" name="app_url" value="${v('app_url')}" placeholder="https://motoboys.grupofornopaulista.com"><p class="hint">Vai no e-mail como link para abrir o fechamento.</p></div></div></div>

<div class="card"><div class="card-h"><span class="hico">${icone('enviar')}</span><div class="t"><h2>Conta que envia (servidor SMTP)</h2><p>O e-mail sai desta conta.</p></div></div><div class="card-b">
<details class="alert fold" style="display:block;margin-bottom:16px" ${v('smtp_host') ? '' : 'open'}><summary>${icone('info')} <b style="display:inline">Como configurar com o Google Workspace do grupo (5 minutos)</b> ${icone('chevron', 'chev')}</summary>
<ol style="margin:10px 0 0 22px;padding:0;line-height:1.7">
<li>Escolha a conta que vai enviar, ex.: <b>tecnologia@grupofornopaulista.com</b> (ou crie uma como <b>naoresponda@</b>).</li>
<li>Entre nela e ative a <b>Verificação em duas etapas</b>: myaccount.google.com → Segurança.</li>
<li>Em <b>myaccount.google.com/apppasswords</b>, crie uma senha de app chamada "Motoboys" e copie os 16 caracteres.</li>
<li>Preencha abaixo: servidor <b>smtp.gmail.com</b>, porta <b>587</b>, usuário = o e-mail da conta, senha = a senha de app.</li>
<li>Salve e use <b>Enviar teste</b>. Se a opção de senha de app não aparecer, o administrador do Google Workspace precisa liberar a verificação em duas etapas para a conta.</li></ol></details>
<div class="fgrid"><div class="field"><label for="smtp_host">Servidor</label><input id="smtp_host" name="smtp_host" value="${v('smtp_host')}" placeholder="smtp.gmail.com"></div>
<div class="field"><label for="smtp_port">Porta</label><input id="smtp_port" name="smtp_port" value="${v('smtp_port') || '587'}" inputmode="numeric"></div></div>
<div class="fgrid"><div class="field"><label for="smtp_user">Usuário</label><input id="smtp_user" name="smtp_user" value="${v('smtp_user')}" placeholder="tecnologia@grupofornopaulista.com" autocomplete="off"></div>
<div class="field"><label for="smtp_pass">Senha</label><input id="smtp_pass" name="smtp_pass" type="password" placeholder="${temSenha ? '•••••••• (mantida)' : ''}" autocomplete="new-password"><p class="hint">${temSenha ? 'Deixe vazio para manter a atual.' : 'Para Gmail, use a senha de app.'}</p></div></div>
<div class="field"><label for="smtp_from">Remetente</label><input id="smtp_from" name="smtp_from" value="${v('smtp_from')}" placeholder='Motoboys Forno Paulista <tecnologia@grupofornopaulista.com>'><p class="hint">Opcional. Se vazio, usa o usuário.</p></div></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar configurações</button></div></div></form>

<div class="stack">
<form method="post" action="/config/teste" class="card"><div class="card-h"><span class="hico">${icone('email')}</span><div class="t"><h2>Testar envio</h2><p>Manda um e-mail de teste com as configurações salvas.</p></div></div>
<div class="card-b"><div class="field" style="margin:0"><label for="teste">Para</label><input id="teste" name="para" type="email" required value="${req.user.email || listaEmails(v('email_para'))[0] || ''}"></div></div>
<div class="card-f"><button class="btn btn-sec">${icone('enviar')} Enviar teste</button></div></form>

<form method="post" action="/config/alertas" class="card" id="alertas"><div class="card-h"><span class="hico pri">${icone('relogio')}</span><div class="t"><h2>Alertas automáticos por e-mail</h2><p>Horário de Teresina. Cada alerta sai uma vez por pagamento.</p></div></div><div class="card-b">
${[['alerta_resumo', 'hora_resumo', '16:00', 'Resumo diário ao financeiro', 'Nos dias de pagamento: quais lojas já enviaram (com o total) e quais faltam. Vai para os destinatários da solicitação de pagamento.']]
    .map(([k, h, padrao, t, d]) => html`<div class="field" style="display:flex;gap:12px;align-items:flex-start"><label class="check" style="flex:1;margin:0;align-items:flex-start"><input type="checkbox" name="${k}" value="1" ${v(k) !== '0' ? 'checked' : ''} style="margin-top:3px"><span><b>${t}</b><br><span class="mut small" style="font-weight:400">${d}</span></span></label>
<input type="time" name="${h}" value="${v(h) || padrao}" aria-label="Horário: ${t}" style="width:120px"></div>`)}
${process.env.ALERTAS === '0' ? html`<div class="alert warn">${icone('alerta')}<div>Os alertas estão desligados neste servidor (variável ALERTAS=0).</div></div>` : ''}
${v('smtp_host') ? '' : html`<div class="alert warn">${icone('alerta')}<div>Sem servidor de e-mail configurado, os alertas não saem.</div></div>`}
<p class="hint">O despachante vê os avisos (amanhã, hoje, atrasado) na tela inicial do sistema.</p>
${ultimosAlertas.length ? html`<details class="fold" style="margin-top:8px"><summary class="mut small">${icone('chevron', 'chev')} Últimos alertas</summary><ul class="timeline" style="margin-top:10px">${ultimosAlertas.map((a) => html`<li>${a.acao}<small>${a.quando}</small></li>`)}</ul></details>` : ''}</div>
<div class="card-f"><button class="btn btn-sec">${icone('check')} Salvar alertas</button></div></form>

<div class="card"><div class="card-h"><span class="hico">${icone('loja')}</span><div class="t"><h2>Lojas e dias de pagamento</h2><p>O nome precisa ser <b>igual ao do Agilizone</b>. Dias de pagamento no formato <b>dia: dias de referência</b>, separados por ponto e vírgula.</p></div></div>
<div class="items">${lojas.map((l) => html`<form method="post" action="/config/lojas/${l.id}"><div class="field" style="margin-bottom:8px"><input name="nome" value="${l.nome}" required aria-label="Nome da loja"></div>
<div class="field" style="margin-bottom:6px"><input name="calendario" value="${l.calendario || AG.PADRAO}" required aria-label="Dias de pagamento de ${l.nome}"></div>
<div class="item-h" style="padding:0"><span class="mut small">${AG.textoCalendario(calendarioDa(l))} · ${l.n} fechamento(s)</span><button class="btn btn-ghost btn-sm">Salvar</button></div></form>`)}
<form method="post" action="/config/lojas" class="item-h" style="flex-wrap:nowrap"><input name="nome" required placeholder="Nova loja (nome igual ao Agilizone)" aria-label="Nova loja"><button class="btn btn-sec btn-sm">${icone('mais', 'sm')} Adicionar</button></form></div>
<div class="card-b mut small" style="border-top:1px solid var(--bd)">Exemplos: <b>seg: sex sab dom; sex: seg ter qua qui</b> (padrão) · <b>seg: sex sab dom; qua: seg ter; sex: qua qui</b> (DIRCEU)</div></div></div></div>`));
});

app.post('/config', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const b = req.body, emails = listaEmails(b.email_para);
  const invalido = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (invalido) throw falha(`E-mail inválido: ${invalido}`);
  if (b.smtp_port && !/^\d{2,5}$/.test(String(b.smtp_port).trim())) throw falha('Porta inválida.');
  const valores = { email_para: emails.join(', '), email_copia: b.email_copia ? '1' : '0', app_url: String(b.app_url || '').trim(),
    smtp_host: String(b.smtp_host || '').trim(), smtp_port: String(b.smtp_port || '').trim(), smtp_user: String(b.smtp_user || '').trim(), smtp_from: String(b.smtp_from || '').trim() };
  if (b.smtp_pass) valores.smtp_pass = String(b.smtp_pass);
  const set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  tx(() => { for (const [k, val] of Object.entries(valores)) set.run(k, val); });
  log(req.user.id, 'config', `Configurações de e-mail salvas (destinatários: ${valores.email_para || 'nenhum'}; servidor: ${valores.smtp_host || 'nenhum'}${b.smtp_pass ? '; senha alterada' : ''})`);
  volta(res, '/config', 'ok', 'Configurações salvas. Use "Enviar teste" para conferir.');
});

app.post('/config/teste', so((r) => r.user.perfil === 'admin'), async (req, res) => {
  const para = String(req.body.para || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para)) throw falha('E-mail inválido.');
  try {
    const r = await enviarEmail({ to: para, subject: 'Teste · Motoboys Forno Paulista', text: 'Se você recebeu este e-mail, o envio das solicitações de pagamento está funcionando.' });
    if (r.salvo) return volta(res, '/config', 'erro', 'O servidor de e-mail não está configurado: o teste foi salvo no servidor e não foi enviado.');
    volta(res, '/config', 'ok', `E-mail de teste enviado para ${para}. Confira a caixa de entrada (e o spam).`);
  } catch (e) {
    volta(res, '/config', 'erro', `O servidor de e-mail recusou: ${e.message}`);
  }
});

const salvaLoja = (req, res) => {
  const nome = String(req.body.nome || '').trim(), id = Number(req.params.id) || null;
  if (!nome) throw falha('Informe o nome da loja.');
  if (id && !db.prepare('SELECT 1 FROM lojas WHERE id = ?').get(id)) throw falha('Loja não encontrada.', 404);
  const dono = db.prepare('SELECT id FROM lojas WHERE nome = ?').get(nome);
  if (dono && dono.id !== id) throw falha('Já existe uma loja com esse nome.');
  let cal;
  if (req.body.calendario != null) { try { cal = AG.lerCalendario(req.body.calendario); } catch (e) { throw falha(`Calendário de pagamento inválido: ${e.message}`); } }
  if (id) db.prepare('UPDATE lojas SET nome = ?, calendario = COALESCE(?, calendario) WHERE id = ?').run(nome, cal ? String(req.body.calendario).trim() : null, id);
  else db.prepare('INSERT INTO lojas (nome, calendario) VALUES (?, ?)').run(nome, cal ? String(req.body.calendario).trim() : AG.PADRAO);
  log(req.user.id, 'config', `${id ? 'Alterou loja #' + id : 'Criou loja'} "${nome}"${cal ? ` · pagamentos: ${AG.textoCalendario(cal)}` : ''}`);
  volta(res, '/config', 'ok', 'Loja salva.');
};
app.post('/config/lojas', so((r) => r.user.perfil === 'admin'), salvaLoja);
app.post('/config/lojas/:id', so((r) => r.user.perfil === 'admin'), salvaLoja);

app.post('/config/alertas', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const b = req.body, set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  for (const h of ['hora_resumo']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b[h] || ''))) throw falha('Horário inválido.');
  tx(() => {
    set.run('alerta_resumo', b.alerta_resumo ? '1' : '0');
    set.run('hora_resumo', String(b.hora_resumo));
  });
  log(req.user.id, 'config', `Resumo diário ao financeiro: ${b.alerta_resumo ? b.hora_resumo : 'desligado'}`);
  volta(res, '/config', 'ok', 'Alertas salvos.');
});

// ---------- Alertas automáticos ----------
// Roda a cada 5 minutos. Cada alerta tem uma chave (tipo:loja:data) e sai uma vez só.
// Sem servidor de e-mail configurado, não marca como enviado: sai assim que o e-mail for configurado (no mesmo dia).
let verificando = false;
async function verificarAlertas() {
  if (verificando || process.env.ALERTAS === '0' || !cfg('smtp_host')) return;
  verificando = true;
  try {
    const { data: hoje, hora } = agora(), url = cfg('app_url').replace(/\/$/, '');
    const ligado = (k) => cfg(k) !== '0', horario = (k, p) => hora >= (cfg(k) || p);
    const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all();
    const emails = (sql, ...a) => db.prepare(`SELECT email FROM usuarios WHERE ativo = 1 AND email IS NOT NULL AND ${sql}`).all(...a).map((x) => x.email);
    const ti = emails("perfil = 'admin'");
    const link = url ? `\n\nAbrir o sistema: ${url}` : '';
    const dispara = async (chave, para, msg) => {
      if (db.prepare('SELECT 1 FROM alertas WHERE chave = ?').get(chave)) return;
      db.prepare('INSERT INTO alertas (chave) VALUES (?)').run(chave); // marca antes de enviar: nunca repete
      let resultado;
      if (!para.length) resultado = 'não enviado: nenhum destinatário com e-mail';
      else try { await enviarEmail({ to: para.join(', '), ...msg }); resultado = `enviado para ${para.join(', ')}`; } catch (e) { resultado = `falhou: ${e.message}`; }
      db.prepare('UPDATE alertas SET resultado = ? WHERE chave = ?').run(resultado, chave);
      log(null, 'alertas', `${msg.subject} → ${resultado}`);
    };

    if (ligado('alerta_resumo') && horario('hora_resumo', '16:00')) {
      const itens = agenda(lojas, hoje, hoje);
      if (itens.length) {
        const linha = (p) => { if (p.situacao !== 'enviado') return `• ${p.loja.nome}: NÃO ENVIADO${p.f ? ' (em conferência)' : ''}`;
          const f = db.prepare('SELECT f.*, l.nome loja FROM fechamentos f JOIN lojas l ON l.id = f.loja_id WHERE f.id = ?').get(p.f.id);
          return `• ${p.loja.nome}: enviado · ${brl(grade(f).total)}`; };
        const faltam = itens.filter((p) => p.situacao !== 'enviado').length;
        await dispara(`resumo:${hoje}`, listaEmails(cfg('email_para')), {
          subject: `Pagamentos de motoboys de hoje (${dataFmt(hoje)}): ${faltam ? `faltam ${faltam} loja(s)` : 'todas as lojas enviaram'}`,
          text: `Olá,\n\nSituação dos pagamentos de motoboys de hoje, ${diaLongo(hoje)}:\n\n${itens.map(linha).join('\n')}${link}`,
        });
      }
    }
  } catch (e) { console.error('alertas:', e); } finally { verificando = false; }
}
setInterval(verificarAlertas, 5 * 60e3).unref();
setTimeout(verificarAlertas, 15e3).unref();

// ---------- Erros ----------
const telaErro = (req, titulo, msg) => page(req, titulo, html`<div class="card empty" style="max-width:560px;margin:0 auto"><div class="hico warn">${icone('alerta', 'lg')}</div><h2>${msg}</h2>
<p>Se precisar de ajuda, fale com a TI.</p><div class="row" style="display:flex;gap:8px;justify-content:center"><a class="btn btn-sec" href="javascript:history.back()">${icone('voltar')} Voltar</a><a class="btn btn-pri" href="/">Ir para o início</a></div></div>`);
app.use((req, res) => res.status(404).send(telaErro(req, 'Página não encontrada', 'Página não encontrada.')));
app.use((err, req, res, next) => {
  if (err.volta) return volta(res, err.volta, 'erro', err.message); // recusa de decisão: volta para a tela com o motivo
  const grande = err instanceof multer.MulterError || err.type === 'entity.too.large';
  const msg = err.publico ? err.message : grande ? 'Arquivo ou texto grande demais, ou arquivos demais.' : 'Erro inesperado. Avise a TI.';
  if (!err.publico && !grande) console.error(err);
  res.status(err.status || (err.publico || grande ? 400 : 500)).send(telaErro(req, 'Não foi possível concluir', msg));
});

const PORT = process.env.PORT || 3080;
app.listen(PORT, process.env.HOST, () => console.log(`Pagamento Motoboys em http://localhost:${PORT}`));
