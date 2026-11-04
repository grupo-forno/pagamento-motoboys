const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOADS, hashSenha, confereSenha, log, tx } = require('./db');
const { lerRelatorio, centavos } = require('./importar');
const { gerarPdf, enviarEmail, brl, diaFmt, dataFmt } = require('./relatorio');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

// ---------- HTML ----------
class Raw { constructor(s) { this.s = s; } }
const esc = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join('') : v == null || v === false ? ''
  : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? esc(v[i]) : ''), ''));

const PERFIS = { admin: 'TI / Admin', gestao: 'Gestão', financeiro: 'Financeiro', despachante: 'Despachante', motoboy: 'Motoboy' };
const STATUS = { rascunho: 'Em conferência', enviado: 'Enviado ao financeiro', pago: 'Pago' };

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--tx:#1d2330;--mut:#667085;--bd:#dde1e7;--pri:#c2410c;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--div:#fff4d6}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
nav{display:flex;gap:16px;align-items:center;padding:10px 20px;background:#1d2330;color:#fff;flex-wrap:wrap}
nav a,nav .link{color:#fff;text-decoration:none}nav b{margin-right:12px}.sp{flex:1}
main{max-width:1300px;margin:0 auto;padding:20px}h1{font-size:22px;margin:4px 0 16px}h2{font-size:17px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef0f4;font-weight:600;white-space:nowrap}td.n,th.n{text-align:right;white-space:nowrap}.scroll{overflow-x:auto}
tr.tot td{font-weight:700;background:#eef0f4}td.div{background:var(--div)}td a{color:inherit}
input,select,textarea,button{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:6px}
textarea{width:100%;min-height:90px}label{display:block;margin:10px 0 4px;font-weight:600}
button,.btn{background:var(--pri);color:#fff;border:0;cursor:pointer;text-decoration:none;display:inline-block;padding:8px 14px;border-radius:6px}
.btn.sec,button.sec{background:#e5e7eb;color:var(--tx)}button.bad{background:var(--bad)}button.ok{background:var(--ok)}
button.link{background:none;padding:0;border:0;text-decoration:underline;color:inherit}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.row>*{margin:0}form.in{display:inline}
.msg{padding:10px 14px;border-radius:6px;margin-bottom:14px;background:#e0f2fe}.msg.e{background:#fee2e2}.msg.w{background:var(--div)}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:13px;background:#e5e7eb}
.tag.rascunho{background:#fef3c7}.tag.enviado{background:#dbeafe}.tag.pago{background:#dcfce7}
.mut{color:var(--mut);font-size:13px}.warn{color:var(--warn);font-weight:600}
@media print{nav,form,.btn{display:none}}`;

function page(req, titulo, corpo) {
  const u = req.user, q = req.query || {};
  return '<!doctype html>' + html`<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} · Pagamento Motoboys</title><style>${new Raw(CSS)}</style></head><body>
${u ? html`<nav><b>🛵 Pagamento Motoboys</b>${u.perfil === 'motoboy' ? html`<a href="/">Meus pagamentos</a>` : html`<a href="/">Fechamentos</a><a href="/motoboys">Motoboys</a>`}
${u.perfil === 'admin' ? html`<a href="/usuarios">Usuários</a>` : ''}<span class="sp"></span>
<a href="/senha">${u.nome} · ${PERFIS[u.perfil]}</a><form method="post" action="/logout" class="in"><button class="link">Sair</button></form></nav>` : ''}
<main><h1>${titulo}</h1>${q.ok ? html`<div class="msg">${q.ok}</div>` : ''}${q.erro ? html`<div class="msg e">${q.erro}</div>` : ''}${corpo}</main></body></html>`.s;
}
const volta = (res, url, chave, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${chave}=${encodeURIComponent(msg)}`);
const falha = (msg, status = 400) => Object.assign(new Error(msg), { publico: true, status });

// ---------- Login / sessão ----------
const tentativas = new Map(); // ponytail: em memória, zera ao reiniciar; suficiente para uma instância
app.get('/login', (req, res) => res.send(page(req, 'Entrar', html`<form method="post" class="card" style="max-width:360px">
<label>Login</label><input name="login" required autofocus style="width:100%"><label>Senha</label><input name="senha" type="password" required style="width:100%">
<p><button>Entrar</button></p></form>`)));
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
  if (sid) req.user = db.prepare('SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND s.expira > ? AND u.ativo = 1').get(sid, Date.now());
  if (!req.user) return res.redirect('/login');
  req.sid = sid;
  // Motoboy só acessa as próprias telas (lista explícita: nada de planilhas, evidências ou cadastros).
  if (req.user.perfil === 'motoboy' && !/^\/(senha|logout|fechamentos\/\d+(\/reclamar)?)?$/.test(req.path)) return next(falha('Sem permissão.', 403));
  next();
});
app.post('/logout', (req, res) => { db.prepare('DELETE FROM sessoes WHERE token = ?').run(req.sid); res.clearCookie('sid'); res.redirect('/login'); });

app.get('/senha', (req, res) => res.send(page(req, 'Minha senha', html`<form method="post" class="card" style="max-width:360px">
<label>Senha atual</label><input name="atual" type="password" required><label>Nova senha (mín. 8)</label><input name="nova" type="password" minlength="8" required>
<p><button>Salvar</button></p></form>`)));
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
app.get('/', (req, res) => {
  const u = req.user;
  if (u.perfil === 'motoboy') {
    const meus = db.prepare(`SELECT f.*, l.nome loja FROM fechamentos f JOIN lojas l ON l.id = f.loja_id WHERE f.id IN
      (SELECT fechamento_id FROM pedidos WHERE motoboy_id = ?1 UNION SELECT fechamento_id FROM ajustes WHERE motoboy_id = ?1) ORDER BY f.data_fim DESC LIMIT 100`).all(u.motoboy_id);
    return res.send(page(req, 'Meus pagamentos', html`<div class="scroll"><table><tr><th>Loja</th><th>Período</th><th>Situação</th><th class="n">Valor</th><th></th></tr>
${meus.map((f) => { const l = grade(f).linhas.find((x) => x.id === u.motoboy_id);
    return html`<tr><td>${f.loja}</td><td>${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}</td><td>${l?.pago ? html`<span class="tag pago">Pago em ${l.pago.pago_em}</span>` : html`<span class="tag ${f.status}">${STATUS[f.status]}</span>`}</td>
<td class="n"><b>${brl(l?.total || 0)}</b></td><td><a href="/fechamentos/${f.id}">ver por dia</a></td></tr>`; })}
${meus.length ? '' : html`<tr><td colspan="5" class="mut">Nenhum pagamento ainda.</td></tr>`}</table></div>`));
  }
  const fs_ = db.prepare(`SELECT f.*, l.nome loja, u.nome autor FROM fechamentos f JOIN lojas l ON l.id = f.loja_id LEFT JOIN usuarios u ON u.id = f.criado_por
    WHERE ? OR f.loja_id = ? ORDER BY f.data_fim DESC, f.id DESC LIMIT 200`).all(veTudo(u) ? 1 : 0, u.loja_id ?? -1);
  const pendentes = fs_.filter((f) => f.status === 'enviado').length;
  res.send(page(req, 'Fechamentos', html`
${editaMotoboy(u) ? html`<p><a class="btn" href="/fechamentos/novo">+ Novo fechamento (importar Agilizone)</a></p>` : ''}
${['financeiro', 'admin'].includes(u.perfil) && pendentes ? html`<div class="msg w">${pendentes} fechamento(s) aguardando pagamento.</div>` : ''}
<div class="scroll"><table><tr><th>Loja</th><th>Período</th><th>Status</th><th class="n">Total</th><th>Criado por</th><th></th></tr>
${fs_.map((f) => html`<tr><td>${f.loja}</td><td>${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}</td><td><span class="tag ${f.status}">${STATUS[f.status]}</span></td>
<td class="n">${brl(grade(f).total)}</td><td>${f.autor} <span class="mut">${f.criado_em}</span></td><td><a href="/fechamentos/${f.id}">abrir</a></td></tr>`)}
${fs_.length ? '' : html`<tr><td colspan="6" class="mut">Nenhum fechamento ainda.</td></tr>`}</table></div>`));
});

const COMO_EXPORTAR = html`<ol class="mut"><li>No Agilizone, escolha a loja e abra <b>Relatório de Pedidos</b>.</li>
<li>Preencha <b>Data inicial / Data final</b> do período a pagar e clique em <b>Aplicar filtros</b>.</li>
<li>Clique em <b>Exportar Pedidos</b> e envie o .xlsx aqui.</li></ol>`;

app.get('/fechamentos/novo', so((r) => editaMotoboy(r.user)), (req, res) => res.send(page(req, 'Novo fechamento', html`
<form method="post" enctype="multipart/form-data" class="card">${COMO_EXPORTAR}
<label>Relatório de Pedidos (.xlsx)</label><input type="file" name="arquivo" accept=".xlsx,.xls" required>
<p><button>Importar</button></p></form>`)));

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
    : res.redirect(`/fechamentos/${r.fid}`);
});

const naoMapeados = (f) => db.prepare('SELECT entregador, COUNT(*) n, SUM(taxa) v FROM pedidos WHERE fechamento_id = ? AND motoboy_id IS NULL AND entregador IS NOT NULL GROUP BY 1 ORDER BY 1').all(f.id);
const normaliza = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
function sugestao(nome, motoboys) {
  const p = normaliza(nome);
  const c = motoboys.filter((m) => { const w = normaliza(m.nome); return p.every((x) => w.includes(x)); });
  return c.length === 1 ? c[0].id : null;
}

const reclamacoesAbertas = (f) => db.prepare("SELECT r.*, m.nome FROM reclamacoes r JOIN motoboys m ON m.id = r.motoboy_id WHERE r.fechamento_id = ? AND r.status = 'aberta' ORDER BY m.nome, r.dia").all(f.id);
const ajustesDetalhados = (f, g) => db.prepare(`SELECT a.*, m.nome motoboy, u.nome autor, (SELECT COUNT(*) FROM evidencias WHERE ajuste_id = a.id) evidencias
  FROM ajustes a JOIN motoboys m ON m.id = a.motoboy_id LEFT JOIN usuarios u ON u.id = a.criado_por WHERE a.fechamento_id = ? ORDER BY m.nome, a.dia`).all(f.id)
  .map((a) => ({ ...a, agil: g.linhas.find((l) => l.id === a.motoboy_id)?.dias[a.dia]?.agil ?? 0 }));

function telaMotoboy(req, res) {
  const f = req.f, mid = req.user.motoboy_id, g = grade(f), l = g.linhas.find((x) => x.id === mid);
  const recs = new Map(db.prepare('SELECT * FROM reclamacoes WHERE fechamento_id = ? AND motoboy_id = ?').all(f.id, mid).map((r) => [r.dia, r]));
  const dias = [];
  for (let d = new Date(f.data_ini + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= f.data_fim; d.setUTCDate(d.getUTCDate() + 1)) dias.push(d.toISOString().slice(0, 10));
  const aberto = f.status === 'rascunho';
  res.send(page(req, `${f.loja} · ${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`, html`
<p>${l?.pago ? html`<span class="tag pago">Pago em ${l.pago.pago_em} no PIX ${l.pago.pix}</span>` : html`<span class="tag ${f.status}">${STATUS[f.status]}</span>`}</p>
<div class="scroll"><table><tr><th>Dia</th><th class="n">Entregas</th><th class="n">Pelo Agilizone</th><th class="n">Valor a receber</th><th>Sua informação</th></tr>
${dias.map((d) => { const c = l?.dias[d], r = recs.get(d); return html`<tr><td>${diaFmt(d)}</td><td class="n">${c?.n || 0}</td><td class="n">${brl(c?.agil || 0)}</td>
<td class="n ${c?.ajuste ? 'div' : ''}"><b>${brl(c?.final || 0)}</b>${c?.ajuste ? html`<br><span class="mut" style="white-space:pre-wrap">${c.ajuste.justificativa}</span>` : ''}</td>
<td>${r ? html`Você informou ${brl(r.valor)} · ${r.status === 'aberta' ? 'aguardando despachante' : 'analisado'}<br><span class="mut">${r.obs}</span>` : html`<span class="mut">—</span>`}</td></tr>`; })}
<tr class="tot"><td>TOTAL</td><td class="n">${Object.values(l?.dias || {}).reduce((s, c) => s + c.n, 0)}</td><td></td><td class="n">${brl(l?.total || 0)}</td><td></td></tr></table></div>
${aberto ? html`<form method="post" action="/fechamentos/${f.id}/reclamar" class="card" style="max-width:520px;margin-top:16px">
<b>O valor de algum dia não bate com o que você fez?</b>
<label>Dia</label><select name="d" required>${dias.map((d) => html`<option value="${d}">${diaFmt(d)}</option>`)}</select>
<label>Quanto deu, pelas suas contas (R$)</label><input name="valor" inputmode="decimal" required placeholder="ex: 152,00">
<label>Explique (quais entregas faltaram, nº dos pedidos)</label><textarea name="obs" required minlength="5"></textarea>
<p><button>Enviar para o despachante</button></p></form>` : html`<p class="mut">Este fechamento já foi conferido e enviado ao financeiro. Dúvidas, fale com o despachante.</p>`}`));
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
  const ajustes = ajustesDetalhados(f, g);
  const evid = db.prepare('SELECT id, nome FROM evidencias WHERE ajuste_id = ?');
  const hist = db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`f:${f.id}`);
  const semPix = g.linhas.filter((l) => l.total > 0 && !l.pix);
  const mostraPago = f.status !== 'rascunho';

  res.send(page(req, `${f.loja} · ${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`, html`
<p><span class="tag ${f.status}">${STATUS[f.status]}</span> <span class="mut">Importado por ${f.autor} em ${f.criado_em} (${f.arquivo})</span></p>

${nm.length ? html`<div class="card"><h2 style="margin-top:0">Identificar entregadores</h2>
<p class="mut">Estes nomes do Agilizone ainda não estão ligados a um motoboy cadastrado. É feito uma vez por loja; nas próximas importações o sistema já reconhece.</p>
${edita ? html`<form method="post" action="/fechamentos/${f.id}/mapear"><table><tr><th>Nome no Agilizone</th><th class="n">Pedidos</th><th class="n">Taxas</th><th>Motoboy</th></tr>
${nm.map((x, i) => { const s = sugestao(x.entregador, motoboys); return html`<tr><td>${x.entregador}<input type="hidden" name="n${i}" value="${x.entregador}"></td><td class="n">${x.n}</td><td class="n">${brl(x.v)}</td>
<td><select name="m${i}" required><option value="">— escolha —</option><option value="novo">+ Cadastrar novo motoboy "${x.entregador}"</option>
${motoboys.map((m) => html`<option value="${m.id}" ${m.id === s ? 'selected' : ''}>${m.nome}</option>`)}</select></td></tr>`; })}
</table><p><button>Salvar</button></p></form>` : html`<ul>${nm.map((x) => html`<li>${x.entregador} (${brl(x.v)})</li>`)}</ul>`}</div>` : ''}

${semEnt.n ? html`<div class="msg w">${semEnt.n} pedido(s) sem entregador no Agilizone (${brl(semEnt.v)} em taxas) não entram no pagamento.</div>` : ''}
${cancel.n ? html`<div class="msg">${cancel.n} pedido(s) cancelado(s) com entregador estão incluídos (${brl(cancel.v)}), igual ao "Resumo de entregas por entregador" do Agilizone. Se algum não deve ser pago, registre uma divergência.</div>` : ''}
${recs.length ? html`<div class="card" style="border-color:#f59e0b"><h2 style="margin-top:0">Valores informados pelos motoboys (${recs.length} pendente${recs.length > 1 ? 's' : ''})</h2>
<table><tr><th>Motoboy</th><th>Dia</th><th class="n">Agilizone</th><th class="n">Motoboy diz</th><th>Explicação</th><th></th></tr>
${recs.map((r) => html`<tr><td>${r.nome}</td><td>${diaFmt(r.dia)}</td><td class="n">${brl(g.linhas.find((l) => l.id === r.motoboy_id)?.dias[r.dia]?.agil ?? 0)}</td><td class="n">${brl(r.valor)}</td>
<td style="white-space:pre-wrap">${r.obs}</td><td>${edita ? html`<a href="/fechamentos/${f.id}/ajuste?m=${r.motoboy_id}&d=${r.dia}">conferir</a>` : ''}</td></tr>`)}</table>
<p class="mut">Confira no Agilizone. Se o motoboy estiver certo, ajuste o valor; se não, mantenha o valor e explique na justificativa.</p></div>` : ''}
${semPix.length ? html`<div class="msg w">Sem chave PIX: ${semPix.map((l, i) => html`${i ? ', ' : ''}<a href="/motoboys/${l.id}">${l.nome}</a>`)}</div>` : ''}

<h2>Valores por dia</h2>
${edita ? html`<p class="mut">Clique em um valor para registrar divergência (motoboy informou outro valor). Células amarelas têm divergência registrada.</p>` : ''}
<div class="scroll"><table><tr><th>Motoboy</th><th>PIX</th>${g.dias.map((d) => html`<th class="n">${diaFmt(d)}</th>`)}<th class="n">Total</th>${mostraPago ? html`<th>Pagamento</th>` : ''}</tr>
${g.linhas.map((l) => html`<tr><td>${l.nome}</td><td>${l.pix || html`<a class="warn" href="/motoboys/${l.id}">sem PIX</a>`}</td>
${g.dias.map((d) => { const c = l.dias[d]; const v = (recs.some((r) => r.motoboy_id === l.id && r.dia === d) ? '⚠ ' : '') + (c ? brl(c.final) : '–');
    return html`<td class="n ${c?.ajuste ? 'div' : ''}" title="${c ? `Agilizone: ${brl(c.agil)} (${c.n} pedidos)` : ''}">${edita ? html`<a href="/fechamentos/${f.id}/ajuste?m=${l.id}&d=${d}">${v}</a>` : v}</td>`; })}
<td class="n"><b>${brl(l.total)}</b></td>
${mostraPago ? html`<td>${l.pago ? html`✅ ${brl(l.pago.valor)} <span class="mut">${l.pago.pago_em}</span>${paga ? html` <form method="post" action="/fechamentos/${f.id}/despagar" class="in"><input type="hidden" name="m" value="${l.id}"><button class="link">desfazer</button></form>` : ''}`
    : l.total <= 0 ? html`<span class="mut">—</span>` : paga ? html`<form method="post" action="/fechamentos/${f.id}/pagar" class="in"><input type="hidden" name="m" value="${l.id}"><button class="ok" ${l.pix ? '' : 'disabled'}>Marcar pago</button></form>` : html`<span class="mut">pendente</span>`}</td>` : ''}</tr>`)}
<tr class="tot"><td colspan="2">TOTAL</td>${g.dias.map((d) => html`<td class="n">${brl(g.totDia[d])}</td>`)}<td class="n">${brl(g.total)}</td>${mostraPago ? html`<td></td>` : ''}</tr></table></div>

<p class="row" style="margin-top:12px">
${edita ? html`<a class="btn sec" href="/fechamentos/${f.id}/ajuste">+ Registrar divergência / lançamento manual</a>
<form method="post" action="/fechamentos/${f.id}/enviar" class="in" onsubmit="return confirm('Enviar ao financeiro? Depois disso só o financeiro pode devolver para correção.')"><button>Enviar ao financeiro</button></form>` : ''}
<a class="btn sec" href="/fechamentos/${f.id}/pdf" target="_blank">PDF</a>
<a class="btn sec" href="/fechamentos/${f.id}/csv">Exportar planilha (CSV)</a>
${edita ? html`<form method="post" action="/fechamentos/${f.id}/excluir" class="in" onsubmit="return confirm('Excluir este fechamento e todas as divergências?')"><button class="bad">Excluir fechamento</button></form>` : ''}</p>

${paga && !g.linhas.some((l) => l.pago) ? html`<form method="post" action="/fechamentos/${f.id}/devolver" class="card"><label>Devolver ao despachante para correção</label>
<textarea name="motivo" required placeholder="O que precisa ser corrigido?"></textarea><p><button class="sec">Devolver</button></p></form>` : ''}

<h2>Divergências (${ajustes.length})</h2>
${ajustes.length ? html`<div class="scroll"><table><tr><th>Motoboy</th><th>Dia</th><th class="n">Agilizone</th><th class="n">Motoboy informou</th><th class="n">Valor pago</th><th class="n">Diferença</th><th>Justificativa</th><th>Evidências</th><th>Por</th></tr>
${ajustes.map((a) => { const agil = a.agil; return html`<tr>
<td>${a.motoboy}</td><td>${diaFmt(a.dia)}</td><td class="n">${brl(agil)}</td><td class="n">${a.valor_informado == null ? '–' : brl(a.valor_informado)}</td>
<td class="n"><b>${brl(a.valor_final)}</b></td><td class="n">${a.valor_final - agil > 0 ? '+' : ''}${brl(a.valor_final - agil)}</td>
<td style="white-space:pre-wrap">${a.justificativa}</td><td>${evid.all(a.id).map((e) => html`<a href="/evidencias/${e.id}" target="_blank">${e.nome}</a><br>`)}</td>
<td>${a.autor}<br><span class="mut">${a.criado_em}</span>${edita ? html`<br><a href="/fechamentos/${f.id}/ajuste?m=${a.motoboy_id}&d=${a.dia}">editar</a>` : ''}</td></tr>`; })}</table></div>`
    : html`<p class="mut">Nenhuma divergência registrada.</p>`}

<h2>Histórico</h2><ul class="mut">${hist.map((h) => html`<li>${h.quando} · ${h.nome}: ${h.acao}</li>`)}</ul>`));
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
  res.redirect(`/fechamentos/${f.id}`);
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
  res.send(page(req, 'Divergência', html`
<p><a href="/fechamentos/${f.id}">← voltar ao fechamento</a></p>
<form method="post" enctype="multipart/form-data" class="card" style="max-width:720px">
${mb && d ? html`<p><b>${mb.nome}</b> · ${diaFmt(d)} · ${f.loja}</p><input type="hidden" name="m" value="${m}"><input type="hidden" name="d" value="${d}">
<p>Valor pelo Agilizone: <b>${brl(agil)}</b> (${peds.length} pedidos)</p>
${rec ? html`<div class="msg w">O motoboy informou <b>${brl(rec.valor)}</b> em ${rec.criado_em}: <span style="white-space:pre-wrap">${rec.obs}</span></div>` : ''}`
    : html`<p class="mut">Use para um dia que o motoboy rodou mas não aparece no Agilizone.</p>
<label>Motoboy</label><select name="m" required><option value="">— escolha —</option>${db.prepare('SELECT id, nome FROM motoboys WHERE ativo = 1 ORDER BY nome').all().map((x) => html`<option value="${x.id}">${x.nome}</option>`)}</select>
<label>Dia</label><input type="date" name="d" required min="${f.data_ini}" max="${f.data_fim}">`}
<label>Valor que o motoboy informou (R$)</label><input name="informado" inputmode="decimal" placeholder="ex: 152,00" value="${reais(a?.valor_informado ?? rec?.valor)}">
<label>Valor a pagar após conferência (R$) *</label><input name="final" inputmode="decimal" required placeholder="ex: 152,00" value="${reais(a ? a.valor_final : mb && d ? agil : null)}">
<label>Justificativa * <span class="mut">(o que aconteceu, quais pedidos, como foi conferido)</span></label><textarea name="justificativa" required>${a?.justificativa}</textarea>
<label>Evidências <span class="mut">(prints, fotos, PDF — até 6 arquivos de 10 MB)</span></label><input type="file" name="evidencias" multiple accept="image/*,application/pdf">
${evs.length ? html`<p class="mut">Já anexadas: ${evs.map((e) => html`<a href="/evidencias/${e.id}" target="_blank">${e.nome}</a> `)}</p>` : ''}
<p class="row"><button>Salvar divergência</button></p></form>
${a ? html`<form method="post" action="/fechamentos/${f.id}/ajuste/${a.id}/excluir" onsubmit="return confirm('Remover esta divergência? O valor volta a ser o do Agilizone.')"><button class="bad">Remover divergência</button></form>` : ''}
${peds.length ? html`<h2>Pedidos do Agilizone neste dia</h2><table><tr><th>Nº</th><th>Status</th><th class="n">Taxa do entregador</th></tr>
${peds.map((p) => html`<tr><td>${p.numero}</td><td>${p.status}</td><td class="n">${brl(p.taxa)}</td></tr>`)}</table>` : ''}`));
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
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Divergência salva.');
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
  volta(res, `/fechamentos/${f.id}`, 'ok', 'Enviado ao financeiro.');
});

