const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DIR, UPLOADS, hashSenha, confereSenha, log, tx } = require('./db');
const XLSX = require('xlsx');
const { lerRelatorio, lerResumo, valorDigitado, pixValido, FILTRO_HORA, VIRADA_H } = require('./importar');
const AGZ_API = require('./agilizone');
const AG = require('./agenda');
const CONF = require('./conferencia');
const TG = require('./telegram');
const revisao = (...campos) => crypto.createHash('sha1').update(JSON.stringify(campos)).digest('hex').slice(0, 12);
const revLinha = (l) => revisao(l.nome, l.pix || '', l.obs || '');
const MSG_ALTERADO = 'foi alterado por outra pessoa (ou em outra aba) depois que você abriu esta tela. Nada foi salvo: recarregue, confira e edite de novo.';
const pixCadastro = (loja, id) => db.prepare('SELECT * FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(loja, id);
function salvaPixCadastro(loja, id, pix, usuario) {
  if (!pixCadastro(loja, id)) return false;
  db.prepare("UPDATE entregador_pix SET pix = ?, pix_por = ?, pix_em = datetime('now','localtime') WHERE loja_id = ? AND motoboy_id = ?").run(pix, usuario, loja, id);
  return true;
}
const mascaraPix = (pix) => pix ? '••••••' + pix.slice(-4) : 'Sem chave Pix';
const { gerarPdf, enviarEmail, cfg, listaEmails, brl, diaFmt, dataFmt } = require('./relatorio');
const { Raw, html, esc, icone, iniciais, semAcento, CSS, JS } = require('./ui');

const app = express();
app.set('trust proxy', 1);
// Cabeçalhos de segurança: sem iframe, sem adivinhar tipo de arquivo, HSTS quando em HTTPS.
app.use((req, res, next) => {
  if (!req.path.startsWith('/marca')) res.set('Cache-Control', 'no-store'); // telas internas não ficam no cache do navegador
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  if (process.env.COOKIE_SECURE === '1') res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.urlencoded({ extended: false }));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/marca/favicon.png'));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use('/marca', express.static(path.join(__dirname, 'public'), { maxAge: '1h' })); // logos do Grupo Forno

const PERFIS = { admin: 'TI / Admin', gestao: 'Gestão', financeiro: 'Financeiro', despachante: 'Despachante', conferente: 'Conferência geral' };
const STATUS = { rascunho: 'Em conferência', enviado: 'Aguardando aprovação', pago: 'Aprovado, a pagar' }; // 'pago' no banco = aprovado pelo financeiro (não quer dizer pago)
// Situação mostrada ao usuário (texto sempre presente; a cor só reforça).
const filhoDe = (id) => db.prepare('SELECT id FROM fechamentos WHERE origem_id = ? ORDER BY id DESC').get(id)?.id;
const situacaoF = (f, devolvido) => f.arquivado_em ? ['nodot', 'Arquivado'] : f.pago_em ? ['ok', 'Pago'] : devolvido && f.status === 'rascunho' ? ['bad', f.origem_id ? 'Devolvido · parte já aprovada' : 'Devolvido para correção']
  : f.status === 'pago' && filhoDe(f.id) ? ['ok', 'Aprovado em parte']
  : [{ rascunho: 'warn', enviado: 'info', pago: 'ok' }[f.status], STATUS[f.status]];
const selo = (f, devolvido) => { const [c, t] = situacaoF(f, devolvido); return html`<span class="badge ${c}">${t}</span>`; };
const quando = (q) => `${q.slice(8, 10)}/${q.slice(5, 7)}/${q.slice(0, 4)} às ${q.slice(11, 16)}`; // "AAAA-MM-DD HH:MM" → "DD/MM/AAAA às HH:MM"
const inicio = (u) => (u.perfil === 'despachante' ? 'Pendências' : u.perfil === 'financeiro' ? 'Para aprovar' : 'Fechamentos');
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
const nomeArq = (n) => { n = String(n || ''); return /[^\u0000-\u00ff]/.test(n) || !/[ÃÂ]/.test(n) ? n : Buffer.from(n, 'latin1').toString('utf8'); };
const versao = (u) => { try { return Math.trunc(fs.statSync(path.join(__dirname, 'public', u.replace('/marca/', ''))).mtimeMs); } catch { return 0; } };
function page(req, o, corpo) {
  if (typeof o === 'string') o = { titulo: o };
  const u = req.user, p = req.path, qq = req.query || {};
  const lk = typeof qq.lk === 'string' && qq.lk.startsWith('/') ? qq.lk : '';
  const q = { ok: qq.ok && qq.k === assina('ok', qq.ok + (lk ? `
${lk}` : '')) ? qq.ok : '', erro: qq.erro && qq.k === assina('erro', qq.erro) ? qq.erro : '' };
  const aba = (href, ic, txt, on) => html`<a href="${href}" class="${on ? 'on' : ''}" title="${txt}" ${on ? new Raw('aria-current="page"') : ''}>${icone(ic)}<span class="tx">${txt}</span></a>`;
  const marca = html`<a class="brand" href="/" aria-label="Grupo Forno · Pagamento de entregadores"><img class="logo-h" src="/marca/logo.png" alt=""><span class="marca-t"><b>Entregadores</b><small>Grupo Forno</small></span></a>`;
  // Sucesso de ação pontual: aviso temporário. Erro: fica na página (ou junto ao campo, quando a tela trata).
  const flash = html`${q.ok ? html`<div class="toast" role="status">${icone('ok')}<span>${q.ok}${lk ? html` <a class="toast-a" href="${lk.split('	')[0]}">${lk.split('	')[1] || 'Abrir'}</a>` : ''}</span><button type="button" class="icon-btn" data-fecha-toast aria-label="Fechar aviso">${icone('erro', 'sm')}</button></div>` : ''}${q.erro && !o.erroNoCampo ? html`<div class="alert bad" role="alert">${icone('erro')}<div>${q.erro}</div></div>` : ''}`;
  const desp = u?.perfil === 'despachante', conf = u?.perfil === 'conferente', financeiro = u?.perfil === 'financeiro' || o.financeiro || p === '/pagar';
  const emFech = p === '/' || p.startsWith('/fechamentos');
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#df6d2a">
<title>${o.titulo} · Entregadores Forno Paulista</title>
<link rel="icon" type="image/png" href="/marca/favicon.png"><link rel="apple-touch-icon" href="/marca/apple-touch-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${new Raw(CSS)}</style><link rel="stylesheet" href="/marca/marca.css?v=${versao('/marca/marca.css')}">${o.css ? html`<link rel="stylesheet" href="${o.css}?v=${versao(o.css)}">` : ''}</head>
${u ? html`<body class="${o.largura || ''} ${desp ? 'despachante operacional' : financeiro ? 'financeiro operacional' : ['admin', 'gestao'].includes(u.perfil) ? 'admin operacional' : u.perfil === 'conferente' ? 'conferente operacional' : ''}"><a class="pular" href="#conteudo">Pular para o conteúdo</a><div class="app"><aside class="side" id="menu-lateral"><div class="side-top">${marca}<button type="button" class="icon-btn recolher" data-recolher aria-label="Recolher ou expandir o menu" title="Recolher/expandir menu">${icone('painel')}</button></div>
<nav class="tabs" aria-label="Menu">${conf ? html`${aba('/conferencia', 'caixa', 'Conferência', p.startsWith('/conferencia'))}${aba('/entregadores', 'moto', 'Entregadores', p.startsWith('/entregadores'))}` : desp ? html`${aba('/', 'pin', 'Pendências', emFech)}${aba('/entregadores', 'moto', 'Entregadores', p.startsWith('/entregadores'))}`
    : html`${aba('/', 'caixa', u.perfil === 'financeiro' ? 'Para aprovar' : 'Fechamentos', emFech)}${decideFin(u) ? aba('/pagar', 'carteira', 'Pagamentos', p.startsWith('/pagar')) : ''}`}
${u.perfil === 'admin' ? html`${aba('/conferencia', 'enviar', 'Conferência geral', p.startsWith('/conferencia'))}${aba('/usuarios', 'capacete', 'Usuários', p.startsWith('/usuarios'))}${aba('/entregadores', 'moto', 'Entregadores', p.startsWith('/entregadores'))}${aba('/config', 'ajustes', 'Configurações', p.startsWith('/config'))}` : ''}</nav>
<div class="side-arte" aria-hidden="true"></div><div class="side-user"><div class="who">${avatar(u.nome)}<div class="tx"><b>${u.nome}</b><small>${PERFIS[u.perfil]}${u.loja ? ` · ${lojaCurta(u.loja)}` : ''}</small></div></div>
<form method="post" action="/logout"><button title="Sair do sistema">${icone('sair', 'sm')}<span class="tx">Sair</span></button></form></div></aside>
<div class="veu" data-fecha-menu aria-hidden="true"></div>
<div class="main"><header class="top"><div class="top-in"><button type="button" class="icon-btn abre-menu" data-abre-menu aria-label="Abrir menu" aria-controls="menu-lateral">${icone('menu')}</button>
<nav class="crumbs" aria-label="Caminho"><a href="/" aria-label="Início">${icone('casa', 'sm')}</a>${(o.trilha?.length ? o.trilha : [[o.titulo]]).map(([t, h]) => html`${icone('chevron', 'sm')}${h ? html`<a href="${h}">${t}</a>` : html`<span aria-current="page">${t}</span>`}`)}</nav>
<span class="sp"></span>${u.loja ? html`<span class="loja-tag" title="${u.loja}">${icone('loja', 'sm')} ${lojaCurta(u.loja)}</span>` : ''}</div></header>
<main class="wrap" id="conteudo">
${o.semCabecalho ? '' : html`<div class="ph ${(o.compacto ?? o.largura === 'larga') ? 'compacto' : ''}"><div>${!(o.compacto ?? o.largura === 'larga') && o.eyebrow !== false ? html`<div class="eyebrow">${o.eyebrow || 'Pagamentos de entregadores'}</div>` : ''}<div class="ph-t"><h1>${o.titulo}</h1>${o.selo || ''}</div>${o.sub ? html`<p class="sub">${o.sub}</p>` : ''}</div>${o.acoes ? html`<div class="ph-actions">${o.acoes}</div>` : ''}</div>`}
${flash}${corpo}</main></div></div>`
    : html`<body class="auth operacional"><div class="auth-arte" aria-hidden="true"><div class="auth-brand"><img src="/marca/logo.png" alt=""><span><b>Entregadores</b><small>Grupo Forno</small></span></div></div><main class="auth-box"><h2 class="auth-t">Pagamento de entregadores</h2><p class="auth-sub">Importe relatórios do Agilizone, confira os valores e acompanhe a aprovação e o pagamento.</p>${flash}${corpo}</main>`}
<script>${new Raw(JS)}</script><script src="/marca/marca.js?v=${versao('/marca/marca.js')}" defer></script>${o.js ? html`<script src="${o.js}?v=${versao(o.js)}" defer></script>` : ''}</body></html>`.s;
}
const SEGREDO_MSG = crypto.randomBytes(16);
const assina = (chave, msg) => crypto.createHmac('sha256', SEGREDO_MSG).update(`${chave}:${msg}`).digest('hex').slice(0, 16);
// link opcional [href, rótulo]: aparece no aviso de sucesso como próximo passo (assinado junto com a mensagem).
const volta = (res, url, chave, msg, link) => { const lk = link ? `${link[0]}	${link[1]}` : '';
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  url = url.split('#')[0];
  res.redirect(`${url}${url.includes('?') ? '&' : '?'}${chave}=${encodeURIComponent(msg)}${lk ? `&lk=${encodeURIComponent(lk)}` : ''}&k=${assina(chave, msg + (lk ? `
${lk}` : ''))}${hash}`); };
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
<p class="mut small rodape">Esqueceu a senha? Peça uma nova ao suporte.</p></form>`));
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

// ---------- API do Apps Script (pasta MOTOBOYS no Drive) ----------
// Fora do login por cookie: autentica por segredo (variável DRIVE_SCRIPT_SEGREDO, mín. 24 caracteres) no cabeçalho Authorization: Bearer.
// O script lista os pendentes, baixa cada .xlsx, grava na pasta e confirma com o ID do arquivo no Drive.
const nomeDrive = (f) => `${(f.pagamento || f.data_fim).split('-').reverse().join('-')}-motoboys${f.id}.xlsx`;
const enfileiraDrive = (f) => db.prepare('INSERT OR IGNORE INTO drive_fila (fechamento_id, arquivo) VALUES (?, ?)').run(f.id, nomeDrive(f));
const apiDrive = express.Router();
apiDrive.use((req, res, next) => {
  const seg = process.env.DRIVE_SCRIPT_SEGREDO || '', dado = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
  if (seg.length < 24) return res.status(503).json({ erro: 'API do Drive desligada: defina DRIVE_SCRIPT_SEGREDO (mínimo 24 caracteres) no servidor.' });
  const a = crypto.createHash('sha256').update(dado).digest(), b = crypto.createHash('sha256').update(seg).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: 'Não autorizado.' });
  next();
});
// Duas filas, uma chave por item: "f12" = fechamento 12 (fluxo por loja); "c3" = envio 3 da Conferência geral (todas as lojas juntas).
const nomeDriveEnvio = (e) => `${e.pagamento.split('-').reverse().join('-')}-motoboys${e.id}.xlsx`;
const enfileiraEnvio = (e) => db.prepare('INSERT OR IGNORE INTO drive_fila_envios (envio_id, arquivo) VALUES (?, ?)').run(e.id, nomeDriveEnvio(e));
const FILAS = { f: { tabela: 'drive_fila', col: 'fechamento_id', ref: (id) => `f:${id}` }, c: { tabela: 'drive_fila_envios', col: 'envio_id', ref: () => 'conferencia' } };
const itemDrive = (chave) => {
  const m = /^([fc])(\d+)$/.exec(chave), F = m && FILAS[m[1]], id = m && Number(m[2]), q = F && db.prepare(`SELECT * FROM ${F.tabela} WHERE ${F.col} = ?`).get(id);
  return q ? { F, id, chave, q } : null;
};
const urlDrive = (chave) => `/api/drive/itens/${chave}`;
apiDrive.get('/pendentes', (req, res) => res.json({ pendentes: [
  ...db.prepare('SELECT fechamento_id id, arquivo, tentativas, criado_em FROM drive_fila WHERE drive_id IS NULL').all().map((p) => ({ ...p, chave: `f${p.id}` })),
  ...db.prepare('SELECT envio_id id, arquivo, tentativas, criado_em FROM drive_fila_envios WHERE drive_id IS NULL').all().map((p) => ({ ...p, chave: `c${p.id}` })),
].sort((a, b) => a.criado_em.localeCompare(b.criado_em) || a.chave.localeCompare(b.chave)).slice(0, 50)
  .map(({ criado_em, id, ...p }) => ({ id: p.chave, ...p, download: `${urlDrive(p.chave)}/xlsx`, confirmar: `${urlDrive(p.chave)}/confirmar`, falha: `${urlDrive(p.chave)}/falha` })) }));
apiDrive.get('/itens/:chave/xlsx', (req, res) => {
  const it = itemDrive(req.params.chave);
  let buf = null;
  if (it?.chave[0] === 'f') { const f = carregaF(it.id); buf = f && xlsxFechamento(f, grade(f)); }
  else if (it) { const e = db.prepare('SELECT pagamento FROM envios WHERE id = ?').get(it.id); buf = e && fs.existsSync(arqEnvio(e.pagamento)) ? fs.readFileSync(arqEnvio(e.pagamento)) : null; } // exatamente a planilha enviada por e-mail
  if (!buf) return res.status(404).json({ erro: 'Item não encontrado na fila.' });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${it.q.arquivo}"`, 'X-Arquivo': it.q.arquivo, 'X-Content-SHA256': crypto.createHash('sha256').update(buf).digest('hex') }).send(buf);
});
// Confirmação idempotente: repetir devolve 200 e mantém o primeiro ID gravado.
apiDrive.post('/itens/:chave/confirmar', express.json({ limit: '10kb' }), (req, res) => {
  const it = itemDrive(req.params.chave), driveId = String(req.body?.driveId || '');
  if (!it) return res.status(404).json({ erro: 'Item não encontrado na fila.' });
  if (!/^[\w-]{10,100}$/.test(driveId)) return res.status(400).json({ erro: 'driveId inválido.' });
  if (it.q.drive_id) return res.json({ ok: true, repetido: true, driveId: it.q.drive_id });
  db.prepare(`UPDATE ${it.F.tabela} SET drive_id = ?, gravado_em = datetime('now','localtime'), erro = NULL WHERE ${it.F.col} = ? AND drive_id IS NULL`).run(driveId, it.id);
  log(null, it.F.ref(it.id), `Planilha ${it.q.arquivo} gravada na pasta do Google Drive`);
  res.json({ ok: true, repetido: false, driveId });
});
// Falha informada pelo script: o item continua pendente; só registra o motivo (e no histórico, se mudou).
apiDrive.post('/itens/:chave/falha', express.json({ limit: '10kb' }), (req, res) => {
  const it = itemDrive(req.params.chave), erro = String(req.body?.erro || 'erro').slice(0, 300);
  if (!it) return res.status(404).json({ erro: 'Item não encontrado na fila.' });
  db.prepare(`UPDATE ${it.F.tabela} SET tentativas = tentativas + 1, erro = ? WHERE ${it.F.col} = ? AND drive_id IS NULL`).run(erro, it.id);
  if (!it.q.drive_id && it.q.erro !== erro) log(null, it.F.ref(it.id), `Gravação no Google Drive falhou (segue pendente): ${erro}`);
  res.json({ ok: true });
});
app.use('/api/drive', apiDrive);

app.use((req, res, next) => {
  const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  if (sid) req.user = db.prepare('SELECT u.*, l.nome loja FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id LEFT JOIN lojas l ON l.id = u.loja_id WHERE s.token = ? AND s.expira > ? AND u.ativo = 1 AND u.perfil <> \'motoboy\'').get(sid, Date.now());
  if (!req.user) return sid ? volta(res, '/login', 'erro', 'Sua sessão expirou. Entre de novo.') : res.redirect('/login');
  req.sid = sid;
  next();
});
app.post('/logout', (req, res) => { db.prepare('DELETE FROM sessoes WHERE token = ?').run(req.sid); res.clearCookie('sid'); res.redirect('/login'); });

// ---------- Permissões ----------
const veTudo = (u) => ['admin', 'gestao', 'financeiro'].includes(u.perfil);
// Financeiro: só fechamentos já enviados ao menos uma vez (versao > 0) e da loja dele (sem loja no cadastro = todas).
const podeVer = (u, f) => (u.perfil === 'financeiro' ? f.versao > 0 && (!u.loja_id || u.loja_id === f.loja_id)
  : veTudo(u) || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const podeEditar = (u, f) => f.status === 'rascunho' && !f.arquivado_em && (u.perfil === 'admin' || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const decideFin = (u) => ['admin', 'financeiro'].includes(u.perfil); // aprova/devolve (o estado do fechamento é conferido na ação)
const podeDevolver = (u, f) => f.status === 'enviado' && decideFin(u);
const podeReenviar = (u, f) => f.status !== 'rascunho' && (['admin', 'financeiro'].includes(u.perfil) || (u.perfil === 'despachante' && u.loja_id === f.loja_id));
const editaMotoboy = (u) => ['admin', 'despachante', 'conferente'].includes(u.perfil);
const confere = (u) => ['admin', 'conferente'].includes(u.perfil); // conferência geral (todas as lojas)
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
// Valor por entregador/dia = soma da "Taxa do Entregador" dos pedidos. Fechamento de 1 dia (so_resumo): o total do Resumo é o valor do dia.
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
  // Resumo do Agilizone (quando enviado): total confiável por entregador. Quem só aparece no Resumo também entra na grade.
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
      if (f.status === 'rascunho' && e?.pix) pixF.set(m.id, e.pix), pixR.delete(m.id);
      const cadastro = pixCadastro(f.loja_id, m.id);
      const divergenciaPix = f.status === 'rascunho' && !e?.pix && !!cadastro?.pix && !!pixR.get(m.id) && cadastro.pix !== pixR.get(m.id);
      const c = cels.get(m.id);
      // bruto = soma dos dias (taxas); total a pagar = bruto + ocorrências do Agilizone - o que já foi pago lá.
      const bruto = Object.values(c).reduce((s, x) => s + x.final, 0), res = temResumo ? (resumo.get(m.id) ?? 0) : null;
      const ex = extra.get(m.id), oc = ex?.oc ?? 0, qtdOc = ex?.q ?? 0, pago = ex?.p ?? 0, total = bruto + oc - pago;
      // ok: bate com o Resumo · pendente: a soma dos dias difere do Resumo (aviso; o Agilizone é a referência)
      const confere = res == null || bruto === res ? 'ok' : 'pendente';
      const pix = f.status !== 'rascunho' ? (pixF.get(m.id) ?? aprov.get(m.id)?.pix ?? pixR.get(m.id) ?? null) : (pixF.get(m.id) ?? pixR.get(m.id) ?? cadastro?.pix ?? null), ap = aprov.get(m.id);
      // A aprovação vale para o valor e o PIX aprovados; se mudarem (reenvio), o item volta para análise.
      const aprovado = ap ? ap.valor == null || (ap.valor === total && ap.pix === pix) : f.status === 'pago';
      return { ...m, divergenciaPix, identidadePendente: !cadastro, aprovado, aprovacao: ap, alterado: !!ap && !aprovado, pix, pixDigitado: f.status === 'rascunho' && pixF.has(m.id) && !pixR.has(m.id), obs: e?.obs || '', dias: c, bruto, oc, qtdOc, pago, total, resumo: res, noResumo: temResumo && !resumo.has(m.id), confere };
    }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const diasArr = [...dias].sort();
  const totDia = Object.fromEntries(diasArr.map((d) => [d, linhas.reduce((s, l) => s + (l.dias[d]?.final || 0), 0)]));
  const soma = (k) => linhas.reduce((s, l) => s + l[k], 0);
  return { dias: diasArr, linhas, totDia, total: soma('total'), totOc: soma('oc'), totPago: soma('pago'), temOc: linhas.some((l) => l.oc || l.qtdOc), temPago: linhas.some((l) => l.pago), temResumo };
}

// Arquivos sem id: agrupa nomes apenas dentro deste fechamento, sem herdar Pix por nome.
function vincula(fid) {
  const nomes = db.prepare('SELECT entregador FROM pedidos WHERE fechamento_id = ?1 AND motoboy_id IS NULL AND entregador IS NOT NULL UNION SELECT entregador FROM resumo WHERE fechamento_id = ?1 AND motoboy_id IS NULL').all(fid);
  for (const { entregador: n } of nomes) {
    const id = db.prepare('SELECT motoboy_id id FROM pedidos WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NOT NULL UNION SELECT motoboy_id id FROM resumo WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NOT NULL').get(fid, n, fid, n)?.id ?? Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(n).lastInsertRowid);
    db.prepare('UPDATE pedidos SET motoboy_id = ? WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NULL').run(id, fid, n);
    db.prepare('UPDATE resumo SET motoboy_id = ? WHERE fechamento_id = ? AND entregador = ? AND motoboy_id IS NULL').run(id, fid, n);
  }
}
const aplicaResumo = (f) => vincula(f.id);
for (const { id } of db.prepare("SELECT id FROM fechamentos WHERE status = 'rascunho'").all()) vincula(id); // fechamentos de antes da mudança

function gravaResumo(f, rows, uid, arquivo) {
  db.prepare('DELETE FROM resumo WHERE fechamento_id = ?').run(f.id);
  const ins = db.prepare('INSERT INTO resumo (fechamento_id, entregador, pedidos, total, cpf, pix, pago, ocorrencias, qtd_oc, motoboy_id) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET pedidos = pedidos + excluded.pedidos, total = total + excluded.total, pago = pago + excluded.pago, ocorrencias = ocorrencias + excluded.ocorrencias, qtd_oc = qtd_oc + excluded.qtd_oc');
  for (const r of rows) ins.run(f.id, r.entregador, r.pedidos, r.total, r.cpf, r.pix, r.pago, r.ocorrencias, r.qtdOc, r.motoboyId ?? null);
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
<div class="passo"><span class="n">4</span><p>Na mesma tela, clique no botão verde <b>Resumo de entregas por entregador</b> e depois em <b>Exportar Resumo</b>: baixa o <b>.csv</b> com o total certo de cada entregador.</p></div></div>`;

// ---------- Calendário de pagamento ----------
// Modo teste LOCAL: MODO_TESTE_LOCAL=1 no .env deixa enviar o fechamento com cadastro de entregador incompleto, para testar a planilha e o e-mail.
// O e-mail sai com "[TESTE]" no assunto, nada é registrado (dá para reenviar), não sobe no Drive e o automático fica parado.
// Ignorado em produção (NODE_ENV=production, que o Docker já define): não existe como ligar isso lá.
const TESTE_LOCAL = process.env.MODO_TESTE_LOCAL === '1' && process.env.NODE_ENV !== 'production';
if (TESTE_LOCAL) console.log('>>> MODO TESTE LOCAL: fechamento pode ser enviado com cadastros incompletos (e-mail com [TESTE], nada registrado).');
const TZ = process.env.TZ_ALERTAS || 'America/Fortaleza'; // Teresina
function agora() {
  if (process.env.AGORA_TESTE) { const [data, hora] = process.env.AGORA_TESTE.split(' '); return { data, hora }; } // só para testes: "2026-11-23 13:00"
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
const calendarioDa = (l) => { try { return AG.lerCalendario(l.calendario || AG.PADRAO); } catch { return AG.lerCalendario(AG.PADRAO); } };
const diaLongo = (d) => `${AG.NOMES[AG.semana(d)].toLowerCase()} ${dataFmt(d).slice(0, 5)}`;
// Filtro sugerido para o Agilizone (orientação): do 1º dia às FILTRO_HORA até o dia seguinte ao último às FILTRO_HORA. Ver VIRADA_H em importar.js.
const filtroAgilizone = (p) => `${dataFmt(p.ini)} ${FILTRO_HORA} até ${dataFmt(AG.soma(p.fim, 1))} ${FILTRO_HORA}`;

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

function cardAgenda(u, itens, compacta = false) {
  const pode = (p) => editaMotoboy(u) && (u.perfil === 'admin' || u.loja_id === p.loja.id);
  const linha = (p) => { const [cor, txt] = p.aprovado ? ['ok', 'Aprovado'] : SITUACAO[p.situacao]; return html`<tr${p.f ? new Raw(` data-href="/fechamentos/${p.f.id}"`) : ''}>
<td class="nw"><b>${diaLongo(p.pagamento)}</b></td><td>${lojaCurta(p.loja.nome)}</td><td><span class="nw">${diaLongo(p.dias[0])}</span>${p.dias.length > 1 ? html` a <span class="nw">${diaLongo(p.dias[p.dias.length - 1])}</span>` : ''}${compacta ? html`<details class="ag-filtro"><summary>Filtro do Agilizone</summary><span class="mut small">${filtroAgilizone(p)}</span></details>` : html`<div class="mut small">Filtro no Agilizone: ${filtroAgilizone(p)}</div>`}</td>
<td><span class="badge ${cor}">${txt}</span></td>
<td class="n">${p.f ? html`<a class="btn btn-ghost btn-sm" href="/fechamentos/${p.f.id}">Abrir ${icone('chevron', 'sm')}</a>`
      : p.situacao !== 'futuro' && pode(p) ? html`<a class="btn btn-sec btn-sm" href="/fechamentos/novo?p=${p.pagamento}&l=${p.loja.id}">${icone('subir', 'sm')} Importar</a>` : ''}</td></tr>`; };
  const tabela = (arr) => html`<div class="tw"><table><thead><tr><th scope="col">Pagamento</th><th scope="col">Loja</th><th scope="col">Referente a</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>${arr.map(linha)}</tbody></table></div>`;
  // O que pede ação (atrasado, hoje, em conferência, enviado) fica à vista; o que ainda vai chegar fica recolhido.
  const agora = itens.filter((p) => p.situacao !== 'futuro' || p.f), prox = itens.filter((p) => !agora.includes(p));
  return html`<div class="card agenda" id="agenda" style="margin-bottom:20px"><div class="card-h"><span class="hico pri">${icone('calendario')}</span><div class="t"><h2>Agenda de pagamentos</h2>
<p>Segunda paga sexta a domingo; sexta paga segunda a quinta${u.perfil === 'despachante' && !/dirceu/i.test(u.loja || '') ? '' : ' (DIRCEU: quarta paga seg/ter e sexta paga qua/qui)'}. Datas no fuso de Teresina.</p></div></div>
${itens.length ? html`${agora.length ? tabela(agora) : html`<div class="card-b mut">Nenhum pagamento pendente agora.</div>`}${prox.length ? html`<details class="ag-prox" ${agora.length ? '' : new Raw('open')}><summary>Próximos pagamentos (${prox.length})</summary>${tabela(prox)}</details>` : ''}`
    : html`<div class="card-b mut">Nenhum pagamento nos próximos dias.</div>`}</div>`;
}

// Fechamentos que o usuário pode ver, com total e se está devolvido (último evento é a devolução).
const fechamentosDe = (u) => db.prepare(`SELECT f.*, l.nome loja, u.nome autor,
    (SELECT MAX(id) FROM log WHERE ref = 'f:' || f.id AND acao LIKE 'Devolveu%') > COALESCE((SELECT MAX(id) FROM log WHERE ref = 'f:' || f.id AND acao LIKE 'Enviou%'), 0) devolvido FROM fechamentos f JOIN lojas l ON l.id = f.loja_id LEFT JOIN usuarios u ON u.id = f.criado_por
    WHERE ? OR f.loja_id = ? ORDER BY f.data_fim DESC, f.id DESC LIMIT 300`).all(veTudo(u) ? 1 : 0, u.loja_id ?? -1)
  .filter((f) => podeVer(u, f))
  .map((f) => { const g = grade(f), ap = g.linhas.filter((l) => l.total > 0 && l.aprovado);
    return { ...f, enviou: f.enviado_por && db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(f.enviado_por)?.nome, total: g.total, n: g.linhas.filter((l) => l.total > 0).length, nAprov: ap.length, aprovado: ap.reduce((t, l) => t + l.total, 0) }; });
// Nomes dos entregadores devolvidos na última devolução deste fechamento.
const afetadosDevolucao = (f) => db.prepare('SELECT DISTINCT m.nome FROM devolucoes d JOIN motoboys m ON m.id = d.motoboy_id WHERE d.fechamento_id = ? AND d.versao = (SELECT MAX(versao) FROM devolucoes WHERE fechamento_id = ?) ORDER BY 1').all(f.id, f.id).map((x) => x.nome);
const motivoDevolucao = (f) => db.prepare("SELECT l.acao, l.quando, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE ref = ? AND acao LIKE 'Devolveu%' ORDER BY l.id DESC").get(`f:${f.id}`);

// Período de exibição: o padrão é a semana (segunda a domingo). O que exige ação nunca é escondido; o resto pode ser ampliado.
// Também aceita datas livres (ini / fim) escolhidas pelo usuário.
function periodoSel(q, hoje) {
  const ultimo = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
  const dow = (new Date(hoje + 'T12:00:00Z').getUTCDay() + 6) % 7, sem0 = AG.soma(hoje, -dow), ym = hoje.slice(0, 7);
  const R = { semana: [sem0, AG.soma(sem0, 6)], mes: [ym + '-01', ultimo(ym)], ano: [hoje.slice(0, 4) + '-01-01', hoje.slice(0, 4) + '-12-31'], tudo: ['0000-01-01', '9999-12-31'] };
  const dia = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : '');
  let cini = dia(q.ini), cfim = dia(q.fim);
  if (cini && cfim && cini > cfim) [cini, cfim] = [cfim, cini];
  const mes = !cini && !cfim && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.mes || '') ? q.mes : '';
  const tipo = cini || cfim ? 'livre' : mes ? 'outro' : ['semana', 'mes', 'ano', 'tudo'].includes(q.per) ? q.per : 'semana';
  const [ini, fim] = tipo === 'livre' ? [cini || '0000-01-01', cfim || '9999-12-31'] : mes ? [mes + '-01', ultimo(mes)] : R[tipo];
  return { tipo, mes, ini, fim, cini, cfim, R, param: mes || tipo === 'livre' || tipo === 'semana' ? '' : tipo, dentro: (d) => !!d && d >= ini && d <= fim };
}
function barraPeriodo(per, datas, href, nota, padraoTipo = 'semana') {
  const n = (r) => datas.filter((d) => d >= r[0] && d <= r[1]).length, dm = (d) => dataFmt(d).slice(0, 5);
  const meses = [...new Set(datas.map((d) => d.slice(0, 7)))].sort().reverse(), limpo = { per: '', mes: '', ini: '', fim: '' };
  const nomeMes = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const base = new URL(href(limpo), 'http://x'), campos = [...base.searchParams.entries()]; // os outros filtros da tela seguem junto
  const faixa = per.tipo === 'tudo' ? 'Todos os períodos' : per.tipo === 'livre' ? `${per.cini ? dataFmt(per.cini) : 'início'} a ${per.cfim ? dataFmt(per.cfim) : 'sem data final'}` : `${dm(per.ini)} a ${dm(per.fim)}`;
  const rotulo = { semana: 'Esta semana', mes: 'Este mês', ano: 'Este ano', tudo: 'Tudo', outro: nomeMes(per.mes || '2000-01'), livre: 'Período personalizado' }[per.tipo];
  const padrao = per.tipo === padraoTipo, id = 'dlg-per-' + Math.random().toString(36).slice(2, 7);
  return html`<div class="per-resumo"><button type="button" class="btn btn-sec btn-sm" data-abre="${id}">${icone('calendario', 'sm')} Filtrar por data</button>
<span class="per-atual"><b>${rotulo}</b> · ${faixa} · ${pl(n([per.ini, per.fim]), 'item', 'itens')}</span>${padrao ? '' : html`<a class="per-limpar" href="${href(limpo)}">${padraoTipo === 'semana' ? 'Voltar à semana' : 'Limpar datas'}</a>`}</div>
<dialog id="${id}" class="dlg dlg-per" aria-labelledby="${id}-t"><h2 id="${id}-t">Filtrar por data</h2>${nota ? html`<p class="hint">${nota}.</p>` : ''}
<h3 class="per-sub">Atalhos</h3>
<nav class="pills per-atalhos" aria-label="Atalhos de período">${[['semana', 'Esta semana'], ['mes', 'Este mês'], ['ano', 'Este ano'], ['tudo', 'Tudo']].map(([k, t]) => html`<a href="${href({ ...limpo, per: k })}" class="${per.tipo === k ? 'on' : ''}" ${per.tipo === k ? new Raw('aria-current="true"') : ''}>${t}<span class="c">${n(per.R[k])}</span></a>`)}</nav>
${meses.length ? html`<h3 class="per-sub"><label for="${id}-mes">Outro mês</label></h3><select id="${id}-mes" onchange="if(this.value)location=this.value"><option value="">Escolha um mês…</option>${meses.map((m) => html`<option value="${href({ ...limpo, mes: m })}" ${per.mes === m ? 'selected' : ''}>${nomeMes(m)}</option>`)}</select>` : ''}
<h3 class="per-sub">Datas livres</h3>
<form class="per-datas ${per.tipo === 'livre' ? 'on' : ''}" method="get" action="${base.pathname}">${campos.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<div class="field"><label for="${id}-ini">De</label><input id="${id}-ini" type="date" name="ini" value="${per.cini}"></div><div class="field"><label for="${id}-fim">Até</label><input id="${id}-fim" type="date" name="fim" value="${per.cfim}"></div><button class="btn btn-pri">Aplicar datas</button></form>
<div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Fechar</button></div></dialog>`;
}

// Despachante: a página inicial responde "o que preciso fazer agora?".
function pendenciasDespachante(req, res) {
  const u = req.user, hoje = agora().data, amanha = AG.soma(hoje, 1);
  const ativos = fechamentosDe(u).filter((f) => !f.arquivado_em);
  const ag = agenda(db.prepare('SELECT * FROM lojas WHERE id = ?').all(u.loja_id ?? -1), AG.soma(hoje, -14), AG.soma(hoje, 14));
  const porPag = (a, b) => (a.pagamento || '').localeCompare(b.pagamento || '');
  const atrasadoF = (f) => f.pagamento && f.pagamento < hoje;
  // Seções na ordem do trabalho: o que está nas mãos da loja primeiro, depois o que está com o financeiro.
  const andamento = ativos.filter((f) => f.status === 'rascunho' && !f.devolvido).sort(porPag);
  const devolvidos = ativos.filter((f) => f.status === 'rascunho' && f.devolvido).sort(porPag).map((f) => ({ ...f, motivo: motivoDevolucao(f), afetados: afetadosDevolucao(f) }));
  // Em andamento, devolvidos e enviados (em análise) aparecem sempre. Só os aprovados mostram a semana e podem ser ampliados.
  const per = periodoSel(req.query, hoje), dataF = (f) => f.pagamento || f.data_fim;
  const todosEnv = ativos.filter((f) => f.status === 'enviado').sort(porPag), todosApr = ativos.filter((f) => f.status === 'pago').sort((a, b) => porPag(b, a));
  const enviados = todosEnv, aprovados = todosApr.filter((f) => per.dentro(dataF(f)));
  const infoDatas = todosApr.map(dataF);
  const hrefPer = (o) => { const p = new URLSearchParams(); if (o.per && o.per !== 'semana') p.set('per', o.per); if (o.mes) p.set('mes', o.mes); if (o.ini) p.set('ini', o.ini); if (o.fim) p.set('fim', o.fim); return p.size ? `/?${p}` : '/'; };
  // Previstos: os atrasados e o de hoje ainda sem importar, e só o próximo futuro (não a agenda inteira).
  const semImportar = ag.filter((p) => !p.f && ['atrasado', 'hoje'].includes(p.situacao)).sort(porPag);
  const proximo = ag.filter((p) => !p.f && p.situacao === 'futuro').sort(porPag)[0];
  const hojeP = semImportar.filter((p) => p.situacao === 'hoje'), atrasadosL = semImportar.filter((p) => p.situacao === 'atrasado');
  const previstos = atrasadosL;
  const periodoP = (p) => `${dataFmt(p.ini)} a ${dataFmt(p.fim)}`;
  let primeiro = !hojeP.length; // só a primeira ação da tela é laranja (com importação de hoje, ela é a ação principal)
  const botao = (href, txt) => { const c = primeiro ? 'btn-pri' : 'btn-sec'; primeiro = false; return html`<a class="btn ${c} btn-sm" href="${href}">${txt}</a>`; };
  const pagCel = (pag) => html`<td class="nw"><b>${pag ? diaLongo(pag) : '—'}</b></td>`;
  const linhaF = (f, acao, sit) => html`<tr data-href="/fechamentos/${f.id}">${pagCel(f.pagamento)}<td class="nw">${periodo(f)}</td><td>${sit || selo(f)}${f.motivo ? html`<p class="quote">${f.motivo.acao.replace(/^Devolveu para correção: /, '')}</p>` : ''}${f.afetados?.length ? html`<p class="small"><b>Devolvidos:</b> ${f.afetados.join(', ')}</p>` : ''}</td><td class="n b">${brl(f.total)}</td>
<td class="n">${acao ? botao(`/fechamentos/${f.id}`, acao) : html`<a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Ver detalhes</a>`}</td></tr>`;
  const linhaP = (p) => { const sit = p.situacao === 'atrasado' ? ['bad', 'Atrasado: falta importar'] : p.situacao === 'hoje' ? ['warn', 'Importar hoje'] : ['', p.pagamento === amanha ? 'Amanhã: importe quando o período terminar' : 'Período em andamento'];
    return html`<tr>${pagCel(p.pagamento)}<td class="nw">${periodoP(p)}</td><td><span class="badge ${sit[0] || 'nodot'}">${sit[1]}</span></td><td class="n mut">—</td>
<td class="n">${p.situacao === 'futuro' ? '' : botao(`/fechamentos/novo?p=${p.pagamento}`, 'Importar')}</td></tr>`; };
  // Com mais de 6 linhas, a seção vira uma sanfona (fechada), independente das outras.
  const secao = (id, titulo, dica, linhas, rodape) => {
    if (!linhas.length) return '';
    const cab = html`<h2 id="${id}">${titulo} <span class="c">${linhas.length}</span></h2>${dica ? html`<p>${dica}</p>` : ''}`;
    const tabela = html`<div class="tw card"><table class="tab-p"><thead><tr><th scope="col">Pagamento previsto</th><th scope="col">Período</th><th scope="col">Situação</th><th scope="col" class="n">Total</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>${linhas}</tbody></table></div>`;
    return linhas.length > 6
      ? html`<section class="sec-p"><details class="sanfona"><summary class="sec-h">${cab}${icone('chevron', 'chev')}</summary>${tabela}</details>${rodape || ''}</section>`
      : html`<section class="sec-p" aria-labelledby="${id}"><div class="sec-h">${cab}</div>${tabela}${rodape || ''}</section>`;
  };
  // As seções são montadas em ordem para o primeiro botão laranja cair na primeira ação da tela.
  const sDev = secao('h-dev', 'Devolvidos pelo financeiro', 'Corrija o que o financeiro pediu e envie de novo.', devolvidos.map((f) => linhaF(f, 'Corrigir devolução', html`<span class="badge bad">Devolvido para correção</span>`)));
  const sAnd = secao('h-and', 'Em conferência', 'Importados e ainda não enviados ao financeiro.', andamento.map((f) => linhaF(f, 'Conferir', atrasadoF(f) ? html`<span class="badge bad">Atrasado: falta enviar</span>` : html`<span class="badge warn">Falta enviar</span>`)));
  const sEnv = secao('h-env', 'O que está com o Financeiro', 'Aguardando aprovação. Não dá para editar enquanto isso; se o financeiro devolver, aparece em "O que você precisa fazer".', enviados.map((f) => linhaF(f)));
  const sApr = secao('h-apr', 'Aprovados', 'Aprovado não quer dizer pago: o financeiro faz a transferência fora do sistema e registra o pagamento.', aprovados.map((f) => linhaF(f)));
  const sPre = secao('h-pre', 'Importações atrasadas', atrasadosL.length ? 'Ainda sem fechamento importado. No fim, o próximo da agenda.' : 'Importe quando o período terminar.', previstos.map(linhaP));
  const destaqueHoje = hojeP.length ? html`<section class="hoje-dest" aria-labelledby="h-hoje"><span class="hoje-ico">${icone('moto', 'lg')}</span><div class="hoje-t"><p class="eyebrow">Prioridade de hoje</p><h2 id="h-hoje">Importar hoje</h2><p>${hojeP.length === 1 ? 'O pagamento de hoje ainda não teve os arquivos importados.' : `${hojeP.length} pagamentos de hoje ainda não tiveram os arquivos importados.`}</p></div>
<ul class="hoje-l">${hojeP.map((p) => html`<li><div><b>${diaLongo(p.pagamento)}</b><span>${periodoP(p)} · filtro no Agilizone</span></div><a class="btn btn-pri btn-lg" href="/fechamentos/novo?p=${p.pagamento}">${icone('subir')} Importar arquivos</a></li>`)}</ul></section>` : '';
  const nada = !andamento.length && !devolvidos.length && !semImportar.length;
  const nAtr = semImportar.filter((p) => p.situacao === 'atrasado').length, nPer = ag.filter((p) => !p.f).length, temEsq = andamento.length || devolvidos.length;
  const painel = html`<aside class="painel-pend ${semImportar.length ? '' : 'pp-ok'}" aria-labelledby="h-painel"><h2 id="h-painel">Pagamentos para importar</h2>
<div class="pp-corpo"><b class="pp-num">${nAtr || semImportar.length}</b><div class="pp-txt"><b>${nAtr ? `pagamento${nAtr > 1 ? 's' : ''} atrasado${nAtr > 1 ? 's' : ''}` : semImportar.length ? 'para importar hoje' : 'nada atrasado'}</b><span>${nPer} período${nPer === 1 ? '' : 's'} na agenda</span></div></div>
<a class="pp-ver" href="#h-pre">Ver períodos</a></aside>`;
  res.send(page(req, { titulo: 'Pendências', compacto: true, acoes: html`<a class="btn btn-pri" href="/fechamentos/novo">${icone('subir', 'sm')} Importar arquivos</a>` }, html`
${destaqueHoje}
${nada ? html`<div class="faixa ok">${icone('check')}<p><b>Você não tem pendências agora.</b>${proximo ? ` O próximo período para importar é ${periodoP(proximo)}, com pagamento ${diaLongo(proximo.pagamento)}${proximo.pagamento === amanha ? ' (amanhã)' : ''}. Importe quando o período terminar.` : ' Veja o próximo período de importação em "Próximo pagamento".'}</p></div>` : ''}
<section class="requer" aria-labelledby="h-req"><h2 class="requer-t" id="h-req">O que você precisa fazer</h2><div class="requer-g ${temEsq ? '' : 'so-painel'}">${temEsq ? html`<div>${sDev}${sAnd}</div>` : ''}${painel}</div></section>
${sPre}${proximo ? secao('h-proximo', 'Próximo período', 'Importe após o fim das entregas.', [linhaP(proximo)]) : ''}${sEnv}${infoDatas.length ? html`${barraPeriodo(per, infoDatas, hrefPer, 'vale para os aprovados; o que está em análise ou precisa de ação aparece sempre')}${!aprovados.length ? html`<div class="faixa ok">${icone('check')}<p>Nenhum fechamento aprovado neste período. Escolha outro período acima.</p></div>` : ''}` : ''}
${sApr}`));
}

// ---------- Financeiro: fila e conferência ----------
const FIN_ABAS = { aguardando: 'Aguardando aprovação', parcial: 'Parcialmente aprovados', devolvidos: 'Devolvidos', aprovados: 'Aprovados', todos: 'Todos' };
const abaFin = (f) => (f.status === 'pago' ? 'aprovados' : f.status === 'rascunho' ? 'devolvidos' : f.nAprov ? 'parcial' : 'aguardando');
const SELO_FIN = { aguardando: ['info', 'Aguardando aprovação'], parcial: ['warn', 'Parcialmente aprovado'], devolvidos: ['bad', 'Devolvido para correção'], aprovados: ['ok', 'Aprovado, a pagar'] };
const vinculo = (f) => { const filho = filhoDe(f.id);
  return html`${f.origem_id ? html`<div class="alert info">${icone('link')}<div><b>Restante do fechamento #${f.origem_id}</b>Os entregadores aprovados ficaram fechados no <a href="/fechamentos/${f.origem_id}">fechamento #${f.origem_id}</a>. Aqui estão só os que não foram aprovados.</div></div>` : ''}${filho ? html`<div class="alert info">${icone('link')}<div><b>Aprovado em parte</b>Aqui ficaram só os entregadores aprovados. Os demais foram devolvidos à loja no <a href="/fechamentos/${filho}">fechamento #${filho}</a>.</div></div>` : ''}`; };
const seloFin = (f) => { const [c, t] = f.arquivado_em ? ['nodot', 'Arquivado pela loja'] : f.pago_em ? ['ok', 'Pago'] : f.status === 'pago' && filhoDe(f.id) ? ['ok', 'Aprovado em parte'] : f.status === 'rascunho' && f.origem_id ? ['bad', 'Devolvido · parte já aprovada'] : SELO_FIN[abaFin(f)]; return html`<span class="badge ${c}">${t}</span>`; };
// Volta à fila com os mesmos filtros e página (só aceita endereço da própria fila).
const voltaFila = (v) => (typeof v === 'string' && /^\/(?:pagar)?(\?[\w=&%.+-]*)?$/.test(v) ? v : '/');
const detalheFin = (f, v) => `/fechamentos/${f.id}${voltaFila(v) === '/' ? '' : `?volta=${encodeURIComponent(voltaFila(v))}`}`;
const SIT_ITEM = { aprovado: ['ok', 'Aprovado'], aguardando: ['info', 'Aguardando aprovação'], alterado: ['warn', 'Mudou após aprovação'], bloqueado: ['bad', 'Bloqueado'], devolvido: ['bad', 'Devolvido'], semvalor: ['nodot', 'Sem valor'] };

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
  const env = (f) => (f.enviado_em || '').slice(0, 10), per = periodoSel(q, hoje), dataF = (f) => f.pagamento || f.data_fim;
  const filtrados = todos.filter((f) => (!loja || f.loja_id === loja) && (!de || env(f) >= de) && (!ate || env(f) <= ate) && (f.status !== 'pago' || f.arquivado_em || per.dentro(dataF(f)))
    && (!termo || semAcento(`${f.id} ${f.loja} ${periodo(f)} ${f.enviou || ''} ${f.autor || ''}`).includes(termo)));
  const daAba = (k) => filtrados.filter((f) => k === 'todos' || (!f.arquivado_em && abaFin(f) === k));
  const aba = q.aba in FIN_ABAS ? q.aba : 'aguardando', pendente = ['aguardando', 'parcial'].includes(aba);
  // Pendentes: os mais antigos primeiro, para nada ficar esquecido. Os demais: os mais recentes primeiro.
  const lista = daAba(aba).sort((a, b) => (pendente ? (a.enviado_em || '').localeCompare(b.enviado_em || '') : (b.enviado_em || '').localeCompare(a.enviado_em || '')) || b.id - a.id);
  const POR = 20, pags = Math.max(1, Math.ceil(lista.length / POR)), pag = Math.min(pags, Math.max(1, Math.trunc(Number(q.p)) || 1));
  const qs = (mud = {}) => { const p = new URLSearchParams(), v = { aba, loja: loja || '', de, ate, q: busca, p: pag, per: per.param, mes: per.mes, ini: per.cini, fim: per.cfim, ...mud };
    for (const [k, x] of Object.entries(v)) if (x && !(k === 'aba' && x === 'aguardando') && !(k === 'p' && x === 1)) p.set(k, x);
    return p.size ? `/?${p}` : '/'; };
  const aqui = qs(), filtrando = !!(loja || de || ate || busca || per.tipo !== 'semana'), limpar = aba === 'aguardando' ? '/' : `/?aba=${aba}`;
  const link = (f) => detalheFin(f, aqui);
  const ativos = filtrados.filter((f) => !f.arquivado_em), emAnalise = ativos.filter((f) => f.status === 'enviado');
  const nDev = daAba('devolvidos').length, nParc = emAnalise.filter((f) => abaFin(f) === 'parcial').length;
  const antigo = emAnalise.map((f) => f.enviado_em).filter(Boolean).sort()[0];
  const dias = antigo ? Math.round((Date.parse(hoje) - Date.parse(antigo.slice(0, 10))) / 864e5) : 0;
  const ag = agenda(lojas, AG.soma(hoje, -7), AG.soma(hoje, 7)).filter((p) => p.pagamento >= hoje || p.situacao !== 'enviado');
  const VAZIO = { aguardando: 'Nada aguardando análise. Quando uma loja enviar, aparece aqui.', parcial: 'Nenhum fechamento parcialmente aprovado.', devolvidos: 'Nenhum fechamento devolvido aguardando correção da loja.', aprovados: 'Nenhum fechamento aprovado ainda.', todos: 'Nenhuma solicitação recebida ainda.' };
  res.send(page(req, { titulo: 'Para aprovar', eyebrow: 'Financeiro', largura: 'larga fila-pg', compacto: true, sub: 'Confira os valores e aprove ou devolva à loja. Registre transferências em Pagamentos.' }, html`
<p class="fin-escopo">Indicadores e contadores: ${loja ? lojaCurta(lojas.find((l) => l.id === loja).nome) : 'todas as lojas autorizadas'} · filtros de envio e busca atuais · todas as situações. Aprovados: ${dataFmt(per.ini)} a ${dataFmt(per.fim)}.</p>
<dl class="resumo fin-indicadores" aria-label="Indicadores${filtrando ? ' (com os filtros atuais)' : ''}">
<div class="destaque"><dt>Aguardando sua análise</dt><dd>${brl(emAnalise.reduce((t, f) => t + f.total - f.aprovado, 0))}</dd><dd>${pl(emAnalise.length, 'fechamento', 'fechamentos')}${nParc ? ` · incl. ${pl(nParc, 'parcialmente aprovado', 'parcialmente aprovados')}` : ''}</dd></div>
<div><dt>Envio pendente mais antigo</dt><dd>${antigo ? dataFmt(antigo.slice(0, 10)) : '—'}</dd><dd class="${dias > 2 ? 'bad-t' : ''}">${antigo ? (dias ? `há ${pl(dias, 'dia', 'dias')}` : 'enviado hoje') : 'nada pendente'}</dd></div>
<div class="${nDev ? 'atenc' : 'zero'}"><dt>Devolvidos à loja</dt><dd>${nDev}</dd><dd>${nDev ? 'aguardando correção da loja' : 'nenhum aguardando correção'}</dd></div>
<div><dt>Já aprovado</dt><dd>${brl(ativos.reduce((t, f) => t + f.aprovado, 0))}</dd><dd>nos filtros atuais, incluindo aprovações parciais</dd></div></dl>
<section class="card fila" aria-labelledby="h-fila"><header class="fila-cab"><h2 id="h-fila">Fechamentos recebidos</h2><span class="mut small">${pl(lista.length, 'resultado', 'resultados')} em “${FIN_ABAS[aba]}”</span></header>
<nav class="seg fila-abas" aria-label="Situação">${Object.entries(FIN_ABAS).map(([k, t]) => html`<a href="${qs({ aba: k, p: 1 })}" class="${aba === k ? 'on' : ''}" ${aba === k ? new Raw('aria-current="page"') : ''}>${t}<span class="c">${daAba(k).length}</span></a>`)}</nav>
<details class="filtros-det" open data-ativos="${filtrando ? 1 : 0}"><summary class="filtros-sum">${icone('ajustes', 'sm')} Filtros${filtrando ? ' (ativos)' : ''}</summary><form method="get" action="/" class="filtros" role="search" aria-label="Filtrar fechamentos">${aba !== 'aguardando' ? html`<input type="hidden" name="aba" value="${aba}">` : ''}${per.param ? html`<input type="hidden" name="per" value="${per.param}">` : ''}${per.mes ? html`<input type="hidden" name="mes" value="${per.mes}">` : ''}${per.cini ? html`<input type="hidden" name="ini" value="${per.cini}">` : ''}${per.cfim ? html`<input type="hidden" name="fim" value="${per.cfim}">` : ''}
<div class="field"><label for="f-loja">Loja</label><select id="f-loja" name="loja"><option value="">Todas as autorizadas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === loja ? 'selected' : ''}>${lojaCurta(l.nome)}</option>`)}</select></div>
<div class="field"><label for="f-de">Enviado de</label><input id="f-de" type="date" name="de" value="${de}"></div>
<div class="field"><label for="f-ate">Enviado até</label><input id="f-ate" type="date" name="ate" value="${ate}"></div>
<div class="field grow"><label for="f-q">Buscar</label><input id="f-q" type="search" name="q" value="${busca}" placeholder="Código, loja, período ou quem enviou"></div>
<div class="filtros-b"><button class="btn btn-sec">${icone('busca', 'sm')} Filtrar</button>${filtrando ? html`<a class="btn btn-ghost" href="${limpar}">Limpar filtros</a>` : ''}</div></form></details>
${todos.some((f) => f.status === 'pago' && !f.arquivado_em) ? html`<details class="fin-periodo"><summary>Período dos aprovados · ${dataFmt(per.ini)} a ${dataFmt(per.fim)}</summary>${barraPeriodo(per, todos.filter((f) => f.status === 'pago' && !f.arquivado_em && (!loja || f.loja_id === loja)).map(dataF), (o) => qs({ per: o.per === 'semana' ? '' : o.per, mes: o.mes, ini: o.ini, fim: o.fim, p: 1 }), 'vale para os aprovados; o que aguarda análise aparece sempre')}</details>` : ''}
${lista.length ? html`<div class="tw"><table class="tab-fila"><thead><tr><th scope="col">Código</th><th scope="col">Loja</th><th scope="col">Período das entregas</th><th scope="col" class="opc">Data de envio</th><th scope="col">Situação</th><th scope="col" class="n opc qtd">Entregadores</th><th scope="col" class="n">Total solicitado</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${lista.slice((pag - 1) * POR, pag * POR).map((f) => { const pend = !f.arquivado_em && f.status === 'enviado';
    return html`<tr data-href="${link(f)}"><td><b>#${f.id}</b><span class="ver" title="Versão ${f.versao}">v${f.versao}</span></td><td>${lojaCurta(f.loja)}</td>
<td><span class="nw">${dataFmt(f.data_ini)} a</span> <span class="nw">${dataFmt(f.data_fim)}</span>${f.pagamento ? html`<div class="mut small nw">Pagamento previsto: ${diaLongo(f.pagamento)}</div>` : ''}</td>
<td class="opc">${f.enviado_em ? quando(f.enviado_em) : '—'}${f.enviou ? html`<div class="mut small">por ${f.enviou}</div>` : ''}</td>
<td>${seloFin(f)}${abaFin(f) === 'parcial' && !f.arquivado_em ? html`<div class="mut small">${f.nAprov} de ${f.n} aprovados · ${brl(f.aprovado)}</div>` : ''}</td>
<td class="n opc qtd">${f.n}</td><td class="n b">${brl(f.total)}</td>
<td class="n">${pend ? html`<a class="btn btn-pri btn-sm" href="${link(f)}">Conferir</a>` : html`<a class="btn btn-ghost btn-sm" href="${link(f)}" aria-label="Abrir fechamento #${f.id}">Abrir</a>`}</td></tr>`; })}</tbody></table></div>
${pags > 1 ? html`<nav class="pag" aria-label="Paginação"><span class="mut small">${(pag - 1) * POR + 1}–${Math.min(pag * POR, lista.length)} de ${lista.length}</span>
${pag > 1 ? html`<a class="btn btn-sec btn-sm" href="${qs({ p: pag - 1 })}" rel="prev">${icone('voltar', 'sm')} Anterior</a>` : ''}<span class="small">Página ${pag} de ${pags}</span>${pag < pags ? html`<a class="btn btn-sec btn-sm" href="${qs({ p: pag + 1 })}" rel="next">Próxima ${icone('chevron', 'sm')}</a>` : ''}</nav>` : ''}`
    : html`<p class="vazio-p">${filtrando ? html`Nenhum fechamento em "${FIN_ABAS[aba]}" com estes filtros. <a href="${limpar}">Limpar filtros</a>` : VAZIO[aba]}</p>`}
</section>
<details class="fold sec-agenda card"><summary>${icone('chevron', 'chev')} Agenda de pagamentos das lojas</summary>${cardAgenda(u, ag, true)}</details>`));
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
  const detalheSit = (i) => (i.sit === 'aprovado' ? (i.aprovacao ? (() => { const q = quando(i.aprovacao.aprovado_em); return `${i.aprovacao.por || '—'} · ${q.slice(0, 5)} ${q.slice(-5)}`; })() : '')
    : i.sit === 'devolvido' ? `Motivo: ${i.dev.motivo}`
    : i.sit === 'bloqueado' ? `Não pode ser aprovado: ${i.bloq}. Será devolvido à loja.${i.alterado ? ' Também mudou depois de aprovado.' : ''}`
    : i.sit === 'alterado' ? `Aprovado antes com ${brl(i.aprovacao.valor)} (PIX ${i.aprovacao.pix}); a loja mudou. Confira de novo.`
    : i.dev ? `Corrigido pela loja após devolução (versão ${i.dev.versao})` : difDe(i) ? `Pedidos e Resumo diferem em ${brl(difDe(i))}. O valor a pagar segue os pedidos; se não estiver certo, devolva com o motivo.` : '');
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
  const detSit = (i) => (modo === 'desp' && f.status === 'rascunho' ? (i.sit === 'bloqueado' ? (i.bloq === 'sem chave PIX' ? 'Informe a chave PIX (botão Editar).' : `Atenção: ${i.bloq}.`) : difDe(i) ? `Pedidos e Resumo diferem em ${brl(difDe(i))}. Confira se os dois arquivos saíram com o mesmo filtro. Para enviar assim, você vai precisar justificar a diferença.` : '') : modo === 'desp' && i.sit === 'aprovado' ? '' : detalheSit(i));
  const semanas = Math.ceil(g.dias.length / 7);
  // Uma só fonte de dados: a tabela, a lista do celular e o detalhe leem este mesmo objeto.
  const dados = {
    decide, edit: edita ? `/fechamentos/${f.id}/motoboy/` : '', temResumo: g.temResumo, dias: g.dias.map((d, k) => ({ d, rot: diaFmt(d), sem: Math.floor(k / 7) })),
    itens: itens.map((i) => ({ id: i.id, nome: i.nome, pix: i.pix || '', aviso: i.avisoPix, bruto: i.bruto, oc: i.oc, qtdOc: i.qtdOc, pago: i.pago, total: i.total, resumo: i.resumo, noResumo: !!i.noResumo, dif: difDe(i),
      obs: i.obs, sit: i.sit, sitTxt: sitDe(i)[1], sitCor: sitDe(i)[0], det: detSit(i), bloq: i.bloq, pode: podeSelDe(i), dias: g.dias.map((d) => (i.dias[d] ? [i.dias[d].final, i.dias[d].n] : null)) })),
  };
  const json = new Raw(JSON.stringify(dados).replace(/</g, '\\u003c'));
  const linhaResumo = (i) => {
    const [cor, txt] = sitDe(i), pode = podeSelDe(i), d = difDe(i), aj = i.oc - i.pago;
    return html`<tr class="${temAj(i) ? 'tem-oc' : ''}" id="ent-${i.id}" data-id="${i.id}" data-res="${i.resumo || 0}" data-q="${semAcento(i.nome)}" data-sit="${grupoDe(i)}" data-base="${i.bruto}" data-aj="${aj}" data-valor="${i.total}" ${i.bloq ? new Raw('data-bloq="1"') : ''}>
${decide ? html`<td class="c-sel">${pode ? html`<label class="alvo"><input type="checkbox" name="m" value="${i.id}" aria-label="Marcar ${i.nome} para devolver, ${brl(i.total)}"></label>` : ''}</td>` : ''}
<th scope="row" class="c-nome"><button type="button" class="nm" data-det="${i.id}" title="Ver detalhes de ${i.nome}"><span>${i.nome}</span></button>
${i.pix ? html`<div class="pix-sub"><span class="rot-pix">PIX</span><span>${i.pix}</span><button type="button" class="icon-btn" data-copiar="${i.pix}" title="Copiar chave PIX" aria-label="Copiar chave PIX de ${i.nome}">${icone('copiar', 'sm')}</button>${i.avisoPix ? html`<span class="pix-av" title="${i.avisoPix}">${icone('alerta', 'sm')}<span class="pix-av-t">${i.avisoPix.startsWith('Mesma') ? 'PIX repetido' : 'PIX fora do padrão'}</span></span>` : ''}</div>` : ''}
${i.obs ? html`<div class="obs-sub" title="Observação do despachante">${icone('balao', 'sm')} ${i.obs}</div>` : ''}
<div class="meta"><span class="badge ${cor} so-estreito">${txt}</span>${!i.pix && sitDe(i)[1] !== 'Falta chave PIX' ? html`<span class="badge bad">Sem PIX</span>` : ''}${temAj(i) ? html`<span class="badge warn nodot so-estreito">${icone('alerta', 'sm')} Ajuste ${aj > 0 ? '+' : ''}${brl(aj)}</span>` : ''}${d ? html`<span class="badge bad nodot so-estreito" title="Soma dos dias diferente da soma das taxas do Resumo">${icone('alerta', 'sm')} Difere do Resumo ${d > 0 ? '+' : ''}${brl(d)}</span>` : ''}</div></th>
<td class="n c-base">${brl(i.bruto)}</td>
<td class="n c-res">${!g.temResumo ? html`<span class="mut">–<span class="sr">sem Resumo</span></span>` : i.noResumo ? html`<span class="bad-t">${icone('alerta', 'sm')} não consta</span>` : html`${brl(i.resumo)}<small class="${d ? 'bad-t' : 'ok-t'}">${d ? html`${icone('alerta', 'sm')} diferença ${d > 0 ? '+' : ''}${brl(d)}` : html`${icone('check', 'sm')} confere`}</small>`}</td>
<td class="n c-aj">${temAj(i) ? html`<b class="${aj < 0 ? 'bad-t' : ''}">${aj > 0 ? '+' : ''}${brl(aj)}</b><small>${[i.oc || i.qtdOc ? `${i.qtdOc} ocorrência(s)` : '', i.pago ? `já pago ${brl(i.pago)}` : ''].filter(Boolean).join(' · ')}</small>` : html`<span class="mut">–<span class="sr">sem ajustes</span></span>`}</td>
<td class="n c-tot"><b>${brl(i.total)}</b></td>
<td class="c-sit"><span class="badge ${cor}">${txt}</span>${detSit(i) ? html`<span class="sit-d" id="sit-${i.id}">${detSit(i)}</span>` : ''}</td>
${decide || edita ? html`<td class="n c-acoes"><div class="acoes-c">${edita ? html`<a class="btn btn-ghost btn-xs" href="/fechamentos/${f.id}/motoboy/${i.id}" aria-label="Editar nome e PIX de ${i.nome}">${icone('lapis', 'sm')} Editar</a>` : ''}${decide ? html`<button type="button" class="btn btn-ghost btn-xs" data-det="${i.id}" aria-label="Ver detalhes de ${i.nome}">Detalhes</button>` : ''}</div></td>` : ''}</tr>`;
  };
  const linhaDia = (i) => html`<tr data-q="${semAcento(i.nome)}" data-sit="${grupoDe(i)}">
<th scope="row" class="c-nome"><button type="button" class="nm" data-det="${i.id}" title="Ver detalhes de ${i.nome}"><span>${i.nome}</span></button></th>
${g.dias.map((d, k) => { const c = i.dias[d]; return html`<td class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}" data-v="${c ? c.final : 0}">${c ? brl(c.final) : html`<span class="mut" title="Sem entregas no dia">–<span class="sr">sem entregas</span></span>`}</td>`; })}
<td class="n c-int"><b data-int>${brl(0)}</b></td></tr>`;
  return html`<div class="fc" id="fc" data-w="largo">
<div class="abas" role="tablist" aria-label="Seções do fechamento">
<button type="button" role="tab" id="t-conf" aria-controls="conf" aria-selected="true">Resumo</button>
${o.pixPanel ? html`<button type="button" role="tab" id="t-pix" aria-controls="pix" aria-selected="false" tabindex="-1">Chaves Pix <span class="c">${g.linhas.filter((l) => l.total > 0 && (!l.pix || l.divergenciaPix)).length}</span></button>` : ''}
<button type="button" role="tab" id="t-dia" aria-controls="pordia" aria-selected="false" tabindex="-1">Por dia</button>
<button type="button" role="tab" id="t-hist" aria-controls="hist" aria-selected="false" tabindex="-1">Histórico <span class="c">${modo === 'desp' ? hist.length : decisoes.length}</span></button></div>
<div class="fc-bar" role="search" aria-label="Buscar e filtrar entregadores">
<div class="search">${icone('busca', 'sm')}<input type="search" id="fc-q" placeholder="Buscar entregador" aria-label="Buscar entregador" autocomplete="off"></div>
<button type="button" class="btn btn-sec fc-filtros" id="fc-filtros-btn" aria-expanded="false" aria-controls="fc-seg" ${new Raw(filtro.filter(([k, , n]) => k === 'todos' || (n && n < itens.length)).length < 2 ? 'data-sem-filtros' : '')}>${icone('ajustes', 'sm')} Filtros <span class="c" data-fc-nfiltros>0</span></button>
<div class="seg fc-seg" id="fc-seg" role="group" aria-label="Mostrar por situação" ${new Raw(filtro.filter(([k, , n]) => k === 'todos' || (n && n < itens.length)).length < 2 ? 'hidden' : '')}><span class="fc-seg-rot">Mostrar:</span>${filtro.filter(([k, , n]) => k === 'todos' || (n && n < itens.length)).map(([k, t, n]) => html`<button type="button" data-f="${k}" class="${k === 'todos' ? 'on' : ''}" aria-pressed="${k === 'todos'}">${t}<span class="c">${n}</span></button>`)}</div>
</div>
${o.pixPanel ? html`<section id="pix" role="tabpanel" aria-labelledby="t-pix" hidden>${o.pixPanel}</section>` : ''}
<form id="dec" method="post" action="/fechamentos/${f.id}/decidir" data-carregando="Registrando a decisão…">
<input type="hidden" name="versao" value="${f.versao}"><input type="hidden" name="volta" value="${voltar}">
<section class="card painel" id="conf" role="tabpanel" aria-labelledby="t-conf">
<div class="tw fc-tw"><table class="fc-t ${decide ? 'com-sel' : ''}" id="fc-resumo"><caption class="sr">Resumo por entregador</caption>
<thead><tr>${decide ? html`<th scope="col" class="c-sel"><label class="alvo" title="Marcar todos os entregadores da lista para devolver"><input type="checkbox" id="sel-todos" aria-label="Marcar todos os entregadores da lista para devolver"><span class="sel-txt">Marcar para devolver</span></label></th>` : ''}<th scope="col" class="c-nome">Entregador</th><th scope="col" class="n c-base" title="Soma da taxa do entregador no Relatório de Pedidos (Exportar Pedidos)">Valor dos pedidos</th><th scope="col" class="n c-res" title="Soma das taxas no Resumo de entregas (Exportar Resumo) e a diferença para o valor dos pedidos">Valor do Resumo</th><th scope="col" class="n c-aj" title="Ocorrências do Agilizone (acréscimo ou desconto, sem data) e valor já pago no Agilizone">Ajustes</th><th scope="col" class="n c-tot">Valor a pagar</th><th scope="col" class="c-sit">Situação</th>${decide || edita ? html`<th scope="col" class="n c-acoes">Ações</th>` : ''}</tr></thead>
<tbody>${itens.map(linhaResumo)}</tbody>
<tfoot><tr class="tot">${decide ? html`<td class="c-sel"></td>` : ''}<th scope="row" class="c-nome"><span data-esc>Total do fechamento</span><small data-esc-n></small></th><td class="n c-base" data-t="base">${brl(g.linhas.reduce((t, l) => t + l.bruto, 0))}</td><td class="n c-res" data-t="res">${g.temResumo ? brl(g.linhas.reduce((t, l) => t + (l.resumo || 0), 0)) : '–'}</td><td class="n c-aj" data-t="aj">${brl(g.totOc - g.totPago)}</td><td class="n c-tot" data-t="tot">${brl(g.total)}</td><td class="c-sit"></td>${decide || edita ? html`<td class="c-acoes"></td>` : ''}</tr></tfoot></table></div>
<p class="fc-vazio" data-vazio hidden>Nenhum entregador com esta busca ou filtro. <button type="button" class="btn btn-sec btn-sm" data-limpar-filtros>Limpar busca e filtros</button></p>
<details class="fin-legenda"><summary>Como ler esta tabela</summary><p>Valor a pagar = valor dos pedidos + ajustes. Valor dos pedidos: soma da taxa do entregador no Relatório de Pedidos. Valor do Resumo: soma das taxas no Resumo de entregas; a diferença compara só esses dois. Ajustes: ocorrências do Agilizone (acréscimo ou desconto, sem data) menos o que já foi pago lá; entram nos dois lados igualmente, então não explicam uma diferença. Com diferença, a loja só envia com justificativa (aparece no topo da tela do financeiro); o valor a pagar segue o Relatório de Pedidos.${decide ? ' A caixa no cabeçalho da tabela seleciona todos os entregadores da lista; com busca ou filtro, só os que aparecem.' : ''}</p></details>
${decide ? html`<div class="barra" role="region" aria-label="Decisão sobre o fechamento"><div class="barra-in">
<div><span class="mut small" data-sel-n aria-live="polite">Nenhum entregador marcado para devolver</span><b data-sel-v>${brl(0)}</b></div>
<span class="small bad-t" data-sel-bloq hidden></span>
<button type="button" class="btn btn-ghost" data-limpar>Limpar marcação</button>
<button type="button" class="btn btn-sec" data-dec="devolver">${icone('desfazer', 'sm')} <span data-rot-dev>Devolver</span></button>
<button type="button" class="btn btn-ok" data-dec="aprovar">${icone('check', 'sm')} <span data-rot-apr>Aprovar todos</span></button></div></div>
<dialog id="dlg-dec" class="dlg dlg-dec" aria-labelledby="dlg-dec-t" aria-describedby="dlg-dec-r"><h2 id="dlg-dec-t">Confirmar decisão</h2><p id="dlg-dec-r"></p>
<div class="dec-aviso" data-dec-aviso hidden>${icone('info')}<p></p></div>
<ul class="dec-lista" data-dlg-lista hidden></ul>
<p class="hint" data-dlg-hint hidden>O aviso aparece na tela inicial de ${avisados.length ? avisados.map((a) => a.nome).join(', ') : 'ninguém: a loja não tem despachante cadastrado'}.</p>
<div class="acoes-f"><button type="button" class="btn btn-ghost" data-dlg-cancela>Cancelar</button><button type="button" class="btn btn-ghost" data-dlg-volta hidden>Voltar</button><button type="button" class="btn btn-pri" data-dlg-prox hidden>Continuar</button><button class="btn btn-sec" name="resto" value="manter" data-dlg-man hidden>Devolver e deixar os demais aguardando</button><button class="btn btn-ok" name="resto" value="aprovar" data-dlg-ok hidden>Confirmar</button></div></dialog>` : ''}
</section>
<section class="card painel" id="pordia" role="tabpanel" aria-labelledby="t-dia" hidden>
<div class="dia-ctrl">${semanas > 1 ? html`<div class="seg dia-sem" role="group" aria-label="Semana">${Array.from({ length: semanas }, (_, k) => { const a = g.dias[k * 7], b = g.dias[Math.min(g.dias.length, k * 7 + 7) - 1]; return html`<button type="button" data-sem="${k}" class="${k === 0 ? 'on' : ''}" aria-pressed="${k === 0}">${diaFmt(a).slice(0, 5)} a ${diaFmt(b).slice(0, 5)}</button>`; })}</div>` : ''}
<div class="field dia-sel"><label for="dia-sel">Dia</label><select id="dia-sel">${g.dias.map((d) => html`<option value="${d}">${diaFmt(d)}</option>`)}</select></div></div>
<div class="tw fc-tw"><table class="fc-t fc-dia" id="fc-dia"><caption class="sr">Valores por dia e entregador</caption>
<thead><tr><th scope="col" class="c-nome">Entregador</th>${g.dias.map((d, k) => html`<th scope="col" class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}">${diaFmt(d)}</th>`)}<th scope="col" class="n c-int">Total do intervalo</th></tr></thead>
<tbody>${itens.map(linhaDia)}</tbody>
<tfoot><tr class="tot"><th scope="row" class="c-nome"><span data-esc>Total do intervalo</span><small data-esc-n></small></th>${g.dias.map((d, k) => html`<td class="n dcol" data-d="${d}" data-sem="${Math.floor(k / 7)}" data-tdia="${d}">${brl(g.totDia[d])}</td>`)}<td class="n c-int" data-tint>${brl(0)}</td></tr></tfoot></table></div>
<p class="fc-vazio" data-vazio hidden>Nenhum entregador com esta busca ou filtro. <button type="button" class="btn btn-sec btn-sm" data-limpar-filtros>Limpar busca e filtros</button></p>
<details class="fin-legenda"><summary>Como ler esta tabela</summary><p>Valores do Relatório de Pedidos do Agilizone (taxa do entregador) por dia. Ajustes (ocorrências e já pago) não têm data: aparecem só no Resumo, por isso o total do intervalo não inclui ajustes.</p></details>
</section></form>
<section class="card painel" id="hist" role="tabpanel" aria-labelledby="t-hist" hidden>
${decisoes.length ? html`<div class="tw"><table><caption class="sr">Decisões do financeiro</caption><thead><tr><th scope="col">Quando</th><th scope="col">Decisão</th><th scope="col">Entregador</th><th scope="col" class="n">Valor</th><th scope="col">PIX considerado</th><th scope="col" class="n">Versão</th><th scope="col">Responsável</th></tr></thead><tbody>
${decisoes.map((d) => html`<tr><td>${quando(d.quando)}</td><td><span class="badge ${d.tipo === 'Aprovado' ? 'ok' : 'bad'}">${d.tipo}</span>${d.motivo ? html`<div class="quote">${d.motivo}</div>` : ''}${d.para ? html`<div class="mut small">Avisados: ${d.para}</div>` : ''}</td>
<td>${nomeDe(d.motoboy_id, d.entregador)}</td><td class="n">${d.valor == null ? '—' : brl(d.valor)}</td><td>${d.pix || '—'}</td><td class="n">${d.versao ?? '—'}</td><td>${d.por || '—'}</td></tr>`)}</tbody></table></div>`
    : html`<p class="vazio-p">Nenhuma decisão registrada ainda.</p>`}
<div class="card-b"><h3 class="sec-t">Linha do tempo</h3><ul class="timeline">${hist.map((h) => html`<li>${h.acao}<small>${quando(h.quando)} · ${h.nome || 'Sistema'}</small></li>`)}</ul></div></section></div>
<script type="application/json" id="fc-dados">${json}</script>
<details class="fold fc-mais"><summary>Dados do envio</summary><dl class="fc-mais-dl"><div><dt>Enviado por</dt><dd>${f.enviou || f.autor || '—'}</dd></div><div><dt>Enviado em</dt><dd>${f.enviado_em ? quando(f.enviado_em) : '—'}</dd></div><div><dt>Versão</dt><dd>${f.versao}</dd></div><div><dt>Arquivo importado</dt><dd>${nomeArq(f.arquivo) || '—'}</dd></div></dl></details>
<dialog id="dlg-det" class="dlg sheet" aria-labelledby="det-t"><div class="sheet-h"><div><div class="eyebrow">Detalhe do entregador</div><h2 id="det-t"></h2><span class="badge" id="det-sit"></span></div><button type="button" class="icon-btn alvo-ic" data-det-fecha aria-label="Fechar detalhe">${icone('erro')}</button></div>
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
    titulo: `Fechamento #${f.id}`, financeiro: true, compacto: true, selo: seloFin({ ...f, nAprov }), largura: 'larga', css: '/marca/conferencia.css', js: '/marca/conferencia.js',
    sub: html`<b>${f.loja}</b> · período ${periodo(f)} · versão ${f.versao}${f.pagamento ? html` · pagamento previsto <b>${diaLongo(f.pagamento)}</b>` : ''}`,
    trilha: [[voltar.startsWith('/pagar') ? 'Pagamentos' : u.perfil === 'financeiro' ? 'Para aprovar' : inicio(u), voltar], [`#${f.id} · ${lojaCurta(f.loja)}`]],
    acoes: html`<a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/pdf" target="_blank">${icone('arquivo', 'sm')} Baixar PDF</a><a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/xlsx">${icone('baixar', 'sm')} Baixar Excel</a>`,
  }, html`${aviso}${vinculo(f)}
${f.justificativa && f.status !== 'rascunho' ? html`<div class="alert warn" role="note">${icone('balao')}<div><b>Justificativa da loja para a diferença com o Resumo</b>${f.justificativa}</div></div>` : ''}
${nBloq ? html`<div class="alert bad" role="note"><div><b>${nBloq} entregador(es) bloqueado(s)</b>Sem Pix não é possível aprovar. Confira os itens e devolva para correção.</div></div>` : ''}
<dl class="resumo" aria-label="Valores do fechamento">
<div><dt>Total solicitado</dt><dd>${brl(g.total)}</dd><dd>${conta(() => true)} entregador(es)${g.temOc ? html` · inclui ${g.totOc > 0 ? '+' : ''}${brl(g.totOc)} de ocorrências` : ''}</dd></div>
<div><dt>Aprovado</dt><dd class="${nAprov ? 'ok-t' : ''}">${brl(soma(ehAp))}</dd><dd>${nAprov} entregador(es)</dd></div>
<div class="destaque"><dt>Falta analisar</dt><dd>${brl(soma(ehPend))}</dd><dd>${conta(ehPend)} de ${conta(() => true)} entregador(es)${nBloq ? ` · ${nBloq} bloqueado(s)` : ''}</dd></div>
<div><dt>Devolvido</dt><dd class="${conta(ehDev) ? 'bad-t' : ''}">${brl(soma(ehDev))}</dd><dd>${conta(ehDev)} entregador(es)</dd></div></dl>
${blocoConferencia({ f, g, itens, decide, edita: false, modo: 'fin', decisoes, hist, nomeDe, avisados, voltar })}`));
}

// Histórico: consulta com filtros de situação, período (data do pagamento previsto), loja e entregador. Padrão: tudo.
app.get('/historico', (req, res) => {
  if (req.user.perfil === 'despachante') return res.redirect('/'); // o despachante trabalha só pelas Pendências
  const u = req.user, q = req.query, todos = fechamentosDe(u);
  const SIT = { '': 'Todos', rascunho: 'Em conferência', enviado: 'Aguardando aprovação', pago: 'Aprovados', arquivado: 'Arquivados' };
  const s = q.s in SIT ? q.s : '';
  const per = periodoSel({ ...q, per: q.per || 'tudo' }, agora().data), dataF = (f) => f.pagamento || f.data_fim;
  const lojas = veTudo(u) ? db.prepare('SELECT id, nome FROM lojas ORDER BY nome').all().filter((l) => todos.some((f) => f.loja_id === l.id)) : [];
  const loja = lojas.some((l) => String(l.id) === q.loja) ? Number(q.loja) : 0;
  const busca = String(q.q || '').trim().slice(0, 80), bq = semAcento(busca);
  // Fechamentos em que aparece um entregador com esse nome (Relatório de Pedidos ou Resumo).
  const comEnt = bq ? new Set(db.prepare('SELECT DISTINCT fechamento_id id, entregador FROM resumo UNION SELECT DISTINCT fechamento_id, entregador FROM pedidos').all().filter((x) => semAcento(x.entregador || '').includes(bq)).map((x) => x.id)) : null;
  const base = todos.filter((f) => per.dentro(dataF(f)) && (!loja || f.loja_id === loja) && (!comEnt || comEnt.has(f.id)));
  const daSit = (k) => base.filter((f) => (k === 'arquivado' ? !!f.arquivado_em : !f.arquivado_em && (!k || f.status === k)));
  const lista = daSit(s);
  const perQ = per.param === 'tudo' ? '' : per.tipo === 'semana' ? 'semana' : per.param; // "tudo" é o padrão daqui: não vai na URL
  const qs = (o = {}) => { const p = new URLSearchParams(), v = { s, per: perQ, mes: per.mes, ini: per.cini, fim: per.cfim, loja: loja || '', q: busca, ...o };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x); return p.size ? `/historico?${p}` : '/historico'; };
  const filtros = [per.tipo !== 'tudo', loja, busca].filter(Boolean).length;
  res.send(page(req, { titulo: 'Histórico', sub: 'Todos os fechamentos. Filtre por situação, data do pagamento, loja ou entregador.' }, html`
<div class="ferramentas"><nav class="seg" aria-label="Situação">${Object.entries(SIT).map(([k, t]) => html`<a href="${qs({ s: k })}" class="${s === k ? 'on' : ''}" ${s === k ? new Raw('aria-current="page"') : ''}>${t}<span class="c">${daSit(k).length}</span></a>`)}</nav>
<form method="get" action="/historico" class="hist-f" role="search">${[['s', s], ['per', perQ], ['mes', per.mes], ['ini', per.cini], ['fim', per.cfim]].filter(([, v]) => v).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
${lojas.length > 1 ? html`<label class="sr" for="h-loja">Loja</label><select id="h-loja" name="loja" onchange="this.form.submit()"><option value="">Todas as lojas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === loja ? 'selected' : ''}>${lojaCurta(l.nome)}</option>`)}</select>` : ''}
<div class="search">${icone('busca', 'sm')}<input type="search" name="q" value="${busca}" placeholder="Buscar entregador" aria-label="Buscar fechamentos por entregador"></div><button class="btn btn-sec btn-sm">Buscar</button>
${filtros ? html`<a class="btn btn-ghost btn-sm" href="${s ? `/historico?s=${s}` : '/historico'}">Limpar filtros</a>` : ''}</form></div>
${barraPeriodo(per, todos.filter((f) => (!loja || f.loja_id === loja) && (!comEnt || comEnt.has(f.id))).map(dataF), (o) => qs({ per: o.per, mes: o.mes, ini: o.ini, fim: o.fim }), 'pela data do pagamento previsto (ou o fim do período)', 'tudo')}
<div class="tw card"><table class="tab-hist"><thead><tr><th scope="col">Pagamento previsto</th><th scope="col">Período</th>${veTudo(u) ? html`<th scope="col">Loja</th>` : ''}<th scope="col">Situação</th><th scope="col" class="n">Total</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${lista.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td class="c-pag"><b>${f.pagamento ? diaLongo(f.pagamento) : '—'}</b><span class="mut small"> ${f.pagamento ? dataFmt(f.pagamento).slice(6) : ''}</span></td><td class="c-per">${periodo(f)}</td>${veTudo(u) ? html`<td class="c-loja">${f.loja}</td>` : ''}<td class="c-sit">${selo(f, f.devolvido)}</td><td class="n c-tot">${brl(f.total)}</td><td class="n c-acao"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir</a></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="6" class="vazio-p">Nenhum fechamento ${s ? `com a situação "${SIT[s].toLowerCase()}"` : ''}${busca ? ` com o entregador "${busca}"` : ''}${filtros ? ' nestes filtros' : ''}.${filtros ? html` <a href="${s ? `/historico?s=${s}` : '/historico'}">Limpar filtros</a>` : ''}</td></tr>`}</tbody></table></div>`));
});

// Primeira configuração (admin): o que falta para o sistema funcionar, cada item leva à tela certa.
function checklistAdmin() {
  const nLojas = db.prepare('SELECT COUNT(*) n FROM lojas').get().n, perfis = new Set(db.prepare("SELECT perfil FROM usuarios WHERE ativo = 1").all().map((x) => x.perfil));
  const itens = [['Lojas e calendários de pagamento', nLojas > 0, '/config', `${nLojas} loja(s) cadastrada(s)`],
    ['Usuários: despachante e financeiro', perfis.has('despachante') && perfis.has('financeiro'), '/usuarios', perfis.has('despachante') && perfis.has('financeiro') ? 'Perfis principais cadastrados' : `Falta: ${['despachante', 'financeiro'].filter((p) => !perfis.has(p)).map((p) => PERFIS[p]).join(' e ')}`],
    ['Notificações por e-mail', !!(cfg('email_para') && cfg('smtp_host')), '/config', !cfg('email_para') ? 'Sem destinatários: o envio ao financeiro exige pelo menos um' : !cfg('smtp_host') ? 'Sem servidor: os e-mails não saem e o envio ao financeiro fica bloqueado' : 'Configuradas']];
  if (itens.every((i) => i[1])) return '';
  return html`<section class="conferencia" aria-labelledby="chk-t"><h2 id="chk-t">Configuração pendente</h2><ol>${itens.map(([t, ok, href, txt]) => html`<li class="${ok ? 'ok' : 'warn'}"><a href="${href}"><span class="marca" aria-hidden="true">${icone(ok ? 'check' : 'alerta', 'sm')}</span><span><b>${t}</b><span>${txt}</span></span></a></li>`)}</ol></section>`;
}
app.get('/', (req, res) => {
  if (req.user.perfil === 'despachante') return pendenciasDespachante(req, res);
  if (req.user.perfil === 'financeiro') return filaFinanceiro(req, res);
  if (req.user.perfil === 'conferente') return res.redirect('/conferencia');
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
  const filtro = ['rascunho', 'enviado', 'aprovado', 'pago'].includes(req.query.s) ? req.query.s : '';
  const casa = (f, st) => (st === 'aprovado' ? f.status === 'pago' && !f.pago_em : st === 'pago' ? !!f.pago_em : f.status === st); // aprovado = sem pagamento registrado; pago = transferência registrada
  const mes0 = hoje.slice(0, 7), mesDe = (f) => (f.pagamento || f.data_fim).slice(0, 7), per = periodoSel(req.query, hoje), dataF = (f) => f.pagamento || f.data_fim;
  const doMes = verArq ? arquivados : todos.filter((f) => f.status !== 'pago' || per.dentro(dataF(f)));
  const daLoja = lojaF ? doMes.filter((f) => f.loja_id === lojaF) : doMes;
  const lista = filtro ? daLoja.filter((f) => casa(f, filtro)) : daLoja;
  const conta = (s) => todos.filter((f) => f.status === s);
  const mes = AG.soma(hoje, -30);
  const sub = { despachante: 'Importe o relatório do Agilizone no dia do pagamento, confira e envie ao financeiro.', financeiro: 'Solicitações de pagamento enviadas pelas lojas.', gestao: 'Somente leitura: acompanhe o que aguarda aprovação, o que foi aprovado e ainda está a pagar e o que já foi pago.', admin: 'Visão geral de todas as lojas. Aprovar é na tela de cada fechamento; registrar pagamentos é em Pagamentos.' }[u.perfil];
  const qs = (st) => { const p = new URLSearchParams(); if (st) p.set('s', st); if (lojaF) p.set('loja', lojaF); if (per.param) p.set('per', per.param); if (per.mes) p.set('mes', per.mes); if (per.cini) p.set('ini', per.cini); if (per.cfim) p.set('fim', per.cfim); if (verArq) p.set('arq', '1'); return p.size ? `/?${p}` : '/'; };
  const hrefAdm = (o) => { const p = new URLSearchParams(); if (filtro) p.set('s', filtro); if (lojaF) p.set('loja', lojaF); if (o.per && o.per !== 'semana') p.set('per', o.per); if (o.mes) p.set('mes', o.mes); if (o.ini) p.set('ini', o.ini); if (o.fim) p.set('fim', o.fim); return p.size ? `/?${p}` : '/'; };
  const seg = (st, txt, n) => html`<a href="${qs(st)}" class="${filtro === st ? 'on' : ''}">${txt}<span class="c">${n}</span></a>`;
  const contaL = (st) => daLoja.filter((f) => casa(f, st)).length;

  res.send(page(req, { titulo: 'Fechamentos', compacto: true, sub, css: '/marca/admin.css', js: '/marca/admin.js', acoes: editaMotoboy(u) ? html`<a class="btn btn-pri" href="/fechamentos/novo">${icone('mais')} Novo fechamento</a>` : '' }, html`
${devolvidos.length ? html`<section class="aviso-dev" aria-label="Devolvidos para correção"><h2>${devolvidos.length === 1 ? 'O financeiro devolveu um fechamento' : `O financeiro devolveu ${devolvidos.length} fechamentos`}</h2>
${devolvidos.map((f) => html`<a class="aviso-item" href="/fechamentos/${f.id}"><span><b>${f.loja} · ${f.pagamento ? `pagamento de ${diaLongo(f.pagamento)}` : periodo(f)}</b>
<span class="quote">${f.motivo ? f.motivo.acao.replace(/^Devolveu para correção: /, '') : ''}</span><small class="mut">${f.motivo ? `${f.motivo.nome || ''}, ${f.motivo.quando.slice(0, 16)}` : ''}</small></span><span class="btn btn-pri btn-sm">Corrigir</span></a>`)}</section>` : ''}
${u.perfil === 'despachante' ? '' : html`<div class="stats">
<div class="card stat"><span class="hico ${atrasados ? 'warn' : 'ok'}">${icone(atrasados ? 'alerta' : 'check')}</span><div><div class="v">${atrasados}</div><div class="l">Pagamento(s) atrasado(s)</div></div></div>
<div class="card stat"><span class="hico warn">${icone('lapis')}</span><div><div class="v">${conta('rascunho').length}</div><div class="l">Em conferência nas lojas</div></div></div>
<div class="card stat"><span class="hico info">${icone('relogio')}</span><div><div class="v">${brl(conta('enviado').reduce((t, f) => t + f.total, 0))}</div><div class="l">${conta('enviado').length} aguardando aprovação</div></div></div>
<div class="card stat"><span class="hico warn">${icone('carteira')}</span><div><div class="v">${brl(todos.filter((f) => f.status === 'pago' && !f.pago_em).reduce((t, f) => t + f.total, 0))}</div><div class="l">Aprovado, sem pagamento registrado · ${todos.filter((f) => f.status === 'pago' && !f.pago_em).length}</div></div></div>
<div class="card stat"><span class="hico ok">${icone('check')}</span><div><div class="v">${brl(todos.filter((f) => f.pago_em && f.pago_em.slice(0, 7) === mes0).reduce((t, f) => t + f.total, 0))}</div><div class="l">Pago este mês (registrado)</div></div></div></div>`}
${u.perfil === 'despachante' ? '' : html`<p class="escopo-ind">${icone('info', 'sm')} Indicadores de todas as lojas e períodos, sem os filtros da lista. A lista abaixo segue loja, situação e período.</p>`}
${editaMotoboy(u) ? (() => { const amanha = AG.soma(hoje, 1), fazer = itens.filter((p) => !p.f && (['hoje', 'atrasado'].includes(p.situacao) || p.pagamento === amanha)), atr = fazer.filter((p) => p.situacao === 'atrasado').length; return fazer.length ? html`<div class="faixa ${atr ? 'bad' : ''}">${icone(atr ? 'alerta' : 'calendario')}<p><b>${fazer.length} pagamento(s) para importar</b>${atr ? html`, ${atr} atrasado(s)` : ''}. <a href="#agenda">Ver na agenda</a></p><a class="btn btn-pri btn-sm" href="/fechamentos/novo">${icone('subir', 'sm')} Importar</a></div>` : ''; })() : ''}
${doUsuario.length ? html`<div class="card"><div class="card-h"><div class="t"><h2>${verArq ? 'Fechamentos arquivados' : 'Fechamentos'}</h2>
<p>${verArq ? 'Não contam como fechamento válido. Abra um para ver ou recuperar.' : 'Clique em uma linha para abrir. O que está em andamento aparece sempre; os aprovados seguem o período.'}</p></div>
${lojas.length ? html`<form method="get" action="/" class="sel-loja">${filtro ? html`<input type="hidden" name="s" value="${filtro}">` : ''}${per.param ? html`<input type="hidden" name="per" value="${per.param}">` : ''}${per.mes ? html`<input type="hidden" name="mes" value="${per.mes}">` : ''}${per.cini ? html`<input type="hidden" name="ini" value="${per.cini}">` : ''}${per.cfim ? html`<input type="hidden" name="fim" value="${per.cfim}">` : ''}${verArq ? html`<input type="hidden" name="arq" value="1">` : ''}<select name="loja" onchange="this.form.submit()" aria-label="Filtrar por loja"><option value="">Todas as lojas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === lojaF ? 'selected' : ''}>${l.nome}</option>`)}</select></form>` : ''}</div>
<nav class="seg" style="padding:0 20px;margin:0" aria-label="Fechamentos"><a href="/" class="${verArq ? '' : 'on'}">Fechamentos<span class="c">${todos.length}</span></a><a href="/?arq=1" class="${verArq ? 'on' : ''}">Arquivados<span class="c">${arquivados.length}</span></a></nav>
${verArq || !todos.some((f) => f.status === 'pago') ? '' : html`<div style="padding:14px 20px 0">${barraPeriodo(per, todos.filter((f) => f.status === 'pago').map(dataF), hrefAdm, 'vale para os aprovados; o que está em andamento aparece sempre')}</div>`}
${u.perfil === 'despachante' ? '' : html`<div class="ferramentas" style="padding-top:14px"><nav class="pills" aria-label="Filtrar por situação"><span class="rot">Mostrar:</span>${seg('', 'Todos', daLoja.length)}${seg('rascunho', 'Em conferência', contaL('rascunho'))}${seg('enviado', 'Aguardando aprovação', contaL('enviado'))}${seg('aprovado', 'Aprovados, sem pagamento registrado', contaL('aprovado'))}${seg('pago', 'Pagos (registrados)', contaL('pago'))}</nav></div>`}
<div class="tw"><table><thead><tr><th scope="col">Pagamento previsto</th><th scope="col">Loja</th><th scope="col">Período das entregas</th><th scope="col">Situação</th><th scope="col" class="n">Entregadores</th><th scope="col" class="n">Total</th><th scope="col"><span class="sr">Ação</span></th></tr></thead><tbody>
${lista.map((f) => html`<tr data-href="/fechamentos/${f.id}"><td><b>${f.pagamento ? diaLongo(f.pagamento) : '—'}</b></td><td>${f.loja}</td><td>${periodo(f)}<div class="mut small">por ${f.autor}</div></td><td>${f.arquivado_em ? html`<span class="badge nodot">Arquivado em ${dataFmt(f.arquivado_em.slice(0, 10))}</span>` : html`${selo(f, f.devolvido)}${f.pago_em ? html`<div class="mut small">Transferência registrada em ${dataFmt(f.pago_em.slice(0, 10))}</div>` : ''}`}</td>
<td class="n">${f.n}</td><td class="n b">${brl(f.total)}</td><td class="n"><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}">Abrir ${icone('chevron', 'sm')}</a></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="7" class="mut" style="text-align:center;padding:32px">Nenhum fechamento nesta situação.</td></tr>`}</tbody></table></div></div>`
    : html`<div class="card empty"><div class="hico pri">${icone('moto', 'lg')}</div><h2>Nenhum fechamento ainda</h2>
<p>${editaMotoboy(u) ? 'No dia do pagamento, exporte os dois arquivos do Agilizone e importe aqui. O sistema calcula quanto cada entregador recebe por dia.' : 'Quando as lojas enviarem as solicitações de pagamento, elas aparecem aqui.'}</p>
${editaMotoboy(u) ? html`<div style="max-width:820px;margin:0 auto 20px">${COMO_EXPORTAR}</div><a class="btn btn-pri btn-lg" href="/fechamentos/novo">${icone('subir')} Importar primeiro relatório</a>` : ''}</div>`}
${u.perfil === 'admin' ? checklistAdmin() : ''}
${html`<details class="agenda-rec" id="agenda-rec" ${atrasados ? new Raw('open') : ''}><summary>${icone('calendario', 'sm')} Agenda de pagamentos <span class="c">${itens.length}</span></summary>${cardAgenda(u, itens)}</details>`}
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
  const erro = req.query.erro && req.query.k === assina('erro', req.query.erro) ? req.query.erro : '', campo = ['resumo', 'dia', 'api'].includes(req.query.campo) ? req.query.campo : 'arquivo', modoDia = req.query.modo === 'dia';
  const diaQ = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dia || '') ? req.query.dia : '', lojaQ = Number(req.query.loja) || 0;
  const abrir = Number(req.query.abrir) && carregaF(req.query.abrir), podeAbrir = abrir && podeVer(u, abrir);
  const erroDe = (c) => (erro && campo === c ? html`<div class="erro-campo" id="erro-${c}" role="alert" tabindex="-1" data-foca>${icone('erro', 'sm')} <span>${erro}${podeAbrir ? html` <a href="/fechamentos/${abrir.id}">Abrir fechamento existente (#${abrir.id})</a>` : ''}<small class="erro-re">O navegador limpa os arquivos depois de um erro: escolha de novo ${modoDia ? 'o Resumo (.csv)' : 'os dois arquivos'}.</small></span></div>` : '');
  const apiOk = !!p && AGZ_API.configurada(p.loja);
  const cartaoApi = apiOk ? html`<form method="post" action="/fechamentos/novo/api" class="card importar-api" data-carregando="Buscando os pedidos no Agilizone…"><input type="hidden" name="loja" value="${p.loja.id}"><input type="hidden" name="p" value="${p.pagamento}">
<div class="card-b"><h2 class="api-t">Importar direto do Agilizone</h2><p class="api-d">Busca os pedidos e a taxa de cada entregador de ${diaLongo(p.ini)} a ${diaLongo(p.fim)}, sem baixar nem enviar arquivos.</p>
${erro && campo === 'api' ? html`<div class="erro-campo" role="alert" tabindex="-1" data-foca>${icone('erro', 'sm')} <span>${erro}${podeAbrir ? html` <a href="/fechamentos/${abrir.id}">Abrir fechamento existente (#${abrir.id})</a>` : ''}</span></div>` : ''}</div>
<div class="card-f"><button class="btn btn-pri btn-lg">${icone('subir')} Importar do Agilizone</button><a class="btn btn-ghost" href="/">Cancelar</a></div></form>` : p ? html`<div class="alert warn" role="note">${icone('alerta')}<div><b>${p.loja.nome} ainda não está ligada ao Agilizone</b>${u.perfil === 'admin' ? html`<p>Defina no servidor as variáveis <b>${AGZ_API.variaveis(p.loja).id}</b> e <b>${AGZ_API.variaveis(p.loja).secret}</b> e reinicie o serviço. Enquanto isso, importe pelos arquivos abaixo.</p>` : html`<p>Peça ao suporte para ligar esta loja. Enquanto isso, importe pelos arquivos abaixo.</p>`}</div></div>` : '';
  const upload = (n, name, accept, titulo, ext) => html`<li class="upload"><span class="num" aria-hidden="true">${n}</span><div class="field">
<label for="f-${name}">${titulo} <span class="chip-ext">${ext.replace('.', '').toUpperCase()}</span></label>
<label class="drop ${erro && campo === name ? 'erro' : ''}">${icone('subir')}<b class="drop-t">Escolher arquivo</b><span class="fname" aria-live="polite"></span>
<input id="f-${name}" type="file" name="${name}" accept="${accept}" required ${new Raw(erro && campo === name ? `aria-invalid="true" aria-describedby="erro-${name}"` : '')}></label>${erroDe(name)}</div></li>`;
  res.send(page(req, { titulo: 'Importar fechamento', compacto: true, eyebrow: 'Fechamento de entregadores', trilha: [[inicio(u), '/'], ['Importar fechamento']], erroNoCampo: true, sub: 'Importe do Agilizone ou envie os arquivos. Revise os totais após a leitura, antes de enviar ao financeiro.' }, html`<div class="split imp"><div class="stack">
${p ? html`<section class="contexto" aria-label="Período a importar">
<div><span class="mut small">${p.situacao === 'atrasado' ? 'Envio atrasado · pagamento previsto' : p.situacao === 'futuro' ? 'Próximo pagamento previsto' : 'Pagamento previsto'}</span><b>${diaLongo(p.pagamento)}</b><span class="small">${p.loja.nome} · Entregas: ${dataFmt(p.ini)} a ${dataFmt(p.fim)}</span></div>
<div class="filtro"><span class="mut small">Filtro sugerido no Agilizone (orientação: loja e período são lidos dos próprios arquivos)</span><dl><div><dt>Data inicial</dt><dd>${dataFmt(p.ini)} ${FILTRO_HORA}</dd></div><div><dt>Data final</dt><dd>${dataFmt(AG.soma(p.fim, 1))} ${FILTRO_HORA}</dd></div></dl></div>
${opcoes.length > 1 ? html`<nav class="outros" aria-label="Outros períodos pendentes"><span class="mut small">Outro período pendente:</span>${opcoes.filter((x) => x !== p).map((x) => html`<a href="/fechamentos/novo?p=${x.pagamento}&l=${x.loja.id}">${diaLongo(x.pagamento)}${lojas.length > 1 ? ` · ${lojaCurta(x.loja.nome)}` : ''}</a>`)}</nav>` : ''}
</section>` : ''}
${cartaoApi}${apiOk ? new Raw('<details class="alt-arq"><summary>Enviar arquivos (alternativa)</summary>') : ''}<form method="post" enctype="multipart/form-data" class="card importar" data-modo data-carregando="Lendo os arquivos…"><div class="card-b">
<fieldset class="modo"><legend>O que você vai pagar?</legend><div class="modo-op">
<label><input type="radio" name="modo" value="periodo" ${modoDia ? '' : new Raw('checked')}><span><b>Vários dias</b><small>Relatório de Pedidos + Resumo: mostra o valor de cada dia</small></span></label>
<label><input type="radio" name="modo" value="dia" ${modoDia ? new Raw('checked') : ''}><span><b>Só 1 dia</b><small>Só o Resumo de entregas</small></span></label></div></fieldset>
<div class="field dia-campo" data-so-dia ${modoDia ? '' : new Raw('hidden')}>${u.perfil === 'admin' ? html`<label for="f-loja">Loja</label><select id="f-loja" name="loja"><option value="">Escolha a loja</option>${lojas.map((x) => html`<option value="${x.id}" ${x.id === lojaQ ? new Raw('selected') : ''}>${x.nome}</option>`)}</select>` : ''}
<label for="f-dia">Dia das entregas</label><input id="f-dia" type="date" name="dia" max="${hoje}" value="${diaQ}" ${new Raw(erro && campo === 'dia' ? 'aria-invalid="true" aria-describedby="erro-dia"' : '')}>${erroDe('dia')}<p class="hint">No Agilizone, filtre do dia escolhido às ${FILTRO_HORA} até o dia seguinte às ${FILTRO_HORA} e use só <b>Exportar Resumo</b>.</p></div>
<div class="alert bad aviso-abrir" role="note">${icone('alerta')}<div><b>Não abra os arquivos antes de importar</b>
<p>Abrir no Excel estraga as chaves PIX. Se abriu, baixe de novo no Agilizone.</p></div></div>
<ol class="uploads">${upload(1, 'arquivo', '.xlsx,.xls', 'Relatório de Pedidos (botão "Exportar Pedidos")', '.xlsx')}${upload(2, 'resumo', '.csv,text/csv', 'Resumo de entregas (botão "Exportar Resumo")', '.csv')}</ol>
</div>
<div class="card-f"><button class="btn btn-pri btn-lg">Importar e revisar</button><a class="btn btn-ghost" href="/">Cancelar</a></div></form>${apiOk ? new Raw('</details>') : ''}</div>
<aside class="card guia" aria-label="Como exportar no Agilizone"><div class="card-h"><span class="hico pri">${icone('info')}</span><div class="t"><h2>Como exportar no Agilizone</h2><p data-guia-periodo ${modoDia ? new Raw('hidden') : ''}>Vários dias: dois arquivos, da mesma tela e com o mesmo filtro.</p><p data-guia-dia ${modoDia ? '' : new Raw('hidden')}>Só 1 dia: apenas o Resumo.</p></div></div><div class="card-b"><div data-guia-periodo ${modoDia ? new Raw('hidden') : ''}>${COMO_EXPORTAR}</div><div data-guia-dia ${modoDia ? '' : new Raw('hidden')}>${COMO_EXPORTAR_DIA}</div>
<ul class="regras"><li>${icone('check', 'sm')} <span>Exporte os dois arquivos da <b>mesma tela</b>, com o <b>mesmo filtro</b>. Para <b>1 dia</b>, só o Resumo.</span></li><li>${icone('check', 'sm')} <span>Pedidos sem entregador são descartados automaticamente.</span></li><li>${icone('alerta', 'sm')} <span>Se algum pedido já estiver em outro fechamento, a importação é recusada (ninguém recebe duas vezes).</span></li>${u.perfil === 'admin' ? html`<li>${icone('alerta', 'sm')} <span><b>Admin:</b> a loja vem do nome no arquivo. Se esse nome não existir, o sistema <b>cria a loja</b> com o calendário padrão. Confira em Configurações › Lojas.</span></li>` : ''}</ul></div></aside></div>`));
});

const COMO_EXPORTAR_DIA = html`<div class="passos">
<div class="passo"><span class="n">1</span><p>No <b>Agilizone</b>, escolha a loja e abra <b>Relatório de Pedidos</b>.</p></div>
<div class="passo"><span class="n">2</span><p>Filtre do dia das entregas às <b>${FILTRO_HORA}</b> até o dia seguinte às <b>${FILTRO_HORA}</b> e clique em <b>Aplicar filtros</b>.</p></div>
<div class="passo"><span class="n">3</span><p>Clique em <b>Resumo de entregas por entregador</b> e depois em <b>Exportar Resumo</b>: baixa o <b>.csv</b>.</p></div>
<div class="passo"><span class="n">4</span><p>Aqui, escolha <b>Só 1 dia</b>, informe o dia e envie só esse arquivo.</p></div></div>`;
const doisArquivos = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20e6, files: 2 } }).fields([{ name: 'arquivo', maxCount: 1 }, { name: 'resumo', maxCount: 1 }]);
// Erro de validação da importação volta para o formulário, junto ao arquivo correspondente.
app.post('/fechamentos/novo', so((r) => editaMotoboy(r.user)), doisArquivos, (req, res, next) => {
  try { importar(req, res); } catch (e) {
    if (!e.publico) return next(e);
    const b = req.body || {}, dia = b.modo === 'dia', campo = e.campo || (dia || /resumo|\.csv/i.test(e.message) ? 'resumo' : 'arquivo');
    const p = new URLSearchParams({ campo });
    if (dia) p.set('modo', 'dia');
    if (/^\d{4}-\d{2}-\d{2}$/.test(b.dia || '')) p.set('dia', b.dia);
    if (Number(b.loja)) p.set('loja', Number(b.loja));
    if (e.abrir) p.set('abrir', e.abrir);
    volta(res, `/fechamentos/novo?${p}`, 'erro', e.message);
  }
});
// Fechamento de 1 dia: só o Resumo (o total do dia de cada entregador), sem o Relatório de Pedidos.
function importarDia(req, res, arq) {
  if (!arq) throw falha('Escolha o arquivo do Resumo (.csv) baixado em "Exportar Resumo".');
  const dia = String(req.body.dia || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia > agora().data) throw Object.assign(falha('Informe o dia das entregas (não pode ser no futuro).'), { campo: 'dia' });
  const l = db.prepare('SELECT * FROM lojas WHERE id = ?').get(req.user.perfil === 'admin' ? Number(req.body.loja) : req.user.loja_id);
  if (!l) throw falha('Escolha a loja.');
  const resumo = lerResumo(arq.buffer);
  const x = db.prepare('SELECT id, data_ini, data_fim FROM fechamentos WHERE loja_id = ? AND arquivado_em IS NULL AND data_ini <= ? AND data_fim >= ?').get(l.id, dia, dia);
  if (x) throw Object.assign(falha(`Pedidos já importados: o dia ${dataFmt(dia)} já está no fechamento #${x.id} (${periodo(x)}). Continue por ele; se ele estava errado, arquive-o e importe de novo.`), { abrir: x.id });
  const pagamento = AG.pagamentoDoDia(calendarioDa(l), dia);
  const fid = tx(() => {
    const fid = Number(db.prepare('INSERT INTO fechamentos (loja_id, data_ini, data_fim, criado_por, arquivo, pagamento, so_resumo) VALUES (?,?,?,?,?,?,1)')
      .run(l.id, dia, dia, req.user.id, nomeArq(arq.originalname), pagamento).lastInsertRowid);
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
  if (!req.file) throw falha('Escolha o Relatório de Pedidos (.xlsx) baixado em "Exportar Pedidos".');
  if (!arqResumo) throw falha('Escolha também o Resumo (.csv) baixado em "Exportar Resumo". Ele traz a chave PIX e o total de cada entregador para conferir.');
  const { loja, pedidos } = lerRelatorio(req.file.buffer);
  const resumo = lerResumo(arqResumo.buffer);
  let l = db.prepare('SELECT * FROM lojas WHERE nome = ?').get(loja);
  if (!l && req.user.perfil === 'admin') {
    db.prepare('INSERT INTO lojas (nome, calendario) VALUES (?, ?)').run(loja, AG.PADRAO);
    l = db.prepare('SELECT * FROM lojas WHERE nome = ?').get(loja);
  }
  if (!l) throw falha(`Loja não cadastrada: o arquivo é da loja "${loja}", que não está cadastrada. Peça ao suporte para cadastrar em Configurações (o nome tem que ser igual ao do Agilizone).`);
  if (req.user.perfil === 'despachante' && req.user.loja_id !== l.id) throw falha(`Loja incorreta: este arquivo é da loja "${loja}", que não é a sua. No Agilizone, escolha a sua loja antes de exportar.`, 403);
  return registra(req, res, l, loja, pedidos, resumo, nomeArq(req.file.originalname), arqResumo.originalname, 'arquivo');
}
// Grava o fechamento a partir dos pedidos e do resumo (vindos de arquivos ou da API do Agilizone).
function registra(req, res, l, loja, pedidos, resumo, nomeArquivo, nomeResumo, origem) {
  const comMotoboy = pedidos.filter((p) => p.entregador), semMotoboy = pedidos.length - comMotoboy.length;
  if (!comMotoboy.length) throw falha('O arquivo não tem nenhum pedido com entregador atrelado.');

  // Pedido que já está em outro fechamento: recusa tudo. O Resumo do período conta esses pedidos,
  // então importar "o resto" faria a tela sugerir repor um valor que já foi pago.
  const repetidos = db.prepare(`SELECT p.fechamento_id id, COUNT(*) n, f.data_ini, f.data_fim FROM pedidos p JOIN fechamentos f ON f.id = p.fechamento_id
    WHERE p.loja_id = ? AND p.ativo = 1 AND p.chave IN (SELECT value FROM json_each(?)) GROUP BY 1`).all(l.id, JSON.stringify(comMotoboy.map((p) => p.chave)));
  if (repetidos.length) throw Object.assign(falha(`Pedidos já importados: este arquivo tem pedidos que já estão em ${repetidos.map((x) => `#${x.id} (${periodo(x)}, ${x.n} pedidos em comum)`).join('; ')}. Ninguém recebe duas vezes, então nada foi importado. Continue pelo fechamento existente, ou exporte de novo só os dias que ainda não foram importados. Se o fechamento anterior estava errado, arquive-o e importe de novo.`), { abrir: repetidos[0].id });

  const cal = calendarioDa(l);
  const dias = [...new Set(comMotoboy.map((p) => p.dia))].sort();
  const umDia = db.prepare('SELECT data_ini FROM fechamentos WHERE loja_id = ? AND so_resumo = 1 AND arquivado_em IS NULL AND data_ini BETWEEN ? AND ?').all(l.id, dias[0], dias[dias.length - 1]);
  if (umDia.length) throw falha(`Pedidos já importados: o período exportado inclui ${umDia.map((x) => dataFmt(x.data_ini)).join(', ')}, que já está em um fechamento de 1 dia. Exporte de novo só os dias que ainda não foram importados.`);
  if (origem === 'api') { // o Agilizone não tem o número+horário dos arquivos: a trava contra pagar duas vezes é o período
    const x = db.prepare('SELECT id, data_ini, data_fim FROM fechamentos WHERE loja_id = ? AND arquivado_em IS NULL AND data_ini <= ? AND data_fim >= ?').get(l.id, dias[dias.length - 1], dias[0]);
    if (x) throw Object.assign(falha(`Pedidos já importados: o período já está no fechamento #${x.id} (${periodo(x)}). Continue por ele; se estava errado, arquive-o e importe de novo.`), { abrir: x.id });
  }
  const pagamento = AG.pagamentoDoDia(cal, dias[dias.length - 1]);
  const ref = pagamento ? AG.diasReferencia(cal, pagamento) : [];
  const fora = pagamento ? dias.filter((d) => !ref.includes(d)) : [];

  const fid = tx(() => {
    const fid = Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, criado_por, arquivo, pagamento) VALUES (?, ?, ?, ?, ?, ?)")
      .run(l.id, dias[0], dias[dias.length - 1], req.user.id, nomeArquivo, pagamento).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO pedidos (fechamento_id, loja_id, chave, numero, dia, entregador, motoboy_id, taxa, status)
      VALUES (?,?,?,?,?,?,COALESCE(?, (SELECT motoboy_id FROM apelidos WHERE loja_id = ? AND nome = ?)),?,?)`);
    const vistos = new Set();
    for (const p of comMotoboy) {
      if (vistos.has(p.chave)) throw falha(`O pedido ${p.numero} aparece duas vezes no arquivo com o mesmo horário. Exporte de novo do Agilizone.`);
      vistos.add(p.chave);
      ins.run(fid, l.id, p.chave, p.numero, p.dia, p.entregador, p.motoboyId ?? null, l.id, p.entregador, p.taxa, p.status);
    }
    log(req.user.id, `f:${fid}`, `Importou ${nomeArquivo}: ${comMotoboy.length} pedidos com entregador` + (semMotoboy ? `; ${semMotoboy} sem entregador descartados` : ''));
    if (pagamento) log(req.user.id, `f:${fid}`, `Pagamento de ${diaLongo(pagamento)} (referente a ${ref.map(diaLongo).join(', ')})`);
    if (fora.length) log(req.user.id, `f:${fid}`, `Atenção: dias fora do período desse pagamento: ${fora.map(diaLongo).join(', ')}`);
    const f = { id: fid, loja_id: l.id, loja };
    if (origem === 'arquivo') confereMesmoPeriodo(f, resumo);
    gravaResumo(f, resumo, req.user.id, nomeResumo);
    return fid;
  });
  fora.length ? volta(res, `/fechamentos/${fid}`, 'erro', `Importado, mas o arquivo tem dias fora do período do pagamento de ${diaLongo(pagamento)}: ${fora.map(diaLongo).join(', ')}. Confira o filtro de datas no Agilizone.`)
    : volta(res, `/fechamentos/${fid}`, 'ok', pagamento ? `Importado: pagamento de ${diaLongo(pagamento)}. Agora revise os valores.` : 'Importado. Agora revise os valores.');
}

// ---- Entregadores da loja (nome e chave PIX), em dia com o Agilizone ----
// O cadastro fica no banco: a chave digitada persiste e vale para todos os fechamentos. Entregador novo no Agilizone
// entra sozinho (busca em segundo plano ao subir, a cada 30 minutos e quando alguém abre a página).
const sincronizado = new Map(); // loja_id -> quando foi a última busca
let sincronizando = false;
async function sincronizaEntregadores(l, dias) {
  const lista = await AGZ_API.entregadores(l, dias), antes = db.prepare('SELECT COUNT(*) n FROM motoboys').get().n;
  for (const e of lista) {
    const id = motoboyDoAgilizone(l, e.id, e.nome), cpf = String(e.cpf || '').replace(/\D/g, '');
    if (cpf.length === 11 || cpf.length === 14) db.prepare("UPDATE motoboys SET cpf = ? WHERE id = ? AND IFNULL(cpf, '') = ''").run(cpf, id);
    if (e.pix && pixValido(e.pix) && !pixCadastro(l.id, id)?.pix) salvaPixCadastro(l.id, id, e.pix, null); // só preenche vazio; nunca sobrescreve
  }
  sincronizado.set(l.id, Date.now());
  return { achados: lista.length, novos: db.prepare('SELECT COUNT(*) n FROM motoboys').get().n - antes };
}
async function sincronizaTodas(dias) {
  if (sincronizando) return;
  sincronizando = true;
  try {
    for (const l of db.prepare('SELECT * FROM lojas').all().filter((x) => AGZ_API.configurada(x))) {
      try { const r = await sincronizaEntregadores(l, dias); if (r.novos) log(null, 'entregadores', `Cadastrou ${r.novos} entregador(es) novo(s) vindo(s) do Agilizone (${l.nome})`); }
      catch (e) { console.error(`Entregadores de ${l.nome}: ${e.message}`); }
    }
  } finally { sincronizando = false; }
}
// Quem trabalha na loja: ligado pela API ou que já aparece em pedidos dela.
const entregadoresDaLoja = (lojaId) => db.prepare(`SELECT m.*, p.pix, p.pix_em, p.pix_por, p.agz_id identidade FROM motoboys m LEFT JOIN entregador_pix p ON p.motoboy_id = m.id AND p.loja_id = ?1 WHERE ativo = 1 AND m.id IN (
  SELECT motoboy_id FROM loja_motoboys WHERE loja_id = ?1 UNION SELECT motoboy_id FROM pedidos WHERE loja_id = ?1 AND motoboy_id IS NOT NULL) ORDER BY nome COLLATE NOCASE`).all(lojaId);
function lojaEntregadores(req) {
  const u = req.user, lojas = ['admin', 'conferente'].includes(u.perfil) ? db.prepare('SELECT * FROM lojas ORDER BY nome').all() : db.prepare('SELECT * FROM lojas WHERE id = ?').all(u.loja_id);
  const todas = lojas.length > 1 && (req.query.ver ?? req.body?.ver) === 'todas';
  const solicitado = req.query.loja ?? req.body?.loja;
  const l = solicitado ? lojas.find((x) => x.id === Number(solicitado)) : lojas[0];
  if (!l) throw falha('Loja não encontrada.', 404);
  return { lojas, l, todas };
}
const urlEntregadores = (req, l, todas) => '/entregadores?' + new URLSearchParams({ loja: l.id, ver: todas ? 'todas' : '', f: req.body.f === 'sem' ? 'sem' : '', q: String(req.body.q || '').slice(0, 120) });
const nomeEnt = (m) => m.nome_completo || m.nome; // nome completo (planilha) ou apelido do Agilizone
app.get('/entregadores', so((r) => editaMotoboy(r.user)), (req, res) => {
  const u = req.user, { lojas, l, todas } = lojaEntregadores(req), conectada = !todas && AGZ_API.configurada(l);
  for (const x of todas ? lojas : [l]) if (AGZ_API.configurada(x) && Date.now() - (sincronizado.get(x.id) || 0) > 10 * 60e3) { // abrir a página também atualiza (sem travar a tela)
    sincronizado.set(x.id, Date.now());
    sincronizaEntregadores(x, 3).catch((e) => console.error(`Entregadores de ${x.nome}: ${e.message}`));
  }
  const todos = (todas ? lojas : [l]).flatMap((x) => entregadoresDaLoja(x.id).map((m) => ({ ...m, loja: x }))).sort((a, b) => nomeEnt(a).localeCompare(nomeEnt(b), 'pt-BR'));
  const soSem = req.query.f === 'sem', pend = (m) => !m.pix || !m.nome_completo || !CONF.docValido(m.cpf), sem = todos.filter(pend);
  const busca = String(req.query.q || '').trim().slice(0, 120);
  const lista = (soSem ? sem : todos).filter((m) => semAcento(`${m.nome} ${m.nome_completo || ''}`).includes(semAcento(busca)));
  const qs = (o = {}) => '/entregadores?' + new URLSearchParams({ loja: l.id, ver: todas ? 'todas' : '', f: soSem ? 'sem' : '', q: busca, ...o });
  const linha = (m) => { const k = `${m.loja.id}-${m.id}`; return html`<tr><th scope="row">${nomeEnt(m)}<small class="mut">${m.nome_completo && m.nome_completo !== m.nome ? `Agilizone: ${m.nome} · ` : ''}${lojaCurta(m.loja.nome)}${m.nome_completo ? '' : ' · Falta nome completo'}${m.identidade ? '' : ' · Identidade pendente'}</small></th><td>${m.cpf ? CONF.docFmt(m.cpf) : html`<span class="bad-t">Falta</span>`}</td><td>${m.nascimento ? m.nascimento.split('-').reverse().join('/') : '—'}</td><td>${m.pix ? mascaraPix(m.pix) : html`<span class="bad-t">Falta</span>`}</td><td class="n"><button type="button" class="btn btn-sec btn-sm" data-abre="pix-ed-${k}">Editar</button>
<dialog id="pix-ed-${k}" class="dlg sheet ent-sheet" aria-labelledby="pix-t-${k}"><h2 id="pix-t-${k}">Editar · ${nomeEnt(m)}</h2><p>${m.loja.nome} · no Agilizone: ${m.nome}</p><p class="hint">O Pix vale para as próximas importações desta loja. Nome completo e CPF/CNPJ valem para todas as lojas e vão na planilha.</p>
<form method="post" action="/entregadores/${m.id}"><input type="hidden" name="loja" value="${m.loja.id}"><input type="hidden" name="ver" value="${todas ? 'todas' : ''}"><input type="hidden" name="f" value="${soSem ? 'sem' : ''}"><input type="hidden" name="q" value="${busca}"><div class="field"><label for="nome-ed-${k}">Nome completo</label><input id="nome-ed-${k}" name="nome_completo" value="${m.nome_completo || ''}" placeholder="${m.nome}" maxlength="120" autocomplete="off"><p class="hint">Como no documento. Vai na planilha do financeiro.</p></div><div class="field"><label for="cpf-ed-${k}">CPF ou CNPJ</label><input id="cpf-ed-${k}" name="cpf" value="${m.cpf ? CONF.docFmt(m.cpf) : ''}" inputmode="numeric" maxlength="18" autocomplete="off"><p class="hint">11 números (CPF) ou 14 (CNPJ).</p></div><div class="field"><label for="nasc-ed-${k}">Data de nascimento</label><input id="nasc-ed-${k}" name="nascimento" type="date" value="${m.nascimento || ''}"></div><div class="field"><label for="pix-ed-c-${k}">Chave Pix</label><input id="pix-ed-c-${k}" name="pix" value="${m.pix || ''}" required maxlength="120" autocomplete="off"><p class="hint">CPF, CNPJ, celular, e-mail ou chave aleatória.</p></div>
${m.identidade ? '' : html`<p class="bad-t">Identidade pendente. Confirme o vínculo pelo id do Agilizone antes de cadastrar.</p>`}<div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Cancelar</button><button class="btn btn-pri" ${m.identidade ? '' : 'disabled'}>Salvar</button></div></form></dialog></td></tr>`; };
  res.send(page(req, { titulo: 'Entregadores', compacto: true, eyebrow: 'Cadastro', sub: todas ? 'Todas as lojas' : l.nome,
    acoes: conectada ? html`<form method="post" action="/entregadores/atualizar" data-carregando="Buscando no Agilizone…"><input type="hidden" name="loja" value="${l.id}"><input type="hidden" name="f" value="${soSem ? 'sem' : ''}"><input type="hidden" name="q" value="${busca}"><button class="btn btn-sec">Atualizar do Agilizone</button></form>` : '' }, html`
${lojas.length > 1 ? html`<nav class="pills" aria-label="Loja"><a href="${qs({ ver: 'todas' })}" class="${todas ? 'on' : ''}">Todas</a>${lojas.map((x) => html`<a href="${qs({ loja: x.id, ver: '' })}" class="${!todas && x.id === l.id ? 'on' : ''}">${lojaCurta(x.nome)}</a>`)}</nav>` : ''}
<section class="card"><div class="card-h"><div class="t"><h2>${todos.length} entregadores · ${sem.length} com cadastro incompleto</h2><p>Nome completo e CPF/CNPJ vão na planilha do financeiro; a chave Pix é por loja.</p></div></div>
<div class="card-b"><form method="get" class="linha-form"><input type="hidden" name="loja" value="${l.id}"><input type="hidden" name="ver" value="${todas ? 'todas' : ''}"><div class="field"><label for="ent-busca">Buscar por nome</label><input id="ent-busca" name="q" type="search" value="${busca}" placeholder="Nome do entregador"></div><label><input type="checkbox" name="f" value="sem" ${soSem ? 'checked' : ''}> Cadastro incompleto (sem nome completo, CPF/CNPJ ou Pix)</label><button class="btn btn-sec">Filtrar</button><a class="btn btn-ghost" href="${qs({q: '', f: ''})}">Limpar</a></form></div>
<div class="tw"><table><thead><tr><th>Entregador e loja</th><th>CPF/CNPJ</th><th>Nascimento</th><th>Chave Pix</th><th class="n">Ação</th></tr></thead><tbody>${lista.map(linha)}${lista.length ? '' : html`<tr><td colspan="5">Nenhum entregador com estes filtros.</td></tr>`}</tbody></table></div></section>`));
});
app.post('/entregadores/atualizar', so((r) => editaMotoboy(r.user)), async (req, res, next) => {
  const { l } = lojaEntregadores(req), url = '/entregadores?' + new URLSearchParams({loja:l.id, f:req.body.f === 'sem' ? 'sem' : '', q:String(req.body.q || '').slice(0,120)});
  if (!AGZ_API.configurada(l)) return volta(res, url, 'erro', 'Esta loja ainda não está ligada ao Agilizone.');
  try { const r = await sincronizaEntregadores(l, 80); volta(res, url, 'ok', `${r.achados} entregador(es) no Agilizone; ${r.novos} novo(s) cadastrado(s).`); }
  catch (e) { if (!e.publico) return next(e); volta(res, url, 'erro', e.message); }
});
app.post('/entregadores/:id', so((r) => editaMotoboy(r.user)), (req, res) => {
  const { l, todas } = lojaEntregadores(req), url = req.body.volta === 'conferencia' && confere(req.user) ? `/conferencia?d=${encodeURIComponent(String(req.body.d || ''))}&aba=${encodeURIComponent(String(req.body.aba || ''))}` : urlEntregadores(req, l, todas);
  const m = entregadoresDaLoja(l.id).find((x) => x.id === Number(req.params.id));
  if (!m) throw falha('Entregador não encontrado nesta loja.', 404);
  const pix = String(req.body.pix || '').trim();
  if (!pixValido(pix)) return volta(res, url, 'erro', `${m.nome}: chave PIX inválida. Use CPF, CNPJ, celular (com ou sem +55), e-mail ou chave aleatória.`);
  const cpf = String(req.body.cpf || '').replace(/\D/g, ''), nasc = String(req.body.nascimento || '').trim();
  const nomeC = String(req.body.nome_completo ?? m.nome_completo ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (cpf && !CONF.docValido(cpf)) return volta(res, url, 'erro', `${m.nome}: CPF deve ter 11 números e CNPJ 14.`);
  if (nomeC && nomeC.split(' ').length < 2) return volta(res, url, 'erro', `${m.nome}: informe o nome completo (nome e sobrenome).`);
  if (nasc && (!/^\d{4}-\d{2}-\d{2}$/.test(nasc) || isNaN(Date.parse(nasc)))) return volta(res, url, 'erro', `${m.nome}: data de nascimento inválida.`);
  if (!m.identidade) return volta(res, url, 'erro', 'Identidade pendente: este entregador precisa de vínculo pelo id do Agilizone. Nenhuma chave foi associada pelo nome.');
  const dadosMudaram = cpf !== (m.cpf || '') || nasc !== (m.nascimento || '') || nomeC !== (m.nome_completo || '');
  if (pix === m.pix && !dadosMudaram) return volta(res, url, 'ok', `${m.nome}: sem mudanças.`);
  tx(() => {
  if (dadosMudaram) { db.prepare('UPDATE motoboys SET cpf = ?, nascimento = ?, nome_completo = ? WHERE id = ?').run(cpf || null, nasc || null, nomeC || null, m.id); log(req.user.id, 'entregadores', `Cadastro de ${m.nome} atualizado (nome completo, CPF/CNPJ, nascimento)`); }
  if (pix !== m.pix) {
  salvaPixCadastro(l.id, m.id, pix, req.user.id);
  log(req.user.id, 'entregadores', `PIX de ${m.nome} (${l.nome}) ${m.pix ? `alterado de ${m.pix} para ${pix}` : `cadastrado: ${pix}`}`);
  }
  });
  volta(res, url, 'ok', `${m.nome}: dados salvos.`);
});

// ---- Conferência geral: todas as lojas de um dia de pagamento, numa planilha só ----
// Uma pessoa confere tudo (aba Geral + uma aba por loja), e o envio manda a planilha no modelo do financeiro
// por e-mail e para a pasta do Google Drive, com o título "DD-MM-AAAA - MOTOBOYS". O fluxo por fechamento segue disponível.
// Centro de custo: o nome curto da loja (LESTE, DIRCEU, SUL...).
const centroDa = (l) => lojaCurta(l.nome).replace(/centro de distribui[cç][aã]o\s*/i, '').replace(/\s+ativa$/i, '').trim().toUpperCase();
const CONF_INI = '12:00'; // período da conferência geral: 12h do 1º dia de referência até o corte (Configurações > Alertas, padrão 05:00) do dia do pagamento
const corteHora = () => cfg('hora_corte') || '05:00';
const cacheConf = new Map(); // `${loja}|${data}` -> { em, resumo } (5 min; "Atualizar do Agilizone" ignora)
async function lojaNoDia(l, d, renova) {
  const ref = AG.diasReferencia(calendarioDa(l), d);
  if (!ref) return null; // a loja não paga nesse dia
  const base = { loja: l, ini: ref[0], fim: ref[ref.length - 1], itens: [], erro: '' };
  if (!AGZ_API.configurada(l)) return { ...base, erro: 'Loja sem credenciais do Agilizone (Configurações > Lojas).' };
  const k = `${l.id}|${d}|${corteHora()}`;
  let c = cacheConf.get(k);
  if (renova || !c || Date.now() - c.em > 5 * 60e3) {
    try {
      // Do 1º dia de referência às 12h até o dia do pagamento no horário de corte (Teresina).
      const orders = await AGZ_API.pedidos(l, `${base.ini}T${CONF_INI}:00-03:00`, `${d}T${corteHora()}:59-03:00`); // o Agilizone inclui o minuto final (05:00 vale até 05:00:59)
      const pi = AGZ_API.paraImportacao(orders, { tz: TZ });
      c = { em: Date.now(), resumo: pi.resumo, excluidos: pi.excluidos, total: orders.length };
      cacheConf.set(k, c);
    } catch (e) { return { ...base, erro: e.message }; }
  }
  // Ocorrências do painel (mesmo período), quando a loja tem o storeId DO PAINEL (24 letras/números; o código com traços da API oficial é outro) e há acesso ao painel.
  base.ocAuto = !!(/^[0-9a-f]{24}$/i.test(l.agz_store_id || '') && (AGZ_API.painelLogin() || cfg('agz_painel_token')));
  if (base.ocAuto && (renova || !c.oc)) {
    try { c.oc = await AGZ_API.ocorrencias(l.agz_store_id, `${base.ini}T${CONF_INI}:00-03:00`, `${d}T${corteHora()}:59-03:00`, cfg('agz_painel_token'), c.resumo.map((r) => r.agzId)); c.erroOc = ''; }
    catch (e) { c.oc = null; c.erroOc = e.message; }
  }
  base.erroOc = base.ocAuto ? c.erroOc || '' : '';
  base.lojaAgz = await AGZ_API.lojaLida(l);
  base.excluidos = c.excluidos || {}; base.totalApi = c.total || 0; // pedidos que a API devolveu e o pagamento deixa de fora
  const oc = base.ocAuto && c.oc ? new Map(c.oc) : null;
  // Resumo importado: o valor a pagar vem dele (taxas + ocorrências − já pago); os pedidos da API servem de conferência.
  const cr = db.prepare('SELECT * FROM conf_resumo WHERE pagamento = ? AND loja_id = ?').get(d, l.id);
  const res = cr ? new Map(JSON.parse(cr.linhas).map((r) => [semAcento(r.entregador).trim(), r])) : null;
  base.resumo = cr ? { arquivo: cr.arquivo, em: cr.em } : null;
  base.itens = c.resumo.map((r) => {
    const id = motoboyDoAgilizone(l, r.agzId, r.entregador), m = db.prepare('SELECT * FROM motoboys WHERE id = ?').get(id), pix = pixCadastro(l.id, id);
    const rr = res?.get(semAcento(r.entregador).trim());
    if (rr) res.delete(semAcento(r.entregador).trim());
    const incompleto = !m.nome_completo || !CONF.docValido(m.cpf); // no modo teste local deixa de bloquear
    const falta = [!TESTE_LOCAL && !m.nome_completo && 'nome completo', !TESTE_LOCAL && !CONF.docValido(m.cpf) && 'CPF/CNPJ', res && !rr && 'linha no Resumo'].filter(Boolean);
    const valorRes = rr ? rr.total + rr.ocorrencias - rr.pago : null;
    const o = oc?.get(String(r.agzId)); if (o) oc.delete(String(r.agzId));
    const ocAuto = !rr && o ? o : null;
    return { m: { ...m, pix: pix?.pix, identidade: pix?.agz_id }, pedidos: r.pedidos, valorApi: r.total, rr, ocAuto, incompleto: TESTE_LOCAL && incompleto, valor: rr ? valorRes : r.total + (ocAuto?.valor || 0), falta, semPix: !pix?.pix };
  }).sort((a, b) => nomeEnt(a.m).localeCompare(nomeEnt(b.m), 'pt-BR'));
  base.ocSemPedido = !cr && oc ? [...oc.entries()].filter(([, o]) => o.valor) : []; // ocorrência de entregador sem pedido no período
  base.soNoResumo = res ? [...res.values()].filter((r) => r.total + r.ocorrencias - r.pago > 0).map((r) => r.entregador) : []; // no Resumo, sem pedido no período da API
  return base;
}
const lojasAtivas = () => db.prepare('SELECT * FROM lojas WHERE ativa = 1 ORDER BY nome').all();
async function conferenciaDoDia(d, renova) {
  const lojas = lojasAtivas();
  return (await Promise.all(lojas.map((l) => lojaNoDia(l, d, renova)))).filter(Boolean);
}
const bloqueiosDo = (dia) => dia.flatMap((x) => { const lj = lojaCurta(x.loja.nome); return x.erro ? [`${lj}: ${x.erro}`] : [
  ...x.ocSemPedido.map(([id, o]) => `${lj}: ocorrência de ${brl(o.valor)} para o entregador ${id} do Agilizone, que não tem pedido no período`),
  ...x.soNoResumo.map((n) => `${n} (${lj}): está no Resumo, mas não tem pedido no período da API`),
  ...x.itens.filter((i) => i.falta.length && (i.valor > 0 || i.falta.includes('linha no Resumo'))).map((i) => `${nomeEnt(i.m)} (${lj}): falta ${i.falta.join(' e ')}`)]; });
// Lojas cujas ocorrências o painel não entregou (sem Resumo manual): não bloqueia, mas exige confirmação explícita no envio.
const semOcorrencias = (dia) => dia.filter((x) => x.erroOc && !x.resumo);
const linhasPlanilha = (dia) => dia.flatMap((x) => x.itens.filter((i) => i.valor > 0).map((i) => ({ nome: nomeEnt(i.m), doc: i.m.cpf, centro: centroDa(x.loja), valor: i.valor })));
const envioDo = (d) => db.prepare('SELECT e.*, u.nome por FROM envios e LEFT JOIN usuarios u ON u.id = e.enviado_por WHERE pagamento = ?').get(d);
const dataOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d));

app.get('/conferencia', so((r) => confere(r.user)), async (req, res, next) => { try {
  const hoje = agora().data, lojas = lojasAtivas();
  const datas = [...new Set(agenda(lojas, AG.soma(hoje, -10), AG.soma(hoje, 7)).map((p) => p.pagamento))].sort();
  const d = dataOk(req.query.d) ? req.query.d : datas.find((x) => x >= hoje && !envioDo(x)) || datas.find((x) => x >= hoje) || hoje;
  const dia = await conferenciaDoDia(d, req.query.renova === '1'), env = envioDo(d);
  const aba = dia.find((x) => String(x.loja.id) === req.query.aba) ? req.query.aba : 'geral';
  const total = dia.reduce((s, x) => s + x.itens.reduce((t, i) => t + i.valor, 0), 0), nEnt = dia.reduce((s, x) => s + x.itens.length, 0);
  const bloqueios = bloqueiosDo(dia);  const semPix = dia.reduce((s, x) => s + x.itens.filter((i) => i.semPix).length, 0);
  const url = (o) => '/conferencia?' + new URLSearchParams({ d, aba, ...o });
  const dlg = (x, i) => { const m = i.m, k = `c-${x.loja.id}-${m.id}`; return html`<button type="button" class="btn btn-sec btn-sm" data-abre="${k}">Editar</button>
<dialog id="${k}" class="dlg sheet ent-sheet" aria-labelledby="${k}-t"><h2 id="${k}-t">Editar · ${nomeEnt(m)}</h2><p>${x.loja.nome} · no Agilizone: ${m.nome}</p>
<form method="post" action="/entregadores/${m.id}"><input type="hidden" name="loja" value="${x.loja.id}"><input type="hidden" name="volta" value="conferencia"><input type="hidden" name="d" value="${d}"><input type="hidden" name="aba" value="${aba}">
<div class="field"><label for="${k}-n">Nome completo</label><input id="${k}-n" name="nome_completo" value="${m.nome_completo || ''}" placeholder="${m.nome}" maxlength="120" required autocomplete="off"></div>
<div class="field"><label for="${k}-c">CPF ou CNPJ</label><input id="${k}-c" name="cpf" value="${m.cpf ? CONF.docFmt(m.cpf) : ''}" inputmode="numeric" maxlength="18" required autocomplete="off"><p class="hint">11 números (CPF) ou 14 (CNPJ).</p></div>
<input type="hidden" name="nascimento" value="${m.nascimento || ''}"><div class="field"><label for="${k}-p">Chave Pix</label><input id="${k}-p" name="pix" value="${m.pix || ''}" required maxlength="120" autocomplete="off"></div>
${m.identidade ? '' : html`<p class="bad-t">Identidade pendente: vínculo pelo id do Agilizone não confirmado.</p>`}<div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Cancelar</button><button class="btn btn-pri" ${m.identidade ? '' : 'disabled'}>Salvar</button></div></form></dialog>`; };
  const fonte = (x) => x.erro ? html`<span class="badge bad">Erro no Agilizone</span>` : x.resumo ? html`<span class="badge info">Resumo manual · ${quando(x.resumo.em)}</span> <span class="mut small">Valores com ocorrências e já pago, conferidos com a API.</span>` : x.ocAuto && !x.erroOc ? html`<span class="badge ok">Automático · taxas + ocorrências</span> <span class="mut small">Pedidos pela API e ocorrências pelo painel do Agilizone.</span>`
    : html`<span class="badge warn">Automático · só taxas</span> <span class="mut small">${x.erroOc || (x.loja.agz_store_id ? 'Falta o token do painel do Agilizone (Configurações > Lojas) para trazer as ocorrências.' : 'Falta o storeId desta loja (Configurações > Lojas) para trazer as ocorrências.')}</span>`;
  const comOc = (x) => x.resumo || x.itens.some((i) => i.ocAuto);
  const tabLoja = (x) => html`<section class="card"><div class="card-h"><div class="t"><h2>${x.loja.nome}</h2><p>Pedidos de ${dataFmt(x.ini)} ${CONF_INI} a ${dataFmt(d)} ${corteHora()} · centro de custo ${centroDa(x.loja)}</p></div></div>
<div class="card-b" style="padding-bottom:0">${x.lojaAgz ? html`<p class="mut small" style="margin:0 0 8px">${icone('loja', 'sm')} Lendo a loja <b>${x.lojaAgz.nome}</b> no Agilizone${x.lojaAgz.lojas > 1 ? ` (a credencial enxerga ${x.lojaAgz.lojas} lojas; só esta entra)` : ''}.</p>` : ''}${fonte(x)}
${env ? '' : html`<details class="fold" style="margin-top:10px" ${x.resumo ? '' : ''}><summary class="mut small">${icone('chevron', 'chev')} ${x.resumo ? 'Trocar ou remover o Resumo manual' : 'Importação manual do Resumo (opcional: para incluir ocorrências e o já pago)'}</summary>
<form method="post" action="/conferencia/resumo" enctype="multipart/form-data" class="linha-form" style="margin-top:10px" data-carregando="Lendo o Resumo…"><input type="hidden" name="d" value="${d}"><input type="hidden" name="loja" value="${x.loja.id}"><div class="field"><label for="res-${x.loja.id}">Resumo de entregas por entregador (.csv)</label><input id="res-${x.loja.id}" name="resumo" type="file" accept=".csv" required><p class="hint">No Agilizone: Relatório de Pedidos, filtro <b>${dataFmt(x.ini)} ${CONF_INI}</b> a <b>${dataFmt(d)} ${corteHora()}</b> › Resumo de entregas por entregador › Exportar Resumo.</p></div><button class="btn btn-sec">${icone('subir', 'sm')} Importar</button></form>
${x.resumo ? html`<form method="post" action="/conferencia/resumo/remover" style="margin-top:8px"><input type="hidden" name="d" value="${d}"><input type="hidden" name="loja" value="${x.loja.id}"><button class="btn btn-ghost btn-sm">Remover o Resumo e voltar ao automático</button></form>` : ''}</details>`}</div>
${Object.keys(x.excluidos).length ? html`<div class="card-b"><div class="alert warn">${icone('info')}<div><b>Fora do pagamento (${Object.values(x.excluidos).reduce((s, e) => s + e.n, 0)} de ${x.totalApi} pedidos no período)</b> Só pedidos <b>finalizados com entregador</b> entram. Ficaram de fora: ${Object.entries(x.excluidos).map(([k, e]) => `${{ FINALIZADO_SEM_ENTREGADOR: 'finalizados sem entregador', CANCELED: 'cancelados' }[k] || k.toLowerCase()}: ${e.n} (${brl(e.valor)})`).join(' · ')}. É isso que explica a diferença para os cards do topo do Agilizone.</div></div></div>` : ''}
${x.soNoResumo.length ? html`<div class="card-b"><div class="alert bad">${icone('alerta')}<div>No Resumo, mas sem pedidos no período da API: ${x.soNoResumo.join(', ')}. Confira o filtro de datas do Resumo.</div></div></div>` : ''}
${x.erro ? html`<div class="card-b"><div class="alert bad">${icone('erro')}<div>${x.erro}</div></div></div>` : html`<div class="tw"><table class="tab-conf"><thead><tr><th>Entregador</th><th>CPF/CNPJ</th><th class="n">Pedidos</th><th class="n">Taxas (API)</th>${comOc(x) ? html`<th class="n">Ocorrências</th><th class="n">Já pago</th>` : ''}<th class="n">A pagar</th><th>Situação</th><th class="n">Ação</th></tr></thead><tbody>
${x.itens.map((i) => html`<tr><th scope="row">${nomeEnt(i.m)}${i.m.nome_completo && i.m.nome_completo !== i.m.nome ? html`<small class="mut">Agilizone: ${i.m.nome}</small>` : ''}</th><td>${i.m.cpf ? CONF.docFmt(i.m.cpf) : '—'}</td><td class="n">${i.pedidos}</td><td class="n">${brl(i.valorApi)}${i.rr && i.rr.total !== i.valorApi ? html`<small class="bad-t">Resumo: ${brl(i.rr.total)}</small>` : ''}</td>${comOc(x) ? html`<td class="n">${i.rr?.ocorrencias ? brl(i.rr.ocorrencias) : i.ocAuto ? html`<span title="${i.ocAuto.itens.join(' · ')}">${brl(i.ocAuto.valor)} <small class="mut">(${i.ocAuto.qtd})</small></span>` : '—'}</td><td class="n">${i.rr?.pago ? brl(-i.rr.pago) : '—'}</td>` : ''}<td class="n"><b>${brl(i.valor)}</b></td>
<td>${i.falta.length ? html`<span class="badge bad">Falta ${i.falta.join(' e ')}</span>` : i.incompleto ? html`<span class="badge warn">Incompleto (teste)</span>` : i.semPix ? html`<span class="badge warn">Sem Pix</span>` : html`<span class="badge ok">OK</span>`}</td><td class="n">${dlg(x, i)}</td></tr>`)}
${x.itens.length ? '' : html`<tr><td colspan="9">Nenhum pedido entregue no período.</td></tr>`}</tbody>
<tfoot><tr><th>Total</th><td></td><td class="n">${x.itens.reduce((s, i) => s + i.pedidos, 0)}</td><td class="n">${brl(x.itens.reduce((s, i) => s + i.valorApi, 0))}</td>${comOc(x) ? html`<td colspan="2"></td>` : ''}<td class="n"><b>${brl(x.itens.reduce((s, i) => s + i.valor, 0))}</b></td><td colspan="2"></td></tr></tfoot></table></div>`}</section>`;
  const lojasOk = dia.filter((x) => !bloqueiosDo([x]).length).length;
  const stat = (ic, cor, v, l, hero) => html`<div class="card stat ${hero ? 'hero' : ''}"><span class="hico ${cor}">${icone(ic)}</span><div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
  const topo = html`<div class="stats">${stat('carteira', 'pri', brl(total), `A pagar em ${diaLongo(d)}`, true)}${stat('moto', '', nEnt, 'Entregadores')}${stat('loja', lojasOk === dia.length ? 'ok' : 'warn', `${lojasOk}/${dia.length}`, 'Lojas prontas')}${stat(bloqueios.length ? 'alerta' : 'check', bloqueios.length ? 'bad' : 'ok', bloqueios.length, bloqueios.length ? 'Pendências para corrigir' : 'Sem pendências')}</div>`;
  const geral = html`<section class="card"><div class="card-h"><div class="t"><h2>Lojas que pagam ${diaLongo(d)}</h2><p>Valores puxados automaticamente do Agilizone. Clique na loja para ver os entregadores.</p></div></div>
<div class="tw"><table class="tab-conf"><thead><tr><th>Loja</th><th>Período</th><th>Origem</th><th class="n">Entregadores</th><th class="n">Valor</th><th>Situação</th></tr></thead><tbody>
${dia.map((x) => { const pend = bloqueiosDo([x]).length; return html`<tr><th scope="row"><a href="${url({ aba: x.loja.id })}">${lojaCurta(x.loja.nome)}</a></th><td>${dataFmt(x.ini)} ${CONF_INI} a ${dataFmt(d)} ${corteHora()}</td><td>${x.erro ? '—' : x.resumo ? html`<span class="badge info">Resumo manual</span>` : html`<span class="badge nodot">Automático</span>`}</td><td class="n">${x.itens.length}</td><td class="n">${brl(x.itens.reduce((s, i) => s + i.valor, 0))}</td>
<td>${x.erro ? html`<span class="badge bad">Erro no Agilizone</span>` : pend ? html`<span class="badge bad">${pend} pendência(s)</span>` : html`<span class="badge ok">OK</span>`}</td></tr>`; })}
${dia.length ? '' : html`<tr><td colspan="6">Nenhuma loja paga neste dia.</td></tr>`}</tbody><tfoot><tr><th>Total</th><td></td><td></td><td class="n">${nEnt}</td><td class="n"><b>${brl(total)}</b></td><td></td></tr></tfoot></table></div></section>
${bloqueios.length ? html`<div class="alert bad" role="alert">${icone('alerta')}<div><b>Corrija antes de enviar (${bloqueios.length})</b><ul>${bloqueios.map((b) => html`<li>${b}</li>`)}</ul></div></div>` : ''}
${semPix ? html`<div class="alert warn">${icone('info')}<div>${semPix} entregador(es) sem chave Pix cadastrada. Não impede o envio (a planilha não leva o Pix).</div></div>` : ''}`;
  const semDrive = driveDestino() === 'sem', qe = env && db.prepare('SELECT * FROM drive_fila_envios WHERE envio_id = ?').get(env.id);
  const idDrive = env && (env.drive_id || qe?.drive_id);
  const envio = env ? html`<section class="card"><div class="card-h"><span class="hico pri">${icone('check')}</span><div class="t"><h2>Enviado</h2><p>${quando(env.enviado_em)}${env.por ? ` por ${env.por}` : ''} · ${env.linhas} linhas · ${brl(env.total)}${env.para ? ` · e-mail para ${env.para}` : ''}</p></div></div>
<details class="fold card-b" style="padding-top:0"><summary class="mut small">${icone('chevron', 'chev')} Reenviar a planilha por e-mail (para outras pessoas ou de novo)</summary>
<form method="post" action="/conferencia/reenviar" style="margin-top:10px" data-carregando="Enviando…"><input type="hidden" name="d" value="${d}"><div class="field"><label for="re-d">Reenviar para</label><textarea id="re-d" name="para" required>${env.para || cfg('email_para') || ''}</textarea><p class="hint">Um ou mais e-mails, um por linha ou separados por vírgula. Vai a mesma planilha que foi enviada.</p></div><button class="btn btn-sec">${icone('enviar', 'sm')} Reenviar por e-mail</button></form></details>
<div class="card-f"><a class="btn btn-sec" href="/conferencia/planilha?d=${d}">${icone('baixar')} Baixar planilha</a>${idDrive ? html`<a class="btn btn-ghost" href="https://drive.google.com/file/d/${idDrive}/view" target="_blank" rel="noopener">Abrir no Drive</a>${qe?.drive_id ? html`<form method="post" action="/conferencia/drive" onsubmit="return confirm('Gravar a planilha de novo na pasta do Drive? Se o arquivo ainda estiver lá, nada é duplicado.')"><input type="hidden" name="d" value="${d}"><input type="hidden" name="refazer" value="1"><button class="btn btn-sec">${icone('subir')} Reenviar ao Drive</button></form>` : ''}` : qe ? html`<span class="badge warn">Na fila do Drive</span> <span class="mut small">${qe.erro ? `Última falha: ${qe.erro}. ` : ''}O Apps Script grava ${quandoGrava()}.</span>` : html`<form method="post" action="/conferencia/drive"><input type="hidden" name="d" value="${d}"><button class="btn btn-pri">${icone('subir')} Enviar ao Drive</button></form>`}
<a class="btn btn-ghost" href="/conferencia/entregues">Ver entregues</a></div></section>`
    : html`${TESTE_LOCAL ? html`<div class="alert warn" role="note">${icone('alerta')}<div><b>MODO TESTE LOCAL</b> Pode enviar com cadastros incompletos. O e-mail vai com [TESTE] no assunto, nada é registrado (dá para enviar de novo) e não sobe no Drive.</div></div>` : ''}<form method="post" action="/conferencia/enviar" class="card" data-carregando="Enviando…"><input type="hidden" name="d" value="${d}"><div class="card-h"><span class="hico pri">${icone('enviar')}</span><div class="t"><h2>${TESTE_LOCAL ? '[TESTE] ' : ''}Enviar ${CONF.titulo(d)}</h2><p>Gera a planilha no modelo do financeiro, manda por e-mail para ${listaEmails(cfg('email_para')).join(', ') || 'os destinatários (não configurados)'}${semDrive ? '' : ' e sobe na pasta do Google Drive'}.</p></div></div>
<div class="card-b">${semDrive ? html`<div class="alert warn">${icone('alerta')}<div>Google Drive não configurado (Configurações > Google Drive): a planilha vai só por e-mail.</div></div>` : ''}<label class="check"><input type="checkbox" name="ok" value="1" required ${bloqueios.length ? 'disabled' : ''}> Conferi todas as lojas e os valores estão corretos.</label>
${semOcorrencias(dia).length ? html`<label class="check"><input type="checkbox" name="sem_oc" value="1" required ${bloqueios.length ? 'disabled' : ''}> <span>Sem ocorrências em <b>${semOcorrencias(dia).map((x) => lojaCurta(x.loja.nome)).join(', ')}</b>: o painel do Agilizone não respondeu. Confirmo que não há ocorrências a pagar nelas neste período (ou que lanço à parte).</span></label>` : ''}</div>
<div class="card-f"><a class="btn btn-sec" href="/conferencia/planilha?d=${d}">${icone('baixar')} Baixar planilha (prévia)</a><button class="btn btn-pri" ${bloqueios.length || !nEnt ? 'disabled' : ''}>${icone('enviar')} Enviar</button></div></form>`;
  res.send(page(req, { titulo: 'Conferência geral', compacto: true, eyebrow: 'Pagamento de entregadores', sub: `Pagamento de ${diaLongo(d)} · ${env ? 'Enviado' : 'Em conferência'}`,
    acoes: html`<a class="btn btn-ghost" href="/conferencia/entregues">Entregues</a> <a class="btn btn-sec" href="${url({ renova: '1' })}" data-carregando="Buscando no Agilizone…">Atualizar do Agilizone</a>` }, html`
<nav class="pills" aria-label="Dia de pagamento">${datas.map((x) => html`<a href="/conferencia?d=${x}" class="${x === d ? 'on' : ''}">${dataFmt(x).slice(0, 5)} ${diaLongo(x).split(' ')[0]}${envioDo(x) ? ' ✓' : ''}</a>`)}<form method="get" class="linha-form" style="display:inline-flex"><label class="sr" for="c-d">Outra data</label><input id="c-d" type="date" name="d" value="${d}"><button class="btn btn-ghost btn-sm">Ir</button></form></nav>
<nav class="seg" aria-label="Abas"><a href="${url({ aba: 'geral' })}" class="${aba === 'geral' ? 'on' : ''}">Geral</a>${dia.map((x) => html`<a href="${url({ aba: x.loja.id })}" class="${aba === String(x.loja.id) ? 'on' : ''}">${lojaCurta(x.loja.nome)}${bloqueiosDo([x]).length ? html`<span class="c">!</span>` : ''}</a>`)}</nav>
${topo}${aba === 'geral' ? geral : tabLoja(dia.find((x) => String(x.loja.id) === aba))}
${envio}`));
} catch (e) { next(e); } });

app.post('/conferencia/resumo', so((r) => confere(r.user)), (req, res, next) => umResumo(req, res, (e) => { try {
  const d = String(req.body.d || ''), l = db.prepare('SELECT * FROM lojas WHERE id = ?').get(Number(req.body.loja)), url = `/conferencia?d=${d}&aba=${l?.id}`;
  if (e) return volta(res, url, 'erro', 'Arquivo inválido ou grande demais.');
  if (!dataOk(d) || !l) throw falha('Loja ou data inválida.');
  if (envioDo(d)) return volta(res, url, 'erro', 'Este pagamento já foi enviado.');
  if (!req.file) return volta(res, url, 'erro', 'Escolha o arquivo do Resumo (.csv).');
  let linhas; try { linhas = lerResumo(req.file.buffer); } catch (er) { return volta(res, url, 'erro', er.message); }
  db.prepare('INSERT INTO conf_resumo (pagamento, loja_id, linhas, arquivo, por) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET linhas = excluded.linhas, arquivo = excluded.arquivo, por = excluded.por, em = datetime(\'now\',\'localtime\')')
    .run(d, l.id, JSON.stringify(linhas), nomeArq(req.file.originalname), req.user.id);
  log(req.user.id, 'conferencia', `Resumo de ${l.nome} para ${dataFmt(d)} importado: ${linhas.length} entregadores`);
  volta(res, url, 'ok', `Resumo importado: ${linhas.length} entregadores. Confira a coluna "A pagar".`);
} catch (er) { next(er); } }));

app.post('/conferencia/resumo/remover', so((r) => confere(r.user)), (req, res) => {
  const d = String(req.body.d || ''), id = Number(req.body.loja), url = `/conferencia?d=${d}&aba=${id}`;
  if (envioDo(d)) return volta(res, url, 'erro', 'Este pagamento já foi enviado.');
  db.prepare('DELETE FROM conf_resumo WHERE pagamento = ? AND loja_id = ?').run(d, id);
  log(req.user.id, 'conferencia', `Resumo manual removido (loja ${id}, ${dataFmt(d)}): volta ao automático`);
  volta(res, url, 'ok', 'Resumo removido: valores voltaram ao automático (API).');
});
app.get('/conferencia/planilha', so((r) => confere(r.user)), async (req, res, next) => { try {
  const d = String(req.query.d || '');
  if (!dataOk(d)) throw falha('Data inválida.');
  const buf = envioDo(d) && fs.existsSync(arqEnvio(d)) ? fs.readFileSync(arqEnvio(d)) : CONF.planilha(d, linhasPlanilha(await conferenciaDoDia(d)));
  res.attachment(`${CONF.titulo(d)}.xlsx`).type('xlsx').send(buf);
} catch (e) { next(e); } });

const arqEnvio = (d) => path.join(DIR, 'envios', `${d}.xlsx`); // a planilha exatamente como foi enviada
// Destino no Drive: 'direto' (conta de serviço, Configurações > Google Drive), 'fila' (Apps Script busca; precisa de DRIVE_SCRIPT_SEGREDO) ou 'sem'.
const driveDestino = () => (cfg('drive_pasta') && cfg('drive_credencial') ? 'direto' : (process.env.DRIVE_SCRIPT_SEGREDO || '').length >= 24 ? 'fila' : 'sem');
// Acionamento imediato: com DRIVE_SCRIPT_URL (URL do App da Web do script), o app manda o script gravar os pendentes AGORA
// (botão "Enviar ao Drive" e horário do dia do fechamento). Sem ela, vale o acionador do Apps Script.
const driveRapido = () => !!process.env.DRIVE_SCRIPT_URL;
const quandoGrava = () => (driveRapido() ? 'ao clicar em "Enviar ao Drive"' : 'em até 5 minutos (acionador do Apps Script)');
async function acionaScript() { // { ok, gravados, falhas } ou { erro }
  try {
    const r = await fetch(process.env.DRIVE_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ segredo: process.env.DRIVE_SCRIPT_SEGREDO }), redirect: 'follow', signal: AbortSignal.timeout(90e3) });
    const j = await r.json().catch(() => null);
    if (!j) return { erro: `o Google respondeu ${r.status} sem resposta válida: confira se o script foi implantado como App da Web com acesso para "Qualquer pessoa"` };
    return j.ok ? j : { erro: j.erro || 'erro no script' };
  } catch (e) { return { erro: e.name === 'TimeoutError' ? 'o script do Google demorou demais' : 'não consegui falar com o script do Google' }; } // sem a URL na mensagem
}
// Manda gravar agora e confere na fila se o envio do dia ficou gravado: { ok } ou { ok: false, erro }.
async function gravaAgora(d) {
  driveUltimo = Date.now(); // o reenvio periódico só entra se esta tentativa falhar
  const e = envioDo(d), r = await acionaScript(), q = e && db.prepare('SELECT drive_id, erro FROM drive_fila_envios WHERE envio_id = ?').get(e.id);
  return q?.drive_id ? { ok: true } : { ok: false, erro: r.erro || q?.erro || 'o script não gravou (veja o log do Apps Script)' };
}
async function subirEnvioDrive(d, buf, u) {
  const r = await CONF.subirDrive({ credencial: cfg('drive_credencial'), pasta: cfg('drive_pasta'), nome: `${CONF.titulo(d)}.xlsx`, buffer: buf, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  db.prepare('UPDATE envios SET drive_id = ? WHERE pagamento = ?').run(r.id, d);
  log(u?.id ?? null, 'conferencia', `${CONF.titulo(d)} enviado ao Google Drive`);
}
// Gera a planilha do dia e envia (e-mail + Drive). Serve à tela (user = quem conferiu) e ao fechamento automático (user = null).
// Retorna { erro } (nada foi enviado) ou { titulo, linhas, total, para, drive: 'sem' | 'ok' | { erro } }.
const emEnvio = new Set(); // evita enviar a mesma data duas vezes ao mesmo tempo (tela + automático)
// emailTeste: teste do envio automático — manda SÓ para esse e-mail, com [TESTE] no assunto, sem registrar nada nem ir ao Drive (vale até para data já enviada).
async function enviaFechamento(d, dia, user, { semOcConfirmado = false, emailTeste = '' } = {}) {
  if (emEnvio.has(d)) return { erro: 'Este pagamento está sendo enviado agora. Aguarde um instante e recarregue.' };
  if (!emailTeste && envioDo(d)) return { erro: 'Este pagamento já foi enviado.' };
  const modoTeste = TESTE_LOCAL || !!emailTeste;
  emEnvio.add(d);
  try {
    const semOc = semOcorrencias(dia);
    if (semOc.length && !semOcConfirmado) return { erro: `Nada foi enviado: confirme que não há ocorrências em ${semOc.map((x) => lojaCurta(x.loja.nome)).join(', ')} (o painel do Agilizone não respondeu).` };
    const pend = bloqueiosDo(dia);
    if (pend.length) return { erro: `Nada foi enviado: ${pend.length} pendência(s), ex.: ${pend[0]}. Confira e tente de novo.` };
    const linhas = linhasPlanilha(dia), total = linhas.reduce((s, l) => s + l.valor, 0), titulo = CONF.titulo(d), buf = CONF.planilha(d, linhas);
    if (!linhas.length) return { erro: 'Nenhum valor a pagar neste dia.' };
    const para = emailTeste ? [emailTeste] : listaEmails(cfg('email_para'));
    if (!para.length) return { erro: 'Nada foi enviado: cadastre os destinatários em Configurações > E-mail.' };
    const corpo = `Pagamento dos entregadores de ${diaLongo(d)}.\n\n${dia.map((x) => `${lojaCurta(x.loja.nome)} (${dataFmt(x.ini)} a ${dataFmt(x.fim)}): ${x.itens.filter((i) => i.valor > 0).length} entregadores, ${brl(x.itens.reduce((s, i) => s + i.valor, 0))}`).join('\n')}\n\nTotal: ${brl(total)} (${linhas.length} linhas)${semOc.length ? `\nATENÇÃO: sem ocorrências (painel do Agilizone indisponível): ${semOc.map((x) => lojaCurta(x.loja.nome)).join(', ')}.` : ''}\n${user ? `Conferido por ${user.nome}.` : 'Gerado e enviado automaticamente pelo sistema, sem nenhuma pendência na conferência.'} Planilha em anexo.`;
    try {
      const r = await enviarEmail({ to: para.join(', '), subject: `${modoTeste ? '[TESTE] ' : ''}${titulo}`, text: `${emailTeste ? '*** TESTE DO ENVIO AUTOMÁTICO: só este e-mail foi enviado (o financeiro não recebeu); não vale para pagamento. ***\n\n' : TESTE_LOCAL ? '*** TESTE LOCAL: cadastros podem estar incompletos; não vale para pagamento. ***\n\n' : ''}${corpo}`, attachments: [{ filename: `${titulo}.xlsx`, content: buf }] });
      if (r.salvo && process.env.EMAIL_SO_ARQUIVO !== '1') return { erro: 'Nada foi enviado: servidor de e-mail não configurado (Configurações > E-mail). Baixe a planilha enquanto isso.' };
    } catch (e) { return { erro: `Nada foi enviado: o servidor de e-mail recusou (${e.message}).` }; }
    if (modoTeste) return { titulo, linhas: linhas.length, total, para, teste: true, drive: 'sem' }; // teste: nada é registrado nem vai ao Drive
    fs.mkdirSync(path.dirname(arqEnvio(d)), { recursive: true });
    fs.writeFileSync(arqEnvio(d), buf);
    const envioId = Number(db.prepare('INSERT INTO envios (pagamento, arquivo, total, linhas, para, enviado_por) VALUES (?,?,?,?,?,?)').run(d, `${titulo}.xlsx`, total, linhas.length, para.join(', '), user?.id ?? null).lastInsertRowid);
    log(user?.id ?? null, 'conferencia', `${user ? 'Enviou' : 'Enviou automaticamente'} ${titulo}: ${linhas.length} linhas, ${brl(total)}, para ${para.join(', ')}`);
    const ok = { titulo, linhas: linhas.length, total, para };
    const destino = driveDestino();
    if (destino === 'sem') return { ...ok, drive: 'sem' };
    if (destino === 'fila') { // entra na fila e, com o App da Web, o script grava na pasta já (senão, o acionador do Apps Script)
      enfileiraEnvio({ id: envioId, pagamento: d });
      if (!driveRapido()) return { ...ok, drive: 'fila' };
      const g = await gravaAgora(d);
      return { ...ok, drive: g.ok ? 'ok' : { erro: g.erro } };
    }
    try { await subirEnvioDrive(d, buf, user); return { ...ok, drive: 'ok' }; } catch (e) { return { ...ok, drive: { erro: e.message } }; }
  } finally { emEnvio.delete(d); }
}
app.post('/conferencia/enviar', so((r) => confere(r.user)), async (req, res, next) => { try {
  const d = String(req.body.d || ''), url = `/conferencia?d=${d}`;
  if (!dataOk(d)) throw falha('Data inválida.');
  if (envioDo(d)) return volta(res, url, 'erro', 'Este pagamento já foi enviado.');
  if (req.body.ok !== '1') return volta(res, url, 'erro', 'Marque que conferiu todas as lojas antes de enviar.');
  const r = await enviaFechamento(d, await conferenciaDoDia(d, true), req.user, { semOcConfirmado: req.body.sem_oc === '1' }); // com os dados mais recentes do Agilizone
  if (r.erro) return volta(res, url, 'erro', r.erro);
  if (r.teste) return volta(res, url, 'ok', `TESTE enviado por e-mail para ${r.para.join(', ')} (${r.linhas} linhas, ${brl(r.total)}). Nada foi registrado: pode enviar de novo.`);
  if (r.drive === 'sem') return volta(res, url, 'ok', `${r.titulo} enviado por e-mail. Google Drive não configurado.`);
  if (r.drive === 'ok') return volta(res, url, 'ok', `${r.titulo} enviado por e-mail e salvo no Google Drive.`);
  if (r.drive === 'fila') return volta(res, url, 'ok', `${r.titulo} enviado por e-mail. A planilha entrou na fila e o Apps Script grava ${quandoGrava()}.`);
  volta(res, url, 'erro', `E-mail enviado, mas o Drive falhou: ${r.drive.erro} Use "Enviar ao Drive" para tentar de novo.`);
} catch (e) { next(e); } });
// Reenvio de um pagamento já entregue: manda de novo a planilha exatamente como foi enviada (sem recalcular nada).
app.post('/conferencia/reenviar', so((r) => confere(r.user)), async (req, res, next) => { try {
  const d = String(req.body.d || ''), env = dataOk(d) && envioDo(d), volt = req.body.volta === 'entregues' ? '/conferencia/entregues' : `/conferencia?d=${d}`;
  if (!env || !fs.existsSync(arqEnvio(d))) return volta(res, volt, 'erro', 'Envio não encontrado.');
  const para = [...new Set(listaEmails(req.body.para).map((e) => e.toLowerCase()))], invalido = para.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!para.length || invalido) return volta(res, volt, 'erro', invalido ? `E-mail inválido: ${invalido}.` : 'Informe para quem reenviar.');
  const titulo = CONF.titulo(d);
  try {
    const r = await enviarEmail({ to: para.join(', '), subject: `[REENVIO] ${titulo}`, text: `Reenvio da planilha do pagamento de ${diaLongo(d)} (enviada originalmente em ${quando(env.enviado_em)}), sem alterações.\nReenviado por ${req.user.nome}.`, attachments: [{ filename: `${titulo}.xlsx`, content: fs.readFileSync(arqEnvio(d)) }] });
    if (r.salvo && process.env.EMAIL_SO_ARQUIVO !== '1') return volta(res, volt, 'erro', 'Nada foi enviado: servidor de e-mail não configurado (Configurações > E-mail).');
  } catch (e) { return volta(res, volt, 'erro', `Nada foi enviado: o servidor de e-mail recusou (${e.message}).`); }
  log(req.user.id, 'conferencia', `Reenviou ${titulo} para ${para.join(', ')}`);
  volta(res, volt, 'ok', `${titulo} reenviado para ${para.join(', ')}.`);
} catch (e) { next(e); } });
app.get('/conferencia/entregues', so((r) => confere(r.user)), (req, res) => {
  const lista = db.prepare('SELECT e.*, u.nome por, COALESCE(e.drive_id, q.drive_id) drive, q.envio_id IS NOT NULL AND q.drive_id IS NULL na_fila, q.drive_id IS NOT NULL gravado_fila FROM envios e LEFT JOIN usuarios u ON u.id = e.enviado_por LEFT JOIN drive_fila_envios q ON q.envio_id = e.id ORDER BY e.pagamento DESC LIMIT 100').all();
  res.send(page(req, { titulo: 'Entregues', compacto: true, eyebrow: 'Pagamento de entregadores', sub: 'Planilhas já enviadas ao financeiro',
    acoes: html`<a class="btn btn-sec" href="/conferencia">Em conferência</a>` }, html`
<section class="card"><div class="tw"><table class="tab-conf"><thead><tr><th>Pagamento</th><th>Enviado</th><th>Por</th><th class="n">Linhas</th><th class="n">Total</th><th>Drive</th><th class="n">Ações</th></tr></thead><tbody>
${lista.map((e) => html`<tr><th scope="row">${diaLongo(e.pagamento)}<small class="mut">${e.arquivo}</small></th><td>${quando(e.enviado_em)}<small class="mut">${e.para}</small></td><td>${e.por || 'Automático'}</td><td class="n">${e.linhas}</td><td class="n">${brl(e.total)}</td><td>${e.drive ? html`<a href="https://drive.google.com/file/d/${e.drive}/view" target="_blank" rel="noopener">Abrir</a>` : e.na_fila ? html`<span class="badge warn">Na fila</span>` : '—'}</td>
<td class="n"><a class="btn btn-sec btn-sm" href="/conferencia?d=${e.pagamento}">Abrir</a> <a class="btn btn-ghost btn-sm" href="/conferencia/planilha?d=${e.pagamento}">Baixar</a>
${e.gravado_fila ? html`<form method="post" action="/conferencia/drive" onsubmit="return confirm('Gravar a planilha de novo na pasta do Drive? Se o arquivo ainda estiver lá, nada é duplicado.')"><input type="hidden" name="d" value="${e.pagamento}"><input type="hidden" name="refazer" value="1"><input type="hidden" name="volta" value="entregues"><button class="btn btn-ghost btn-sm">Reenviar ao Drive</button></form>` : ''}<details class="fold"><summary class="mut small">Reenviar por e-mail</summary><form method="post" action="/conferencia/reenviar" data-carregando="Enviando…"><input type="hidden" name="d" value="${e.pagamento}"><input type="hidden" name="volta" value="entregues"><div class="field"><label class="sr" for="re-${e.pagamento}">Reenviar para</label><textarea id="re-${e.pagamento}" name="para" required>${e.para || cfg('email_para') || ''}</textarea></div><button class="btn btn-pri btn-sm">${icone('enviar', 'sm')} Reenviar</button></form></details></td></tr>`)}
${lista.length ? '' : html`<tr><td colspan="7">Nenhum pagamento enviado ainda.</td></tr>`}</tbody></table></div></section>`));
});
app.post('/conferencia/drive', so((r) => confere(r.user)), async (req, res, next) => { try {
  const d = String(req.body.d || ''), url = req.body.volta === 'entregues' ? '/conferencia/entregues' : `/conferencia?d=${d}`;
  if (!dataOk(d) || !envioDo(d)) throw falha('Envio não encontrado.');
  const destino = driveDestino();
  if (destino === 'sem') return volta(res, url, 'erro', 'Drive não configurado: defina DRIVE_SCRIPT_SEGREDO no servidor (Apps Script) ou configure o Google Drive em Configurações.');
  if (destino === 'fila') { // coloca na fila (ou devolve à fila, limpando o erro anterior); idempotente
    const e = envioDo(d), q = db.prepare('SELECT drive_id FROM drive_fila_envios WHERE envio_id = ?').get(e.id);
    const refazer = req.body.refazer === '1';
    if (q?.drive_id && !refazer) return volta(res, url, 'ok', 'Esta planilha já foi gravada no Drive.');
    enfileiraEnvio(e);
    db.prepare('UPDATE drive_fila_envios SET erro = NULL, tentativas = 0, drive_id = NULL, gravado_em = NULL WHERE envio_id = ?').run(e.id); // volta à fila (se estava gravada, o script regrava)
    if (refazer) log(req.user.id, 'conferencia', `Reenviou ${CONF.titulo(d)} ao Google Drive`);
    if (driveRapido()) { // grava na hora
      const g = await gravaAgora(d);
      return g.ok ? volta(res, url, 'ok', refazer ? 'Planilha gravada de novo no Drive (se o arquivo ainda estava lá, foi mantido, sem duplicar).' : 'Planilha gravada na pasta do Drive.')
        : volta(res, url, 'erro', `A planilha ficou na fila, mas não gravou agora: ${g.erro}. Tente de novo.`);
    }
    return volta(res, url, 'ok', refazer ? `Planilha de volta na fila: o Apps Script grava ${quandoGrava()} (se o arquivo ainda estiver lá, ele é mantido, sem duplicar).` : `Planilha na fila: o Apps Script grava ${quandoGrava()}.`);
  }
  try { await subirEnvioDrive(d, fs.readFileSync(arqEnvio(d)), req.user); volta(res, url, 'ok', 'Planilha salva no Google Drive.'); }
  catch (e) { volta(res, url, 'erro', e.message); }
} catch (e) { next(e); } });

// ---- Importação direto da API do Agilizone (alternativa ao envio dos arquivos) ----
// Entregador do Agilizone -> cadastro por loja e id; nunca herda Pix pelo nome.
function motoboyDoAgilizone(l, agzId, nome) {
  const id = achaMotoboy(l, agzId, nome);
  db.prepare('INSERT OR IGNORE INTO loja_motoboys (loja_id, motoboy_id) VALUES (?, ?)').run(l.id, id); // entra na lista de entregadores da loja
  return id;
}
function achaMotoboy(l, agzId, nome) {
  if (agzId == null || String(agzId).trim() === '') throw falha('Entregador sem identidade do Agilizone. Confira a origem dos dados.');
  const existente = db.prepare('SELECT motoboy_id id FROM entregador_pix WHERE loja_id = ? AND agz_id = ?').get(l.id, String(agzId));
  if (existente) return existente.id;
  // Um id da API é confiável; nomes iguais não autorizam herdar Pix legado.
  let id = db.prepare('SELECT id FROM motoboys WHERE agz_id = ?').get(agzId)?.id;
  if (!id) id = Number(db.prepare('INSERT INTO motoboys (nome, agz_id) VALUES (?, ?)').run(nome, agzId).lastInsertRowid);
  db.prepare('INSERT INTO entregador_pix (loja_id, motoboy_id, agz_id) VALUES (?, ?, ?)').run(l.id, id, String(agzId));
  return id;
}
async function importarApi(req, res) {
  const u = req.user, hoje = agora().data;
  const l = db.prepare('SELECT * FROM lojas WHERE id = ?').get(u.perfil === 'admin' ? Number(req.body.loja) : u.loja_id);
  if (!l) throw falha('Escolha a loja.');
  if (!AGZ_API.configurada(l)) throw falha('Esta loja ainda não está ligada ao Agilizone. Peça ao suporte para configurar as credenciais da loja no servidor.');
  const p = agenda([l], AG.soma(hoje, -14), AG.soma(hoje, 7)).find((x) => x.pagamento === String(req.body.p || ''));
  if (!p) throw falha('Esse pagamento não está na agenda. Volte e escolha o período.');
  if (p.f) throw Object.assign(falha(`Esse pagamento já tem fechamento (#${p.f.id}). Continue por ele; se estava errado, arquive-o e importe de novo.`), { abrir: p.f.id });
  // O dia operacional vai de VIRADA_H a VIRADA_H do dia seguinte (horário de Teresina, UTC-3 o ano todo).
  const h = String(VIRADA_H).padStart(2, '0');
  const orders = await AGZ_API.pedidos(l, `${p.ini}T${h}:00:00-03:00`, `${AG.soma(p.fim, 1)}T${h}:00:00-03:00`);
  const { pedidos, resumo } = AGZ_API.paraImportacao(orders, { tz: TZ, de: p.ini, ate: p.fim });
  if (!pedidos.length) throw falha(`O Agilizone não tem pedidos entregues de ${l.nome} entre ${dataFmt(p.ini)} e ${dataFmt(p.fim)}.`);
  const ids = new Map(resumo.map((e) => [e.agzId, motoboyDoAgilizone(l, e.agzId, e.entregador)]));
  for (const x of pedidos) x.motoboyId = ids.get(x.agzId);
  for (const r of resumo) r.motoboyId = ids.get(r.agzId);
  registra(req, res, l, l.nome, pedidos, resumo, 'Agilizone (API)', 'Agilizone (API)', 'api');
}
app.post('/fechamentos/novo/api', so((r) => editaMotoboy(r.user)), async (req, res, next) => {
  try { await importarApi(req, res); } catch (e) {
    if (!e.publico) return next(e);
    const q = new URLSearchParams({ campo: 'api' });
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.p || '')) q.set('p', req.body.p);
    if (Number(req.body.loja)) q.set('l', Number(req.body.loja));
    if (e.abrir) q.set('abrir', e.abrir);
    volta(res, `/fechamentos/novo?${q}`, 'erro', e.message);
  }
});

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
  const semPix = g.linhas.filter((l) => l.total > 0 && (!l.pix || l.divergenciaPix));
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
      ['Chaves PIX', semPix.length ? ['bad', `Revisar ${semPix.length} chave${semPix.length > 1 ? 's' : ''} PIX`] : ['ok', g.linhas.some((l) => l.pixDigitado) ? 'Completas, algumas digitadas por você' : 'Completas'], semPix.length ? '#pix' : '#conf'],
      ['Pedidos × Resumo', !g.temResumo ? ['nodot', 'Sem Resumo para comparar'] : pend.length ? ['warn', `Revisar ${pend.length} diferença${pend.length > 1 ? 's' : ''} de valor (justifique no envio)`] : ['ok', 'Valores conferem'], pend.length ? `#ent-${pend[0].id}` : '#conf'],
    ];
    estado = html`<section class="conferencia" aria-labelledby="conf-t"><h2 id="conf-t">${semPix.length ? 'O que falta para enviar' : 'Pronto para enviar ao financeiro'}</h2><ol>
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

  const sub = html`<b>${f.loja}</b> · ${f.pagamento ? html`Pagamento previsto: <b>${diaLongo(f.pagamento)}</b>` : 'Sem data de pagamento no calendário'} · <span class="mut">importado por ${f.autor}, ${quando(f.criado_em)}</span>`;
  res.send(page(req, {
    titulo: `Fechamento de ${periodo(f)}`, selo: selo(f, devolvido), sub, largura: 'larga', css: '/marca/conferencia.css', js: '/marca/conferencia.js', trilha: [[inicio(u), '/'], [periodo(f)]],
    acoes: html`<a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/pdf" target="_blank">${icone('arquivo', 'sm')} Baixar PDF</a><a class="btn btn-sec btn-sm" href="/fechamentos/${f.id}/xlsx">${icone('baixar', 'sm')} Baixar Excel</a>`,
  }, html`
${devolvido ? html`<div class="motivo" role="note" id="devolvido"><b>Devolvido pelo financeiro${devolucao.nome ? ` (${devolucao.nome})` : ''} em ${quando(devolucao.quando)}</b>
<p>${devolucao.acao.replace(/^Devolveu para correção: /, '')}</p>${(() => { const d = db.prepare('SELECT motoboy_id FROM devolucoes WHERE fechamento_id = ? AND versao = ?').all(f.id, f.versao).map((x) => g.linhas.find((l) => l.id === x.motoboy_id)?.nome).filter(Boolean); return d.length ? html`<p class="small"><b>Entregadores devolvidos:</b> ${d.join(', ')}</p>` : ''; })()}${edita ? html`<span class="small">Corrija abaixo e envie de novo.</span>` : ''}</div>` : ''}
${estado}${vinculo(f)}${email}
<dl class="resumo">
<div class="destaque"><dt>Total a pagar</dt><dd>${brl(g.total)}</dd></div>
<div><dt>Entregadores</dt><dd>${g.linhas.filter((l) => l.total > 0).length}</dd></div>
<div><dt>Entregas</dt><dd>${entregas}</dd></div>${g.temOc ? html`<div><dt>Ocorrências</dt><dd class="${g.totOc < 0 ? 'bad-t' : ''}">${g.totOc > 0 ? '+' : ''}${brl(g.totOc)}</dd><dd>${g.linhas.reduce((t, l) => t + l.qtdOc, 0)} no período, já no total</dd></div>` : ''}</dl>
${fora ? html`<div class="alert warn">${icone('calendario')}<div><b>Dias fora do período do pagamento</b>${(() => { const d = fora.acao.replace(/^Atenção: dias fora do período desse pagamento: /, '').split(', '); return d.length > 4 ? `${d.length} dias (de ${d[0]} a ${d[d.length - 1]})` : d.join(', '); })()}. Confira o filtro de datas no Agilizone.</div></div>` : ''}
${jaPago.length ? html`<div class="alert bad">${icone('alerta')}<div><b>Acerto já feito no Agilizone para ${jaPago.length} entregador(s)</b>O valor já foi descontado do total a pagar: ${jaPago.map((r, i) => html`${i ? ', ' : ''}<b>${r.nome || r.entregador}</b> (${brl(r.pago)})`)}.</div></div>` : ''}



${g.temResumo ? (pend.length ? html`<div class="alert warn" id="conferencia">${icone('alerta')}<div><b>Diferença com o Resumo do Agilizone (${pend.length})</b>${pend.map((l, i) => html`${i ? '; ' : ' '}${l.nome}: soma ${brl(l.bruto)}, Resumo ${brl(l.resumo)}`)}. O Agilizone é a referência: confira se os dois arquivos saíram da mesma tela, com o mesmo filtro. Se não, arquive este fechamento e importe de novo.</div></div>` : '')
  : html`<div class="alert warn" id="conferencia">${icone('alerta')}<div><b>Sem o Resumo de entregas</b>Os totais não foram conferidos com o Agilizone.${edita ? html`
<form method="post" action="/fechamentos/${f.id}/resumo" enctype="multipart/form-data" class="linha-form"><input type="file" name="resumo" accept=".csv,text/csv" required aria-label="Resumo de entregas (.csv)"><button class="btn btn-sec btn-sm">Anexar Resumo</button></form>` : ' O despachante precisa anexar.'}</div></div>`}

${blocoConferencia({ f, g, itens: itensFin(f, g), decide: false, edita, modo: 'desp', decisoes: [], hist, nomeDe: () => '', avisados: [], voltar: '/', pixPanel: painelPix(f, g, semPix, edita) })}


${edita ? html`<details class="fold mais-acoes"><summary class="small">${icone('chevron', 'chev')} Importou o arquivo errado?</summary>
<form method="post" action="/fechamentos/${f.id}/arquivar" onsubmit="return confirm('Arquivar este fechamento? Ele sai da lista e os pedidos ficam livres para importar de novo. Nada é apagado: dá para recuperar em Arquivados, desde que esses pedidos não tenham entrado em outro fechamento.')"><p class="small mut">Arquivar tira o fechamento da lista e libera os pedidos para importar de novo. Nada é apagado.</p><button class="btn btn-sec btn-sm">${icone('arquivo', 'sm')} Arquivar fechamento</button></form></details>
<div class="barra" role="region" aria-label="Enviar ao financeiro"><div class="barra-in"><div><span class="mut small">Total a pagar</span><b>${brl(g.total)}</b></div>
${semPix.length ? html`<span class="small bad-t" id="barra-motivo">Preencha ${semPix.length} chave(s) PIX para enviar</span><a class="btn btn-pri btn-lg" href="#pix">${icone('chave')} Revisar chaves Pix</a>`
      : html`<a class="btn btn-pri btn-lg" href="/fechamentos/${f.id}/enviar">${icone('enviar')} Enviar ao financeiro</a>`}</div></div>` : ''}`));
});

function painelPix(f, g, semPix, edita) {
  const precisa = (l) => !l.pix || l.divergenciaPix, faltam = edita ? g.linhas.filter(precisa).length : 0;
  return html`${g.linhas.length ? html`<form method="post" action="/fechamentos/${f.id}/pix" class="card bloco pede pix-bloco" id="pix-form">
<div class="card-h"><span class="hico warn">${icone('chave')}</span><div class="t"><h2>${g.linhas.length - semPix.length} de ${g.linhas.length} chaves Pix conferidas</h2>
<p>${edita ? 'Salve algumas agora e complete depois. Chaves com identidade confirmada ficam no cadastro desta loja para os próximos fechamentos.' : 'Chaves registradas neste fechamento.'}</p></div>
${faltam ? html`<button class="btn btn-pri">Salvar chaves preenchidas</button>` : ''}${edita ? html`<span class="pix-cont" data-pix-cont data-base="${g.linhas.filter((l) => !precisa(l)).length}" data-total="${g.linhas.length}" aria-live="polite">${g.linhas.filter((l) => l.pix).length} de ${g.linhas.length} preenchidas</span>` : ''}</div>
<div class="pix-lista">${faltam ? html`<div class="pix-cab" aria-hidden="true"><span>Entregador</span><span>Chave PIX</span></div>` : ''}${edita && !faltam ? html`<p class="pix-todas">${icone('check', 'sm')} Todos os entregadores já têm chave Pix. Para trocar uma, use <b>Editar</b>.</p>` : ''}${g.linhas.map((l) => html`<div class="pix-item"><div class="pix-quem"><b>${l.nome}</b><span>${l.divergenciaPix ? 'Divergência com o cadastro: revise e salve a chave correta. ' : l.identidadePendente ? 'Identidade pendente: chave restrita a este fechamento. ' : ''}Vai receber <b>${brl(l.total)}</b></span></div>
${edita && !precisa(l) ? html`<div class="pix-ok"><span class="badge ok">Chave cadastrada</span><span class="pix-mask">${mascaraPix(l.pix)}</span><a class="btn btn-ghost btn-sm" href="/fechamentos/${f.id}/motoboy/${l.id}" aria-label="Editar a chave Pix de ${l.nome}">${icone('lapis', 'sm')} Editar</a></div>` : edita ? html`<div class="field pix-campo"><label for="pix_${l.id}" class="sr">Chave PIX de ${l.nome}</label><input id="pix_${l.id}" name="pix_${l.id}" value="${l.pix}" placeholder="Cole aqui: CPF, telefone, e-mail ou chave aleatória" autocomplete="off" maxlength="120" data-pix aria-describedby="tipo_${l.id}"><input type="hidden" name="rev_${l.id}" value="${revLinha(l)}"><span class="pix-tipo" id="tipo_${l.id}" data-pix-tipo></span></div>` : html`<span>${mascaraPix(l.pix)}</span>`}</div>`)}</div>
${faltam ? html`<div class="card-f"><button class="btn btn-pri">${icone('check', 'sm')} Salvar chaves preenchidas</button><span class="small mut">Pode salvar só algumas agora e completar o resto depois.</span></div>` : ''}</form>` : ''}`; }

const editaPix = db.prepare('INSERT INTO edicoes (fechamento_id, motoboy_id, pix) VALUES (?,?,?) ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET pix = excluded.pix');

// Nome e observação pertencem ao fechamento; Pix também atualiza o cadastro confirmado desta loja.
app.get('/fechamentos/:fid/motoboy/:m', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f, l = grade(f).linhas.find((x) => x.id === Number(req.params.m));
  if (!l) throw falha('Entregador não está neste fechamento.', 404);
  const voltar = `/fechamentos/${f.id}#conf`;
  res.send(page(req, { titulo: 'Editar entregador', sub: html`<b>${f.loja} · ${l.nome}</b>. O Pix também será salvo para os próximos fechamentos desta loja quando houver identidade confirmada no Agilizone. Nome e observação valem para este fechamento.`, trilha: [[inicio(req.user), '/'], [periodo(f), voltar], ['Editar entregador']], largura: 'estreita' }, html`
<form method="post" class="card"><input type="hidden" name="rev" value="${revLinha(l)}"><div class="card-b fgrid">
<div class="field" style="grid-column:1/-1"><label for="nome">Nome <span class="req" aria-hidden="true">*</span></label><input id="nome" name="nome" value="${l.nome}" required minlength="3" maxlength="120" autocomplete="off">${l.nomeAgil ? html`<p class="hint">No Agilizone: ${l.nomeAgil}</p>` : ''}</div>
<div class="field" style="grid-column:1/-1"><label for="pix">Chave PIX <span class="req" aria-hidden="true">*</span></label><input id="pix" name="pix" value="${l.pix}" required maxlength="120" autocomplete="off" placeholder="CPF, telefone, e-mail ou chave aleatória"><p class="hint">Confira com o entregador. É para essa chave que o financeiro vai pagar.</p></div>
<div class="field" style="grid-column:1/-1"><label for="obs">Observação</label><textarea id="obs" name="obs" maxlength="300" rows="2" placeholder="Ex.: chave PIX alterada em 04/11">${l.obs}</textarea><p class="hint">Aparece para o financeiro junto ao valor. Opcional.</p></div></div>
<div class="card-f"><button class="btn btn-pri">Salvar</button><a class="btn btn-ghost" href="${voltar}">Cancelar</a></div></form>`));
});

app.post('/fechamentos/:fid/motoboy/:m', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const f = req.f, l = grade(f).linhas.find((x) => x.id === Number(req.params.m));
  if (!l) throw falha('Entregador não está neste fechamento.', 404);
  if (req.body.rev !== revLinha(l)) return volta(res, `/fechamentos/${f.id}/motoboy/${l.id}`, 'erro', `${l.nome} ${MSG_ALTERADO}`);
  const nome = String(req.body.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120), pix = String(req.body.pix || '').trim().slice(0, 120), obs = String(req.body.obs || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (nome.length < 3) throw falha('Digite o nome do entregador.');
  if (!pixValido(pix)) throw falha('Digite uma chave PIX válida.');
  if (!l.divergenciaPix && nome === l.nome && pix === l.pix && obs === l.obs) return volta(res, `/fechamentos/${f.id}`, 'ok', 'Nada mudou.');
  const agil = l.nomeAgil || l.nome;
  tx(() => {
  db.prepare('INSERT INTO edicoes (fechamento_id, motoboy_id, nome, pix, obs) VALUES (?,?,?,?,?) ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET nome = excluded.nome, pix = excluded.pix, obs = excluded.obs')
    .run(f.id, l.id, nome === agil ? null : nome, pix, obs || null);
  salvaPixCadastro(f.loja_id, l.id, pix, req.user.id);
  log(req.user.id, `f:${f.id}`, `Editou entregador ${l.nome}: ${nome !== l.nome ? `nome → ${nome}; ` : ''}${pix !== l.pix ? `PIX ${l.pix || '(vazio)'} → ${pix}; ` : ''}${obs !== l.obs ? `observação: ${obs || '(removida)'}` : ''}`);
  });
  volta(res, `/fechamentos/${f.id}#pix`, 'ok', `${nome}: chave salva no fechamento${pixCadastro(f.loja_id, l.id) ? ' e no cadastro desta loja' : '; identidade pendente, sem associação ao cadastro'}.`);
});

app.post('/fechamentos/:fid/pix', so((r) => podeEditar(r.user, r.f)), (req, res) => {
  const linhas = new Map(grade(req.f).linhas.map((l) => [l.id, l]));
  let n = 0, invalidas = 0, conflitos = 0;
  tx(() => {
    for (const [k, v] of Object.entries(req.body)) {
      const l = linhas.get(Number(k.replace(/^pix_/, ''))), pix = String(v || '').trim().slice(0, 120);
      if (/^pix_\d+$/.test(k) && l && pix && !pixValido(pix)) invalidas++;
      if (/^pix_\d+$/.test(k) && l && pix && req.body[`rev_${k.replace(/^pix_/, '')}`] !== revLinha(l)) { conflitos++; continue; }
      if (!/^pix_\d+$/.test(k) || !l || !pix || !pixValido(pix)) continue;
      editaPix.run(req.f.id, l.id, pix);
      salvaPixCadastro(req.f.loja_id, l.id, pix, req.user.id);
      log(req.user.id, `f:${req.f.id}`, `PIX de ${l.nome} digitado: ${pix}`);
      n++;
    }
  });
  volta(res, `/fechamentos/${req.f.id}#pix`, n ? 'ok' : 'erro', n ? `${n} chave(s) PIX salva(s) no fechamento; cadastros com identidade confirmada atualizados.${invalidas ? ` ${invalidas} chave(s) inválida(s) não salva(s).` : ''}${conflitos ? ` ${conflitos} não salva(s): o entregador ${MSG_ALTERADO}` : ''}` : (conflitos ? `Nada foi salvo: ${conflitos} entregador(es) ${MSG_ALTERADO}` : 'Nenhuma chave PIX válida preenchida.'));
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
  const g = grade(f), pend = g.linhas.filter((l) => l.confere === 'pendente'), semPix = g.linhas.filter((l) => l.total > 0 && (!l.pix || l.divergenciaPix));
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
  const rotulo = reenvio ? 'Reenviar e-mail' : 'Enviar para aprovação';
  // Há algo para o despachante conferir antes de enviar? (não bloqueia o envio)
  const conferir = !reenvio && pend.length;
  res.send(page(req, { titulo, css: '/marca/envio.css', js: '/marca/envio.js', trilha: [[inicio(req.user), '/'], [periodo(f), `/fechamentos/${f.id}`], [titulo]],
    sub: reenvio ? 'O fechamento já foi enviado. Isto manda o e-mail com o PDF de novo.' : 'Confira o resumo e escolha quem recebe o e-mail com o PDF. Depois é só confirmar.' }, html`
<form method="post" action="/fechamentos/${f.id}/${reenvio ? 'email' : 'enviar'}" id="form-envio" data-confirma="dlg-div">
<dl class="envio-strip" aria-label="Resumo do envio">
<div><dt>Loja</dt><dd>${lojaCurta(f.loja)}</dd></div>
<div><dt>Período</dt><dd>${dataFmt(f.data_ini).slice(0, 5)} a ${dataFmt(f.data_fim).slice(0, 5)}</dd></div>
<div><dt>Pagamento previsto</dt><dd>${f.pagamento ? diaLongo(f.pagamento) : '—'}</dd></div>
<div><dt>Entregadores a pagar</dt><dd>${aPagar.length}</dd></div>
<div class="envio-total"><dt>Total a pagar</dt><dd>${brl(g.total)}</dd></div></dl>
${!padrao.length ? html`<div class="alert warn">${icone('email')}<div><b>Nenhum destinatário padrão configurado</b>Digite abaixo quem deve receber o e-mail (opcional: o fechamento chega ao financeiro mesmo sem e-mail). Para deixar uma lista fixa, peça ao Admin para configurar em Configurações.</div></div>` : ''}
${!cfg('smtp_host') && process.env.EMAIL_SO_ARQUIVO !== '1' ? html`<div class="alert bad">${icone('alerta')}<div><b>Servidor de e-mail não configurado</b>${reenvio ? 'O e-mail não vai sair' : 'O fechamento será enviado ao financeiro, mas o e-mail não vai sair'} até o Admin configurar o servidor em Configurações. Enquanto isso, você pode baixar o PDF e o Excel abaixo.</div></div>` : ''}
${pend.length && !reenvio ? html`<div class="alert warn">${icone('alerta')}<div><b>${pend.length} entregador(s) com diferença com o Resumo do Agilizone</b>${pend.map((l) => l.nome).join(', ')}. <a href="/fechamentos/${f.id}#conferencia">Revisar antes de enviar</a>
<label class="just-rot" for="justificativa">Justificativa da diferença <span class="req" aria-hidden="true">*</span></label>
<textarea id="justificativa" name="justificativa" required minlength="10" maxlength="2000" rows="3" aria-describedby="just-dica">${f.justificativa || ''}</textarea>
<span class="hint" id="just-dica">Obrigatória para enviar com diferença (mínimo 10 caracteres). Explique o motivo; o financeiro vê este texto na aprovação.</span></div></div>` : ''}
<div class="envio-grid">
<section class="card envio-card" aria-labelledby="env-h1">
<div class="card-h"><span class="hico pri">${icone('arquivo')}</span><div class="t"><h2 id="env-h1">1. O que vai anexado</h2><p>Os dois arquivos vão juntos no mesmo e-mail, nesta ordem.</p></div></div>
<div class="card-b"><div class="anexos">
<a class="anexo" href="/fechamentos/${f.id}/xlsx"><span class="hico">${icone('baixar')}</span><span class="anexo-t"><b>1. Planilha (Excel)</b><small>Valores por entregador e por dia, ocorrências, chaves PIX e total.</small></span><span class="btn btn-sec btn-sm">Baixar Excel</span></a>
<a class="anexo" href="/fechamentos/${f.id}/pdf" target="_blank" rel="noopener"><span class="hico">${icone('arquivo')}</span><span class="anexo-t"><b>2. Solicitação de pagamento (PDF)</b><small>Resumo, tabela por entregador, chaves PIX e assinaturas.</small></span><span class="btn btn-sec btn-sm">Ver o PDF</span></a></div></div></section>
<section class="card envio-card" aria-labelledby="env-h2">
<div class="card-h"><span class="hico pri">${icone('email')}</span><div class="t"><h2 id="env-h2">2. Para quem enviar</h2><p>Todos desta lista recebem o e-mail. Vale só para este envio.</p></div></div>
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
${reenvio ? '' : html`<p class="small mut envio-nota">${icone('info', 'sm')} Depois de enviar, o fechamento fica travado para edição. Se o financeiro devolver, você volta a poder editar e envia de novo. Entregadores já aprovados continuam aprovados.</p>`}
<div class="barra envio-barra" role="region" aria-label="Enviar"><div class="barra-in"><div><span class="mut small">Total a pagar</span><b>${brl(g.total)}</b></div>
<a class="btn btn-ghost" href="/fechamentos/${f.id}">Voltar</a>
<button class="btn btn-pri btn-lg" data-envio>${icone('enviar')} <span class="lbl" data-rotulo="${rotulo}">${rotulo}</span></button></div></div>
<dialog id="dlg-div" class="dlg" aria-labelledby="dlg-t"><h2 id="dlg-t">Confira antes de ${reenvio ? 'reenviar' : 'enviar'}</h2>
<p>${lojaCurta(f.loja)} · ${periodo(f)} · <b>${brl(g.total)}</b> para ${aPagar.length} entregador(es).</p>
<p><b>O e-mail com o PDF vai para:</b></p><ul class="dlg-l" data-dlg-para></ul>
<p class="small mut">Confira se os endereços estão certos: é por este e-mail que o financeiro fica sabendo da solicitação.</p>
${conferir ? html`<p><b>Diferença com o Resumo:</b></p><ul class="dlg-l">${pend.map((l) => html`<li class="bad"><b>${l.nome}</b>: pedidos ${brl(l.bruto)} · Resumo ${brl(l.resumo)} · diferença ${brl(l.bruto - (l.resumo || 0))} · a pagar ${brl(l.total)}</li>`)}</ul>
<p><b>Sua justificativa:</b> <span data-dlg-just></span></p>` : ''}
<div class="acoes-f"><button type="submit" class="btn btn-pri" data-confirmado>${reenvio ? 'Confirmar e reenviar' : 'Confirmar e enviar'}</button><button type="button" class="btn btn-ghost" data-fecha-dlg>Voltar e corrigir</button></div></dialog>
</form>`));
});

app.post('/fechamentos/:fid/enviar', so((r) => podeEditar(r.user, r.f)), async (req, res) => {
  // Destinatário e e-mail são opcionais: o envio ao financeiro vale mesmo sem e-mail (dá para reenviar depois).
  const f = req.f, para = String(req.body.para || '').trim() ? destinatariosDigitados(req.body.para) : [];
  const p = pendenciasEnvio(f);
  if (p) return volta(res, `/fechamentos/${f.id}`, 'erro', p);
  // Reenvio: entregador já aprovado que mudou (valor ou PIX) exige revisão explícita do despachante.
  const alterados = grade(f).linhas.filter((l) => l.alterado);
  if (alterados.length && req.body.revisei !== '1') return volta(res, `/fechamentos/${f.id}/enviar`, 'erro', `Marque que revisou as mudanças em ${alterados.map((l) => l.nome).join(', ')} (já aprovados pelo financeiro).`);
  // Diferença Pedidos × Resumo: pode enviar, mas com justificativa registrada.
  const difs = grade(f).linhas.filter((l) => l.confere === 'pendente');
  const just = difs.length ? String(req.body.justificativa || '').trim().slice(0, 2000) : null;
  if (difs.length && just.length < 10) return volta(res, `/fechamentos/${f.id}/enviar`, 'erro', `Escreva a justificativa da diferença com o Resumo (${nomes(difs)}), com pelo menos 10 caracteres. Nada foi enviado.`);
  // A transição para "enviado" é gravada primeiro, num único passo síncrono: só quem a conclui notifica. Requisição simultânea
  // ou repetida encontra o fechamento já enviado (403 em podeEditar, ou a checagem de versão abaixo) e não manda e-mail nenhum.
  // O e-mail vem depois e não bloqueia: se falhar (ou o processo cair antes dele), o fechamento já está com o financeiro e
  // "Reenviar e-mail" (POST /fechamentos/:id/email) refaz só o e-mail; o histórico mostra se a versão teve e-mail confirmado.
  const ok = tx(() => {
    const atual = carregaF(f.id);
    if (atual.status !== 'rascunho' || atual.versao !== f.versao) return false;
    db.prepare("UPDATE fechamentos SET status = 'enviado', versao = versao + 1, enviado_em = datetime('now','localtime'), enviado_por = ?, justificativa = ? WHERE id = ?").run(req.user.id, just, f.id);
    enfileiraDrive(f); // planilha deste fechamento vai para a pasta do Drive (Apps Script)
    if (just) log(req.user.id, `f:${f.id}`, `Justificou a diferença com o Resumo (${difs.map((l) => `${l.nome}: pedidos ${brl(l.bruto)}, Resumo ${brl(l.resumo || 0)}`).join('; ')}): ${just}`);
    // Congela o PIX de cada entregador como foi enviado ao financeiro.
    const ls = grade(f).linhas;
    db.prepare('DELETE FROM envio_pix WHERE fechamento_id = ?').run(f.id);
    for (const l of ls) db.prepare('INSERT INTO envio_pix (fechamento_id, motoboy_id, pix) VALUES (?,?,?)').run(f.id, l.id, l.pix);
    const g = grade({ ...f, status: 'enviado' });
    log(req.user.id, `f:${f.id}`, `Enviou ao financeiro (versão ${f.versao + 1}, total ${brl(g.total)}${alterados.length ? `; revisou mudanças em itens já aprovados: ${alterados.map((l) => l.nome).join(', ')}` : ''})`);
    // Reenvio em que tudo já estava aprovado (aprovações preservadas): conclui direto.
    if (!g.linhas.some((l) => l.total > 0 && !l.aprovado)) { db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id); log(null, `f:${f.id}`, 'Aprovou a solicitação de pagamento (todos já estavam aprovados)'); }
    return true;
  });
  if (!ok) return volta(res, `/fechamentos/${f.id}`, 'ok', 'Este fechamento já tinha sido enviado. Nada mudou.');
  const erro = await solicitarPagamento(carregaF(f.id), req.user, para).catch((e) => { console.error(e); return `falha ao gerar o e-mail (${e.message})`; });
  volta(res, `/fechamentos/${f.id}`, erro ? 'erro' : 'ok', erro ? `Fechamento enviado ao financeiro, mas o e-mail não saiu (${erro}). O financeiro já vê o fechamento em Para aprovar. Use "Reenviar e-mail" quando puder.` : `Fechamento enviado ao financeiro. E-mail com o PDF enviado para ${para.join(', ')}.`);
});

// Envia e registra no histórico do fechamento. Devolve null se enviou, ou o motivo de não ter enviado.
async function enviaELoga(f, rotulo, para, msg) {
  if (!para.length) { log(null, `f:${f.id}`, `E-mail (${rotulo}) não enviado: nenhum destinatário configurado`); return 'nenhum destinatário configurado em Configurações'; }
  try {
    const r = await enviarEmail({ to: para.join(', '), ...msg });
    // EMAIL_SO_ARQUIVO=1 (testes e desenvolvimento): a cópia salva em data/emails conta como enviada.
    if (r.salvo && process.env.EMAIL_SO_ARQUIVO !== '1') { log(null, `f:${f.id}`, `E-mail (${rotulo}) não enviado: servidor de e-mail não configurado (cópia salva no servidor)`); return 'servidor de e-mail não configurado em Configurações'; }
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
  const resumo = [['Loja', f.loja], ['Período das entregas', periodo(f)], ['Pagamento previsto', f.pagamento ? diaLongo(f.pagamento) : '—'], ['Entregadores a pagar', String(pagar.length)],
    ...(g.temOc ? [['Ocorrências do Agilizone (já no total)', `${g.totOc > 0 ? '+' : ''}${brl(g.totOc)}`]] : []), ...(g.temPago ? [['Já pago no Agilizone (descontado)', `-${brl(g.totPago)}`]] : []), ...(f.justificativa ? [['Justificativa da diferença com o Resumo', f.justificativa]] : [])];
  const td = 'padding:8px 12px;border-bottom:1px solid #e7e2df;font-size:14px;color:#140a08';
  const corpoHtml = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f8f7f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #e7e2df;border-radius:10px;overflow:hidden">
<tr><td style="border-top:6px solid #df6d2a;padding:24px 24px 8px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b6360">Grupo Forno · Pagamento de entregadores</div>
<h1 style="margin:8px 0 0;font-size:22px;color:#140a08">Solicitação de pagamento</h1></td></tr>
<tr><td style="padding:8px 24px 16px;font-size:14px;line-height:1.55;color:#140a08">Olá,<br>${esc(autor.nome)} enviou a solicitação de pagamento dos entregadores da loja <b>${esc(f.loja)}</b>${quem ? `, ${esc(quem)}` : ''}. Confira os valores e as chaves PIX e aprove no sistema.</td></tr>
<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f7;border:1px solid #e7e2df;border-radius:8px">
${resumo.map(([k, v]) => `<tr><td style="${td};color:#6b6360;width:55%">${esc(k)}</td><td style="${td};text-align:right;font-weight:bold">${esc(v)}</td></tr>`).join('')}
<tr><td style="padding:14px 12px;font-size:14px;color:#6b6360">Total a pagar</td><td style="padding:14px 12px;text-align:right;font-size:24px;font-weight:bold;color:#c2521a">${esc(brl(g.total))}</td></tr></table></td></tr>
${link ? `<tr><td style="padding:20px 24px 4px"><a href="${esc(link)}" style="display:inline-block;background:#c2521a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:8px">Abrir no sistema e aprovar</a></td></tr>` : ''}
<tr><td style="padding:20px 24px 4px;font-size:15px;font-weight:bold;color:#140a08">Anexos neste e-mail</td></tr>
<tr><td style="padding:0 24px 8px;font-size:14px;line-height:1.6;color:#140a08">1. <b>Planilha (Excel)</b>: valores por entregador e por dia, ocorrências, chaves PIX e total.<br>2. <b>PDF</b>: a mesma solicitação para conferência e assinatura.</td></tr>
<tr><td style="padding:12px 24px 4px;font-size:15px;font-weight:bold;color:#140a08">Entregadores a pagar (${pagar.length})</td></tr>
<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e2df;border-radius:8px;border-collapse:separate">
<tr style="background:#140a08"><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold">Entregador</td><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold">Chave PIX</td><td style="padding:8px 12px;font-size:12px;color:#ffffff;font-weight:bold;text-align:right">Total</td></tr>
${pagar.map((l, i) => `<tr style="background:${i % 2 ? '#faf8f7' : '#ffffff'}"><td style="${td}"><b>${esc(l.nome)}</b>${l.oc || l.qtdOc ? `<br><span style="font-size:12px;color:#b8501a">inclui ocorrência ${l.oc > 0 ? '+' : ''}${esc(brl(l.oc))}</span>` : ''}</td><td style="${td};word-break:break-all">${esc(l.pix || '—')}</td><td style="${td};text-align:right;font-weight:bold;white-space:nowrap">${esc(brl(l.total))}</td></tr>`).join('')}
</table></td></tr>
<tr><td style="padding:8px 24px 24px;font-size:12.5px;line-height:1.5;color:#6b6360">Aprovar no sistema não é pagar: o pagamento é feito fora do sistema, com as chaves PIX acima. Este e-mail foi enviado automaticamente pelo sistema Pagamento de entregadores.</td></tr>
</table></td></tr></table></body></html>`;
  const texto = `Olá,\n\n${autor.nome} enviou a solicitação de pagamento dos entregadores da loja ${f.loja}${quem ? `, ${quem}` : ''}.\n\n` +
    resumo.map(([k, v]) => `${k}: ${v}`).join('\n') + `\nTOTAL A PAGAR: ${brl(g.total)}\n\n` +
    'Entregadores a pagar:\n' + pagar.map((l) => `• ${l.nome}: ${brl(l.total)} · PIX ${l.pix || '—'}`).join('\n') +
    '\n\nAnexos: 1) planilha em Excel com os valores por dia; 2) PDF da solicitação.' + (link ? `\nAbrir no sistema e aprovar: ${link}` : '') +
    '\n\nAprovar no sistema não é pagar: o pagamento é feito fora do sistema.';
  return enviaELoga(f, 'solicitação', para, {
    subject: `Solicitação de pagamento · Entregadores · ${f.loja} · ${f.pagamento ? `pagamento ${dataFmt(f.pagamento)} · ` : ''}${brl(g.total)}`,
    text: texto, html: corpoHtml,
    // Os dois anexos vão juntos, na ordem: planilha e depois o PDF.
    attachments: [
      { filename: `planilha-entregadores-${nome}-${ref}.xlsx`, content: xlsxFechamento(f, g), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { filename: `solicitacao-pagamento-entregadores-${nome}-${ref}.pdf`, content: await gerarPdf(f, g), contentType: 'application/pdf' },
    ],
  });
}

app.post('/fechamentos/:fid/email', so((r) => podeReenviar(r.user, r.f)), async (req, res) => {
  const para = req.body.para != null ? destinatariosDigitados(req.body.para) : destinatariosPadrao(req.user);
  const erro = await solicitarPagamento(req.f, req.user, para);
  volta(res, `/fechamentos/${req.f.id}`, erro ? 'erro' : 'ok', erro ? `E-mail não enviado: ${erro}. O fechamento não mudou.` : `E-mail da solicitação de pagamento reenviado para ${para.join(', ')}. O fechamento não mudou.`);
});

app.get('/fechamentos/:fid/pdf', async (req, res) => {
  const g = grade(req.f);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="entregadores-${req.f.loja.replace(/\W+/g, '_')}-${req.f.data_ini}.pdf"`);
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
    return { url, n: sel.length, total, faltam, loja: f.loja, lojaId: f.loja_id };
  });
  volta(res, r.url, 'ok', r.faltam ? `${r.n} aprovado(s), ${brl(r.total)}. Faltam ${r.faltam} entregador(es) para analisar.`
    : `Solicitação de ${r.loja} aprovada por completo. Agora está em Pagamentos: faça a transferência e registre o pagamento lá.`, r.faltam ? null : [`/pagar?loja=${r.lojaId}`, 'Ir para pagamentos']);
});

// Quem recebe o aviso de devolução: quem importou e os despachantes da loja.
const avisadosDevolucao = (f) => db.prepare("SELECT nome FROM usuarios WHERE ativo = 1 AND (id = ? OR (perfil = 'despachante' AND loja_id = ?)) ORDER BY nome").all(f.criado_por, f.loja_id);

// Devolve entregadores à loja: grava o motivo de cada um, separa os já aprovados (se houver) e reabre o restante como rascunho.
// manter = true: só os devolvidos saem (para um fechamento novo); os demais ficam aqui aguardando aprovação.
function devolveLote(f, user, devSel, motivos, avisados, manter = false) {
  const itens = itensFin(f, grade(f)), para = avisados.map((a) => a.nome).join(', ');
  const ins = db.prepare('INSERT INTO devolucoes (fechamento_id, motoboy_id, versao, valor, pix, motivo, devolvido_por, para) VALUES (?,?,?,?,?,?,?,?)');
  for (const i of devSel) ins.run(f.id, i.id, f.versao, i.total, i.pix, motivos.get(i.id), user.id, para);
  const total = devSel.reduce((t, i) => t + i.total, 0), iguais = new Set(devSel.map((i) => motivos.get(i.id))).size === 1;
  const texto = iguais ? motivos.get(devSel[0].id) : devSel.map((i) => `• ${i.nome}: ${motivos.get(i.id)}`).join('\n');
  const quais = `${devSel.map((i) => `${i.nome} ${brl(i.total)}`).join('; ')}. Avisados: ${para || 'ninguém cadastrado'}`;
  // Quem fica no fechamento original: os aprovados (ou, com manter, todos os não devolvidos). Quem sai vai para um fechamento novo devolvido à loja.
  const devIds = new Set(devSel.map((i) => i.id));
  const ficam = manter ? itens.filter((i) => !devIds.has(i.id) && (i.total > 0 || i.sit === 'aprovado')) : itens.filter((i) => i.sit === 'aprovado');
  const saem = manter ? [...devIds] : itens.filter((i) => i.sit !== 'aprovado').map((i) => i.id);
  let alvo = f;
  if (ficam.length) {
    const novo = Number(db.prepare(`INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, criado_por, criado_em, arquivo, pagamento, versao, enviado_em, enviado_por, origem_id, so_resumo)
      SELECT loja_id, data_ini, data_fim, 'rascunho', criado_por, criado_em, arquivo, pagamento, versao, enviado_em, enviado_por, id, so_resumo FROM fechamentos WHERE id = ?`).run(f.id).lastInsertRowid);
    const lista = saem.map(Number).join(',') || '0';
    for (const t of ['pedidos', 'resumo', 'edicoes', 'envio_pix'])
      db.prepare(`UPDATE ${t} SET fechamento_id = ? WHERE fechamento_id = ? AND motoboy_id IN (${lista})`).run(novo, f.id);
    db.prepare(`INSERT INTO devolucoes (fechamento_id, motoboy_id, versao, valor, pix, motivo, devolvido_por, devolvido_em, para)
      SELECT ?, motoboy_id, versao, valor, pix, motivo, devolvido_por, devolvido_em, para FROM devolucoes WHERE fechamento_id = ? AND versao = ?`).run(novo, f.id, f.versao);
    // Concluído se todos os que ficaram estão aprovados; senão (manter) segue aguardando aprovação.
    const concluido = !grade(f).linhas.some((l) => l.total > 0 && !l.aprovado);
    if (concluido) db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id);
    const valorFica = ficam.reduce((t, i) => t + i.total, 0);
    log(user.id, `f:${f.id}`, `Devolveu ${saem.length} entregador(es) para o fechamento #${novo}: ${texto}`);
    log(user.id, `f:${f.id}`, concluido ? `Aprovou a solicitação de pagamento em parte: ${ficam.length} entregador(es), ${brl(valorFica)}` : `${ficam.length} entregador(es) continuam aqui aguardando aprovação (${brl(valorFica)})`);
    log(user.id, `f:${novo}`, `Criado a partir do fechamento #${f.id}: entregadores devolvidos (os outros, ${brl(valorFica)}, ficaram no #${f.id})`);
    alvo = carregaF(novo);
  }
  db.prepare("UPDATE fechamentos SET status = 'rascunho' WHERE id = ?").run(alvo.id);
  // Descongela o PIX que veio do Agilizone (pode mudar se o Resumo for anexado de novo); o digitado continua.
  db.prepare('DELETE FROM envio_pix WHERE fechamento_id = ?1 AND motoboy_id IN (SELECT motoboy_id FROM resumo WHERE fechamento_id = ?1 AND pix IS NOT NULL)').run(alvo.id);
  log(user.id, `f:${alvo.id}`, `Devolveu para correção: ${texto}`);
  log(user.id, `f:${alvo.id}`, `Entregadores devolvidos (versão ${f.versao}, ${brl(total)}): ${quais}`);
  return { alvo, separado: alvo.id !== f.id, total, itens };
}

app.post('/fechamentos/:fid/devolver', so((r) => decideFin(r.user)), async (req, res) => {
  const motivo = String(req.body.motivo || '').trim().slice(0, 2000);
  if (motivo.length < 5) recusa('Escreva o motivo da devolução (mínimo 5 caracteres). Nada foi alterado.', detalheFin(req.f, req.body.volta));
  const avisados = avisadosDevolucao(req.f);
  const r = tx(() => {
    const { f, url, sel } = decisao(req);
    const apr = sel.filter((i) => i.sit === 'aprovado');
    if (apr.length) recusa(`${nomes(apr)} já foi aprovado e não pode ser devolvido. Nada foi alterado.`, url);
    // Só os marcados saem (para um fechamento novo); os demais continuam aqui aguardando aprovação.
    const out = devolveLote(f, req.user, sel, new Map(sel.map((i) => [i.id, motivo])), avisados, true);
    return { f: out.alvo, url, sel, total: out.total, separado: out.separado, origem: f };
  });
  const sep = r.separado ? ` Eles foram para o novo fechamento #${r.f.id}; os demais continuam no #${r.origem.id}, aguardando aprovação.` : ' O fechamento inteiro voltou à loja.';
  volta(res, r.url, 'ok', `Devolvido(s) para correção: ${nomes(r.sel)} (${brl(r.total)}).${sep} O despachante vê o motivo em Pendências.`, [`/fechamentos/${r.f.id}`, 'Abrir o que voltou à loja']);
});

// Decisão única do financeiro: ele marca quem devolver (cada um com o seu motivo) e todos os demais são aprovados juntos.
app.post('/fechamentos/:fid/decidir', so((r) => decideFin(r.user)), (req, res) => {
  const avisados = avisadosDevolucao(req.f);
  const r = tx(() => {
    const url = detalheFin(req.f, req.body.volta), f = carregaF(req.f.id);
    if (f.status !== 'enviado' || String(f.versao) !== String(req.body.versao))
      recusa(`Este fechamento mudou desde que você abriu a tela (${f.status === 'enviado' ? `a loja reenviou: agora é a versão ${f.versao}` : f.status === 'pago' ? 'já foi aprovado' : 'já foi devolvido à loja'}). Nada foi alterado. Confira e decida de novo.`, url);
    const itens = itensFin(f, grade(f)), ids = [...new Set([].concat(req.body.dev ?? []).map(Number).filter(Boolean))];
    const devSel = itens.filter((i) => ids.includes(i.id));
    if (devSel.length !== ids.length) recusa('Há entregador marcado que não está neste fechamento. Nada foi alterado.', url);
    const nao = devSel.filter((i) => ['aprovado', 'semvalor'].includes(i.sit));
    if (nao.length) recusa(`${nomes(nao)} não pode ser devolvido (já aprovado ou sem valor). Nada foi alterado.`, url);
    const motivos = new Map(devSel.map((i) => [i.id, String(req.body[`motivo_${i.id}`] || '').trim().slice(0, 2000)]));
    const sem = devSel.filter((i) => motivos.get(i.id).length < 5);
    if (sem.length) recusa(`Escreva o motivo da devolução de ${nomes(sem)} (mínimo 5 caracteres). Nada foi alterado.`, url);
    // resto=manter: devolve só os marcados e os demais continuam aguardando. Senão, todos os outros com valor a pagar são aprovados;
    // quem não pode ser aprovado (sem PIX) precisa estar na lista de devoluções.
    const manter = devSel.length > 0 && req.body.resto === 'manter';
    const aprovar = manter ? [] : itens.filter((i) => !ids.includes(i.id) && i.total > 0 && ['aguardando', 'alterado', 'bloqueado'].includes(i.sit));
    const bloq = aprovar.filter((i) => i.bloq);
    if (bloq.length) recusa(`Não dá para aprovar ${bloq.map((i) => `${i.nome} (${i.bloq})`).join('; ')}: marque para devolver. Nada foi alterado.`, url);
    const ins = db.prepare(`INSERT INTO aprovacoes (fechamento_id, motoboy_id, aprovado_por, valor, pix, versao) VALUES (?,?,?,?,?,?)
      ON CONFLICT (fechamento_id, motoboy_id) DO UPDATE SET aprovado_por = excluded.aprovado_por, aprovado_em = datetime('now','localtime'), valor = excluded.valor, pix = excluded.pix, versao = excluded.versao`);
    for (const i of aprovar) ins.run(f.id, i.id, req.user.id, i.total, i.pix, f.versao);
    const totApr = aprovar.reduce((t, i) => t + i.total, 0);
    if (aprovar.length) log(req.user.id, `f:${f.id}`, `Aprovou ${aprovar.length} entregador(es) da versão ${f.versao}${devSel.length ? ' (os não marcados para devolver)' : ''}, total ${brl(totApr)}: ${aprovar.map((i) => `${i.nome} ${brl(i.total)} (PIX ${i.pix})`).join('; ')}`);
    if (!devSel.length) {
      if (!grade(f).linhas.some((l) => l.total > 0 && !l.aprovado)) { db.prepare("UPDATE fechamentos SET status = 'pago' WHERE id = ?").run(f.id); log(req.user.id, `f:${f.id}`, 'Aprovou a solicitação de pagamento (todos os entregadores)'); }
      return { url, aprovou: true, nApr: aprovar.length, totApr, loja: f.loja, lojaId: f.loja_id };
    }
    const out = devolveLote(f, req.user, devSel, motivos, avisados, manter);
    return { url: out.separado && !manter ? detalheFin(out.alvo, req.body.volta) : url, nDev: devSel.length, nomesDev: nomes(devSel), totDev: out.total, nApr: aprovar.length, totApr, separado: out.separado, manter, origem: f, novo: out.alvo };
  });
  if (r.aprovou) return volta(res, r.url, 'ok', `Solicitação de ${r.loja} aprovada por completo (${r.nApr} entregador(es), ${brl(r.totApr)}). Agora está em Pagamentos: faça a transferência e registre o pagamento lá.`, [`/pagar?loja=${r.lojaId}`, 'Ir para pagamentos']);
  const sep = !r.separado ? ' Nenhum entregador ficou: o fechamento inteiro voltou à loja.'
    : r.manter ? ` Os devolvidos foram para o novo fechamento #${r.novo.id}; os demais continuam aqui, aguardando aprovação.`
    : ` Os aprovados ficaram no #${r.origem.id} (já em Pagamentos); os devolvidos estão no novo fechamento #${r.novo.id}.`;
  volta(res, r.url, 'ok', `Devolvido(s) para correção: ${r.nomesDev} (${brl(r.totDev)})${r.nApr ? `. ${r.nApr} aprovado(s) automaticamente (${brl(r.totApr)})` : ''}.${sep} O despachante vê o motivo em Pendências, em "O que você precisa fazer".`, [`/fechamentos/${r.novo.id}`, 'Abrir o que voltou à loja']);
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
  const cab = ['Entregador', 'Chave PIX', ...g.dias.map(diaFmt), ...(g.temOc ? ['Ocorrências'] : []), ...(g.temPago ? ['Já pago'] : []), ...(g.temResumo ? ['Valor do Resumo', 'Diferença pedidos - Resumo'] : []), 'Total a pagar'];
  const linhas = g.linhas.map((l) => [l.nome, l.pix || '', ...g.dias.map((d) => R(l.dias[d]?.final || 0)), ...(g.temOc ? [R(l.oc)] : []), ...(g.temPago ? [R(-l.pago)] : []), ...(g.temResumo ? [R(l.resumo || 0), R(l.bruto - (l.resumo || 0))] : []), R(l.total)]);
  const tot = ['TOTAL', '', ...g.dias.map((d) => R(g.totDia[d])), ...(g.temOc ? [R(g.totOc)] : []), ...(g.temPago ? [R(-g.totPago)] : []), ...(g.temResumo ? [R(g.linhas.reduce((t, l) => t + (l.resumo || 0), 0)), R(g.linhas.reduce((t, l) => t + l.bruto - (l.resumo || 0), 0))] : []), R(g.total)];
  const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas, tot]);
  const ref = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= ref.e.r; r++) for (let c = 2; c <= ref.e.c; c++) { const cel = ws[XLSX.utils.encode_cell({ r, c })]; if (cel) { cel.t = 'n'; cel.z = '#,##0.00'; } }
  ws['!cols'] = [{ wch: 36 }, { wch: 34 }, ...Array(ref.e.c - 1).fill({ wch: 13 })];
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  const info = XLSX.utils.aoa_to_sheet([['Loja', f.loja], ['Período das entregas', periodo(f)], ['Pagamento previsto', f.pagamento ? diaLongo(f.pagamento) : '—'], ['Entregadores a pagar', g.linhas.filter((l) => l.total > 0).length],
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
  res.setHeader('Content-Disposition', `attachment; filename="entregadores-${nomeArquivo(f)}.xlsx"`);
  res.send(xlsxFechamento(f, grade(f)));
});

// ---------- Pagamentos (financeiro): fechamentos aprovados, pagos um a um ou juntos em um lote ----------
const soPagar = so((r) => decideFin(r.user));
const pl = (n, um, mais) => `${n} ${n === 1 ? um : mais}`;
const urlPagar = (v) => (typeof v === 'string' && /^\/pagar(\?[\w=&%.+-]*)?$/.test(v) ? v : '/pagar');

// Quem recebe em um fechamento aprovado: valor e PIX registrados na aprovação de cada entregador.
const aPagarDe = (f) => grade(f).linhas.filter((l) => l.total > 0).map((l) => ({ id: l.id, nome: l.nome, valor: l.aprovacao?.valor ?? l.total, pix: l.aprovacao?.pix ?? l.pix }));
// Assinatura do que estava na tela: se a aprovação, o valor ou o PIX mudarem antes de registrar, o registro é recusado.
const assinaPag = (itens) => crypto.createHash('sha256').update(itens.map((i) => `${i.id}:${i.valor}:${i.pix}`).join('|')).digest('hex').slice(0, 12);
app.get('/pagar', soPagar, (req, res) => {
  const u = req.user, q = req.query, hoje = agora().data, dm = (d) => dataFmt(d).slice(0, 5);
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all().filter((l) => !u.loja_id || l.id === u.loja_id);
  const loja = lojas.some((l) => l.id === Number(q.loja)) ? Number(q.loja) : 0;
  const aba = ['naopagos', 'vencidos', 'pagos'].includes(q.aba) ? q.aba : 'naopagos', per = periodoSel(q, hoje);
  // Filtro de datas: pagamento previsto (não pagos e vencidos) ou dia em que foi pago (aba Pagos).
  const dt = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : ''), de = dt(q.de), ate = dt(q.ate), filtrando = !!(de || ate);
  const todos = fechamentosDe(u).filter((f) => !f.arquivado_em && f.versao > 0), daLoja = todos.filter((f) => !loja || f.loja_id === loja);
  const aprovados = daLoja.filter((f) => f.status === 'pago'), nao = aprovados.filter((f) => !f.pago_em), pagos = aprovados.filter((f) => f.pago_em);
  const prev = (f) => f.pagamento || f.data_fim, atraso = (f) => Math.round((Date.parse(hoje) - Date.parse(prev(f))) / 864e5);
  const venc = nao.filter((f) => prev(f) < hoje);
  const soma = (xs) => xs.reduce((t, f) => t + f.total, 0);
  const emAnalise = daLoja.filter((f) => f.status === 'enviado');
  const dia = (f) => (aba === 'pagos' ? (f.pago_em || '').slice(0, 10) : prev(f)), noPeriodo = (f) => (!de || dia(f) >= de) && (!ate || dia(f) <= ate), pagosF = pagos.filter(noPeriodo).filter((f) => per.dentro((f.pago_em || '').slice(0, 10)));
  const lista = (aba === 'pagos' ? pagosF : (aba === 'vencidos' ? venc : nao).filter(noPeriodo)).sort((a, b) => prev(a).localeCompare(prev(b)) || a.id - b.id);
  const qs = (m = {}) => { const p = new URLSearchParams(Object.entries({ aba: aba === 'naopagos' ? '' : aba, loja: loja || '', de, ate, per: aba === 'pagos' ? per.param : '', mes: aba === 'pagos' ? per.mes : '', ini: aba === 'pagos' ? per.cini : '', fim: aba === 'pagos' ? per.cfim : '', ...m }).filter(([, x]) => x)); return p.size ? `/pagar?${p}` : '/pagar'; };
  const aqui = qs(), nomes = new Map(db.prepare('SELECT id, nome FROM usuarios').all().map((x) => [x.id, x.nome]));
  const abas = [['naopagos', 'A pagar', nao.length], ['vencidos', 'Vencidos', venc.length], ['pagos', 'Pagos', pagos.length]];
  const recebimentos = new Map(lista.map((f) => [f.id, aPagarDe(f)]));
  const linhaF = (f, comCx) => { const its = recebimentos.get(f.id) || aPagarDe(f);
    return html`<tr>${comCx ? html`<td class="c-chk"><input type="checkbox" name="sel" value="${f.id}:${f.total}:${assinaPag(its)}" data-v="${f.total}" data-rot="#${f.id} · ${lojaCurta(f.loja)}" data-n="${its.length}" aria-label="Selecionar fechamento #${f.id}, ${lojaCurta(f.loja)}, ${brl(f.total)}"></td>` : ''}
<td class="c-fech"><a href="${detalheFin(f, aqui)}"><b>#${f.id}</b></a></td><td class="c-loja">${lojaCurta(f.loja)}</td><td class="c-per">${periodo(f)}</td>
<td class="c-pag">${f.pagamento ? dataFmt(f.pagamento) : html`<span title="Vencimento usa o fim do período">Sem data · referência ${dataFmt(f.data_fim)}</span>`}${!f.pago_em && prev(f) < hoje ? html`<small class="bad-t">Vencido há ${atraso(f)} dia${atraso(f) === 1 ? '' : 's'}</small>` : ''}</td>
<td class="n c-ent">${f.n}</td><td class="n b c-tot">${brl(f.total)}</td><td class="n c-acao"><button type="button" class="btn btn-sec btn-sm" data-abre="recebe-${f.id}">Quem recebe</button></td></tr>`; };
  const cab = (cx) => html`<thead><tr>${cx ? html`<th scope="col"><input type="checkbox" data-todos aria-label="Selecionar todos os ${lista.length} fechamentos desta fila filtrada" aria-describedby="pg-selecao-escopo"></th>` : ''}<th scope="col">Fechamento</th><th scope="col">Loja</th><th scope="col">Período das entregas</th><th scope="col">Pagamento previsto</th><th scope="col" class="n">Entregadores</th><th scope="col" class="n">Total</th><th scope="col">Ação</th></tr></thead>`;
  const paineis = lista.map((f) => html`<dialog id="recebe-${f.id}" class="dlg sheet side-panel" aria-labelledby="recebe-t-${f.id}"><h2 id="recebe-t-${f.id}">Quem recebe · fechamento #${f.id}</h2><p><b>${f.loja}</b> · ${periodo(f)}</p><p class="hint">Pix e valores registrados na aprovação. Total: <b>${brl(f.total)}</b>.</p>
<div class="tw"><table class="pg-sub"><caption class="sr">Destinatários do fechamento #${f.id}</caption><thead><tr><th scope="col">Entregador e Pix aprovado</th><th scope="col" class="n">Valor</th><th scope="col">Copiar</th></tr></thead><tbody>${recebimentos.get(f.id).map((i) => html`<tr><th scope="row">${i.nome}<small class="pix-c">${i.pix || 'Sem Pix'}</small></th><td class="n">${brl(i.valor)}</td><td>${i.pix ? html`<button type="button" class="btn btn-sec btn-xs" data-copiar="${i.pix}" data-copiar-nome="${i.nome}" aria-label="Copiar Pix de ${i.nome}"><span data-copiar-tx>Copiar Pix</span></button>` : ''}</td></tr>`)}</tbody></table></div><div class="acoes-f"><button type="button" class="btn btn-sec" data-fecha>Fechar</button></div></dialog>`);
  const lotes = new Map();
  for (const f of pagosF) { const k = f.lote || `u${f.id}`; if (!lotes.has(k)) lotes.set(k, []); lotes.get(k).push(f); }
  const gruposPagos = [...lotes.entries()].map(([k, fs]) => ({ k, fs, em: fs[0].pago_em, por: nomes.get(fs[0].pago_por), lote: fs[0].lote })).sort((a, b) => b.em.localeCompare(a.em));
  res.send(page(req, { titulo: 'Pagamentos', eyebrow: 'Financeiro', sub: 'Consulte os destinatários, transfira no banco e registre a transferência feita.', css: '/marca/admin.css', js: '/marca/pagar.js', largura: 'larga', compacto: true, financeiro: true }, html`
<h2 class="sec-t pg-visao">Visão geral${loja ? ` · ${lojaCurta(lojas.find((l) => l.id === loja).nome)}` : ' · todas as lojas'} <span class="mut small">(não muda com o filtro de datas)</span></h2>
<div class="stats fin-indicadores"><div class="card stat"><span class="hico bad">${icone('alerta')}</span><div><div class="v">${brl(soma(venc))}</div><div class="l">${venc.length} fechamento(s) vencido(s)</div></div></div>
<div class="card stat"><span class="hico ok">${icone('carteira')}</span><div><div class="v">${brl(soma(nao))}</div><div class="l">Aprovado, a pagar · ${nao.length} fechamento(s)</div></div></div>
<div class="card stat"><span class="hico info">${icone('relogio')}</span><div><div class="v">${brl(emAnalise.reduce((t, f) => t + f.total - f.aprovado, 0))}</div><div class="l">Aguardando aprovação · ${emAnalise.length} fechamento(s)</div></div></div>
<div class="card stat"><span class="hico ok">${icone('check')}</span><div><div class="v">${brl(soma(pagos))}</div><div class="l">Pago · ${pagos.length} fechamento(s)</div></div></div></div>
<section class="card fila pg-fila" aria-labelledby="pg-fila-t"><header class="fila-cab"><h2 id="pg-fila-t">Fila de pagamentos</h2><span class="mut small">${lista.length} fechamento(s) · ${brl(soma(lista))} nos filtros atuais</span></header><nav class="seg fila-abas" aria-label="Situação do pagamento">${abas.map(([k, t, n]) => html`<a href="${qs({ aba: k === 'naopagos' ? '' : k })}" class="${aba === k ? 'on' : ''}" ${aba === k ? new Raw('aria-current="page"') : ''}>${t}<span class="c">${n}</span></a>`)}</nav><p class="fin-escopo">Contadores das abas: loja selecionada, sem filtro de datas. A lista e seu total seguem as datas abaixo.</p>
<form method="get" action="/pagar" class="filtros" role="search" aria-label="Filtrar por data">${aba !== 'naopagos' ? html`<input type="hidden" name="aba" value="${aba}">` : ''}${aba === 'pagos' && per.param ? html`<input type="hidden" name="per" value="${per.param}">` : ''}${aba === 'pagos' && per.mes ? html`<input type="hidden" name="mes" value="${per.mes}">` : ''}${aba === 'pagos' && per.cini ? html`<input type="hidden" name="ini" value="${per.cini}">` : ''}${aba === 'pagos' && per.cfim ? html`<input type="hidden" name="fim" value="${per.cfim}">` : ''}<div class="field"><label for="p-loja">Loja</label><select id="p-loja" name="loja"><option value="">Todas as autorizadas</option>${lojas.map((l) => html`<option value="${l.id}" ${l.id === loja ? 'selected' : ''}>${lojaCurta(l.nome)}</option>`)}</select></div>
<div class="field"><label for="p-de">${aba === 'pagos' ? 'Pagamento efetivo de' : 'Pagamento previsto de'}</label><input id="p-de" type="date" name="de" value="${de}"></div><div class="field"><label for="p-ate">${aba === 'pagos' ? 'Pagamento efetivo até' : 'Pagamento previsto até'}</label><input id="p-ate" type="date" name="ate" value="${ate}"></div>
<div class="filtros-b"><button class="btn btn-sec">${icone('busca', 'sm')} Filtrar</button>${filtrando ? html`<a class="btn btn-ghost" href="${qs({ de: '', ate: '' })}">Limpar datas</a>` : ''}</div>${filtrando ? html`<p class="mut small filtros-r">${pl(lista.length, 'fechamento', 'fechamentos')} no período.</p>` : ''}</form>
${aba === 'pagos' && pagos.length ? html`<div style="padding:14px 20px 0">${barraPeriodo(per, pagos.map((f) => f.pago_em.slice(0, 10)), (o) => qs({ per: o.per === 'semana' ? '' : o.per, mes: o.mes, ini: o.ini, fim: o.fim }))}</div>` : ''}
${aba === 'pagos' ? (gruposPagos.length ? html`${gruposPagos.map((g) => html`<section class="lote" aria-label="Pagamento de ${quando(g.em)}"><div class="lote-h"><div><b>${g.lote ? `Lote #${g.lote}` : 'Pagamento'}</b> · pago em ${quando(g.em)}${g.por ? ` por ${g.por}` : ''}<div class="mut small">${g.fs.length} fechamento${g.fs.length > 1 ? 's' : ''} · ${brl(soma(g.fs))}</div></div>
${g.lote ? html`<form method="post" action="/pagar/desfazer" data-confirma-txt="Desfazer o registro de pagamento do lote #${g.lote}? Isto só tira a marcação no sistema: os fechamentos voltam para A pagar. Nenhuma transferência é cancelada no banco; se ela já foi feita, continua valendo."><input type="hidden" name="lote" value="${g.lote}"><input type="hidden" name="volta" value="${aqui}"><button class="btn btn-ghost btn-sm">${icone('desfazer', 'sm')} Desfazer registro de pagamento</button></form>` : ''}</div>
<div class="tw"><table class="tab-pg">${cab(false)}<tbody>${g.fs.map((f) => linhaF(f, false))}</tbody></table></div></section>`)}` : html`<p class="vazio-p">${filtrando || pagos.length ? 'Nenhum fechamento pago neste período. Escolha outro período acima.' : 'Nenhum fechamento pago ainda.'}</p>`)
  : html`<form method="post" action="/pagar" data-pagar data-sem-carga data-usuario="${u.id}"><input type="hidden" name="volta" value="${aqui}">
<p class="pg-instrucao" id="pg-selecao-escopo">Abra <b>Quem recebe</b> para consultar e copiar o Pix aprovado. Selecionar todos marca os <b>${lista.length} fechamentos desta fila filtrada</b>.</p>
<div class="tw"><table class="tab-pg">${cab(true)}<tbody>${lista.map((f) => linhaF(f, true))}${lista.length ? '' : html`<tr><td colspan="8" class="mut" style="text-align:center;padding:32px">${filtrando || loja ? 'Nenhum fechamento com estes filtros. Altere a loja ou as datas.' : aba === 'vencidos' ? 'Nenhum fechamento vencido. Tudo em dia.' : 'Nenhum fechamento aprovado esperando pagamento.'}</td></tr>`}</tbody>
${lista.length ? html`<tfoot><tr><th colspan="6" scope="row">Total na tela</th><td class="n b">${brl(soma(lista))}</td><td></td></tr></tfoot>` : ''}</table></div>
${lista.length ? html`<div class="barra" role="region" aria-label="Registrar pagamento"><div class="barra-in"><div><span class="mut small" id="sel-rot" aria-live="polite">Nenhum fechamento selecionado</span><b id="sel-total">R$ 0,00</b></div><span class="small pg-aviso-banco">Faça a transferência no banco antes de registrar o pagamento</span><button type="button" class="btn btn-ghost" data-limpar>Limpar</button><button class="btn btn-pri btn-lg" data-pagar-btn disabled>${icone('check')} Registrar pagamento</button></div></div>` : ''}</form>`}</section>${paineis}
<dialog id="dlg-pagamento" class="dlg" aria-labelledby="pg-confirmar-t" aria-describedby="pg-confirmar-hint"><h2 id="pg-confirmar-t">Registrar pagamento</h2><p id="pg-confirmar-hint">Faça a transferência no banco antes de registrar o pagamento</p><div data-pg-resumo></div><p class="hint" data-pg-total></p><p role="status" aria-live="polite" data-pg-status></p><div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha data-pg-cancelar>Cancelar</button><button type="button" class="btn btn-sec" data-pg-consultar hidden>Consultar estado registrado</button><a class="btn btn-sec" href="${aqui}" data-pg-atualizar hidden>Atualizar fila</a><button type="button" class="btn btn-pri" data-pg-confirmar>Registrar pagamento</button></div></dialog>`));
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

app.post('/pagar', soPagar, (req, res) => {
  const u = req.user, url = urlPagar(req.body.volta);
  const pares = [].concat(req.body.sel ?? []).map((s) => String(s).split(':')).filter((t) => t.length === 3 && Number.isInteger(Number(t[0])) && Number.isInteger(Number(t[1]))).map(([a, b, c]) => [Number(a), Number(b), c]);
  if (!pares.length || new Set(pares.map((p) => p[0])).size !== pares.length) recusa('Selecione pelo menos um fechamento. Se a tela estava aberta há tempo, atualize e marque de novo.', url);
  const r = tx(() => {
    const lote = db.prepare('SELECT COALESCE(MAX(lote), 0) + 1 n FROM fechamentos').get().n;
    let total = 0;
    for (const [id, valor, assin] of pares) {
      const f = carregaF(id);
      if (!f || !podeVer(u, f) || f.status !== 'pago' || f.arquivado_em) recusa(`O fechamento #${id} não está aprovado para pagar. Atualize a tela. Nenhum pagamento foi registrado.`, url);
      if (f.pago_em) recusa(`O pagamento do fechamento #${id} já foi registrado. Atualize a tela. Nenhum pagamento novo foi registrado.`, url);
      const t = grade(f).total;
      if (t !== valor) recusa(`O valor do fechamento #${id} mudou. Atualize a tela e confira de novo. Nenhum pagamento foi registrado.`, url);
      if (assinaPag(aPagarDe(f)) !== assin) recusa(`A aprovação ou a chave PIX de algum entregador do fechamento #${id} mudou desde que você abriu a tela. Atualize e confira de novo. Nenhum pagamento foi registrado.`, url);
      db.prepare("UPDATE fechamentos SET pago_em = datetime('now','localtime'), pago_por = ?, lote = ? WHERE id = ?").run(u.id, lote, id);
      total += t;
      log(u.id, `f:${id}`, `Registrou o pagamento (lote #${lote}${pares.length > 1 ? `, junto com mais ${pares.length - 1} fechamento(s)` : ''}): ${brl(t)}`);
    }
    return { n: pares.length, total, lote };
  });
  volta(res, url, 'ok', `Pagamento registrado: ${r.n} fechamento${r.n > 1 ? 's' : ''} (lote #${r.lote}), ${brl(r.total)}. Ficam na aba Pagos.`);
});

app.post('/pagar/desfazer', soPagar, (req, res) => {
  const u = req.user, url = urlPagar(req.body.volta), lote = Number(req.body.lote);
  const fs = lote ? db.prepare('SELECT id FROM fechamentos WHERE lote = ? AND pago_em IS NOT NULL').all(lote).map((x) => carregaF(x.id)) : [];
  if (!fs.length || fs.some((f) => !podeVer(u, f))) recusa('Esse lote não tem pagamento registrado (talvez já tenha sido desfeito). Atualize a tela.', url);
  tx(() => { for (const f of fs) { db.prepare('UPDATE fechamentos SET pago_em = NULL, pago_por = NULL, lote = NULL WHERE id = ?').run(f.id); log(u.id, `f:${f.id}`, `Desfez o registro de pagamento (lote #${lote})`); } });
  volta(res, url, 'ok', `Registro de pagamento do lote #${lote} desfeito: ${pl(fs.length, 'fechamento voltou', 'fechamentos voltaram')} para A pagar. Transferências já feitas no banco não foram alteradas.`);
});

// ---------- Usuários (admin) ----------
const soAdmin = so((r) => r.user.perfil === 'admin');
const superAdmin = (u) => u.perfil === 'admin' && u.login === 'admin'; // o usuário inicial do sistema: único que renomeia lojas
// Alcance de cada perfil, escrito uma vez: a tela mostra o texto do perfil/loja escolhidos (o JS troca sem recarregar).
const escopoUsuario = (perfil, loja) => ({
  despachante: loja ? `Importa, confere e envia fechamentos só de ${loja}.` : 'Escolha a loja: o despachante só enxerga a própria loja.',
  financeiro: loja ? `Aprova, devolve e registra pagamentos só de ${loja}.` : 'Aprova, devolve e registra pagamentos de todas as lojas. Vê só fechamentos já enviados.',
  gestao: 'Acompanha os fechamentos de todas as lojas, somente leitura.',
  admin: 'Acesso total: todas as lojas, usuários e configurações.',
}[perfil] || '');
const lojaDoUsuario = (u) => (['despachante', 'financeiro'].includes(u.perfil) && u.loja ? u.loja : '');
function telaUsuarios(req, res, ctx = {}) {
  const us = db.prepare("SELECT u.*, l.nome loja FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id WHERE u.perfil <> 'motoboy' ORDER BY u.ativo DESC, u.nome").all();
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all(), erros = ctx.erros || {};
  const err = (p, c) => (erros[c] && ctx.abrir === p ? html`<div class="erro-campo" id="${p}-e-${c}" role="alert">${icone('erro', 'sm')} <span>${erros[c]}</span></div>` : '');
  const inv = (p, c) => (erros[c] && ctx.abrir === p ? new Raw(`aria-invalid="true" aria-describedby="${p}-e-${c}"`) : '');
  const form = (u, p) => {
    const val = ctx.abrir === p && ctx.valores ? ctx.valores : u, perfil = PERFIS[val.perfil] ? val.perfil : 'despachante', lojaId = Number(ctx.abrir === p && ctx.valores ? ctx.valores.loja : val.loja_id) || '';
    const nomeLoja = lojas.find((l) => l.id === lojaId)?.nome || '', criar = p === 'novo';
    return html`<form method="post" action="${criar ? '/usuarios' : `/usuarios/${u.id}`}" data-guarda data-escopo-form>${criar ? '' : html`<input type="hidden" name="rev" value="${revisao(u.nome, u.perfil, u.loja_id, u.ativo)}">`}
${criar ? html`<div class="field"><label for="${p}-login">Login <span class="req" aria-hidden="true">*</span></label><input id="${p}-login" name="login" required autocapitalize="none" autocomplete="off" value="${val.login || ''}" ${inv(p, 'login')}>${err(p, 'login')}<p class="hint">Não muda depois de criado.</p></div>`
  : html`<div class="field"><span class="rot-ro">Login</span><b class="login-ro">${u.login}</b><p class="hint">O login não muda. Para trocar, crie outro usuário e desative este.</p></div>`}
<div class="field"><label for="${p}-nome">Nome <span class="req" aria-hidden="true">*</span></label><input id="${p}-nome" name="nome" required value="${val.nome || ''}" ${inv(p, 'nome')}>${err(p, 'nome')}</div>
<div class="fgrid"><div class="field"><label for="${p}-perfil">Perfil</label><select id="${p}-perfil" name="perfil" data-perfil ${inv(p, 'perfil')}>${Object.entries(PERFIS).map(([k, v]) => html`<option value="${k}" ${perfil === k ? 'selected' : ''}>${v}</option>`)}</select>${err(p, 'perfil')}</div>
<div class="field"><label for="${p}-loja">Loja</label><select id="${p}-loja" name="loja" data-loja ${inv(p, 'loja')}><option value="">${perfil === 'despachante' ? 'Escolha a loja…' : 'Todas as lojas'}</option>${lojas.map((l) => html`<option value="${l.id}" ${lojaId === l.id ? 'selected' : ''}>${l.nome}</option>`)}</select>${err(p, 'loja')}</div></div>
<p class="escopo-box" data-escopo role="status" aria-live="polite">${icone('info', 'sm')} <span>${escopoUsuario(perfil, nomeLoja)}</span></p>
<div class="field"><label for="${p}-senha">${criar ? 'Senha inicial' : 'Nova senha (opcional)'} ${criar ? html`<span class="req" aria-hidden="true">*</span>` : ''}</label><input id="${p}-senha" name="senha" type="password" ${criar ? 'required' : ''} autocomplete="new-password" ${inv(p, 'senha')}>${err(p, 'senha')}<p class="hint">${criar ? 'Mínimo 8 caracteres.' : 'Vazio mantém a senha atual. Ao trocar, a pessoa é desconectada.'} Só a TI altera senhas.</p></div>
${criar ? html`<input type="hidden" name="ativo" value="1">` : html`<label class="check"><input type="checkbox" name="ativo" value="1" ${(ctx.abrir === p && ctx.valores ? !!ctx.valores.ativo : u.ativo) ? new Raw('checked') : ''} ${inv(p, 'ativo')}> Ativo (pode entrar no sistema)</label>${err(p, 'ativo')}`}
<div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Cancelar</button><button class="btn btn-pri">${icone(criar ? 'mais' : 'check', 'sm')} ${criar ? 'Criar usuário' : 'Salvar alterações'}</button></div></form>`;
  };
  const dlg = (p, titulo, sub, u) => html`<dialog id="dlg-${p}" class="dlg sheet ent-sheet" aria-labelledby="t-${p}" ${ctx.abrir === p ? new Raw('data-abrir') : ''}><h2 id="t-${p}">${titulo}</h2><p>${sub}</p>${form(u, p)}</dialog>`;
  const linha = (u) => html`<tr data-u data-perfil="${u.perfil}" data-ativo="${u.ativo ? 1 : 0}" data-texto="${semAcento(`${u.nome} ${u.login}`)}" class="${u.ativo ? '' : 'inativo'}"><th scope="row"><div class="who">${avatar(u.nome)}<div><div class="nome-l">${u.nome}</div><small class="mut">${u.login}</small></div></div></th>
<td><span class="badge nodot">${PERFIS[u.perfil]}</span></td><td>${lojaDoUsuario(u) || html`<span class="mut">Todas as lojas</span>`}</td><td>${u.ativo ? html`<span class="badge ok">Ativo</span>` : html`<span class="badge bad">Inativo</span>`}</td>
<td class="n"><button type="button" class="btn btn-sec btn-sm" data-abre="dlg-u${u.id}" aria-label="Editar ${u.nome}">${icone('lapis', 'sm')} Editar</button></td></tr>`;
  res.status(ctx.status || 200).send(page(req, { titulo: 'Usuários', compacto: true, eyebrow: 'Administração', sub: 'Quem acessa o sistema e o que cada pessoa enxerga.', css: '/marca/admin.css', js: '/marca/admin.js',
    acoes: html`<button type="button" class="btn btn-pri" data-abre="dlg-novo">${icone('mais')} Novo usuário</button>` }, html`
<div class="card"><div class="card-h"><div class="t"><h2>Equipe <span class="c-n" id="u-conta" data-total="${us.length}">${us.length}</span></h2><p>Perfil define o que a pessoa faz; a loja define onde. Edição abre num painel lateral.</p></div></div>
<form class="admin-barra" data-filtro-u onsubmit="return false"><div class="field"><label for="busca-u">Buscar pessoa</label><input id="busca-u" type="search" placeholder="Nome ou login" autocomplete="off" data-f="q"></div>
<div class="field"><label for="f-perfil">Perfil</label><select id="f-perfil" data-f="perfil"><option value="">Todos</option>${Object.entries(PERFIS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
<div class="field"><label for="f-sit">Situação</label><select id="f-sit" data-f="ativo"><option value="">Todas</option><option value="1">Ativos</option><option value="0">Inativos</option></select></div>
<button type="button" class="btn btn-ghost" data-limpar-u>Limpar filtros</button></form>
<div class="tw"><table class="tab-u"><thead><tr><th scope="col">Pessoa</th><th scope="col">Perfil</th><th scope="col">Loja / escopo</th><th scope="col">Situação</th><th scope="col" class="n"><span class="sr">Ação</span></th></tr></thead><tbody>${us.map(linha)}
<tr id="vazio-u" hidden><td colspan="5" class="vazio-busca">Nenhum usuário com estes filtros. <button type="button" class="btn btn-ghost btn-sm" data-limpar-u>Limpar filtros</button></td></tr></tbody></table></div></div>
<section class="card" style="margin-top:20px" aria-labelledby="perfis-t"><div class="card-h"><div class="t"><h2 id="perfis-t">O que cada perfil faz</h2></div></div><dl class="perfis-guia">
<div><dt>Despachante</dt><dd>Importa, confere e envia fechamentos. Vê só a loja do cadastro.</dd></div>
<div><dt>Financeiro</dt><dd>Aprova, devolve e registra pagamentos. Com loja no cadastro, só dela; sem loja, todas. Vê só fechamentos já enviados.</dd></div>
<div><dt>Gestão</dt><dd>${escopoUsuario('gestao', '')}</dd></div>
<div><dt>TI / Admin</dt><dd>${escopoUsuario('admin', '')}</dd></div></dl></section>
${dlg('novo', 'Novo usuário', 'Defina perfil e loja; o texto abaixo mostra o que a pessoa vai enxergar.', {})}
${us.map((u) => dlg(`u${u.id}`, `Editar ${u.nome}`, `${PERFIS[u.perfil]}${u.loja ? ` · ${u.loja}` : ''}`, u))}
<script type="application/json" id="escopos">${new Raw(JSON.stringify({ despachante: escopoUsuario('despachante', '{loja}'), despachanteSem: escopoUsuario('despachante', ''), financeiro: escopoUsuario('financeiro', '{loja}'), financeiroSem: escopoUsuario('financeiro', ''), gestao: escopoUsuario('gestao', ''), admin: escopoUsuario('admin', '') }).replace(/</g, '\\u003c'))}</script>`));
}
app.get('/usuarios', soAdmin, (req, res) => telaUsuarios(req, res));
// Validação por campo: devolve { v, e }; a tela reabre o painel com os valores digitados e o erro junto ao campo.
function dadosUsuario(b, { criar = false } = {}) {
  const v = { nome: String(b.nome || '').trim(), perfil: String(b.perfil), loja_id: Number(b.loja) || null }, e = {};
  if (criar) {
    v.login = String(b.login || '').trim().toLowerCase();
    if (!v.login) e.login = 'Informe o login.';
    else if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(v.login)) e.login = 'Já existe um usuário com este login.';
  }
  if (!v.nome) e.nome = 'Informe o nome.';
  if (!PERFIS[v.perfil]) e.perfil = 'Escolha um perfil.';
  else if (v.perfil === 'despachante' && !v.loja_id) e.loja = 'O despachante precisa de uma loja.';
  if (v.loja_id && !db.prepare('SELECT 1 FROM lojas WHERE id = ?').get(v.loja_id)) e.loja = 'Loja inválida.';
  if (!['despachante', 'financeiro'].includes(v.perfil)) v.loja_id = null; // só despachante e financeiro têm loja; financeiro sem loja vê todas
  const senha = String(b.senha || '');
  if (criar && !senha) e.senha = 'Informe a senha inicial.';
  else if (senha && senha.length < 8) e.senha = 'A senha precisa ter 8 caracteres ou mais.';
  return { v, e };
}
app.post('/usuarios', soAdmin, (req, res) => {
  const { v, e } = dadosUsuario(req.body, { criar: true });
  if (Object.keys(e).length) return telaUsuarios(req, res, { erros: e, abrir: 'novo', valores: req.body, status: 422 });
  db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(v.nome, v.login, hashSenha(String(req.body.senha)), v.perfil, v.loja_id);
  log(req.user.id, 'usuarios', `Criou usuário ${v.login} (${v.perfil})`);
  volta(res, '/usuarios', 'ok', `Usuário ${v.nome} criado.`);
});
app.post('/usuarios/:id', soAdmin, (req, res) => {
  const id = Number(req.params.id), ativo = req.body.ativo ? 1 : 0;
  const atual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!atual) throw falha('Usuário não encontrado.', 404);
  if (req.body.rev !== revisao(atual.nome, atual.perfil, atual.loja_id, atual.ativo)) return volta(res, '/usuarios', 'erro', `O cadastro de ${atual.nome} ${MSG_ALTERADO}`);
  const { v, e } = dadosUsuario(req.body);
  if (id === req.user.id && !e.perfil && (!ativo || v.perfil !== 'admin')) e[!ativo ? 'ativo' : 'perfil'] = 'Você não pode remover seu próprio acesso de admin.';
  if (Object.keys(e).length) return telaUsuarios(req, res, { erros: e, abrir: `u${id}`, valores: { ...req.body, ativo }, status: 422 });
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, loja_id = ?, ativo = ? WHERE id = ?').run(v.nome, v.perfil, v.loja_id, ativo, id);
  if (req.body.senha) db.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').run(hashSenha(String(req.body.senha)), id);
  if (req.body.senha || !ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  log(req.user.id, 'usuarios', `Alterou usuário #${id}${req.body.senha ? ' (senha redefinida)' : ''}`);
  volta(res, '/usuarios', 'ok', `Usuário ${v.nome} salvo.`);
});

// ---------- Configurações (TI) ----------
function telaConfig(req, res, ctx = {}) {
  const v = (k) => cfg(k), val = (k) => ctx.valores?.[k] ?? cfg(k), erros = ctx.erros || {}, lojas = db.prepare('SELECT l.*, (SELECT COUNT(*) FROM fechamentos WHERE loja_id = l.id) n FROM lojas l ORDER BY nome').all();
  const ultimosAlertas = db.prepare("SELECT acao, quando FROM log WHERE ref = 'alertas' ORDER BY id DESC LIMIT 15").all();
  const temSenha = !!v('smtp_pass'), semSmtp = !v('smtp_host');
  const aba = ctx.aba || (['email', 'alertas', 'lojas', 'entregadores', 'drive'].includes(req.query.aba) ? req.query.aba : 'email');
  const nav = html`<nav class="seg abas-cfg" aria-label="Seções das configurações">${[['email', 'E-mail'], ['alertas', 'Alertas'], ['lojas', 'Lojas e pagamentos'], ['entregadores', 'Entregadores'], ['drive', 'Google Drive']].map(([k, t]) => html`<a href="/config?aba=${k}" class="${k === aba ? 'on' : ''}" ${k === aba ? new Raw('aria-current="page"') : ''}>${t}${k === 'email' && semSmtp ? html`<span class="c" title="Falta configurar o servidor de e-mail">!</span>` : ''}</a>`)}</nav>`;
  const ultimoTeste = db.prepare("SELECT acao, quando FROM log WHERE ref = 'config' AND acao LIKE 'Teste de e-mail%' ORDER BY id DESC LIMIT 1").get(), nDest = listaEmails(v('email_para')).length;
  const errC = (c) => (erros[c] ? html`<div class="erro-campo" id="e-${c}" role="alert">${icone('erro', 'sm')} <span>${erros[c]}</span></div>` : ''), invC = (c) => (erros[c] ? new Raw(`aria-invalid="true" aria-describedby="e-${c}"`) : '');
  const estadoEmail = html`<section class="cfg-estado" aria-label="Situação do e-mail"><div><span class="rot">Servidor de e-mail (salvo)</span>${semSmtp ? html`<span class="badge warn">Não configurado</span>` : html`<span class="badge ok">${v('smtp_host')}</span>`}</div>
<div><span class="rot">Destinatários (salvo)</span>${nDest ? html`<span class="badge ok">${nDest} cadastrado(s)</span>` : html`<span class="badge warn">Nenhum</span>`}</div>
<div><span class="rot">Último teste de envio</span>${ultimoTeste ? html`<span class="badge ${/aceito/.test(ultimoTeste.acao) ? 'ok' : 'bad'}">${/aceito/.test(ultimoTeste.acao) ? 'Aceito pelo servidor' : 'Não enviado'}</span><small class="mut">${ultimoTeste.quando.slice(0, 16)} · ${ultimoTeste.acao.replace(/^Teste de e-mail /, '')}</small>` : html`<span class="badge nodot">Nunca testado</span>`}</div></section>
<p class="hint cfg-nota">${icone('info', 'sm')} "Salvo" é o que está gravado aqui; só o teste mostra se o servidor aceita o envio, e a entrega real depende da caixa de entrada do destinatário.</p>`;
  const email = html`${estadoEmail}<div class="split">
<form method="post" action="/config" class="stack" data-guarda>
${semSmtp ? html`<div class="alert warn">${icone('alerta')}<div><b>Servidor de e-mail ainda não configurado</b>Enquanto isso, os e-mails não saem: ficam salvos no servidor (pasta data/emails) e o fechamento mostra o aviso.</div></div>` : ''}
<div class="card"><div class="card-h"><span class="hico pri">${icone('email')}</span><div class="t"><h2>Solicitação de pagamento</h2><p>Quando o despachante clica em "Enviar ao financeiro", sai um e-mail com a planilha e o PDF em anexo.</p></div></div><div class="card-b">
<div class="field"><label for="email_para">Enviar para <span class="req">*</span></label><textarea id="email_para" name="email_para" style="min-height:80px" placeholder="financeiro@grupofornopaulista.com" ${invC('email_para')}>${val('email_para')}</textarea>${errC('email_para')}<p class="hint">Um ou mais e-mails, um por linha ou separados por vírgula.</p></div>
<div class="field"><label for="app_url">Endereço do sistema</label><input id="app_url" name="app_url" value="${val('app_url')}" placeholder="https://entregadores.grupofornopaulista.com"><p class="hint">Vai no e-mail como link para abrir o fechamento.</p></div></div></div>

<div class="card"><div class="card-h"><span class="hico">${icone('enviar')}</span><div class="t"><h2>Conta que envia (servidor SMTP)</h2><p>O e-mail sai desta conta.</p></div></div><div class="card-b">
<details class="alert fold" style="display:block;margin-bottom:16px" ${semSmtp ? 'open' : ''}><summary>${icone('info')} <b style="display:inline">Como configurar com o Google Workspace do grupo (5 minutos)</b> ${icone('chevron', 'chev')}</summary>
<ol style="margin:10px 0 0 22px;padding:0;line-height:1.7">
<li>Escolha a conta que vai enviar, ex.: <b>tecnologia@grupofornopaulista.com</b> (ou crie uma como <b>naoresponda@</b>).</li>
<li>Entre nela e ative a <b>Verificação em duas etapas</b>: myaccount.google.com → Segurança.</li>
<li>Em <b>myaccount.google.com/apppasswords</b>, crie uma senha de app chamada "Entregadores" e copie os 16 caracteres.</li>
<li>Preencha abaixo: servidor <b>smtp.gmail.com</b>, porta <b>587</b>, usuário = o e-mail da conta, senha = a senha de app.</li>
<li>Salve e use <b>Enviar teste</b>. Se a opção de senha de app não aparecer, o administrador do Google Workspace precisa liberar a verificação em duas etapas para a conta.</li></ol></details>
<div class="fgrid"><div class="field"><label for="smtp_host">Servidor</label><input id="smtp_host" name="smtp_host" value="${val('smtp_host')}" placeholder="smtp.gmail.com"></div>
<div class="field"><label for="smtp_port">Porta</label><input id="smtp_port" name="smtp_port" value="${val('smtp_port') || '587'}" inputmode="numeric" ${invC('smtp_port')}>${errC('smtp_port')}</div></div>
<div class="fgrid"><div class="field"><label for="smtp_user">Usuário</label><input id="smtp_user" name="smtp_user" value="${val('smtp_user')}" placeholder="tecnologia@grupofornopaulista.com" autocomplete="off"></div>
<div class="field"><label for="smtp_pass">Senha</label><input id="smtp_pass" name="smtp_pass" type="password" placeholder="${temSenha ? '•••••••• (mantida)' : ''}" autocomplete="new-password"><p class="hint">${temSenha ? 'Deixe vazio para manter a atual.' : 'Para Gmail, use a senha de app.'}</p></div></div>
<div class="field"><label for="smtp_from">Remetente</label><input id="smtp_from" name="smtp_from" value="${val('smtp_from')}" placeholder='Entregadores Forno Paulista <tecnologia@grupofornopaulista.com>'><p class="hint">Opcional. Se vazio, usa o usuário.</p></div></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar configurações</button></div></div></form>

<form method="post" action="/config/teste" class="card"><div class="card-h"><span class="hico">${icone('email')}</span><div class="t"><h2>Testar envio</h2><p>Usa as configurações <b>salvas</b> (não o que está digitado acima). O resultado fica registrado.</p></div></div>
<div class="card-b"><div class="field" style="margin:0"><label for="teste">Para</label><input id="teste" name="para" type="email" required value="${ctx.valores?.para ?? (req.user.email || listaEmails(v('email_para'))[0] || '')}" ${invC('teste')}>${errC('teste')}</div><p class="cfg-ajuda">Salve as configurações antes de testar. "Aceito pelo servidor" não garante a entrega.</p></div>
<div class="card-f"><button class="btn btn-sec">${icone('enviar')} Enviar teste</button></div></form></div>`;
  const alertaLigado = v('alerta_resumo') !== '0', [corAl, txtAl] = process.env.ALERTAS === '0' ? ['bad', 'Desligados neste servidor (ALERTAS=0): nada será enviado, mesmo com a preferência ligada.'] : !alertaLigado ? ['warn', 'Preferência desligada: nenhum resumo será enviado.'] : semSmtp ? ['warn', 'Preferência ligada, mas sem servidor de e-mail: nada será enviado até configurar o e-mail.'] : ['ok', `Resumo diário ativo: sai às ${v('hora_resumo') || '16:00'} (horário de Teresina), uma vez por dia de pagamento.`];
  const alertas = html`<form method="post" action="/config/alertas" class="card cfg-estreito" id="alertas" data-guarda><div class="card-h"><span class="hico pri">${icone('relogio')}</span><div class="t"><h2>Alertas automáticos por e-mail</h2><p>Horário de Teresina. Cada alerta sai uma vez por pagamento.</p></div></div><div class="card-b">
<p class="cfg-sit ${corAl}" role="status"><b>Situação real:</b> ${txtAl}</p>
${[['alerta_resumo', 'hora_resumo', '16:00', 'Resumo diário ao financeiro', 'Nos dias de pagamento: quais lojas já enviaram (com o total) e quais faltam. Vai para os destinatários da solicitação de pagamento.']]
    .map(([k, h, padrao, t, d]) => html`<div class="field" style="display:flex;gap:12px;align-items:flex-start"><label class="check" style="flex:1;margin:0;align-items:flex-start"><input type="checkbox" name="${k}" value="1" ${v(k) !== '0' ? 'checked' : ''} style="margin-top:3px"><span><b>${t}</b><br><span class="mut small" style="font-weight:400">${d}</span></span></label>
<input type="time" name="${h}" value="${v(h) || padrao}" aria-label="Horário: ${t}" style="width:120px"></div>`)}
${process.env.ALERTAS === '0' ? html`<div class="alert warn">${icone('alerta')}<div>Os alertas estão desligados neste servidor (variável ALERTAS=0).</div></div>` : ''}
${semSmtp ? html`<div class="alert warn">${icone('alerta')}<div>Sem servidor de e-mail configurado, os alertas não saem. <a href="/config?aba=email">Configurar agora</a></div></div>` : ''}
<p class="hint">O despachante vê os avisos (amanhã, hoje, atrasado) na tela inicial do sistema.</p>
${ultimosAlertas.length ? html`<details class="fold" style="margin-top:8px"><summary class="mut small">${icone('chevron', 'chev')} Últimos alertas</summary><ul class="timeline" style="margin-top:10px">${ultimosAlertas.map((a) => html`<li>${a.acao}<small>${a.quando}</small></li>`)}</ul></details>` : ''}</div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar alertas</button></div></form>`;
  const autoLigado = v('auto_fechamento') === '1', temToken = !!process.env.TELEGRAM_BOT_TOKEN, tgOk = temToken && TG.ids().length > 0, driveOk = !!(v('drive_pasta') && v('drive_credencial'));
    const automacao = html`<form method="post" action="/config/automacao" class="card cfg-estreito" id="automacao" data-guarda><div class="card-h"><span class="hico pri">${icone('enviar')}</span><div class="t"><h2>Envio automático do fechamento</h2><p>No dia de pagamento, no horário que você definir, o sistema envia sozinho: o Excel por e-mail, o mesmo Excel no Drive e um aviso no Telegram.</p></div></div><div class="card-b">
<p class="cfg-sit ${autoLigado && tgOk && !semSmtp && nDest && process.env.DRIVE_SCRIPT_URL ? 'ok' : 'warn'}" role="status"><b>Situação:</b> ${autoLigado ? `LIGADO. No dia de pagamento, a partir das ${v('hora_fechamento') || '06:00'} (Teresina), envia o e-mail, grava no Drive e avisa no Telegram` : '<b>DESLIGADO</b>: nada é enviado sozinho. Marque a caixa abaixo e clique em Salvar'}${[semSmtp && 'servidor de e-mail', !nDest && 'e-mail de destino', !tgOk && 'Telegram (token e alguém aprovado)', !process.env.DRIVE_SCRIPT_URL && 'Drive (DRIVE_SCRIPT_URL no servidor)'].filter(Boolean).length ? `. Falta configurar: ${[semSmtp && 'servidor de e-mail', !nDest && 'e-mail de destino', !tgOk && 'Telegram (token e alguém aprovado)', !process.env.DRIVE_SCRIPT_URL && 'Drive (DRIVE_SCRIPT_URL no servidor)'].filter(Boolean).join(', ')}` : ''}.</p>
<div class="field" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><label class="check" style="flex:1;margin:0;min-width:240px"><input type="checkbox" name="auto_fechamento" value="1" ${autoLigado ? 'checked' : ''}><span><b>Enviar automaticamente no dia do fechamento</b></span></label>
<label class="mut small" for="hora_fechamento">às</label><input id="hora_fechamento" type="time" name="hora_fechamento" value="${v('hora_fechamento') || '06:00'}" style="width:120px"></div>
<p class="hint" style="margin-top:-6px">Se houver qualquer problema (cadastro incompleto, erro no Agilizone…), não envia nada: avisa no Telegram e tenta de novo a cada 30 minutos.</p>
<div class="field"><label for="auto_email_para">Enviar o e-mail para</label><textarea id="auto_email_para" name="email_para" style="min-height:70px" placeholder="financeiro@grupofornopaulista.com">${v('email_para')}</textarea><p class="hint">Um ou mais e-mails, um por linha ou separados por vírgula.</p></div>
<details class="fold" style="margin-bottom:12px"><summary class="mut small">${icone('chevron', 'chev')} Avançado</summary><div class="field" style="margin-top:10px"><label for="hora_corte">Pedidos contados até</label><input id="hora_corte" name="hora_corte" type="time" value="${v('hora_corte') || '05:00'}" required style="width:120px"><p class="hint">Hora do dia do pagamento em que o período dos pedidos termina (ele começa às 12:00 do 1º dia de referência). O horário do envio precisa ser depois dela. Normalmente não precisa mexer.</p></div></details>
<details class="fold" style="margin-bottom:12px" ${temToken ? '' : 'open'}><summary class="mut small">${icone('chevron', 'chev')} Como criar o bot do Telegram</summary><ol style="margin:8px 0 0 22px;line-height:1.7"><li>No Telegram, abra <b>@BotFather</b>, envie <b>/newbot</b> e siga os passos. Ele devolve o <b>token</b>.</li><li>Guarde o token na variável <code>TELEGRAM_BOT_TOKEN</code> do servidor (no computador local, no arquivo <code>.env</code>) e reinicie o app. Ele não é digitado aqui.</li><li>Mande o <b>link do bot</b> (aparece em "Convidar alguém", logo abaixo) a quem deve receber. A pessoa toca em <b>Iniciar</b> e o pedido aparece em <b>Pedidos para receber</b>, para você aprovar. Para sair, ela envia <b>/parar</b>.</li><li>Use <b>Enviar teste</b> para conferir.</li></ol></details>
<div class="fgrid"><div class="field"><label>Bot do Telegram</label>${temToken ? html`<p class="cfg-sit ok" role="status" style="margin:0"><b>Token configurado no servidor.</b></p>` : html`<p class="cfg-sit warn" role="status" style="margin:0"><b>Sem token.</b> Defina <code>TELEGRAM_BOT_TOKEN</code> nas variáveis do servidor (ou no arquivo <code>.env</code>, no computador local) e reinicie o app.</p>`}<p class="hint">O token nunca é digitado nem guardado aqui.</p></div>
<div class="field"><label>Quem recebe</label><p class="hint" style="margin-top:0">${TG.ids().length ? `${TG.ids().length} pessoa(s)/grupo(s) recebem os alertas.` : 'Ninguém ainda.'} Convide e aprove nos quadros logo abaixo deste cartão.</p></div></div>
<details class="fold" style="margin-bottom:12px"><summary class="mut small">${icone('chevron', 'chev')} Testes (opcional)</summary><div style="margin-top:10px">
<div class="field"><label for="d_sim">Simular um fechamento</label><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="d_sim" name="d_sim" type="date" value="${agora().data}"><button class="btn btn-sec" formaction="/config/automacao/simular">Simular (não envia nada)</button></div><p class="hint">Roda a conferência da data e avisa no Telegram se estaria tudo certo ou o que está faltando.</p></div>
${(() => { let ta = null; try { ta = JSON.parse(v('teste_auto') || 'null'); } catch {} const hojeA = agora().data, ult = agenda(lojasAtivas(), AG.soma(hojeA, -10), hojeA).map((p) => p.pagamento).sort().pop() || hojeA;
  return html`<div class="field" role="group" aria-label="Teste automático agendado (hoje)"><b>Teste automático agendado (hoje)</b>
${ta && !ta.feito ? html`<p class="cfg-sit ok" role="status">Agendado para hoje às <b>${ta.hora}</b>: fechamento de ${dataFmt(ta.data)}, e-mail de teste só para <b>${ta.email}</b>.</p>` : ta?.feito ? html`<p class="mut small">Último teste rodou em ${ta.feito.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1')} (fechamento de ${dataFmt(ta.data)}). O resultado foi para o Telegram e ficou no histórico.</p>` : ''}
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><div><label class="mut small" for="teste_data">Pagamento a testar</label><input id="teste_data" name="teste_data" type="date" value="${ta?.data || ult}"></div><div><label class="mut small" for="teste_hora">Hora de hoje</label><input id="teste_hora" name="teste_hora" type="time" value="${ta?.hora || '17:30'}"></div><div style="flex:1;min-width:220px"><label class="mut small" for="teste_email">Enviar o teste só para</label><input id="teste_email" name="teste_email" type="email" value="${ta?.email || req.user.email || ''}" autocomplete="off"></div></div>
<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-sec" formaction="/config/automacao/agendar-teste">Agendar teste</button>${ta && !ta.feito ? html`<button class="btn btn-ghost" formaction="/config/automacao/cancelar-teste">Cancelar teste</button>` : ''}</div>
<p class="hint">Na hora marcada o sistema faz tudo como no dia real (puxa o Agilizone, confere, gera a planilha), mas manda o e-mail só para o endereço acima, com [TESTE] no assunto, sem registrar nada e sem o financeiro receber. O resultado vem no Telegram.</p></div>`; })()}
<div class="field"><button class="btn btn-sec" formaction="/config/automacao/teste">${icone('enviar', 'sm')} Enviar mensagem de teste ao Telegram</button></div></div></details></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar</button></div></form>`;
  const calCampos = (p, nome, cal, travaNome = false) => {
    const er = (c) => (erros[c] && ctx.abrir === p ? html`<div class="erro-campo" id="${p}-e-${c}" role="alert">${icone('erro', 'sm')} <span>${erros[c]}</span></div>` : ''), iv = (c) => (erros[c] && ctx.abrir === p ? new Raw(`aria-invalid="true" aria-describedby="${p}-e-${c}"`) : '');
    let leitura = ''; try { leitura = AG.textoCalendario(AG.lerCalendario(cal)); } catch (_) {}
    const ex = (rot, txt) => html`<button type="button" class="btn btn-ghost btn-xs" data-cal-ex="${txt}" title="${AG.textoCalendario(AG.lerCalendario(txt))}">${rot}</button>`;
    return html`<div class="field"><label for="${p}-nome">Nome no Agilizone <span class="req" aria-hidden="true">*</span></label><input id="${p}-nome" name="nome" required value="${nome}" ${travaNome ? new Raw('readonly aria-readonly="true"') : ''} ${iv('nome')}>${er('nome')}<p class="hint">${travaNome ? 'Bloqueado: só o super administrador (login admin) pode renomear lojas.' : 'Igual ao nome da loja no Agilizone: os arquivos e a API se ligam à loja por esse nome.'}</p></div>
<div class="field"><label for="${p}-cal">Dias de pagamento <span class="req" aria-hidden="true">*</span></label><input id="${p}-cal" name="calendario" required value="${cal}" ${iv('calendario')}>${er('calendario')}
<p class="hint">Formato <b>dia que paga: dias pagos</b>, ciclos separados por ponto e vírgula. Dias: seg ter qua qui sex sab dom. Um dia só pode ser pago em um ciclo.</p>
<div class="cal-ex"><span class="mut small">Usar exemplo:</span>${ex('Padrão (segunda e sexta)', AG.PADRAO)}${ex('Três pagamentos (segunda, quarta, sexta)', AG.PADRAO_DIRCEU)}</div>
${leitura ? html`<p class="cal-leg"><b>Como o sistema lê:</b> ${leitura}</p>` : ''}</div>`;
  };
  // As credenciais do Agilizone não passam pela tela: ficam nas variáveis do servidor. Aqui só aparece o estado e o nome das variáveis.
  const agzStatus = (l) => { const v = AGZ_API.variaveis(l); return AGZ_API.configurada(l) ? html`<p class="hint">${icone('check', 'sm')} Conexão com o Agilizone configurada no servidor.</p>` : html`<p class="hint">Para importar direto do Agilizone, defina no servidor (EasyPanel > Ambiente) as variáveis <b>${v.id}</b> e <b>${v.secret}</b> com o Client ID e o Client Secret desta loja, e reinicie o serviço.</p>`; };
  const entTab = html`<section class="card" aria-labelledby="ent-t"><div class="card-h"><span class="hico">${icone('moto')}</span><div class="t"><h2 id="ent-t">Entregadores e chaves Pix</h2><p>O Agilizone traz os entregadores, mas não o Pix. A chave é cadastrada <b>por loja</b> em Entregadores e fica salva no sistema: atualizar a lista do Agilizone só acrescenta quem é novo e <b>nunca apaga nem troca</b> uma chave já salva.</p></div><a class="btn btn-pri" href="/entregadores">Abrir Entregadores</a></div>
<div class="card-b"><form method="post" action="/config/entregadores/buscar" class="ent-imp" data-carregando="Buscando os entregadores nas lojas…"><div><b>Trazer do Agilizone (todas as lojas conectadas)</b><p class="hint">Lê os pedidos dos últimos 80 dias de cada loja conectada e cadastra quem ainda não está no sistema, com o id do Agilizone. Quem já tem Pix salvo não é alterado. Para uma loja só, use "Atualizar do Agilizone" em Entregadores.</p></div><button class="btn btn-sec">${icone('subir', 'sm')} Buscar entregadores no Agilizone</button></form></div></section>`;
  const tkP = v('agz_painel_token'), expP = tkP ? AGZ_API.tokenPainelExpira(tkP) : null;
  const painel = html`<form method="post" action="/config/painel" class="card" style="margin-bottom:16px" data-guarda><div class="card-h"><span class="hico pri">${icone('moto')}</span><div class="t"><h2>Ocorrências dos entregadores (painel do Agilizone)</h2><p>A API oficial não traz ocorrências. Elas vêm do painel (ledger.agilizone.com) com o login do painel. O storeId de cada loja é descoberto sozinho pela API oficial: preencha abaixo só se uma loja ficar sem ocorrências.</p></div></div><div class="card-b">
<p class="cfg-sit ${AGZ_API.painelLogin() || (tkP && (!expP || expP > Date.now())) ? 'ok' : 'warn'}" role="status"><b>Acesso ao painel:</b> ${AGZ_API.painelLogin() ? 'login automático configurado no servidor (renova sozinho)' : !tkP ? 'não configurado: defina AGILIZONE_PAINEL_EMAIL e AGILIZONE_PAINEL_SENHA no servidor (ou cole um token abaixo, que expira)' : expP && expP < Date.now() ? `expirou em ${new Date(expP).toLocaleString('pt-BR', { timeZone: TZ })}` : expP ? `válido até ${new Date(expP).toLocaleString('pt-BR', { timeZone: TZ })}` : 'configurado'}</p>
<details class="fold" style="margin-bottom:12px" ${tkP || AGZ_API.painelLogin() ? '' : 'open'}><summary class="mut small">${icone('chevron', 'chev')} Como ligar: storeId de cada loja e acesso ao painel</summary><ol style="margin:8px 0 0 22px;line-height:1.7"><li><b>storeId:</b> no painel do Agilizone, abra o Resumo de entregas com o F12 na aba Rede e clique na requisição <b>occurrences</b>. A URL traz <b>storeId=…</b> com <b>24 letras e números</b>. Não é o código com traços (ex.: 8afa395c-…) que a API oficial usa.</li><li><b>Acesso:</b> defina no servidor <b>AGILIZONE_PAINEL_EMAIL</b> e <b>AGILIZONE_PAINEL_SENHA</b> (o sistema faz o login e renova sozinho). Rodando local, ponha no arquivo <b>.env</b> e reinicie.</li></ol></details>
<details class="fold" style="margin-bottom:12px"><summary class="mut small">${icone('chevron', 'chev')} Token manual (só para teste, se não usar o login automático)</summary><div class="field" style="margin-top:10px"><label for="agz_painel_token">Token do painel</label><textarea id="agz_painel_token" name="agz_painel_token" style="min-height:70px" placeholder="${tkP ? '•••••••• (mantido)' : 'eyJ0eXAiOiJKV1Qi…'}" autocomplete="off"></textarea><p class="hint">Expira em dias. Deixe vazio para manter o atual.</p></div></details>
<div class="fgrid">${lojas.map((l) => html`<div class="field"><label for="sid-${l.id}">storeId · ${lojaCurta(l.nome)}</label><input id="sid-${l.id}" name="sid_${l.id}" value="${l.agz_store_id || ''}" placeholder="6a03160245f42a2cff69ab95" autocomplete="off"></div>`)}</div></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar</button></div></form>`;
  const lojasTab = html`${painel}<section class="card" aria-labelledby="lojas-t"><div class="card-h"><div class="t"><h2 id="lojas-t">Lojas e dias de pagamento <span class="c-n">${lojas.length}</span></h2><p>Alterar nome ou calendário não apaga fechamentos, entregadores nem histórico. Fechamentos já importados mantêm o pagamento previsto da época.</p></div><button type="button" class="btn btn-sec" data-abre="dlg-nl">${icone('mais', 'sm')} Nova loja</button></div>
<div class="tw"><table class="tab-l"><thead><tr><th scope="col">Loja</th><th scope="col">Quando paga</th><th scope="col">Integração Agilizone</th><th scope="col" class="n">Fechamentos</th><th scope="col" class="n"><span class="sr">Ação</span></th></tr></thead><tbody>
${lojas.map((l) => html`<tr><th scope="row">${l.nome}${l.ativa ? '' : html` <span class="badge nodot">Desativada</span>`}</th><td>${AG.textoCalendario(calendarioDa(l))}</td><td>${AGZ_API.configurada(l) ? html`<span class="badge ok">Conectada</span>` : html`<span class="badge warn">Sem credenciais</span>`}</td><td class="n">${l.n}</td><td class="n"><button type="button" class="btn btn-sec btn-sm" data-abre="dlg-l${l.id}" aria-label="Editar ${l.nome}">${icone('lapis', 'sm')} Editar</button></td></tr>`)}</tbody></table></div></section>
${lojas.map((l) => { const p = `l${l.id}`, dados = ctx.abrir === p ? ctx.valores : { nome: l.nome, calendario: l.calendario || AG.PADRAO }; return html`<dialog id="dlg-${p}" class="dlg sheet ent-sheet" aria-labelledby="t-${p}" ${ctx.abrir === p ? new Raw('data-abrir') : ''}><h2 id="t-${p}">Editar ${l.nome}</h2><p>${l.n} fechamento(s) · ${AGZ_API.configurada(l) ? 'integração conectada' : 'sem credenciais do Agilizone'}</p>
<div class="alert bad aviso-renomear" role="alert">${icone('alerta')}<div><b>NÃO RENOMEIE A LOJA</b>O nome liga a loja ao Agilizone: as credenciais, os arquivos e a importação dependem dele. Renomear derruba a integração até as variáveis do servidor serem trocadas.</div></div>
<form method="post" action="/config/lojas/${l.id}" data-guarda><input type="hidden" name="rev" value="${revisao(l.nome, l.calendario || AG.PADRAO)}">${calCampos(p, dados.nome, dados.calendario, !superAdmin(req.user))}<input type="hidden" name="ativa_f" value="1"><label class="check" style="margin-bottom:12px"><input type="checkbox" name="ativa" value="1" ${l.ativa ? 'checked' : ''}><span><b>Loja ativa</b><br><span class="mut small" style="font-weight:400">Desmarque para esconder a loja da Conferência, do fechamento automático e dos alertas (ex.: sem entregadores). Nada é apagado; é só marcar de novo para voltar.</span></span></label><div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Cancelar</button><button class="btn btn-pri">${icone('check', 'sm')} Salvar loja</button></div></form>
<div class="cfg-agz">${agzStatus(l)}<p class="hint">As credenciais ficam no servidor e seus nomes vêm do nome da loja: ao renomear, ajuste as variáveis (${AGZ_API.variaveis(l).id} e ${AGZ_API.variaveis(l).secret}) ou a integração para de funcionar.</p>${AGZ_API.configurada(l) ? html`<form method="post" action="/config/lojas/${l.id}/agilizone"><button class="btn btn-sec">${icone('check', 'sm')} Testar conexão com o Agilizone</button></form>` : ''}</div></dialog>`; })}
<dialog id="dlg-nl" class="dlg sheet ent-sheet" aria-labelledby="t-nl" ${ctx.abrir === 'nl' ? new Raw('data-abrir') : ''}><h2 id="t-nl">Nova loja</h2><p>Depois de criar, defina as credenciais do Agilizone no servidor.</p><form method="post" action="/config/lojas" data-guarda>${calCampos('nl', ctx.abrir === 'nl' ? ctx.valores.nome : '', ctx.abrir === 'nl' ? ctx.valores.calendario : AG.PADRAO)}
<div class="acoes-f"><button type="button" class="btn btn-ghost" data-fecha>Cancelar</button><button class="btn btn-pri">${icone('mais', 'sm')} Adicionar loja</button></div></form></dialog>`;
  let cred = ''; try { const c = JSON.parse(v('drive_credencial')); cred = c.client_email || (c.refresh_token ? `usuário autorizado (${c.client_id?.slice(0, 12)}…)` : ''); } catch (_) {}
  const driveTab = html`<form method="post" action="/config/drive" class="card cfg-estreito" data-guarda><div class="card-h"><span class="hico pri">${icone('subir')}</span><div class="t"><h2>Google Drive</h2><p>A Conferência geral salva a planilha "DD-MM-AAAA - MOTOBOYS" nesta pasta ao enviar.</p></div></div><div class="card-b">
<p class="cfg-sit ${cred && v('drive_pasta') ? 'ok' : 'warn'}" role="status"><b>Situação:</b> ${cred && v('drive_pasta') ? `configurado · credencial ${cred}` : 'não configurado: a planilha vai só por e-mail.'}</p>
<details class="alert fold" style="display:block;margin-bottom:16px"><summary>${icone('info')} <b style="display:inline">Como configurar (pasta de terceiros)</b> ${icone('chevron', 'chev')}</summary><ol style="margin:10px 0 0 22px;padding:0;line-height:1.7">
<li>No Google Cloud, ative a <b>Google Drive API</b> no projeto.</li>
<li><b>Se a pasta está num Drive compartilhado:</b> crie uma <b>conta de serviço</b>, gere a chave JSON e peça ao dono para adicionar o e-mail da conta de serviço como <b>Editor/Administrador de conteúdo</b>.</li>
<li><b>Se é uma pasta comum de outra pessoa ("Compartilhados comigo"):</b> conta de serviço não funciona (não tem espaço próprio). Use um usuário do domínio que tenha acesso de <b>Editor</b> à pasta: crie um ID do cliente OAuth e gere um refresh_token com escopo drive; cole o JSON <code>{"type":"authorized_user","client_id":"…","client_secret":"…","refresh_token":"…"}</code>.</li>
<li>Cole abaixo o link da pasta e a credencial. Salve e use <b>Testar</b>.</li></ol></details>
<div class="field"><label for="drive_pasta">Link ou ID da pasta</label><input id="drive_pasta" name="drive_pasta" value="${v('drive_pasta')}" placeholder="https://drive.google.com/drive/folders/…"></div>
<div class="field"><label for="drive_credencial">Credencial (JSON)</label><textarea id="drive_credencial" name="drive_credencial" style="min-height:90px" placeholder="${cred ? '•••••••• (mantida)' : '{ "type": "service_account", … }'}"></textarea><p class="hint">${cred ? 'Deixe vazio para manter a atual.' : 'O conteúdo do arquivo .json.'}</p></div></div>
<div class="card-f"><button class="btn btn-pri">${icone('check')} Salvar</button><button class="btn btn-sec" formaction="/config/drive/teste">Testar</button></div></form>`;
  // Telegram: link do bot, pedidos a aprovar e quem já recebe (o administrador aprova cada pessoa/grupo que mandou /start)
  const tgUser = v('telegram_bot_user'), tgLink = tgUser ? `https://t.me/${tgUser}` : '', tgPend = TG.pendentes(), tgRec = TG.aprovados(), tgLegado = TG.legado().filter((id) => !tgRec.some((x) => x.chat_id === id));
  const tgData = (s) => (s ? s.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1').slice(0, 16) : '—');
  const tgForm = (acao, id, rotulo, cls) => html`<form method="post" action="/config/telegram/${acao}" style="display:inline"><input type="hidden" name="id" value="${id}"><button class="btn ${cls} btn-sm">${rotulo}</button></form>`;
  const tgCards = html`<section class="card cfg-estreito"><div class="card-h"><span class="hico pri">${icone('enviar')}</span><div class="t"><h2>Convidar alguém para os alertas</h2><p>Mande o link do bot a quem deve receber. A pessoa toca em Iniciar e o pedido aparece abaixo para você aprovar. Em grupo: adicione o bot ao grupo e envie /start nele.</p></div></div>
<div class="card-b">${tgLink ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><code style="padding:8px 10px;background:var(--surface-2);border-radius:8px;word-break:break-all">${tgLink}</code><button type="button" class="btn btn-sec btn-sm" onclick="navigator.clipboard.writeText('${tgLink}');this.textContent='Copiado!'">Copiar link</button></div>`
  : html`<form method="post" action="/config/telegram/link" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn btn-sec">Buscar o link do bot</button><span class="mut small">${temToken ? 'Usa o token do servidor para descobrir o nome do bot.' : 'Defina TELEGRAM_BOT_TOKEN no servidor primeiro.'}</span></form>`}</div></section>
<section class="card cfg-estreito"><div class="card-h"><div class="t"><h2>Pedidos para receber <span class="c-n">${tgPend.length}</span></h2></div></div>
<div class="tw"><table><thead><tr><th>Quem</th><th>Tipo</th><th>Pediu em</th><th class="n">Ações</th></tr></thead><tbody>
${tgPend.map((x) => html`<tr><th scope="row">${x.nome}</th><td>${x.tipo}</td><td>${tgData(x.pediu_em)}</td><td class="n">${tgForm('aprovar', x.chat_id, 'Aprovar', 'btn-pri')} ${tgForm('remover', x.chat_id, 'Recusar', 'btn-ghost')}</td></tr>`)}
${tgPend.length ? '' : html`<tr><td colspan="4">Nenhum pedido. Mande o link do bot para quem deve receber os alertas.</td></tr>`}</tbody></table></div></section>
<section class="card cfg-estreito"><div class="card-h"><div class="t"><h2>Recebem os alertas <span class="c-n">${tgRec.length + tgLegado.length}</span></h2></div></div>
<div class="tw"><table><thead><tr><th>Quem</th><th>Tipo</th><th>Aprovado</th><th class="n">Ações</th></tr></thead><tbody>
${tgRec.map((x) => html`<tr><th scope="row">${x.nome}</th><td>${x.tipo}</td><td>${tgData(x.aprovado_em)}</td><td class="n">${tgForm('remover', x.chat_id, 'Remover', 'btn-sec')}</td></tr>`)}
${tgLegado.map((id) => html`<tr><th scope="row">Chat ${id}</th><td>manual</td><td>—</td><td class="n">${tgForm('remover', id, 'Remover', 'btn-sec')}</td></tr>`)}
${tgRec.length + tgLegado.length ? '' : html`<tr><td colspan="4">Ninguém recebe ainda.</td></tr>`}</tbody></table></div></section>`;
  res.status(ctx.status || 200).send(page(req, { titulo: 'Configurações', compacto: true, eyebrow: 'Administração', sub: 'E-mail da solicitação de pagamento, alertas, lojas e entregadores. Só o suporte vê esta tela.', css: '/marca/admin.css', js: '/marca/admin.js' }, html`${nav}${aba === 'alertas' ? html`${automacao}${temToken ? tgCards : ''}${alertas}` : aba === 'lojas' ? lojasTab : aba === 'entregadores' ? entTab : aba === 'drive' ? driveTab : email}`));
}
app.get('/config', so((r) => r.user.perfil === 'admin'), (req, res) => telaConfig(req, res));

app.post('/config', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const b = req.body, emails = listaEmails(b.email_para);
  const invalido = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const erros = {};
  if (invalido) erros.email_para = `E-mail inválido: ${invalido}. Use e-mails completos, um por linha ou separados por vírgula.`;
  if (b.smtp_port && !/^\d{2,5}$/.test(String(b.smtp_port).trim())) erros.smtp_port = 'Porta inválida: use só números (ex.: 587).';
  if (Object.keys(erros).length) return telaConfig(req, res, { erros, valores: b, status: 422 });
  const valores = { email_para: emails.join(', '), app_url: String(b.app_url || '').trim(),
    smtp_host: String(b.smtp_host || '').trim(), smtp_port: String(b.smtp_port || '').trim(), smtp_user: String(b.smtp_user || '').trim(), smtp_from: String(b.smtp_from || '').trim() };
  if (b.smtp_pass) valores.smtp_pass = String(b.smtp_pass);
  const set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  tx(() => { for (const [k, val] of Object.entries(valores)) set.run(k, val); });
  log(req.user.id, 'config', `Configurações de e-mail salvas (destinatários: ${valores.email_para || 'nenhum'}; servidor: ${valores.smtp_host || 'nenhum'}${b.smtp_pass ? '; senha alterada' : ''})`);
  volta(res, '/config?aba=email', 'ok', 'Configurações salvas. Use "Enviar teste" para conferir.');
});

app.post('/config/painel', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const url = '/config?aba=lojas', tk = String(req.body.agz_painel_token || '').trim().replace(/^bearer\s+/i, '');
  if (tk && tk.split('.').length !== 3) return volta(res, url, 'erro', 'Token inválido: copie só o valor depois de "Bearer ".');
  for (const l of db.prepare('SELECT id FROM lojas').all()) {
    const s = String(req.body[`sid_${l.id}`] ?? '').trim();
    if (s && !/^[0-9a-f]{24}$/i.test(s)) return volta(res, url, 'erro', `storeId inválido: ${s}. Use o do painel: 24 letras/números (ex.: 6a03160245f42a2cff69ab95), não o código com traços da API.`);
    db.prepare('UPDATE lojas SET agz_store_id = ? WHERE id = ?').run(s || null, l.id);
  }
  if (tk) db.prepare("INSERT INTO config (chave, valor) VALUES ('agz_painel_token', ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor").run(tk);
  cacheConf.clear();
  log(req.user.id, 'config', `Painel do Agilizone salvo (storeIds${tk ? '; token alterado' : ''})`);
  volta(res, url, 'ok', 'Salvo. A Conferência já traz as ocorrências das lojas com storeId.');
});
function salvaDrive(req) {
  const pasta = CONF.pastaId(req.body.drive_pasta), cred = String(req.body.drive_credencial || '').trim();
  if (cred) {
    let c; try { c = JSON.parse(cred); } catch { throw falha('Credencial inválida: cole o conteúdo do arquivo JSON.'); }
    if (!(c.type === 'service_account' && c.private_key && c.client_email) && !(c.refresh_token && c.client_id && c.client_secret)) throw falha('Credencial inválida: use o JSON da conta de serviço ou de usuário autorizado (client_id, client_secret, refresh_token).');
  }
  const set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  set.run('drive_pasta', pasta);
  if (cred) set.run('drive_credencial', cred);
  log(req.user.id, 'config', `Google Drive salvo (pasta ${pasta || 'nenhuma'}${cred ? '; credencial alterada' : ''})`);
}
app.post('/config/drive', so((r) => r.user.perfil === 'admin'), (req, res) => {
  try { salvaDrive(req); } catch (e) { if (!e.publico) throw e; return volta(res, '/config?aba=drive', 'erro', e.message); }
  volta(res, '/config?aba=drive', 'ok', 'Google Drive salvo. Use "Testar" para conferir.');
});
app.post('/config/drive/teste', so((r) => r.user.perfil === 'admin'), async (req, res) => {
  try {
    salvaDrive(req);
    const r = await CONF.subirDrive({ credencial: cfg('drive_credencial'), pasta: cfg('drive_pasta'), nome: 'TESTE - MOTOBOYS (pode apagar).txt', buffer: Buffer.from('Teste do sistema de entregadores.'), mime: 'text/plain' });
    log(req.user.id, 'config', 'Teste do Google Drive: arquivo criado');
    volta(res, '/config?aba=drive', 'ok', `Funcionou: arquivo de teste criado na pasta (id ${r.id}). Pode apagá-lo.`);
  } catch (e) { volta(res, '/config?aba=drive', 'erro', e.message); }
});
app.post('/config/teste', so((r) => r.user.perfil === 'admin'), async (req, res) => {
  const para = String(req.body.para || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para)) return telaConfig(req, res, { erros: { teste: 'E-mail inválido: informe um endereço completo.' }, valores: { para }, status: 422 });
  try {
    const r = await enviarEmail({ to: para, subject: 'Teste · Entregadores Forno Paulista', text: 'Se você recebeu este e-mail, o envio das solicitações de pagamento está funcionando.' });
    if (r.salvo) { log(req.user.id, 'config', `Teste de e-mail para ${para}: não enviado, servidor de e-mail não configurado`); return volta(res, '/config?aba=email', 'erro', 'O servidor de e-mail não está configurado: o teste foi salvo no servidor e não foi enviado.'); }
    log(req.user.id, 'config', `Teste de e-mail para ${para}: aceito pelo servidor SMTP`);
    volta(res, '/config?aba=email', 'ok', `O servidor aceitou o e-mail de teste para ${para}. Isso não garante a entrega: confira a caixa de entrada e o spam.`);
  } catch (e) {
    log(req.user.id, 'config', `Teste de e-mail para ${para}: recusado pelo servidor (${e.message})`);
    volta(res, '/config?aba=email', 'erro', `O servidor de e-mail recusou: ${e.message}`);
  }
});

const salvaLoja = (req, res) => {
  const nome = String(req.body.nome || '').trim(), id = Number(req.params.id) || null, p = id ? `l${id}` : 'nl', erros = {};
  if (id && !db.prepare('SELECT 1 FROM lojas WHERE id = ?').get(id)) throw falha('Loja não encontrada.', 404);
  const atual = id ? db.prepare('SELECT nome, calendario FROM lojas WHERE id = ?').get(id) : null;
  if (atual && req.body.rev !== revisao(atual.nome, atual.calendario || AG.PADRAO)) return volta(res, '/config?aba=lojas', 'erro', `A loja ${atual.nome} ${MSG_ALTERADO}`);
  if (!nome) erros.nome = 'Informe o nome da loja, igual ao do Agilizone.';
  else if (atual && nome !== atual.nome && !superAdmin(req.user)) erros.nome = 'Só o super administrador (login admin) pode renomear lojas. Não renomeie: isso derruba a integração com o Agilizone.';
  else { const dono = db.prepare('SELECT id FROM lojas WHERE nome = ?').get(nome); if (dono && dono.id !== id) erros.nome = 'Já existe uma loja com esse nome.'; }
  let cal;
  if (req.body.calendario != null) { try { cal = AG.lerCalendario(req.body.calendario); } catch (e) { erros.calendario = `Calendário inválido: ${e.message}`; } }
  if (Object.keys(erros).length) { return telaConfig(req, res, { aba: 'lojas', erros, abrir: p, valores: { nome, calendario: String(req.body.calendario ?? '') }, status: 422 }); }
  if (id) db.prepare('UPDATE lojas SET nome = ?, calendario = COALESCE(?, calendario), ativa = CASE WHEN ? THEN ? ELSE ativa END WHERE id = ?').run(nome, cal ? String(req.body.calendario).trim() : null, req.body.ativa_f ? 1 : 0, req.body.ativa ? 1 : 0, id);
  else db.prepare('INSERT INTO lojas (nome, calendario) VALUES (?, ?)').run(nome, cal ? String(req.body.calendario).trim() : AG.PADRAO);
  log(req.user.id, 'config', `${id ? 'Alterou loja #' + id : 'Criou loja'} "${nome}"${cal ? ` · pagamentos: ${AG.textoCalendario(cal)}` : ''}`);
  volta(res, '/config?aba=lojas', 'ok', `Loja ${nome} salva.`);
};
app.post('/config/lojas/:id/agilizone', so((r) => r.user.perfil === 'admin'), async (req, res, next) => {
  const l = db.prepare('SELECT * FROM lojas WHERE id = ?').get(Number(req.params.id));
  if (!l) return next(falha('Loja não encontrada.', 404));
  if (!AGZ_API.configurada(l)) return volta(res, '/config?aba=lojas', 'erro', `${l.nome}: defina no servidor as variáveis ${AGZ_API.variaveis(l).id} e ${AGZ_API.variaveis(l).secret} antes de testar.`);
  try {
    const t = await AGZ_API.testa(l);
    if (t.taxa === false) return volta(res, '/config?aba=lojas', 'erro', `${l.nome}: conectou, mas o Agilizone não está enviando a taxa do entregador. Peça ao desenvolvedor para liberar o escopo DELIVERYMAN_FEES.`);
    volta(res, '/config?aba=lojas', 'ok', `${l.nome}: conexão com o Agilizone funcionando${t.total != null ? ` (${t.total} pedidos nos últimos 7 dias)` : ''}.`);
  } catch (e) {
    if (!e.publico) return next(e);
    volta(res, '/config?aba=lojas', 'erro', `${l.nome}: ${e.message}`);
  }
});

// Traz do Agilizone todos os entregadores que aparecem nos pedidos recentes das lojas conectadas (a API não tem lista de
// entregadores) e cadastra quem falta, com o id. A chave PIX de quem já existe não é tocada: o que foi salvo persiste.
app.post('/config/entregadores/buscar', so((r) => r.user.perfil === 'admin'), async (req, res, next) => {
  const lojas = db.prepare('SELECT * FROM lojas ORDER BY nome').all().filter((l) => AGZ_API.configurada(l));
  if (!lojas.length) return volta(res, '/config?aba=entregadores', 'erro', 'Nenhuma loja está ligada ao Agilizone ainda. Defina as variáveis de ambiente da loja (Configurações > Lojas mostra os nomes).');
  const antes = db.prepare('SELECT COUNT(*) n FROM motoboys').get().n, ids = new Set(), falhas = [];
  for (const l of lojas) {
    try { for (const e of await AGZ_API.entregadores(l)) { motoboyDoAgilizone(l, e.id, e.nome); ids.add(e.id); } }
    catch (e) { if (!e.publico) return next(e); falhas.push(`${l.nome}: ${e.message}`); }
  }
  const novos = db.prepare('SELECT COUNT(*) n FROM motoboys').get().n - antes;
  log(req.user.id, 'config', `Buscou entregadores no Agilizone: ${ids.size} encontrados, ${novos} novos no cadastro${falhas.length ? `; falhou: ${falhas.length} loja(s)` : ''}`);
  volta(res, '/config?aba=entregadores', falhas.length && !ids.size ? 'erro' : 'ok', `${ids.size} entregador(es) encontrado(s) em ${lojas.length - falhas.length} loja(s); ${novos} novo(s) no cadastro.${falhas.length ? ` Falhou: ${falhas.join(' | ')}` : ''}`);
});
// Edição e importação de Pix por aqui foram desativadas: gravavam em motoboys.pix (global, por nome), que os fechamentos não leem.
// O Pix fica por loja e identidade, em Entregadores (entregador_pix).
const pixPorLoja = (req, res) => volta(res, '/config?aba=entregadores', 'erro', 'Esta edição foi desativada: a chave Pix fica por loja, em Entregadores (menu lateral).');
app.post('/config/entregadores/importar', so((r) => r.user.perfil === 'admin'), pixPorLoja);
app.post('/config/entregadores/:id', so((r) => r.user.perfil === 'admin'), pixPorLoja);

app.post('/config/lojas', so((r) => r.user.perfil === 'admin'), salvaLoja);
app.post('/config/lojas/:id', so((r) => r.user.perfil === 'admin'), salvaLoja);

// Fechamento automático + Telegram (token e chat id). O token nunca aparece na tela nem no log.
function salvaAutomacao(req) {
  const b = req.body, hora = String(b.hora_fechamento || '06:00'), corte = String(b.hora_corte || '05:00'), chat = String(b.telegram_chat || '').trim();
  const emails = [...new Set(listaEmails(b.email_para).map((e) => e.toLowerCase()))], invalido = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (![hora, corte].every((h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h))) throw falha('Horário inválido.');
  if (hora < corte) throw falha(`O envio (${hora}) não pode ser antes do horário de corte dos pedidos (${corte}).`);
  if (invalido) throw falha(`E-mail inválido: ${invalido}. Use e-mails completos, um por linha ou separados por vírgula.`);
  if (chat && !/^-?\d+([\s,;]+-?\d+)*$/.test(chat)) throw falha('Chat ID inválido: só números, separados por vírgula (o de grupo começa com -).');
  const set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  tx(() => { set.run('auto_fechamento', b.auto_fechamento ? '1' : '0'); set.run('hora_fechamento', hora); set.run('hora_corte', corte); if (b.email_para !== undefined) set.run('email_para', emails.join(', ')); if (b.telegram_chat !== undefined) set.run('telegram_chat', chat.split(/[\s,;]+/).filter(Boolean).join(',')); });
  log(req.user.id, 'config', `Fechamento automático: ${b.auto_fechamento ? `ligado às ${hora}` : 'desligado'}; corte dos pedidos ${corte}; e-mails: ${emails.join(', ') || 'nenhum'}; Telegram: ${chat ? `chat ${chat}` : 'sem chat'}`);
}
const comAutomacao = (fn) => (req, res, next) => (async () => { // salva os campos do formulário e depois executa a ação do botão
  try { salvaAutomacao(req); } catch (e) { if (!e.publico) throw e; return volta(res, '/config?aba=alertas', 'erro', e.message); }
  await fn(req, res);
})().catch(next);
app.post('/config/automacao', so((r) => r.user.perfil === 'admin'), comAutomacao((req, res) => volta(res, '/config?aba=alertas', 'ok', 'Salvo. O fechamento automático roda nos dias de pagamento, depois da hora definida.')));
app.post('/config/automacao/teste', so((r) => r.user.perfil === 'admin'), comAutomacao(async (req, res) => {
  const r = await TG.avisar('✅ Teste do sistema de pagamento de entregadores: o Telegram está recebendo os alertas.');
  volta(res, '/config?aba=alertas', r.enviado ? 'ok' : 'erro', r.enviado ? 'Mensagem de teste enviada. Confira no Telegram.' : `Não enviou: ${r.motivo}`);
}));
// Telegram: link do bot e aprovação de quem pediu para receber os alertas (não passam pelo formulário da automação)
const soAdminTg = so((r) => r.user.perfil === 'admin'), voltaTg = (res, t, m) => volta(res, '/config?aba=alertas', t, m);
app.post('/config/telegram/link', soAdminTg, async (req, res) => {
  try { const u = await TG.botUser(); voltaTg(res, u ? 'ok' : 'erro', u ? `Link do bot: https://t.me/${u}` : 'Não consegui identificar o bot: confira o token.'); }
  catch (e) { voltaTg(res, 'erro', e.message); }
});
app.post('/config/telegram/aprovar', soAdminTg, async (req, res) => {
  const id = String(req.body.id || ''), x = db.prepare('SELECT nome FROM telegram_dest WHERE chat_id = ?').get(id);
  if (!x || !TG.aprova(id, req.user.id)) return voltaTg(res, 'erro', 'Pedido não encontrado (talvez já tenha sido tratado).');
  log(req.user.id, 'config', `Telegram: aprovou ${x.nome} (${id}) para receber os alertas`);
  await TG.paraChat(id, '✅ Acesso aprovado! A partir de agora você recebe aqui os alertas do Pagamento de Entregadores. Para sair, envie /parar.');
  voltaTg(res, 'ok', `${x.nome} aprovado(a): passa a receber os alertas.`);
});
app.post('/config/telegram/remover', soAdminTg, (req, res) => {
  const id = String(req.body.id || ''), x = db.prepare('SELECT nome FROM telegram_dest WHERE chat_id = ?').get(id);
  if (!TG.remove(id)) return voltaTg(res, 'erro', 'Não encontrado (talvez já tenha sido removido).');
  log(req.user.id, 'config', `Telegram: removeu ${x?.nome || id} (${id}) dos alertas`);
  voltaTg(res, 'ok', `${x?.nome || id} não recebe mais os alertas.`);
});
app.post('/config/automacao/simular', so((r) => r.user.perfil === 'admin'), comAutomacao(async (req, res) => {
  const d = String(req.body.d_sim || '');
  if (!dataOk(d)) return volta(res, '/config?aba=alertas', 'erro', 'Escolha a data do pagamento a simular.');
  const r = await rodaFechamento(d, { simular: true });
  const texto = r.problemas ? textoFalha(d, r.problemas, false).replace('⚠️', '🧪 SIMULAÇÃO ⚠️') : `🧪 SIMULAÇÃO: o fechamento de ${dataFmt(d)} estaria OK para enviar (nada foi enviado).\n${porLoja(r.dia)}`;
  const a = await TG.avisar(texto);
  volta(res, '/config?aba=alertas', r.problemas ? 'erro' : 'ok', r.problemas ? `Simulação: ${r.problemas.length} problema(s), ex.: ${r.problemas[0]}.${a.enviado ? ' Aviso enviado no Telegram.' : ''}` : `Simulação: tudo certo para enviar o fechamento de ${dataFmt(d)} (nada foi enviado).${a.enviado ? ' Aviso enviado no Telegram.' : ''}`);
}));
app.post('/config/automacao/agendar-teste', so((r) => r.user.perfil === 'admin'), comAutomacao((req, res) => {
  const b = req.body, { data: hoje, hora: agoraH } = agora(), email = String(b.teste_email || '').trim().toLowerCase(), hora = String(b.teste_hora || ''), alvo = String(b.teste_data || '');
  const erro = !dataOk(alvo) ? 'Escolha o pagamento a testar.' : !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ? 'Horário inválido.' : hora <= agoraH ? `Esse horário já passou hoje (agora são ${agoraH}, hora de Teresina). Escolha um mais tarde.`
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Informe um e-mail válido para receber o teste.' : !TG.configurado() ? 'Configure o Telegram antes: é por lá que o resultado do teste chega.' : '';
  if (erro) return volta(res, '/config?aba=alertas', 'erro', erro);
  db.prepare("INSERT INTO config (chave, valor) VALUES ('teste_auto', ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify({ dia: hoje, hora, data: alvo, email }));
  log(req.user.id, 'config', `Agendou teste do envio automático: hoje às ${hora}, pagamento ${dataFmt(alvo)}, e-mail só para ${email}`);
  volta(res, '/config?aba=alertas', 'ok', `Teste agendado para hoje às ${hora}. O resultado chega no Telegram e o e-mail de teste só em ${email}.`);
}));
app.post('/config/automacao/cancelar-teste', so((r) => r.user.perfil === 'admin'), comAutomacao((req, res) => {
  db.prepare("DELETE FROM config WHERE chave = 'teste_auto'").run();
  volta(res, '/config?aba=alertas', 'ok', 'Teste cancelado.');
}));
app.post('/config/alertas', so((r) => r.user.perfil === 'admin'), (req, res) => {
  const b = req.body, set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
  for (const h of ['hora_resumo']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b[h] || ''))) throw falha('Horário inválido.');
  tx(() => {
    set.run('alerta_resumo', b.alerta_resumo ? '1' : '0');
    set.run('hora_resumo', String(b.hora_resumo));
  });
  log(req.user.id, 'config', `Resumo diário ao financeiro: ${b.alerta_resumo ? b.hora_resumo : 'desligado'}`);
  volta(res, '/config?aba=alertas', 'ok', 'Alertas salvos.');
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
    const lojas = lojasAtivas();
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
          subject: `Pagamentos de entregadores de hoje (${dataFmt(hoje)}): ${faltam ? `faltam ${faltam} loja(s)` : 'todas as lojas enviaram'}`,
          text: `Olá,\n\nSituação dos pagamentos de entregadores de hoje, ${diaLongo(hoje)}:\n\n${itens.map(linha).join('\n')}${link}`,
        });
      }
    }
  } catch (e) { console.error('alertas:', e); } finally { verificando = false; }
}
setInterval(verificarAlertas, 5 * 60e3).unref();
// Cadastro de entregadores em dia com o Agilizone: ao subir (80 dias) e a cada 30 minutos (3 dias).
if (process.env.SYNC_ENTREGADORES !== '0') { setTimeout(() => sincronizaTodas(80), 20e3).unref(); setInterval(() => sincronizaTodas(3), 30 * 60e3).unref(); }
setTimeout(verificarAlertas, 15e3).unref();

// ---------- Fechamento automático ----------
// No dia de pagamento, depois da hora configurada: puxa tudo do Agilizone, confere e, SEM nenhuma pendência, gera a planilha
// no modelo, envia por e-mail e sobe no Drive. Com qualquer problema NÃO envia nada: avisa no Telegram e tenta de novo a cada 30 min.
const TENTAR_A_CADA = Number(process.env.FECHAMENTO_RETRY_MS) || 30 * 60e3, REAVISAR_A_CADA = 2 * 3600e3;
const PASSO_FECHAMENTO = Number(process.env.FECHAMENTO_PASSO_MS) || 60e3;
const tentFechamento = new Map(); // data -> { em, sig, avisoEm }: última tentativa, o que deu errado e quando avisou
let fechando = false;
const linkConf = (d) => (cfg('app_url') ? `\n${cfg('app_url').replace(/\/$/, '')}/conferencia?d=${d}` : '');
const porLoja = (dia) => dia.map((x) => `• ${lojaCurta(x.loja.nome)}: ${x.itens.filter((i) => i.valor > 0).length} entregadores, ${brl(x.itens.reduce((s, i) => s + i.valor, 0))}`).join('\n');
// Confere o dia e, sem pendências, envia. Retorna { problemas, dia } (nada enviado), { simulado, dia } ou { enviado, dia }.
async function rodaFechamento(d, { simular = false, emailTeste = '' } = {}) {
  let dia;
  try { dia = await conferenciaDoDia(d, true); } catch (e) { return { problemas: [`erro ao ler o Agilizone: ${e.message}`], dia: [] }; }
  const problemas = [...bloqueiosDo(dia), ...semOcorrencias(dia).map((x) => `${lojaCurta(x.loja.nome)}: ocorrências não carregadas (${x.erroOc})`)];
  if (!dia.length) problemas.push('nenhuma loja paga neste dia');
  else if (!linhasPlanilha(dia).length) problemas.push('não há valores a pagar neste dia');
  if (problemas.length) return { problemas, dia };
  if (simular) return { simulado: true, dia };
  const r = await enviaFechamento(d, dia, null, { emailTeste });
  return r.erro ? { problemas: [r.erro], dia } : { enviado: r, dia };
}
// Teste agendado do envio automático (Configurações > Alertas): na hora marcada de HOJE roda o fluxo de verdade (puxa, confere, gera a
// planilha), mas manda SÓ para o e-mail de teste, sem registrar nada, e avisa o resultado no Telegram. Roda uma única vez.
async function testeAgendado() {
  let t; try { t = JSON.parse(cfg('teste_auto') || 'null'); } catch { t = null; }
  if (!t || t.feito || fechando || TESTE_LOCAL || process.env.ALERTAS === '0') return;
  const { data, hora } = agora();
  if (data !== t.dia || hora < t.hora) return;
  fechando = true;
  try {
    db.prepare("INSERT INTO config (chave, valor) VALUES ('teste_auto', ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify({ ...t, feito: `${data} ${hora}` })); // marca antes: não repete
    const r = await rodaFechamento(t.data, { emailTeste: t.email });
    log(null, 'fechamento', `Teste agendado do envio automático (${dataFmt(t.data)}): ${r.enviado ? `e-mail de teste enviado para ${t.email}` : `falhou: ${r.problemas.join('; ').slice(0, 400)}`}`);
    await TG.avisar(r.enviado ? `🧪 TESTE automático OK às ${hora}: ${r.enviado.titulo} (${r.enviado.linhas} linhas, ${brl(r.enviado.total)}) foi enviado só para ${t.email}. O financeiro não recebeu nada.\n${porLoja(r.dia)}`
      : textoFalha(t.data, r.problemas, false).replace('⚠️', '🧪 TESTE ⚠️'));
  } catch (e) {
    console.error('teste agendado:', e);
    await TG.avisar(`🧪 TESTE automático com erro inesperado: ${e.message}`);
  } finally { fechando = false; }
}
setInterval(testeAgendado, Math.min(30e3, PASSO_FECHAMENTO)).unref();
// Cadastro automático no Telegram: lê as mensagens do bot ("/start <código do link>" cadastra, "/parar" sai).
let lendoTg = false;
async function cadastroTelegram() {
  if (lendoTg || TESTE_LOCAL || process.env.ALERTAS === '0' || !process.env.TELEGRAM_BOT_TOKEN) return;
  lendoTg = true;
  try { for (const e of await TG.sincroniza()) log(null, 'config', `Telegram: ${e.nome} (${e.id}) ${e.acao}`); }
  catch (e) { /* sem rede ou token ruim: tenta de novo na próxima rodada */ }
  finally { lendoTg = false; }
}
// Reenvio: se uma planilha ficou pendente no Drive (o script falhou na hora do envio), manda o script gravar de novo a cada 30 min
// e avisa no Telegram.
let driveRodando = false, driveUltimo = 0, driveAviso = 0;
async function driveAgendado() {
  if (driveRodando || !driveRapido() || driveDestino() !== 'fila' || TESTE_LOCAL || process.env.ALERTAS === '0') return;
  const { hora } = agora();
  const pend = () => db.prepare('SELECT e.pagamento FROM drive_fila_envios q JOIN envios e ON e.id = q.envio_id WHERE q.drive_id IS NULL').all();
  if (!pend().length || Date.now() - driveUltimo < TENTAR_A_CADA) return;
  driveRodando = true; driveUltimo = Date.now();
  try {
    const r = await acionaScript(), faltam = pend().length;
    if (!faltam) { driveAviso = 0; await TG.avisar(`☁️ Planilha(s) gravada(s) no Google Drive (${hora}).`); log(null, 'conferencia', 'Planilha gravada no Google Drive no horário automático'); return; }
    if (Date.now() - driveAviso > REAVISAR_A_CADA) { driveAviso = Date.now(); await TG.avisar(`⚠️ ${faltam} planilha(s) NÃO foram gravadas no Google Drive: ${r.erro || 'o script não gravou (veja o log do Apps Script)'}. Tento de novo a cada 30 min; ou use "Enviar ao Drive" na Conferência.`); }
  } finally { driveRodando = false; }
}
setInterval(() => driveAgendado().catch((e) => console.error('drive agendado:', e)), Math.min(60e3, PASSO_FECHAMENTO)).unref();
setInterval(cadastroTelegram, Math.min(15e3, PASSO_FECHAMENTO)).unref();
setTimeout(cadastroTelegram, 5e3).unref();
const textoFalha = (d, problemas, auto) => `⚠️ Fechamento ${auto ? 'automático ' : ''}de ${dataFmt(d)} NÃO foi enviado (${problemas.length} problema${problemas.length > 1 ? 's' : ''}):\n${problemas.slice(0, 8).map((p) => `• ${p}`).join('\n')}${problemas.length > 8 ? `\n… e mais ${problemas.length - 8}` : ''}\n\nNada foi enviado.${auto ? ' Tento de novo a cada 30 min; ou corrija e envie na Conferência.' : ''}${linkConf(d)}`;
const textoOk = (e, dia) => `${e.drive?.erro ? '⚠️' : '✅'} ${e.titulo} enviado automaticamente\n${porLoja(dia)}\nTotal ${brl(e.total)} (${e.linhas} linhas)\nE-mail: ${e.para.join(', ')}\nConfira o e-mail com a planilha em anexo.\n${e.drive === 'ok' ? 'Planilha salva no Google Drive.' : e.drive === 'fila' ? `Na fila do Drive: grava ${quandoGrava()}.` : e.drive === 'sem' ? 'Google Drive não configurado.' : `Drive FALHOU (${e.drive.erro}): use "Enviar ao Drive" na Conferência.`}`;
async function fechamentoAutomatico() {
  if (fechando || TESTE_LOCAL || process.env.ALERTAS === '0' || cfg('auto_fechamento') !== '1') return; // no modo teste local o automático não roda
  const { data: d, hora } = agora();
  if (hora < (cfg('hora_fechamento') || '06:00')) return;
  if (!agenda(lojasAtivas(), d, d).length || envioDo(d)) return; // hoje ninguém paga, ou já foi enviado
  const t = tentFechamento.get(d);
  if (t && Date.now() - t.em < TENTAR_A_CADA) return;
  fechando = true;
  try {
    const r = await rodaFechamento(d), agoraMs = Date.now();
    if (r.enviado) { tentFechamento.delete(d); await TG.avisar(textoOk(r.enviado, r.dia)); return; }
    const sig = r.problemas.join('|');
    let avisoEm = t?.avisoEm || 0;
    if (!t || t.sig !== sig || agoraMs - avisoEm > REAVISAR_A_CADA) { // avisa quando muda o problema, ou de tempos em tempos
      log(null, 'fechamento', `Fechamento automático de ${dataFmt(d)} não enviado: ${r.problemas.join('; ').slice(0, 500)}`);
      const a = await TG.avisar(textoFalha(d, r.problemas, true));
      if (a.enviado) avisoEm = agoraMs; else log(null, 'fechamento', `Alerta no Telegram não saiu: ${a.motivo}`);
    }
    tentFechamento.set(d, { em: agoraMs, sig, avisoEm });
  } catch (e) {
    console.error('fechamento automático:', e);
    log(null, 'fechamento', `Erro inesperado no fechamento automático: ${e.message}`);
    tentFechamento.set(d, { em: Date.now(), sig: 'erro', avisoEm: t?.avisoEm || 0 });
    await TG.avisar(`⚠️ Erro inesperado no fechamento automático de ${dataFmt(d)}: ${e.message}. Nada foi enviado.${linkConf(d)}`);
  } finally { fechando = false; }
}
setInterval(fechamentoAutomatico, PASSO_FECHAMENTO).unref();
setTimeout(fechamentoAutomatico, Math.min(25e3, PASSO_FECHAMENTO)).unref();

// ---------- Erros ----------
const ERRO_TXT = { 403: ['Acesso negado', 'Seu perfil não tem acesso a esta tela.'], 404: ['Página não encontrada', 'O endereço não existe, foi movido ou o item já não está disponível.'],
  409: ['Mudou enquanto você olhava', 'Alguém alterou isto antes de você. Recarregue a tela e confira.'], 500: ['Algo deu errado', 'Não foi possível concluir. Tente de novo; se continuar, avise o suporte.'] };
const telaErro = (req, titulo, msg, codigo = 400) => page(req, { titulo, semCabecalho: true }, html`<section class="erro-pag" aria-labelledby="erro-t">
<div class="erro-arte" aria-hidden="true"><span class="erro-cod">${codigo >= 400 ? codigo : ''}</span>${icone('moto', 'erro-moto')}<i class="erro-rota"></i></div>
<div class="erro-txt"><p class="eyebrow">${codigo >= 400 ? `Erro ${codigo}` : 'Aviso'}</p><h1 id="erro-t">${titulo}</h1><p class="erro-msg">${msg || (ERRO_TXT[codigo] || [])[1] || ''}</p>
<div class="erro-acoes"><a class="btn btn-sec" href="javascript:history.back()">${icone('voltar')} Voltar</a><a class="btn btn-pri" href="/">${icone('casa')} Ir para o início</a></div>
<p class="hint">Se o problema continuar, fale com o suporte.</p></div></section>`);
app.use((req, res) => res.status(404).send(telaErro(req, ERRO_TXT[404][0], ERRO_TXT[404][1], 404)));
app.use((err, req, res, next) => {
  if (err.volta) return volta(res, err.volta, 'erro', err.message); // recusa de decisão: volta para a tela com o motivo
  const grande = err instanceof multer.MulterError || err.type === 'entity.too.large';
  const msg = err.publico ? err.message : grande ? 'Arquivo ou texto grande demais, ou arquivos demais.' : 'Erro inesperado. Avise o suporte.';
  if (!err.publico && !grande) console.error(err);
  const st = err.status || (err.publico || grande ? 400 : 500);
  res.status(st).send(telaErro(req, (ERRO_TXT[st] || ['Não foi possível concluir'])[0], err.publico || grande ? msg : (ERRO_TXT[st] || [])[1] || msg, st));
});

const PORT = process.env.PORT || 3080;
app.listen(PORT, process.env.HOST, () => console.log(`Pagamento Entregadores em http://localhost:${PORT}`));
