const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOADS, hashSenha, confereSenha, log, tx } = require('./db');
const { lerRelatorio, centavos } = require('./importar');
const { gerarPdf, enviarEmail, brl, diaFmt, dataFmt } = require('./relatorio');
const { Raw, html, icone, iniciais, semAcento, CSS, JS } = require('./ui');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

const PERFIS = { admin: 'TI / Admin', gestao: 'Gestão', financeiro: 'Financeiro', despachante: 'Despachante', motoboy: 'Motoboy' };
const STATUS = { rascunho: 'Em conferência', enviado: 'Aguardando pagamento', pago: 'Pago' };
const SEMANA_LONGA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const periodo = (f) => `${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`;
const diasDoPeriodo = (f) => {
  const r = [];
  for (let x = new Date(f.data_ini + 'T12:00:00Z'); x.toISOString().slice(0, 10) <= f.data_fim; x.setUTCDate(x.getUTCDate() + 1)) r.push(x.toISOString().slice(0, 10));
  return r;
};
const badgeStatus = (s) => html`<span class="badge ${s}">${STATUS[s]}</span>`;
const avatar = (nome) => html`<span class="avatar">${iniciais(nome)}</span>`;
const campoValor = (name, value, extra = '') => html`<div class="money"><span>R$</span><input name="${name}" inputmode="decimal" placeholder="0,00" value="${value}" ${new Raw(extra)}></div>`;

// ---------- Layout ----------
// o: { titulo, sub, trilha: [['Fechamentos', '/'], ['Loja']], acoes }
function page(req, o, corpo) {
  if (typeof o === 'string') o = { titulo: o };
  const u = req.user, q = req.query || {}, p = req.path;
  const aba = (href, ic, txt, on) => html`<a href="${href}" class="${on ? 'on' : ''}" title="${txt}" ${on ? new Raw('aria-current="page"') : ''}>${icone(ic)}<span class="tx">${txt}</span></a>`;
  const marca = html`<a class="brand" href="/"><span class="logo">${icone('bike', 'lg')}</span><span><b>Motoboys</b><small>Forno Paulista</small></span></a>`;
  const flash = html`${q.ok ? html`<div class="alert ok" role="status">${icone('ok')}<div>${q.ok}</div></div>` : ''}${q.erro ? html`<div class="alert bad" role="alert">${icone('erro')}<div>${q.erro}</div></div>` : ''}`;
  const emFech = p === '/' || p.startsWith('/fechamentos');
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#c2410c">
<title>${o.titulo} · Motoboys Forno Paulista</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${new Raw(CSS)}</style></head>
${u ? html`<body><header class="top"><div class="top-in">${marca}
<nav class="tabs" aria-label="Menu">${u.perfil === 'motoboy' ? aba('/', 'carteira', 'Meus pagamentos', emFech)
    : html`${aba('/', 'lista', 'Fechamentos', emFech)}${aba('/motoboys', 'pessoas', 'Motoboys', p.startsWith('/motoboys'))}${u.perfil === 'admin' ? aba('/usuarios', 'escudo', 'Usuários', p.startsWith('/usuarios')) : ''}`}</nav>
<div class="me"><a href="/senha" title="Minha conta e senha">${avatar(u.nome)}<span class="me-txt"><b>${u.nome}</b><small>${PERFIS[u.perfil]}${u.loja ? ` · ${u.loja}` : ''}</small></span></a>
<form method="post" action="/logout" class="in"><button class="icon-btn" title="Sair" aria-label="Sair">${icone('sair')}</button></form></div></div></header>
<main class="wrap">
${o.trilha?.length ? html`<nav class="crumbs" aria-label="Caminho">${o.trilha.map(([t, h], i) => html`${i ? icone('chevron', 'sm') : ''}${h ? html`<a href="${h}">${t}</a>` : html`<span>${t}</span>`}`)}</nav>` : ''}
<div class="ph"><div><h1>${o.titulo}</h1>${o.sub ? html`<p class="sub">${o.sub}</p>` : ''}</div>${o.acoes ? html`<div class="ph-actions">${o.acoes}</div>` : ''}</div>
${flash}${corpo}</main>`
    : html`<body class="auth"><main class="auth-box">${marca}${flash}${corpo}</main>`}
<script>${new Raw(JS)}</script></body></html>`.s;
}
const volta = (res, url, chave, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${chave}=${encodeURIComponent(msg)}`);
const falha = (msg, status = 400) => Object.assign(new Error(msg), { publico: true, status });

// ---------- Login / sessão ----------
const tentativas = new Map(); // ponytail: em memória, zera ao reiniciar; suficiente para uma instância
app.get('/login', (req, res) => res.send(page(req, 'Entrar', html`<form method="post" class="card card-b">
<h1 style="font-size:20px">Entrar</h1><p class="mut small" style="margin:4px 0 18px">Use o login e a senha que a TI ou o despachante passou para você.</p>
<div class="field"><label for="login">Login</label><input id="login" name="login" required autofocus autocomplete="username" autocapitalize="none"></div>
<div class="field"><label for="senha">Senha</label><input id="senha" name="senha" type="password" required autocomplete="current-password"></div>
<button class="btn btn-pri btn-lg btn-block">Entrar ${icone('seta')}</button>
<p class="mut small" style="margin-top:14px;text-align:center">Esqueceu a senha? Fale com o despachante da sua loja ou com a TI.</p></form>`)));
app.post('/login', (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const t = tentativas.get(login);
  if (t && t.n >= 5 && t.ate > Date.now()) return volta(res, '/login', 'erro', 'Muitas tentativas. Aguarde 15 minutos.');
  const u = db.prepare('SELECT * FROM usuarios WHERE login = ? AND ativo = 1').get(login);
  if (!u || !confereSenha(String(req.body.senha || ''), u.senha)) {
    tentativas.set(login, { n: (t && t.ate > Date.now() ? t.n : 0) + 1, ate: Date.now() + 15 * 60e3 });
    return volta(res, '/login', 'erro', 'Login ou senha inválidos.');
  }
  tentativas.delete(login);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessoes WHERE expira < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes VALUES (?,?,?)').run(token, u.id, Date.now() + 12 * 3600e3);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 12 * 3600e3 });
  res.redirect('/');
});