async function notificarFinanceiro(f, autor) {
  const para = db.prepare("SELECT email FROM usuarios WHERE perfil = 'financeiro' AND ativo = 1 AND email IS NOT NULL").all().map((u) => u.email);
  if (!para.length) return log(null, `f:${f.id}`, 'E-mail não enviado: nenhum usuário do financeiro tem e-mail cadastrado');
  const g = grade(f), ajustes = ajustesDetalhados(f, g), periodo = `${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`;
  await enviarEmail({
    to: para.join(', '),
    subject: `Pagamento motoboys · ${f.loja} · ${periodo} · ${brl(g.total)}`,
    text: `${autor.nome} enviou o fechamento de ${f.loja} (${periodo}).\n\nTotal: ${brl(g.total)}\nMotoboys: ${g.linhas.length}\nDivergências: ${ajustes.length}\n\n` +
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
  res.redirect(`/fechamentos/${f.id}`);
});

app.post('/fechamentos/:fid/despagar', so((r) => podePagar(r.user, r.f)), (req, res) => {
  const m = db.prepare('SELECT nome FROM motoboys WHERE id = ?').get(Number(req.body.m));
  if (db.prepare('DELETE FROM pagamentos WHERE fechamento_id = ? AND motoboy_id = ?').run(req.f.id, Number(req.body.m)).changes)
    log(req.user.id, `f:${req.f.id}`, `Desfez pagamento de ${m?.nome}`);
  res.redirect(`/fechamentos/${req.f.id}`);
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
  const ms = db.prepare(`SELECT m.*, (SELECT group_concat(l.nome || ': ' || a.nome, ' | ') FROM apelidos a JOIN lojas l ON l.id = a.loja_id WHERE a.motoboy_id = m.id) apelidos
    FROM motoboys m ORDER BY m.ativo DESC, m.nome`).all();
  res.send(page(req, 'Motoboys', html`${editaMotoboy(req.user) ? html`<p><a class="btn" href="/motoboys/novo">+ Novo motoboy</a></p>` : ''}
<div class="scroll"><table><tr><th>Nome</th><th>CPF</th><th>Chave PIX</th><th>Nome no Agilizone</th><th></th></tr>
${ms.map((m) => html`<tr${m.ativo ? '' : ' class="mut"'}><td>${m.nome}${m.ativo ? '' : ' (inativo)'}</td><td>${m.cpf}</td><td>${m.pix || html`<span class="warn">sem PIX</span>`}</td>
<td class="mut">${m.apelidos}</td><td><a href="/motoboys/${m.id}">${editaMotoboy(req.user) ? 'editar' : 'ver'}</a></td></tr>`)}</table></div>`));
});

function formMotoboy(req, m) {
  const ed = editaMotoboy(req.user), dis = ed ? '' : 'disabled';
  const apel = m.id ? db.prepare('SELECT a.*, l.nome loja FROM apelidos a JOIN lojas l ON l.id = a.loja_id WHERE a.motoboy_id = ?').all(m.id) : [];
  const hist = m.id ? db.prepare('SELECT l.*, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? ORDER BY l.id DESC').all(`m:${m.id}`) : [];
  return page(req, m.id ? m.nome : 'Novo motoboy', html`<form method="post" class="card" style="max-width:520px">
<label>Nome completo</label><input name="nome" required value="${m.nome}" style="width:100%" ${dis}>
<label>CPF</label><input name="cpf" value="${m.cpf}" ${dis}>
<label>Chave PIX</label><input name="pix" value="${m.pix}" style="width:100%" ${dis}>
<label><input type="checkbox" name="ativo" value="1" ${m.ativo !== 0 ? 'checked' : ''} ${dis}> Ativo</label>
${ed ? html`<p><button>Salvar</button></p>` : ''}</form>
${apel.length ? html`<h2>Nomes no Agilizone</h2><ul>${apel.map((a) => html`<li>${a.loja}: <b>${a.nome}</b>
${ed ? html`<form method="post" action="/motoboys/${m.id}/apelido" class="in" onsubmit="return confirm('Desvincular? Na próxima importação o sistema vai perguntar de novo quem é.')"><input type="hidden" name="loja" value="${a.loja_id}"><input type="hidden" name="nome" value="${a.nome}"><button class="link">desvincular</button></form>` : ''}</li>`)}</ul>` : ''}
${m.id && ed ? (() => { const acc = db.prepare('SELECT login, ativo FROM usuarios WHERE motoboy_id = ?').get(m.id); return html`
<h2>Acesso do motoboy ao sistema</h2><form method="post" action="/motoboys/${m.id}/acesso" class="card row" style="max-width:720px">
<div><label>Login</label><input name="login" required value="${acc?.login ?? (m.cpf || '').replace(/\D/g, '')}" placeholder="ex: CPF"></div>
<div><label>${acc ? 'Nova senha (vazio = manter)' : 'Senha'}</label><input name="senha" type="password" minlength="8" ${acc ? '' : 'required'}></div>
<label><input type="checkbox" name="ativo" value="1" ${acc?.ativo === 0 ? '' : 'checked'}> Ativo</label><button>${acc ? 'Salvar acesso' : 'Criar acesso'}</button>
<p class="mut" style="width:100%">O motoboy vê só os próprios valores por dia e pode informar quando algo não bate.</p></form>`; })() : ''}
${hist.length ? html`<h2>Histórico</h2><ul class="mut">${hist.map((h) => html`<li>${h.quando} · ${h.nome}: ${h.acao}</li>`)}</ul>` : ''}`);
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
  const campos = (u = {}) => html`<input name="nome" placeholder="Nome" required value="${u.nome}">
<input name="email" type="email" placeholder="E-mail (financeiro recebe o PDF)" value="${u.email}">
<select name="perfil">${Object.entries(PERFIS).filter(([k]) => k !== 'motoboy').map(([k, v]) => html`<option value="${k}" ${u.perfil === k ? 'selected' : ''}>${v}</option>`)}</select>
<select name="loja"><option value="">(loja: só despachante)</option>${lojas.map((l) => html`<option value="${l.id}" ${u.loja_id === l.id ? 'selected' : ''}>${l.nome}</option>`)}</select>`;
  res.send(page(req, 'Usuários', html`<form method="post" class="card row"><input name="login" placeholder="Login" required>${campos()}
<input name="senha" type="password" placeholder="Senha inicial (mín. 8)" minlength="8" required><button>Criar usuário</button></form>
<div class="scroll"><table><tr><th>Login</th><th>Dados</th><th>Nova senha</th><th>Ativo</th><th></th></tr>
${us.map((u) => html`<tr><td>${u.login}</td><td><form method="post" action="/usuarios/${u.id}" id="u${u.id}" class="row">${campos(u)}</form></td>
<td><input form="u${u.id}" name="senha" type="password" placeholder="(manter)" minlength="8"></td>
<td><input form="u${u.id}" type="checkbox" name="ativo" value="1" ${u.ativo ? 'checked' : ''}></td><td><button form="u${u.id}">Salvar</button></td></tr>`)}</table></div>`));
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
app.use((req, res) => res.status(404).send(page(req, 'Página não encontrada', html`<p><a href="/">Voltar</a></p>`)));
app.use((err, req, res, next) => {
  const msg = err.publico ? err.message : err instanceof multer.MulterError ? 'Arquivo muito grande ou arquivos demais.' : 'Erro inesperado. Avise a TI.';
  if (!err.publico && !(err instanceof multer.MulterError)) console.error(err);
  res.status(err.status || (err.publico ? 400 : 500)).send(page(req, 'Ops', html`<div class="msg e">${msg}</div><p><a href="javascript:history.back()">← Voltar</a></p>`));
});

const PORT = process.env.PORT || 3080;
app.listen(PORT, process.env.HOST, () => console.log(`Pagamento Motoboys em http://localhost:${PORT}`));