app.use((req, res, next) => {
  const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  if (sid) req.user = db.prepare('SELECT u.*, l.nome loja FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN lojas l ON l.id = u.loja_id WHERE s.token = ? AND s.expira > ? AND u.ativo = 1').get(sid, Date.now());
  if (!req.user) return res.redirect('/login');
  req.sid = sid;
  // Motoboy só acessa as próprias telas (lista explícita: nada de planilhas, evidências ou cadastros).
  if (req.user.perfil === 'motoboy' && !/^\/(senha|logout|fechamentos\/\d+(\/reclamar)?)?$/.test(req.path)) return next(falha('Sem permissão.', 403));
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
const participa = (fid, mid) => !!db.prepare('SELECT 1 FROM pedidos WHERE fechamento_id = ?1 AND motoboy_id = ?2 UNION SELECT 1 FROM ajustes WHERE fechamento_id = ?1 AND motoboy_id = ?2').get(fid, mid);
const podeVer = (u, f) => veTudo(u) || (u.perfil === 'despachante' && u.loja_id === f.loja_id) || (u.perfil === 'motoboy' && participa(f.id, u.motoboy_id));
const podeEditar = (u, f) => f.status === 'rascunho' && (u.perfil === 'admin' || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const podePagar = (u, f) => f.status === 'enviado' && ['admin', 'financeiro'].includes(u.perfil);
const editaMotoboy = (u) => ['admin', 'despachante'].includes(u.perfil);
const so = (cond) => (req, res, next) => (cond(req) ? next() : next(falha('Sem permissão para esta ação.', 403)));

app.param('fid', (req, res, next, id) => {
  const f = db.prepare('SELECT f.*, l.nome loja, u.nome autor FROM fechamentos f JOIN lojas l ON l.id = f.loja_id LEFT JOIN usuarios u ON u.id = f.criado_por WHERE f.id = ?').get(Number(id));
  if (!f || !podeVer(req.user, f)) return next(falha('Fechamento não encontrado.', 404));
  req.f = f;
  next();
});

// ---------- Cálculo ----------
// Valor por motoboy/dia = soma da "Taxa do Entregador" dos pedidos; um ajuste (divergência) substitui o valor do dia.
function grade(f) {
  const cels = new Map(), dias = new Set();
  const cel = (m, d) => {
    dias.add(d);
    if (!cels.has(m)) cels.set(m, {});
    return (cels.get(m)[d] ??= { agil: 0, n: 0, final: 0 });
  };
  for (const p of db.prepare('SELECT motoboy_id m, dia, SUM(taxa) v, COUNT(*) n FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NOT NULL GROUP BY 1, 2').all(f.id))
    Object.assign(cel(p.m, p.dia), { agil: p.v, final: p.v, n: p.n });
  for (const a of db.prepare('SELECT * FROM ajustes WHERE fechamento_id = ?').all(f.id))
    Object.assign(cel(a.motoboy_id, a.dia), { final: a.valor_final, ajuste: a });
  const pagos = new Map(db.prepare('SELECT * FROM pagamentos WHERE fechamento_id = ?').all(f.id).map((p) => [p.motoboy_id, p]));
  const ids = [...cels.keys()];
  const linhas = db.prepare(`SELECT id, nome, pix FROM motoboys WHERE id IN (${ids.map(Number).join(',') || 0}) ORDER BY nome`).all()
    .map((m) => {
      const c = cels.get(m.id);
      return { ...m, dias: c, total: Object.values(c).reduce((s, x) => s + x.final, 0), pago: pagos.get(m.id) };
    });
  const diasArr = [...dias].sort();
  const totDia = Object.fromEntries(diasArr.map((d) => [d, linhas.reduce((s, l) => s + (l.dias[d]?.final || 0), 0)]));
  return { dias: diasArr, linhas, totDia, total: linhas.reduce((s, l) => s + l.total, 0) };
}

// ---------- Fechamentos ----------
const COMO_EXPORTAR = html`<div class="passos">
<div class="passo"><span class="n">1</span><p>No <b>Agilizone</b>, escolha a loja e abra <b>Relatório de Pedidos</b>.</p></div>
<div class="passo"><span class="n">2</span><p>Preencha <b>Data inicial</b> e <b>Data final</b> do período a pagar e clique em <b>Aplicar filtros</b>.</p></div>
<div class="passo"><span class="n">3</span><p>Clique em <b>Exportar Pedidos</b> e envie o arquivo <b>.xlsx</b> aqui.</p></div></div>`;

function telaMotoboyInicio(req, res) {
  const u = req.user;
  const meus = db.prepare(`SELECT f.*, l.nome loja FROM fechamentos f JOIN lojas l ON l.id = f.loja_id WHERE f.id IN
    (SELECT fechamento_id FROM pedidos WHERE motoboy_id = ?1 UNION SELECT fechamento_id FROM ajustes WHERE motoboy_id = ?1) ORDER BY f.data_fim DESC LIMIT 100`).all(u.motoboy_id);
  res.send(page(req, { titulo: 'Meus pagamentos', sub: `Olá, ${u.nome.split(' ')[0]}! Toque em um período para ver quanto deu em cada dia.` },
    meus.length ? html`<div class="card items" style="max-width:720px;padding:0">${meus.map((f) => {
      const l = grade(f).linhas.find((x) => x.id === u.motoboy_id);
      return html`<a class="mcard" href="/fechamentos/${f.id}"><span class="hico ${l?.pago ? 'ok' : 'pri'}">${icone(l?.pago ? 'check' : 'carteira')}</span>
<span style="flex:1;min-width:0"><b>${periodo(f)}</b><br><span class="mut small">${f.loja}</span><br>${l?.pago ? html`<span class="badge pago">Pago em ${l.pago.pago_em.slice(0, 10).split('-').reverse().join('/')}</span>` : badgeStatus(f.status)}</span>
<span class="v">${brl(l?.total || 0)}</span>${icone('chevron')}</a>`;
    })}</div>`
      : html`<div class="card empty"><div class="hico pri">${icone('carteira', 'lg')}</div><h2>Nenhum pagamento ainda</h2><p>Quando o despachante importar as entregas do período, seus valores aparecem aqui.</p></div>`));
}

app.get('/', (req, res) => {
  const u = req.user;
  if (u.perfil === 'motoboy') return telaMotoboyInicio(req, res);
  const todos = db.prepare(`SELECT f.*, l.nome loja, u.nome autor FROM fechamentos f JOIN lojas l ON l.id = f.loja_id LEFT JOIN usuarios u ON u.id = f.criado_por
    WHERE ? OR f.loja_id = ? ORDER BY f.data_fim DESC, f.id DESC LIMIT 200`).all(veTudo(u) ? 1 : 0, u.loja_id ?? -1)
    .map((f) => { const g = grade(f); return { ...f, total: g.total, n: g.linhas.length }; });
  const filtro = ['rascunho', 'enviado', 'pago'].includes(req.query.s) ? req.query.s : '';
  const lista = filtro ? todos.filter((f) => f.status === filtro) : todos;
  const conta = (s) => todos.filter((f) => f.status === s);
  const soma = (fs_) => fs_.reduce((s, f) => s + f.total, 0);
  const mes = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const sub = { despachante: `Importe o relatório do Agilizone, confira os valores e envie ao financeiro.`, financeiro: 'Fechamentos enviados pelas lojas para pagamento dos motoboys.', gestao: 'Acompanhe os pagamentos de motoboys de todas as lojas.', admin: 'Pagamentos de motoboys de todas as lojas.' }[u.perfil];
  const seg = (s, txt, n) => html`<a href="/${s ? `?s=${s}` : ''}" class="${filtro === s ? 'on' : ''}">${txt}<span class="c">${n}</span></a>`;

  res.send(page(req, { titulo: 'Fechamentos', sub, acoes: editaMotoboy(u) ? html`<a class="btn btn-pri" href="/fechamentos/novo">${icone('mais')} Novo fechamento</a>` : '' },
    todos.length ? html`
<div class="stats">
<div class="card stat"><span class="hico warn">${icone('lapis')}</span><div><div class="v">${conta('rascunho').length}</div><div class="l">Em conferência nas lojas</div></div></div>
<div class="card stat"><span class="hico info">${icone('relogio')}</span><div><div class="v">${brl(soma(conta('enviado')))}</div><div class="l">${conta('enviado').length} aguardando pagamento</div></div></div>
<div class="card stat"><span class="hico ok">${icone('check')}</span><div><div class="v">${brl(soma(conta('pago').filter((f) => f.data_fim >= mes)))}</div><div class="l">Pago nos últimos 30 dias</div></div></div></div>
${['financeiro', 'admin'].includes(u.perfil) && conta('enviado').length ? html`<div class="alert warn">${icone('alerta')}<div><b>${conta('enviado').length} fechamento(s) aguardando pagamento</b>Abra cada um, pague pelo PIX e marque como pago. <a href="/?s=enviado">Ver só esses</a></div></div>` : ''}
<div class="card"><div class="card-h"><div class="t"><h2>Todos os fechamentos</h2><p>Clique em uma linha para abrir.</p></div>
<nav class="seg" aria-label="Filtrar por situação">${seg('', 'Todos', todos.length)}${seg('rascunho', 'Em conferência', conta('rascunho').length)}${seg('enviado', 'Aguardando pagamento', conta('enviado').length)}${seg('pago', 'Pagos', conta('pago').length)}</nav></div>
<div class="tw"><table><tr><th>Loja</th><th>Período</th><th>Situação</th><th class="n">Motoboys</th><th class="n">Total</th><th></th></tr>
${lista.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td><b>${f.loja}</b></td><td>${periodo(f)}<div class="mut small">por ${f.autor}</div></td><td>${badgeStatus(f.status)}</td>
<td class="n">${f.n}</td><td class="n b">${brl(f.total)}</td><td class="n"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir ${icone('chevron', 'sm')}</a></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="6" class="mut" style="text-align:center;padding:32px">Nenhum fechamento nesta situação.</td></tr>`}</table></div></div>`
      : html`<div class="card empty"><div class="hico pri">${icone('lista', 'lg')}</div><h2>Nenhum fechamento ainda</h2>
<p>${editaMotoboy(u) ? 'Comece importando o relatório de pedidos do Agilizone. O sistema calcula sozinho quanto cada motoboy recebe por dia.' : 'Quando as lojas importarem os relatórios do Agilizone, os fechamentos aparecem aqui.'}</p>
${editaMotoboy(u) ? html`<div style="max-width:820px;margin:0 auto 20px">${COMO_EXPORTAR}</div><a class="btn btn-pri btn-lg" href="/fechamentos/novo">${icone('subir')} Importar primeiro relatório</a>` : ''}</div>`));
});

app.get('/fechamentos/novo', so((r) => editaMotoboy(r.user)), (req, res) => res.send(page(req, {
  titulo: 'Novo fechamento', sub: 'Envie o relatório do Agilizone. O sistema identifica a loja e o período sozinho.', trilha: [['Fechamentos', '/'], ['Novo fechamento']],
}, html`<div class="split">
<form method="post" enctype="multipart/form-data" class="card"><div class="card-b">
<label class="drop">${icone('subir', 'lg')}<b>Clique para escolher o arquivo</b><span class="small">ou arraste aqui o .xlsx exportado do Agilizone</span><span class="fname"></span>
<input type="file" name="arquivo" accept=".xlsx,.xls" required aria-label="Relatório de Pedidos (.xlsx)"></label>
<p class="hint">Pedidos que já estão em outro fechamento são ignorados automaticamente, para ninguém receber duas vezes.</p></div>
<div class="card-f"><button class="btn btn-pri">${icone('subir')} Importar relatório</button><a class="btn btn-ghost" href="/">Cancelar</a></div></form>
<div class="card"><div class="card-h"><span class="hico info">${icone('info')}</span><div class="t"><h2>Como exportar do Agilizone</h2></div></div><div class="card-b">${COMO_EXPORTAR}</div></div></div>`)));

const umArquivo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20e6, files: 1 } }).single('arquivo');
app.post('/fechamentos/novo', so((r) => editaMotoboy(r.user)), umArquivo, (req, res) => {
  if (!req.file) throw falha('Escolha o arquivo.');
  const { loja, pedidos } = lerRelatorio(req.file.buffer);
  let l = db.prepare('SELECT * FROM lojas WHERE nome = ?').get(loja);
  if (!l && req.user.perfil === 'admin') l = { id: Number(db.prepare('INSERT INTO lojas (nome) VALUES (?)').run(loja).lastInsertRowid) };
  if (!l) throw falha(`A loja "${loja}" não está cadastrada. Peça para a TI cadastrar.`);
  if (req.user.perfil === 'despachante' && req.user.loja_id !== l.id) throw falha(`Este arquivo é da loja "${loja}", que não é a sua.`, 403);

  const r = tx(() => {
    const fid = Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, criado_por, arquivo) VALUES (?, '', '', ?, ?)")
      .run(l.id, req.user.id, req.file.originalname).lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO pedidos (fechamento_id, loja_id, chave, numero, dia, entregador, motoboy_id, taxa, status)
      VALUES (?,?,?,?,?,?,(SELECT motoboy_id FROM apelidos WHERE loja_id = ? AND nome = ?),?,?)`);
    let novos = 0;
    for (const p of pedidos) novos += Number(ins.run(fid, l.id, p.chave, p.numero, p.dia, p.entregador, l.id, p.entregador, p.taxa, p.status).changes);
    if (!novos) throw falha('Todos os pedidos deste arquivo já estão em outro fechamento. Nada foi importado.');
    db.prepare('UPDATE fechamentos SET data_ini = (SELECT MIN(dia) FROM pedidos WHERE fechamento_id = ?1), data_fim = (SELECT MAX(dia) FROM pedidos WHERE fechamento_id = ?1) WHERE id = ?1').run(fid);
    log(req.user.id, `f:${fid}`, `Importou ${req.file.originalname}: ${novos} pedidos` + (novos < pedidos.length ? ` (${pedidos.length - novos} ignorados por já estarem em outro fechamento)` : ''));
    return { fid, ignorados: pedidos.length - novos };
  });
  r.ignorados ? volta(res, `/fechamentos/${r.fid}`, 'erro', `${r.ignorados} pedido(s) ignorado(s) porque já estão em outro fechamento.`)
    : volta(res, `/fechamentos/${r.fid}`, 'ok', 'Relatório importado. Agora confira os valores.');
});

const naoMapeados = (f) => db.prepare('SELECT entregador, COUNT(*) n, SUM(taxa) v FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NULL AND entregador IS NOT NULL GROUP BY 1 ORDER BY 1').all(f.id);
const normaliza = (s) => semAcento(s).split(/\s+/).filter(Boolean);
function sugestao(nome, motoboys) {
  const p = normaliza(nome);
  const c = motoboys.filter((m) => { const w = normaliza(m.nome); return p.every((x) => w.includes(x)); });
  return c.length === 1 ? c[0].id : null;
}

const reclamacoesAbertas = (f) => db.prepare("SELECT r.*, m.nome FROM reclamacoes r JOIN motoboys m ON m.id = r.motoboy_id WHERE r.fechamento_id = ? AND r.status = 'aberta' ORDER BY m.nome, r.dia").all(f.id);
const ajustesDetalhados = (f, g) => db.prepare(`SELECT a.*, m.nome motoboy, u.nome autor, (SELECT COUNT(*) FROM evidencias WHERE ajuste_id = a.id) evidencias
  FROM ajustes a JOIN motoboys m ON m.id = a.motoboy_id LEFT JOIN usuarios u ON u.id = a.criado_por WHERE a.fechamento_id = ? ORDER BY m.nome, a.dia`).all(f.id)
  .map((a) => ({ ...a, agil: g.linhas.find((l) => l.id === a.motoboy_id)?.dias[a.dia]?.agil ?? 0 }));
const diferenca = (v) => html`<span class="${v > 0 ? 'ok-t' : v < 0 ? 'bad-t' : 'mut'} b">(${v > 0 ? '+' : ''}${brl(v)})</span>`;

function telaMotoboy(req, res) {
  const f = req.f, mid = req.user.motoboy_id, g = grade(f), l = g.linhas.find((x) => x.id === mid);
  const recs = new Map(db.prepare('SELECT * FROM reclamacoes WHERE fechamento_id = ? AND motoboy_id = ?').all(f.id, mid).map((r) => [r.dia, r]));
  const dias = diasDoPeriodo(f), aberto = f.status === 'rascunho';
  const entregas = Object.values(l?.dias || {}).reduce((s, c) => s + c.n, 0);
  res.send(page(req, { titulo: periodo(f), sub: f.loja, trilha: [['Meus pagamentos', '/'], [periodo(f)]] }, html`<div class="stack" style="max-width:680px">
<div class="card hero"><div class="l">${l?.pago ? 'Você recebeu' : 'Você vai receber'}</div><div class="v">${brl(l?.total || 0)}</div>
${l?.pago ? html`<span class="badge pago">Pago em ${l.pago.pago_em.slice(0, 10).split('-').reverse().join('/')} · PIX ${l.pago.pix}</span>` : badgeStatus(f.status)}
<p class="mut small" style="margin-top:10px">${entregas} entregas no período</p></div>

<div class="card"><div class="card-h"><span class="hico">${icone('calendario')}</span><div class="t"><h2>Valor por dia</h2><p>Pelo Agilizone: soma das taxas das suas entregas.</p></div></div>
<div class="dlist">${dias.map((d) => { const c = l?.dias[d], r = recs.get(d), dt = new Date(d + 'T12:00:00Z'); return html`<div>
<div class="dd"><b>${d.slice(8, 10)}</b><small>${SEMANA_LONGA[dt.getUTCDay()].slice(0, 3)}</small></div>
<div style="flex:1;min-width:0"><div class="small mut">${c?.n || 0} entregas · Pelo Agilizone ${brl(c?.agil || 0)}</div>
${c?.ajuste ? html`<span class="badge div nodot">Valor corrigido pelo despachante</span><div class="quote">${c.ajuste.justificativa}</div>` : ''}
${r ? html`<div style="margin-top:6px"><span class="badge ${r.status === 'aberta' ? 'warn' : 'ok'}">Você informou ${brl(r.valor)} · ${r.status === 'aberta' ? 'aguardando despachante' : 'analisado'}</span></div>` : ''}</div>
<div class="v">${brl(c?.final || 0)}</div></div>`; })}</div></div>

${aberto ? html`<form method="post" action="/fechamentos/${f.id}/reclamar" class="card"><div class="card-h"><span class="hico warn">${icone('balao')}</span><div class="t"><h2>Algum dia não bate?</h2><p>Avise o despachante. Ele confere no Agilizone e corrige se for o caso.</p></div></div>
<div class="card-b"><div class="field"><label for="d">Dia</label><select id="d" name="d" required>${dias.map((d) => html`<option value="${d}">${diaFmt(d)}</option>`)}</select></div>
<div class="field"><label for="valor">Quanto deu, pelas suas contas?</label>${campoValor('valor', '', 'id="valor" required')}</div>
<div class="field"><label for="obs">O que aconteceu?</label><textarea id="obs" name="obs" required minlength="5" placeholder="Ex.: faltou a entrega do pedido 0280, cliente da Rua X"></textarea></div></div>
<div class="card-f"><button class="btn btn-pri btn-block">${icone('enviar')} Enviar para o despachante</button></div></form>`
    : html`<div class="alert">${icone('info')}<div>Este período já foi conferido e enviado ao financeiro. Dúvidas? Fale com o despachante da loja.</div></div>`}</div>`));
}

app.post('/fechamentos/:fid/reclamar', so((r) => r.user.perfil === 'motoboy' && r.f.status === 'rascunho'), (req, res) => {
  const f = req.f, mid = req.user.motoboy_id, d = String(req.body.d || ''), valor = centavos(req.body.valor), obs = String(req.body.obs || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < f.data_ini || d > f.data_fim) throw falha('Dia inválido.');
  if (Number.isNaN(valor) || valor < 0) throw falha('Valor inválido. Use o formato 152,00.');
  if (obs.length < 5) throw falha('Explique o que aconteceu.');
  db.prepare(`INSERT INTO reclamacoes (fechamento_id, motoboy_id, dia, valor, obs) VALUES (?,?,?,?,?) ON CONFLICT (fechamento_id, motoboy_id, dia)
    DO UPDATE SET valor = excluded.valor, obs = excluded.obs, status = 'aberta', criado_em = datetime('now','localtime')`).run(f.id, mid, d, valor, obs);
  log(req.user.id, `f:${f.id}`, `Motoboy informou ${brl(valor)} em ${diaFmt(d)}: ${obs}`);
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Enviado. O despachante vai conferir.');
});

app.get('/fechamentos/:fid', (req, res) => {
  if (req.user.perfil === 'motoboy') return telaMotoboy(req, res);
  const f = req.f, u = req.user, g = grade(f), edita = podeEditar(u, f), paga = podePagar(u, f);
  const nm = naoMapeados(f), recs = reclamacoesAbertas(f);
  const motoboys = db.prepare('SELECT id, nome FROM motoboys WHERE ativo = 1 ORDER BY nome').all();
  const semEnt = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(taxa),0) v FROM pedidos WHERE fechamento_id = ? AND entregador IS NULL').get(f.id);
  const cancel = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(taxa),0) v FROM pedidos WHERE fechamento_id = ? AND status = 'Cancelado' AND entregador IS NOT NULL").get(f.id);
  const entregas = db.prepare('SELECT COUNT(*) n FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NOT NULL').get(f.id).n;
  const ajustes = ajustesDetalhados(f, g);
  const evid = db.prepare('SELECT id, nome FROM evidencias WHERE ajuste_id = ?');
  const hist = db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`f:${f.id}`);
  const semPix = g.linhas.filter((l) => l.total > 0 && !l.pix);
  const mostraPago = f.status !== 'rascunho';
  const comLogin = new Set(db.prepare("SELECT motoboy_id FROM usuarios WHERE perfil = 'motoboy' AND ativo = 1").all().map((x) => x.motoboy_id));
  const nDiv = (l) => Object.values(l.dias).filter((c) => c.ajuste).length;
  const comDiv = g.linhas.filter((l) => nDiv(l)).length;
  const aPagar = g.linhas.filter((l) => l.total > 0), pagos = aPagar.filter((l) => l.pago).length;

  // Etapas do fluxo e o que fazer agora, conforme status e perfil.
  const etapa = { rascunho: 1, enviado: 2, pago: 4 }[f.status];
  const bloqueios = [
    nm.length && [`Identifique ${nm.length} entregador(es) do Agilizone`, '#identificar'],
    recs.length && [`Confira ${recs.length} valor(es) informado(s) pelos motoboys`, '#informados'],
    semPix.length && [`Cadastre a chave PIX de ${semPix.length} motoboy(s)`, '#pix'],
  ].filter(Boolean);

  let proximo;
  if (f.status === 'rascunho' && edita) proximo = html`<div class="next"><span class="hico pri">${icone(bloqueios.length ? 'lista' : 'enviar')}</span><div class="t">
${bloqueios.length ? html`<b>Antes de enviar ao financeiro, falta:</b><ul>${bloqueios.map(([t, h]) => html`<li>${icone('alerta', 'sm')}<a href="${h}">${t}</a></li>`)}</ul>`
      : html`<b>Tudo pronto para enviar.</b><p>Confira os valores abaixo. Se algum motoboy disse que o valor está diferente, clique em <b>Registrar divergência</b> na linha dele.</p>`}</div>
<form method="post" action="/fechamentos/${f.id}/enviar" class="in" onsubmit="return confirm('Enviar ao financeiro? Depois disso só o financeiro pode devolver para correção.')">
<button class="btn btn-pri btn-lg" ${bloqueios.length ? new Raw('disabled title="Resolva as pendências ao lado"') : ''}>${icone('enviar')} Enviar ao financeiro</button></form></div>`;
  else if (f.status === 'rascunho') proximo = html`<div class="next wait"><span class="hico">${icone('relogio')}</span><div class="t"><b>Aguardando a conferência do despachante da loja.</b><p>Quando ele enviar, o financeiro recebe um e-mail com o PDF.</p></div></div>`;
  else if (f.status === 'enviado') proximo = html`<div class="next ${paga ? '' : 'wait'}"><span class="hico ${paga ? 'pri' : ''}">${icone(paga ? 'carteira' : 'relogio')}</span><div class="t">
<b>${paga ? 'Pague cada motoboy pelo PIX e clique em "Marcar pago".' : 'Aguardando pagamento pelo financeiro.'}</b><p>${pagos} de ${aPagar.length} motoboys pagos.</p>
<div class="progress"><i style="width:${aPagar.length ? Math.round((pagos / aPagar.length) * 100) : 0}%"></i></div></div></div>`;
  else proximo = html`<div class="next done"><span class="hico ok">${icone('check')}</span><div class="t"><b>Fechamento concluído: todos os motoboys foram pagos.</b><p>O comprovante de cada pagamento fica no histórico abaixo.</p></div></div>`;

  const titulo = `${f.loja}`;
  res.send(page(req, {
    titulo, sub: html`${icone('calendario', 'sm')} ${periodo(f)} · importado por ${f.autor} em ${f.criado_em.slice(0, 16)}`,
    trilha: [['Fechamentos', '/'], [`${f.loja} · ${periodo(f)}`]],
    acoes: html`<a class="btn btn-sec" href="/fechamentos/${f.id}/pdf" target="_blank">${icone('arquivo')} Ver PDF</a><a class="btn btn-sec" href="/fechamentos/${f.id}/csv">${icone('baixar')} Planilha</a>`,
  }, html`
<ol class="stepper" aria-label="Etapas">${['Importado', 'Conferência', 'Pagamento', 'Pago'].map((t, i) => {
    const feito = i < etapa || f.status === 'pago', atual = !feito && i === etapa;
    return html`<li class="${feito ? 'feito' : atual ? 'atual' : ''}" ${atual ? new Raw('aria-current="step"') : ''}><span class="dot">${feito ? icone('check', 'sm') : i + 1}</span><span class="lb">${t}</span></li>`; })}</ol>
${proximo}

<div class="stats">
<div class="card stat hero"><span class="hico pri">${icone('carteira')}</span><div><div class="v">${brl(g.total)}</div><div class="l">Total a pagar</div></div></div>
<div class="card stat"><span class="hico">${icone('pessoas')}</span><div><div class="v">${g.linhas.length}</div><div class="l">Motoboys</div></div></div>
<div class="card stat"><span class="hico">${icone('pacote')}</span><div><div class="v">${entregas}</div><div class="l">Entregas no Agilizone</div></div></div>
<div class="card stat"><span class="hico ${ajustes.length ? 'warn' : ''}">${icone('lapis')}</span><div><div class="v">${ajustes.length}</div><div class="l">Divergências registradas</div></div></div></div>

${nm.length ? html`<div class="card warn" id="identificar" style="margin-bottom:20px"><div class="card-h"><span class="hico warn">${icone('link')}</span><div class="t"><h2>Identificar entregadores</h2>
<p>Estes nomes do Agilizone ainda não estão ligados a um motoboy cadastrado. Só precisa fazer uma vez por loja: nas próximas importações o sistema já reconhece.</p></div></div>
${edita ? html`<form method="post" action="/fechamentos/${f.id}/mapear"><div class="tw"><table><tr><th>Nome no Agilizone</th><th class="n">Entregas</th><th class="n">Taxas</th><th>É o motoboy…</th></tr>
${nm.map((x, i) => { const s = sugestao(x.entregador, motoboys); return html`<tr><td><b>${x.entregador}</b><input type="hidden" name="n${i}" value="${x.entregador}"></td><td class="n">${x.n}</td><td class="n">${brl(x.v)}</td>
<td style="min-width:260px"><select name="m${i}" required aria-label="Motoboy para ${x.entregador}"><option value="">Escolha…</option><option value="novo">+ É um motoboy novo: cadastrar "${x.entregador}"</option>
${motoboys.map((m) => html`<option value="${m.id}" ${m.id === s ? 'selected' : ''}>${m.nome}</option>`)}</select></td></tr>`; })}
</table></div><div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar identificação</button></div></form>`
      : html`<div class="card-b chips">${nm.map((x) => html`<span class="badge warn">${x.entregador} · ${brl(x.v)}</span>`)}</div>`}</div>` : ''}

${recs.length ? html`<div class="card warn" id="informados" style="margin-bottom:20px"><div class="card-h"><span class="hico warn">${icone('balao')}</span><div class="t">
<h2>Motoboys informaram valores diferentes (${recs.length})</h2><p>Confira no Agilizone. Se o motoboy estiver certo, ajuste o valor; se não, mantenha e explique na justificativa.</p></div></div>
<div class="items">${recs.map((r) => html`<div><div class="item-h"><div class="who">${avatar(r.nome)}<div><b>${r.nome}</b><div class="mut small">${diaFmt(r.dia)}</div></div></div>
<div class="flow">Agilizone <b>${brl(g.linhas.find((l) => l.id === r.motoboy_id)?.dias[r.dia]?.agil ?? 0)}</b> · motoboy diz <b class="warn-t">${brl(r.valor)}</b></div>
${edita ? html`<a class="btn btn-pri btn-sm" href="/fechamentos/${f.id}/ajuste?m=${r.motoboy_id}&d=${r.dia}">Conferir ${icone('seta', 'sm')}</a>` : ''}</div><div class="quote">${r.obs}</div></div>`)}</div></div>` : ''}

${semPix.length ? html`<div class="alert warn" id="pix">${icone('alerta')}<div><b>${semPix.length} motoboy(s) sem chave PIX</b>
<div class="chips" style="margin-top:8px">${semPix.map((l) => html`<a class="badge warn" href="/motoboys/${l.id}">${l.nome}</a>`)}</div></div></div>` : ''}
${semEnt.n ? html`<div class="alert">${icone('info')}<div><b>${semEnt.n} pedido(s) sem entregador no Agilizone</b>${brl(semEnt.v)} em taxas que não entram no pagamento.</div></div>` : ''}
${cancel.n ? html`<div class="alert">${icone('info')}<div><b>${cancel.n} pedido(s) cancelado(s) estão incluídos (${brl(cancel.v)})</b>Igual ao "Resumo de entregas por entregador" do Agilizone. Se algum não deve ser pago, registre uma divergência.</div></div>` : ''}

<div class="card" id="valores"><div class="card-h"><span class="hico pri">${icone('calendario')}</span><div class="t"><h2>Valores por dia</h2>
<p>Soma da taxa do entregador no Agilizone.${edita ? ' Clique em um valor ou em "Registrar divergência" para corrigir.' : ''}</p></div>
<div class="search">${icone('busca', 'sm')}<input type="search" placeholder="Buscar motoboy" data-filtro="#grade" aria-label="Buscar motoboy"></div></div>
<div class="card-b" style="display:flex;gap:12px 20px;flex-wrap:wrap;align-items:center;padding-top:14px;padding-bottom:14px;border-bottom:1px solid var(--bd)">
<div class="seg" data-div-filtro="#grade" role="group" aria-label="Filtrar divergências">
<button type="button" data-f="todos" class="on" aria-pressed="true">Todos<span class="c">${g.linhas.length}</span></button>
<button type="button" data-f="com" aria-pressed="false">Com divergência<span class="c">${comDiv}</span></button>
<button type="button" data-f="sem" aria-pressed="false">Sem divergência<span class="c">${g.linhas.length - comDiv}</span></button></div>
<div class="legend"><span><i style="background:#fef3c7;border:1px solid #fcd34d"></i>Valor corrigido</span>${recs.length ? html`<span><i style="box-shadow:inset 0 0 0 1.5px var(--warn)"></i>⚠ Motoboy informou outro valor</span>` : ''}</div></div>
<div class="tw"><table class="grade" id="grade" data-f="todos"><tr><th>Motoboy</th>${edita ? html`<th></th>` : ''}<th>PIX</th>${g.dias.map((d) => html`<th class="n">${diaFmt(d)}</th>`)}<th class="n">Total</th>${mostraPago ? html`<th>Pagamento</th>` : ''}</tr>
${g.linhas.map((l) => { const n = nDiv(l); return html`<tr data-q="${semAcento(l.nome)}" data-div="${n ? 1 : 0}" data-nome="${l.nome}" data-total="${brl(l.total)}" class="${n ? 'alt' : ''}">
<td><div class="who">${avatar(l.nome)}<div><b>${l.nome}</b><div class="chips" style="margin-top:3px">
${n ? html`<span class="badge div nodot" title="O despachante corrigiu o valor de ${n} dia(s)">${icone('lapis', 'sm')} Divergência${n > 1 ? ` · ${n} dias` : ''}</span>` : ''}
${!l.pix ? html`<a class="badge bad" href="/motoboys/${l.id}">sem PIX</a>` : ''}
${edita && !comLogin.has(l.id) ? html`<a class="badge nodot" href="/motoboys/${l.id}#acesso" title="Motoboy ainda não tem acesso: registre as divergências por ele ou crie o acesso">sem login</a>` : ''}</div></div></div></td>
${edita ? html`<td><a class="btn btn-soft btn-sm" href="/fechamentos/${f.id}/ajuste?m=${l.id}">${icone('lapis', 'sm')} Registrar divergência</a></td>` : ''}
<td class="small">${l.pix || html`<span class="mut">—</span>`}</td>
${g.dias.map((d) => { const c = l.dias[d], rec = recs.some((r) => r.motoboy_id === l.id && r.dia === d);
    const cls = `cell${c?.ajuste ? ' div' : ''}${rec ? ' rec' : ''}${c ? '' : ' vazio'}`, v = `${rec ? '⚠ ' : ''}${c ? brl(c.final) : '–'}`;
    const tit = c ? `Agilizone: ${brl(c.agil)} (${c.n} entregas)${c.ajuste ? ` · corrigido para ${brl(c.final)}` : ''}` : 'Sem entregas';
    return html`<td class="n">${edita ? html`<a class="${cls}" href="/fechamentos/${f.id}/ajuste?m=${l.id}&d=${d}" title="${tit}">${v}</a>` : html`<span class="${cls}" title="${tit}">${v}</span>`}</td>`; })}
<td class="n b">${brl(l.total)}</td>
${mostraPago ? html`<td>${l.pago ? html`<span class="badge pago">Pago ${l.pago.pago_em.slice(8, 10)}/${l.pago.pago_em.slice(5, 7)}</span>${paga ? html` <form method="post" action="/fechamentos/${f.id}/despagar" class="in"><input type="hidden" name="m" value="${l.id}"><button class="link-btn" title="Desfazer pagamento">desfazer</button></form>` : ''}`
    : l.total <= 0 ? html`<span class="mut">—</span>` : paga ? html`<form method="post" action="/fechamentos/${f.id}/pagar" class="in"><input type="hidden" name="m" value="${l.id}"><button class="btn btn-ok btn-sm" ${l.pix ? '' : 'disabled'}>${icone('check', 'sm')} Marcar pago</button></form>` : html`<span class="badge">Pendente</span>`}</td>` : ''}</tr>`; })}
<tr class="tot"><td colspan="${edita ? 3 : 2}">Total</td>${g.dias.map((d) => html`<td class="n">${brl(g.totDia[d])}</td>`)}<td class="n">${brl(g.total)}</td>${mostraPago ? html`<td></td>` : ''}</tr></table></div>
${edita ? html`<div class="card-f"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}/ajuste">${icone('mais', 'sm')} Motoboy que rodou mas não aparece na tabela</a></div>` : ''}</div>

${paga && !g.linhas.some((l) => l.pago) ? html`<form method="post" action="/fechamentos/${f.id}/devolver" class="card" style="margin-top:20px"><div class="card-h"><span class="hico">${icone('desfazer')}</span><div class="t"><h2>Encontrou algum erro?</h2><p>Devolva ao despachante com o motivo. Só é possível antes de marcar pagamentos.</p></div></div>
<div class="card-b"><textarea name="motivo" required placeholder="O que precisa ser corrigido?" aria-label="Motivo da devolução"></textarea></div><div class="card-f"><button class="btn btn-sec">${icone('desfazer')} Devolver ao despachante</button></div></form>` : ''}

<div class="card" style="margin-top:20px"><div class="card-h"><span class="hico ${ajustes.length ? 'warn' : ''}">${icone('lapis')}</span><div class="t"><h2>Divergências (${ajustes.length})</h2><p>Valores que o despachante corrigiu em relação ao Agilizone, com a justificativa.</p></div></div>
${ajustes.length ? html`<div class="items">${ajustes.map((a) => html`<div><div class="item-h"><div class="who">${avatar(a.motoboy)}<div><b>${a.motoboy}</b><div class="mut small">${diaFmt(a.dia)}</div></div></div>
${edita ? html`<a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}/ajuste?m=${a.motoboy_id}&d=${a.dia}">${icone('lapis', 'sm')} Editar</a>` : ''}</div>
<div class="flow">Agilizone <b>${brl(a.agil)}</b>${a.valor_informado == null ? '' : html` · motoboy informou <b>${brl(a.valor_informado)}</b>`} ${icone('seta', 'sm')} pago <b>${brl(a.valor_final)}</b> ${diferenca(a.valor_final - a.agil)}</div>
<div class="quote">${a.justificativa}</div>
<div class="chips" style="margin-top:10px;align-items:center">${evid.all(a.id).map((e) => html`<a class="badge nodot" href="/evidencias/${e.id}" target="_blank">${icone('clipe', 'sm')} ${e.nome}</a>`)}
<span class="mut small">por ${a.autor} em ${a.criado_em.slice(0, 16)}</span></div></div>`)}</div>`
    : html`<div class="card-b mut">Nenhuma divergência. Todos os valores estão conforme o Agilizone.</div>`}</div>

<details class="card fold" style="margin-top:20px"><summary class="card-h" style="border-bottom:0"><span class="hico">${icone('historico')}</span><span class="t"><h2>Histórico</h2></span>${icone('chevron', 'chev')}</summary>
<div class="card-b" style="border-top:1px solid var(--bd)"><ul class="timeline">${hist.map((h) => html`<li>${h.acao}<small>${h.quando} · ${h.nome || 'Sistema'}</small></li>`)}</ul></div></details>
${edita ? html`<details class="fold" style="margin-top:20px"><summary class="mut small">${icone('chevron', 'chev')} Importou o arquivo errado?</summary>
<form method="post" action="/fechamentos/${f.id}/excluir" onsubmit="return confirm('Excluir este fechamento e todas as divergências?')" style="margin-top:10px"><button class="btn btn-bad btn-sm">${icone('lixo', 'sm')} Excluir fechamento</button></form></details>` : ''}`));
});

app.post('/fechamentos/:fid/mapear', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f;
  tx(() => {
    for (let i = 0; `n${i}` in req.body; i++) {
      const nome = String(req.body[`n${i}`]), esc_ = String(req.body[`m${i}`] || '');
      if (!esc_) continue;
      let mid = Number(esc_);
      if (esc_ === 'novo') {
        mid = Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(nome).lastInsertRowid);
        log(req.user.id, `m:${mid}`, `Cadastrou motoboy "${nome}" a partir do Agilizone (${f.loja})`);
      } else if (!db.prepare('SELECT 1 FROM motoboys WHERE id = ?').get(mid)) throw falha('Motoboy inválido.');
      db.prepare('INSERT OR REPLACE INTO apelidos (loja_id, nome, motoboy_id) VALUES (?,?,?)').run(f.loja_id, nome, mid);
      db.prepare('UPDATE pedidos SET motoboy_id = ? WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NULL').run(mid, f.id, nome);
    }
  });
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Entregadores identificados.');
});

// ---------- Divergências ----------
const evidUpload = multer({
  storage: multer.diskStorage({ destination: UPLOADS, filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
  limits: { fileSize: 10e6, files: 6 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/|application\/pdf$)/.test(file.mimetype)),
}).array('evidencias', 6);
const apagaArquivos = (rows) => rows.forEach((e) => fs.rm(path.join(UPLOADS, e.arquivo), { force: true }, () => {}));

app.get('/fechamentos/:fid/ajuste', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f, m = Number(req.query.m) || null, d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.d || '') ? req.query.d : null;
  const mb = m && db.prepare('SELECT * FROM motoboys WHERE id = ?').get(m);
  const a = mb && d && db.prepare('SELECT * FROM ajustes WHERE fechamento_id = ? AND motoboy_id = ? AND dia = ?').get(f.id, m, d);
  const peds = mb && d ? db.prepare('SELECT * FROM pedidos WHERE fechamento_id = ? AND motoboy_id = ? AND dia = ? ORDER BY chave').all(f.id, m, d) : [];
  const agil = peds.reduce((s, p) => s + p.taxa, 0);
  const evs = a ? db.prepare('SELECT * FROM evidencias WHERE ajuste_id = ?').all(a.id) : [];
  const rec = mb && d && db.prepare('SELECT * FROM reclamacoes WHERE fechamento_id = ? AND motoboy_id = ? AND dia = ?').get(f.id, m, d);
  const reais = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const trilha = [['Fechamentos', '/'], [`${f.loja} · ${periodo(f)}`, `/fechamentos/${f.id}`], ['Registrar divergência']];

  // Passo 1: motoboy escolhido, falta o dia.
  if (mb && !d) {
    const c = grade(f).linhas.find((l) => l.id === m)?.dias || {};
    return res.send(page(req, { titulo: 'Registrar divergência', sub: html`${mb.nome} · passo 1 de 2: escolha o dia`, trilha }, html`
<div class="card"><div class="card-h"><div class="who">${avatar(mb.nome)}<div><b>${mb.nome}</b><div class="mut small">Qual dia o valor está diferente?</div></div></div></div>
<div class="card-b"><div class="daygrid">${diasDoPeriodo(f).map((x) => html`<a class="day ${c[x]?.ajuste ? 'div' : ''}" href="/fechamentos/${f.id}/ajuste?m=${m}&d=${x}">
<div class="d">${diaFmt(x)}</div><div class="v">${brl(c[x]?.final || 0)}</div><div class="e">${c[x]?.n || 0} entregas${c[x]?.ajuste ? ' · já corrigido' : ''}</div></a>`)}</div></div>
<div class="card-f"><a class="btn btn-ghost" href="/fechamentos/${f.id}">${icone('voltar')} Voltar ao fechamento</a></div></div>`));
  }

  res.send(page(req, { titulo: a ? 'Editar divergência' : 'Registrar divergência', sub: mb ? html`${mb.nome} · ${diaFmt(d)}${a ? '' : ' · passo 2 de 2'}` : 'Para um motoboy que rodou mas não aparece no Agilizone', trilha }, html`<div class="split">
<form method="post" enctype="multipart/form-data" class="card">
${mb && d ? html`<div class="card-h"><div class="who">${avatar(mb.nome)}<div><b>${mb.nome}</b><div class="mut small">${diaFmt(d)} · <a href="/fechamentos/${f.id}/ajuste?m=${m}">trocar dia</a></div></div></div>
<div style="text-align:right;margin-left:auto"><div class="mut small">Pelo Agilizone</div><div class="b" style="font-size:20px">${brl(agil)}</div><div class="mut small">${peds.length} entregas</div></div></div>
<input type="hidden" name="m" value="${m}"><input type="hidden" name="d" value="${d}">` : ''}
<div class="card-b">
${rec ? html`<div class="alert warn">${icone('balao')}<div><b>O motoboy informou ${brl(rec.valor)}</b><div style="white-space:pre-wrap">${rec.obs}</div><div class="small" style="margin-top:4px;opacity:.8">em ${rec.criado_em.slice(0, 16)}</div></div></div>` : ''}
${mb && d ? '' : html`<div class="fgrid"><div class="field"><label for="m">Motoboy <span class="req">*</span></label><select id="m" name="m" required><option value="">Escolha…</option>${db.prepare('SELECT id, nome FROM motoboys WHERE ativo = 1 ORDER BY nome').all().map((x) => html`<option value="${x.id}">${x.nome}</option>`)}</select></div>
<div class="field"><label for="d">Dia <span class="req">*</span></label><input id="d" type="date" name="d" required min="${f.data_ini}" max="${f.data_fim}"></div></div>`}
<div class="fgrid">
<div class="field"><label for="informado">Quanto o motoboy disse</label>${campoValor('informado', reais(a?.valor_informado ?? rec?.valor), 'id="informado"')}<p class="hint">Opcional. O valor que ele informou.</p></div>
<div class="field"><label for="final">Valor a pagar <span class="req">*</span></label>${campoValor('final', reais(a ? a.valor_final : mb && d ? agil : null), 'id="final" required')}<p class="hint">Depois de conferir no Agilizone.</p></div></div>
<div class="field"><label for="justificativa">Justificativa <span class="req">*</span></label><textarea id="justificativa" name="justificativa" required placeholder="O que aconteceu, quais pedidos, como foi conferido">${a?.justificativa}</textarea>
<p class="hint">Aparece para o financeiro e para o motoboy. Ex.: "Pedido 0299 entregue por ele, mas ficou sem entregador no Agilizone. Conferido pelo print do app."</p></div>
<div class="field"><label>Evidências</label><label class="drop" style="padding:20px">${icone('clipe')}<b>Anexar prints, fotos ou PDF</b><span class="small">até 6 arquivos de 10 MB</span><span class="fname"></span>
<input type="file" name="evidencias" multiple accept="image/*,application/pdf" aria-label="Evidências"></label>
${evs.length ? html`<div class="chips" style="margin-top:10px"><span class="mut small">Já anexadas:</span>${evs.map((e) => html`<a class="badge nodot" href="/evidencias/${e.id}" target="_blank">${icone('clipe', 'sm')} ${e.nome}</a>`)}</div>` : ''}</div></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar divergência</button><a class="btn btn-ghost" href="/fechamentos/${f.id}">Cancelar</a></div></form>

<div class="stack">
${peds.length ? html`<div class="card"><div class="card-h"><span class="hico">${icone('pacote')}</span><div class="t"><h2>Entregas no Agilizone</h2><p>${diaFmt(d)}</p></div></div>
<div class="tw" style="max-height:460px;overflow:auto"><table><tr><th>Pedido</th><th>Status</th><th class="n">Taxa</th></tr>
${peds.map((p) => html`<tr><td>${p.numero}</td><td>${p.status === 'Cancelado' ? html`<span class="badge bad">Cancelado</span>` : html`<span class="mut small">${p.status}</span>`}</td><td class="n">${brl(p.taxa)}</td></tr>`)}
<tr class="tot"><td colspan="2">Total</td><td class="n">${brl(agil)}</td></tr></table></div></div>`
    : html`<div class="alert">${icone('info')}<div>${mb && d ? 'Nenhuma entrega deste motoboy no Agilizone neste dia.' : 'Escolha o motoboy e o dia. Use quando ele rodou mas as entregas não aparecem no Agilizone.'}</div></div>`}
${a ? html`<form method="post" action="/fechamentos/${f.id}/ajuste/${a.id}/excluir" onsubmit="return confirm('Remover esta divergência? O valor volta a ser o do Agilizone.')" class="card card-b">
<p class="small mut" style="margin-bottom:10px">Errou? Remover a divergência faz o valor voltar a ser o do Agilizone.</p><button class="btn btn-bad btn-sm">${icone('lixo', 'sm')} Remover divergência</button></form>` : ''}</div></div>`));
});

app.post('/fechamentos/:fid/ajuste', so((r) => podeEditar(r.user, r.f)), evidUpload, (req, res) => {
  const f = req.f, arquivos = req.files || [];
  try {
    const m = Number(req.body.m), d = String(req.body.d || '');
    const mb = db.prepare('SELECT * FROM motoboys WHERE id = ?').get(m);
    if (!mb) throw falha('Escolha o motoboy.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < f.data_ini || d > f.data_fim) throw falha('Dia fora do período do fechamento.');
    const final = centavos(req.body.final), inf = String(req.body.informado || '').trim() ? centavos(req.body.informado) : null;
    if (Number.isNaN(final) || final < 0 || (inf != null && (Number.isNaN(inf) || inf < 0))) throw falha('Valor inválido. Use o formato 152,00.');
    const just = String(req.body.justificativa || '').trim();
    if (just.length < 10) throw falha('Escreva a justificativa (mínimo 10 caracteres).');
    tx(() => {
      db.prepare(`INSERT INTO ajustes (fechamento_id, motoboy_id, dia, valor_informado, valor_final, justificativa, criado_por) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (fechamento_id, motoboy_id, dia) DO UPDATE SET valor_informado = excluded.valor_informado, valor_final = excluded.valor_final,
        justificativa = excluded.justificativa, criado_por = excluded.criado_por, criado_em = datetime('now','localtime')`).run(f.id, m, d, inf, final, just, req.user.id);
      const aid = db.prepare('SELECT id FROM ajustes WHERE fechamento_id = ? AND motoboy_id = ? AND dia = ?').get(f.id, m, d).id;
      db.prepare("UPDATE reclamacoes SET status = 'resolvida' WHERE fechamento_id = ? AND motoboy_id = ? AND dia = ?").run(f.id, m, d);
      for (const a of arquivos) db.prepare('INSERT INTO evidencias (ajuste_id, arquivo, nome, tipo) VALUES (?,?,?,?)').run(aid, a.filename, a.originalname, a.mimetype);
      log(req.user.id, `f:${f.id}`, `Divergência ${mb.nome} ${diaFmt(d)}: pagar ${brl(final)}${inf != null ? ` (motoboy informou ${brl(inf)})` : ''}, ${arquivos.length} evidência(s)`);
    });
  } catch (e) {
    apagaArquivos(arquivos.map((a) => ({ arquivo: a.filename })));
    if (e.publico) return volta(res, `/fechamentos/${f.id}/ajuste?m=${Number(req.body.m) || ''}&d=${encodeURIComponent(req.body.d || '')}`, 'erro', e.message);
    throw e;
  }
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Divergência salva. A linha do motoboy agora aparece marcada na tabela.');
});

app.post('/fechamentos/:fid/ajuste/:aid/excluir', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const a = db.prepare('SELECT a.*, m.nome FROM ajustes a JOIN motoboys m ON m.id = a.motoboy_id WHERE a.id = ? AND a.fechamento_id = ?').get(Number(req.params.aid), req.f.id);
  if (!a) throw falha('Divergência não encontrada.', 404);
  apagaArquivos(db.prepare('SELECT arquivo FROM evidencias WHERE ajuste_id = ?').all(a.id));
  db.prepare('DELETE FROM ajustes WHERE id = ?').run(a.id);
  log(req.user.id, `f:${req.f.id}`, `Removeu divergência ${a.nome} ${diaFmt(a.dia)}`);
  volta(res, `/fechamentos/${req.f.id}`, 'ok', 'Divergência removida.');
});

app.get('/evidencias/:id', (req, res) => {
  const e = db.prepare('SELECT e.*, f.loja_id, f.status FROM evidencias e JOIN ajustes a ON a.id = e.ajuste_id JOIN fechamentos f ON f.id = a.fechamento_id WHERE e.id = ?').get(Number(req.params.id));
  if (!e || !podeVer(req.user, e)) throw falha('Arquivo não encontrado.', 404);
  res.setHeader('Content-Type', e.tipo);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(e.nome)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(UPLOADS, e.arquivo));
});

// ---------- Fluxo ----------
app.post('/fechamentos/:fid/enviar', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f;
  if (naoMapeados(f).length) return volta(res, `/fechamentos/${f.id}`, 'erro', 'Identifique todos os entregadores antes de enviar.');
  if (reclamacoesAbertas(f).length) return volta(res, `/fechamentos/${f.id}`, 'erro', 'Há valores informados por motoboys ainda não conferidos.');
  const semPix = grade(f).linhas.filter((l) => l.total > 0 && !l.pix);
  if (semPix.length) return volta(res, `/fechamentos/${f.id}`, 'erro', `Cadastre a chave PIX de: ${semPix.map((l) => l.nome).join(', ')}.`);
  db.prepare("UPDATE fechamentos SET status = 'enviado' WHERE id = ?").run(f.id);
  log(req.user.id, `f:${f.id}`, `Enviou ao financeiro (total ${brl(grade(f).total)})`);
  notificarFinanceiro(f, req.user).catch((e) => { console.error(e); log(null, `f:${f.id}`, `Falha ao enviar e-mail ao financeiro: ${e.message}`); });
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Enviado ao financeiro. Eles recebem um e-mail com o PDF.');
});

async function notificarFinanceiro(f, autor) {
  const para = db.prepare("SELECT email FROM usuarios WHERE perfil = 'financeiro' AND ativo = 1 AND email IS NOT NULL").all().map((u) => u.email);
  if (!para.length) return log(null, `f:${f.id}`, 'E-mail não enviado: nenhum usuário do financeiro tem e-mail cadastrado');
  const g = grade(f), ajustes = ajustesDetalhados(f, g);
  await enviarEmail({
    to: para.join(', '),
    subject: `Pagamento motoboys · ${f.loja} · ${periodo(f)} · ${brl(g.total)}`,
    text: `${autor.nome} enviou o fechamento de ${f.loja} (${periodo(f)}).\n\nTotal: ${brl(g.total)}\nMotoboys: ${g.linhas.length}\nDivergências: ${ajustes.length}\n\n` +
      g.linhas.map((l) => `${l.nome}: ${brl(l.total)} · PIX ${l.pix}`).join('\n') +
      (process.env.APP_URL ? `\n\nAbrir no sistema: ${process.env.APP_URL}/fechamentos/${f.id}` : ''),
    attachments: [{ filename: `motoboys-${f.loja.replace(/\W+/g, '_')}-${f.data_ini}.pdf`, content: await gerarPdf(f, g, ajustes) }],
  });
  log(null, `f:${f.id}`, `E-mail com PDF enviado ao financeiro (${para.join(', ')})`);
}

app.get('/fechamentos/:fid/pdf', async (req, res) => {
  const g = grade(req.f);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="motoboys-${req.f.loja.replace(/\W+/g, '_')}-${req.f.data_ini}.pdf"`);
  res.send(await gerarPdf(req.f, g, ajustesDetalhados(req.f, g)));
});

app.post('/fechamentos/:fid/devolver', so((r) => podePagar(r.user, r.f)), (req, res) => {
  const f = req.f, motivo = String(req.body.motivo || '').trim();
  if (!motivo) throw falha('Informe o motivo.');
  if (db.prepare('SELECT 1 FROM pagamentos WHERE fechamento_id = ?').get(f.id)) throw falha('Já há pagamentos marcados. Desfaça-os antes de devolver.');
  db.prepare("UPDATE fechamentos SET status = 'rascunho' WHERE id = ?").run(f.id);
  log(req.user.id, `f:${f.id}`, `Devolveu para correção: ${motivo}`);
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Devolvido ao despachante.');
});

app.post('/fechamentos/:fid/pagar', so((r) => podePagar(r.user, r.f)), (req, res) => {
  const f = req.f, g = grade(f), l = g.linhas.find((x) => x.id === Number(req.body.m));
  if (!l || l.total <= 0) throw falha('Nada a pagar para este motoboy.');
  if (!l.pix) throw falha('Motoboy sem chave PIX.');
  tx(() => {
    db.prepare('INSERT OR IGNORE INTO pagamentos (fechamento_id, motoboy_id, valor, pix, pago_por) VALUES (?,?,?,?,?)').run(f.id, l.id, l.total, l.pix, req.user.id);
    log(req.user.id, `f:${f.id}`, `Marcou pago: ${l.nome} ${brl(l.total)} no PIX ${l.pix}`);
    const faltam = g.linhas.filter((x) => x.total > 0 && x.id !== l.id && !x.pago).length;
    if (!faltam) { db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id); log(req.user.id, `f:${f.id}`, 'Fechamento totalmente pago'); }
  });
  res.redirect(`/fechamentos/${f.id}#valores`);
});

app.post('/fechamentos/:fid/despagar', so((r) => podePagar(r.user, r.f)), (req, res) => {
  const m = db.prepare('SELECT nome FROM motoboys WHERE id = ?').get(Number(req.body.m));
  if (db.prepare('DELETE FROM pagamentos WHERE fechamento_id = ? AND motoboy_id = ?').run(req.f.id, Number(req.body.m)).changes)
    log(req.user.id, `f:${req.f.id}`, `Desfez pagamento de ${m?.nome}`);
  res.redirect(`/fechamentos/${req.f.id}#valores`);
});

app.post('/fechamentos/:fid/excluir', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  apagaArquivos(db.prepare('SELECT e.arquivo FROM evidencias e JOIN ajustes a ON a.id = e.ajuste_id WHERE a.fechamento_id = ?').all(req.f.id));
  db.prepare('DELETE FROM fechamentos WHERE id = ?').run(req.f.id);
  log(req.user.id, `f:${req.f.id}`, `Excluiu fechamento ${req.f.loja} ${req.f.data_ini} a ${req.f.data_fim}`);
  volta(res, '/', 'ok', 'Fechamento excluído.');
});

app.get('/fechamentos/:fid/csv', (req, res) => {
  const f = req.f, g = grade(f);
  const cel = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const num = (c) => (c / 100).toFixed(2).replace('.', ',');
  const linhas = [
    ['NOME', 'PIX', ...g.dias.map(diaFmt), 'TOTAL', 'PAGO EM'],
    ...g.linhas.map((l) => [l.nome, l.pix, ...g.dias.map((d) => num(l.dias[d]?.final || 0)), num(l.total), l.pago?.pago_em]),
    ['TOTAL', '', ...g.dias.map((d) => num(g.totDia[d])), num(g.total), ''],
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="motoboys-${f.loja.replace(/\W+/g, '_')}-${f.data_ini}-a-${f.data_fim}.csv"`);
  res.send('﻿' + linhas.map((r) => r.map(cel).join(';')).join('\r\n'));
});

// ---------- Motoboys ----------
app.get('/motoboys', (req, res) => {
  const ms = db.prepare(`SELECT m.*, (SELECT group_concat(a.nome, ' | ') FROM apelidos a WHERE a.motoboy_id = m.id) apelidos,
    (SELECT login FROM usuarios WHERE motoboy_id = m.id AND ativo = 1) login
    FROM motoboys m ORDER BY m.ativo DESC, m.nome`).all();
  const ed = editaMotoboy(req.user), semPix = ms.filter((m) => m.ativo && !m.pix).length;
  res.send(page(req, { titulo: 'Motoboys', sub: `${ms.filter((m) => m.ativo).length} ativos. O cadastro é único para as 4 lojas.`, acoes: ed ? html`<a class="btn btn-pri" href="/motoboys/novo">${icone('mais')} Novo motoboy</a>` : '' }, html`
${semPix ? html`<div class="alert warn">${icone('alerta')}<div><b>${semPix} motoboy(s) ativo(s) sem chave PIX</b>Sem PIX, o fechamento não pode ser enviado ao financeiro.</div></div>` : ''}
<div class="card"><div class="card-h"><div class="t"><h2>Cadastro</h2><p>Clique em um motoboy para ver ou editar.</p></div>
<div class="search">${icone('busca', 'sm')}<input type="search" placeholder="Buscar por nome ou PIX" data-filtro="#lista" aria-label="Buscar motoboy"></div></div>
${ms.length ? html`<div class="tw"><table id="lista"><tr><th>Motoboy</th><th>Chave PIX</th><th>Nome no Agilizone</th><th>Acesso</th><th></th></tr>
${ms.map((m) => html`<tr data-href="/motoboys/${m.id}" data-q="${semAcento(`${m.nome} ${m.pix || ''} ${m.apelidos || ''}`)}" style="${m.ativo ? '' : 'opacity:.55'}">
<td><div class="who">${avatar(m.nome)}<div><b>${m.nome}</b>${m.ativo ? '' : html` <span class="badge nodot">inativo</span>`}${m.cpf ? html`<div class="mut small">CPF ${m.cpf}</div>` : ''}</div></div></td>
<td>${m.pix ? html`<span class="small">${m.pix}</span>` : html`<span class="badge bad">sem PIX</span>`}</td>
<td class="mut small">${m.apelidos || '—'}</td><td>${m.login ? html`<span class="badge ok">${m.login}</span>` : html`<span class="badge nodot">sem login</span>`}</td>
<td class="n"><a class="btn btn-ghost btn-sm" href="/motoboys/${m.id}">${ed ? 'Editar' : 'Ver'} ${icone('chevron', 'sm')}</a></td></tr>`)}</table></div>`
    : html`<div class="empty"><div class="hico pri">${icone('pessoas', 'lg')}</div><h2>Nenhum motoboy ainda</h2><p>Eles são cadastrados automaticamente na primeira importação do Agilizone, ou manualmente aqui.</p></div>`}</div>`));
});

function formMotoboy(req, m) {
  const ed = editaMotoboy(req.user), dis = ed ? '' : 'disabled';
  const apel = m.id ? db.prepare('SELECT a.*, l.nome loja FROM apelidos a JOIN lojas l ON l.id = a.loja_id WHERE a.motoboy_id = ?').all(m.id) : [];
  const hist = m.id ? db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`m:${m.id}`) : [];
  const acc = m.id && db.prepare('SELECT login, ativo FROM usuarios WHERE motoboy_id = ?').get(m.id);
  return page(req, { titulo: m.id ? m.nome : 'Novo motoboy', sub: m.id ? (m.ativo ? 'Ativo' : 'Inativo') + (acc?.ativo ? ` · acessa o sistema com o login ${acc.login}` : ' · ainda sem acesso ao sistema') : 'Preencha os dados. A chave PIX é para onde vai o pagamento.', trilha: [['Motoboys', '/motoboys'], [m.id ? m.nome : 'Novo']] }, html`<div class="split">
<div class="stack"><form method="post" class="card"><div class="card-h"><span class="hico pri">${icone('pessoa')}</span><div class="t"><h2>Dados do motoboy</h2></div></div><div class="card-b">
<div class="field"><label for="nome">Nome completo <span class="req">*</span></label><input id="nome" name="nome" required value="${m.nome}" ${dis}></div>
<div class="fgrid"><div class="field"><label for="cpf">CPF</label><input id="cpf" name="cpf" value="${m.cpf}" inputmode="numeric" ${dis}></div>
<div class="field"><label for="pix">Chave PIX</label><input id="pix" name="pix" value="${m.pix}" ${dis}><p class="hint">CPF, telefone, e-mail ou chave aleatória. Toda alteração fica registrada.</p></div></div>
<label class="check"><input type="checkbox" name="ativo" value="1" ${m.ativo !== 0 ? 'checked' : ''} ${dis}> Ativo (aparece nas listas)</label></div>
${ed ? html`<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar</button><a class="btn btn-ghost" href="/motoboys">Cancelar</a></div>` : ''}</form>
${hist.length ? html`<details class="card fold"><summary class="card-h" style="border-bottom:0"><span class="hico">${icone('historico')}</span><span class="t"><h2>Histórico de alterações</h2></span>${icone('chevron', 'chev')}</summary>
<div class="card-b" style="border-top:1px solid var(--bd)"><ul class="timeline">${hist.map((h) => html`<li>${h.acao}<small>${h.quando} · ${h.nome || 'Sistema'}</small></li>`)}</ul></div></details>` : ''}</div>

${m.id ? html`<div class="stack">
${ed ? html`<form method="post" action="/motoboys/${m.id}/acesso" class="card" id="acesso"><div class="card-h"><span class="hico ${acc?.ativo ? 'ok' : ''}">${icone('chave')}</span><div class="t"><h2>Acesso ao sistema</h2>
<p>${acc?.ativo ? 'O motoboy já entra no sistema.' : 'Crie um login para o motoboy ver os próprios valores e avisar quando algo não bate.'}</p></div></div><div class="card-b">
<div class="field"><label for="login">Login</label><input id="login" name="login" required value="${acc?.login ?? (m.cpf || '').replace(/\D/g, '')}" placeholder="ex.: CPF" autocapitalize="none"></div>
<div class="field"><label for="senha">${acc ? 'Nova senha' : 'Senha'}</label><input id="senha" name="senha" type="password" minlength="8" ${acc ? '' : 'required'} autocomplete="new-password"><p class="hint">${acc ? 'Deixe vazio para manter a atual.' : 'Mínimo 8 caracteres. Passe para o motoboy.'}</p></div>
<label class="check"><input type="checkbox" name="ativo" value="1" ${acc?.ativo === 0 ? '' : 'checked'}> Acesso ativo</label></div>
<div class="card-f"><button class="btn btn-sec">${icone('chave')} ${acc ? 'Salvar acesso' : 'Criar acesso'}</button></div></form>` : ''}
<div class="card"><div class="card-h"><span class="hico">${icone('link')}</span><div class="t"><h2>Nomes no Agilizone</h2><p>Como ele aparece nos relatórios de cada loja.</p></div></div>
${apel.length ? html`<div class="items">${apel.map((a) => html`<div class="item-h"><div><b>${a.nome}</b><div class="mut small">${a.loja}</div></div>
${ed ? html`<form method="post" action="/motoboys/${m.id}/apelido" class="in" onsubmit="return confirm('Desvincular? Na próxima importação o sistema vai perguntar de novo quem é.')"><input type="hidden" name="loja" value="${a.loja_id}"><input type="hidden" name="nome" value="${a.nome}"><button class="link-btn">desvincular</button></form>` : ''}</div>`)}</div>`
      : html`<div class="card-b mut small">Ainda não apareceu em nenhuma importação.</div>`}</div></div>` : ''}</div>`);
}
app.post('/motoboys/:id/acesso', so((r) => editaMotoboy(r.user)), (req, res) => {
  const m = db.prepare('SELECT * FROM motoboys WHERE id = ?').get(Number(req.params.id));
  if (!m) throw falha('Motoboy não encontrado.', 404);
  const login = String(req.body.login || '').trim().toLowerCase(), senha = String(req.body.senha || ''), ativo = req.body.ativo ? 1 : 0;
  const acc = db.prepare('SELECT * FROM usuarios WHERE motoboy_id = ?').get(m.id);
  if (!login) throw falha('Informe o login.');
  if ((!acc || senha) && senha.length < 8) throw falha('A senha precisa ter 8 caracteres ou mais.');
  const dono = db.prepare('SELECT id FROM usuarios WHERE login = ?').get(login);
  if (dono && dono.id !== acc?.id) throw falha('Esse login já está em uso.');
  if (acc) {
    db.prepare('UPDATE usuarios SET login = ?, nome = ?, ativo = ? WHERE id = ?').run(login, m.nome, ativo, acc.id);
    if (senha) db.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').run(hashSenha(senha), acc.id);
    if (senha || !ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(acc.id);
  } else db.prepare("INSERT INTO usuarios (nome, login, senha, perfil, motoboy_id, ativo) VALUES (?,?,?,'motoboy',?,?)").run(m.nome, login, hashSenha(senha), m.id, ativo);
  log(req.user.id, `m:${m.id}`, `${acc ? 'Alterou' : 'Criou'} acesso do motoboy (login ${login}${senha ? ', senha definida' : ''}${ativo ? '' : ', inativo'})`);
  volta(res, `/motoboys/${m.id}`, 'ok', 'Acesso salvo.');
});
app.get('/motoboys/novo', so((r) => editaMotoboy(r.user)), (req, res) => res.send(formMotoboy(req, {})));
app.get('/motoboys/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM motoboys WHERE id = ?').get(Number(req.params.id));
  if (!m) throw falha('Motoboy não encontrado.', 404);
  res.send(formMotoboy(req, m));
});
function salvaMotoboy(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const v = { nome: String(req.body.nome || '').trim(), cpf: String(req.body.cpf || '').trim() || null, pix: String(req.body.pix || '').trim() || null, ativo: req.body.ativo ? 1 : 0 };
  if (!v.nome) throw falha('Informe o nome.');
  const antes = id && db.prepare('SELECT * FROM motoboys WHERE id = ?').get(id);
  if (id && !antes) throw falha('Motoboy não encontrado.', 404);
  const mid = id || Number(db.prepare('INSERT INTO motoboys (nome, cpf, pix, ativo) VALUES (?,?,?,?)').run(v.nome, v.cpf, v.pix, v.ativo).lastInsertRowid);
  if (id) db.prepare('UPDATE motoboys SET nome = ?, cpf = ?, pix = ?, ativo = ? WHERE id = ?').run(v.nome, v.cpf, v.pix, v.ativo, id);
  if (id) db.prepare('UPDATE usuarios SET nome = ? WHERE motoboy_id = ?').run(v.nome, id);
  // PIX alterado fica registrado: é o campo que define para onde vai o dinheiro.
  const mud = id ? ['nome', 'cpf', 'pix', 'ativo'].filter((k) => (antes[k] ?? null) !== v[k]).map((k) => `${k}: "${antes[k] ?? ''}" → "${v[k] ?? ''}"`) : ['cadastrado'];
  if (mud.length) log(req.user.id, `m:${mid}`, mud.join('; '));
  volta(res, `/motoboys/${mid}`, 'ok', 'Salvo.');
}
app.post('/motoboys/novo', so((r) => editaMotoboy(r.user)), salvaMotoboy);
app.post('/motoboys/:id', so((r) => editaMotoboy(r.user)), salvaMotoboy);
app.post('/motoboys/:id/apelido', so((r) => editaMotoboy(r.user)), (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('DELETE FROM apelidos WHERE motoboy_id = ? AND loja_id = ? AND nome = ?').run(id, Number(req.body.loja), String(req.body.nome)).changes)
    log(req.user.id, `m:${id}`, `Desvinculou nome do Agilizone "${req.body.nome}"`);
  res.redirect(`/motoboys/${id}`);
});

// ---------- Usuários (admin) ----------
const soAdmin = so((r) => r.user.perfil === 'admin');
app.get('/usuarios', soAdmin, (req, res) => {
  const us = db.prepare("SELECT u.*, l.nome loja FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id WHERE u.perfil <> 'motoboy' ORDER BY u.ativo DESC, u.nome").all();
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all();
  const campos = (u = {}) => html`<div class="field"><label>Nome <span class="req">*</span></label><input name="nome" required value="${u.nome}"></div>
<div class="field"><label>E-mail</label><input name="email" type="email" value="${u.email}" placeholder="nome@grupofornopaulista.com"><p class="hint">O financeiro recebe o PDF neste e-mail.</p></div>
<div class="fgrid"><div class="field"><label>Perfil</label><select name="perfil">${Object.entries(PERFIS).filter(([k]) => k !== 'motoboy').map(([k, v]) => html`<option value="${k}" ${u.perfil === k ? 'selected' : ''}>${v}</option>`)}</select></div>
<div class="field"><label>Loja</label><select name="loja"><option value="">—</option>${lojas.map((l) => html`<option value="${l.id}" ${u.loja_id === l.id ? 'selected' : ''}>${l.nome}</option>`)}</select><p class="hint">Só para despachante.</p></div></div>`;
  res.send(page(req, { titulo: 'Usuários', sub: 'Quem acessa o sistema. Motoboys são liberados na ficha de cada um.' }, html`<div class="split">
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
  if (!v.nome || !PERFIS[v.perfil] || v.perfil === 'motoboy') throw falha('Dados inválidos.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) throw falha('E-mail inválido.');
  if (v.perfil === 'despachante' && !v.loja_id) throw falha('Despachante precisa ter loja.');
  if (v.perfil !== 'despachante') v.loja_id = null;
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
  if (id === req.user.id && (!ativo || v.perfil !== 'admin')) throw falha('Você não pode remover seu próprio acesso de admin.');
  if (db.prepare('SELECT perfil FROM usuarios WHERE id = ?').get(id)?.perfil !== 'motoboy')
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, loja_id = ?, email = ?, ativo = ? WHERE id = ?').run(v.nome, v.perfil, v.loja_id, v.email, ativo, id);
  else throw falha('Acesso de motoboy se altera na ficha do motoboy.');
  if (req.body.senha) db.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').run(hashSenha(String(req.body.senha)), id);
  if (req.body.senha || !ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  log(req.user.id, 'usuarios', `Alterou usuário #${id}${req.body.senha ? ' (senha redefinida)' : ''}`);
  volta(res, '/usuarios', 'ok', 'Salvo.');
});

// ---------- Erros ----------
const telaErro = (req, titulo, msg) => page(req, titulo, html`<div class="card empty" style="max-width:560px;margin:0 auto"><div class="hico warn">${icone('alerta', 'lg')}</div><h2>${msg}</h2>
<p>Se precisar de ajuda, fale com a TI.</p><div class="row" style="display:flex;gap:8px;justify-content:center"><a class="btn btn-sec" href="javascript:history.back()">${icone('voltar')} Voltar</a><a class="btn btn-pri" href="/">Ir para o início</a></div></div>`);
app.use((req, res) => res.status(404).send(telaErro(req, 'Página não encontrada', 'Página não encontrada.')));
app.use((err, req, res, next) => {
  const msg = err.publico ? err.message : err instanceof multer.MulterError ? 'Arquivo muito grande ou arquivos demais.' : 'Erro inesperado. Avise a TI.';
  if (!err.publico && !(err instanceof multer.MulterError)) console.error(err);
  res.status(err.status || (err.publico ? 400 : 500)).send(telaErro(req, 'Não foi possível concluir', msg));
});

const PORT = process.env.PORT || 3080;
app.listen(PORT, process.env.HOST, () => console.log(`Pagamento Motoboys em http://localhost:${PORT}`));
