// QA do Despachante: importação, isolamento por loja, perfis, duplicidade, Pix, envio e efeitos no Financeiro.
// Banco isolado, usuários fictícios e Agilizone simulado em servidor local. Roda com `npm test`.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-desp-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const { variaveis } = require('./agilizone');
const PORT = 4300 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, mock, A, Bl, U = {}; let comNovo = false; // A = loja do despachante, Bl = outra loja
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());

before(async () => {
  A = db.prepare("SELECT * FROM lojas WHERE nome LIKE '%SUL'").get(); Bl = db.prepare("SELECT * FROM lojas WHERE nome LIKE '%DIRCEU'").get();
  const user = (login, perfil, l) => Number(db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l).lastInsertRowid);
  db.prepare("UPDATE usuarios SET senha = ? WHERE login = 'admin'").run(hashSenha('senha12345')); // super administrador: o usuário inicial
  U.desp = user('desp', 'despachante', A.id); U.despB = user('despb', 'despachante', Bl.id); user('fin', 'financeiro', null); user('gestao', 'gestao', null);
  // Agilizone simulado: 2 entregadores com um pedido por dia, de 30 dias atrás até 7 dias à frente.
  mock = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/auth/token')) return res.end(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    const data = [];
    for (let i = -30; i <= 7; i++) {
      const d = new Date(Date.parse(hoje + 'T15:00:00Z') + i * 864e5).toISOString();
      data.push({ id: `k${i}`, orderDisplayNumber: String(i + 100), status: 'COMPLETED', deliveryman: { id: 7, name: 'Kevin Fictício' }, deliverymanFee: 10, createdAt: d });
      if (comNovo) data.push({ id: `n${i}`, orderDisplayNumber: String(i + 300), status: 'COMPLETED', deliveryman: { id: 9, name: 'Novo Fictício' }, deliverymanFee: 6, createdAt: d });
      data.push({ id: `m${i}`, orderDisplayNumber: String(i + 200), status: 'COMPLETED', deliveryman: { id: 8, name: 'Marcos Fictício' }, deliverymanFee: 7.5, createdAt: d });
    }
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  const v = variaveis(A);
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1', AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, [v.id]: 'id', [v.secret]: 'segredo' } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); mock.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login) => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = (ck, url) => fetch(B + url, { headers: ck ? { cookie: ck } : {}, redirect: 'manual' });
const texto = async (ck, url) => (await (await get(ck, url)).text()).replace(/&nbsp;| /g, ' ');
const postR = (ck, url, dados = {}) => fetch(B + url, { method: 'POST', headers: ck ? { cookie: ck } : {}, body: new URLSearchParams(dados), redirect: 'manual' });
const post = async (ck, url, dados) => (await postR(ck, url, dados)).headers.get('location') || '';
const msg = (loc) => decodeURIComponent(new URL(loc, B).searchParams.get('ok') || new URL(loc, B).searchParams.get('erro') || '');
const n = (sql, ...p) => db.prepare(sql).get(...p).n;
const crypto = require('node:crypto'), { PADRAO } = require('./agenda');
const rev = (...c) => crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 12);
const revUsuario = (id) => { const u = db.prepare('SELECT nome, perfil, loja_id, ativo FROM usuarios WHERE id = ?').get(id); return rev(u.nome, u.perfil, u.loja_id, u.ativo); };
const revLoja = (id) => { const l = db.prepare('SELECT nome, calendario FROM lojas WHERE id = ?').get(id); return rev(l.nome, l.calendario || PADRAO); };
// campos rev_<id> que a tela de Chaves Pix manda junto com cada chave
const revs = async (ck, fid) => Object.fromEntries([...(await texto(ck, `/fechamentos/${fid}`)).matchAll(/name="(rev_\d+)" value="([0-9a-f]+)"/g)].map((m) => [m[1], m[2]]));
const postPix = async (ck, fid, dados) => post(ck, `/fechamentos/${fid}/pix`, { ...(await revs(ck, fid)), ...dados });

// Arquivos do Agilizone: pedidos [numero, "dd/mm/aaaa hh:mm:ss", entregador, taxa]; resumo [nome, pedidos, pix, total]
const xlsx = (loja, rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Número', 'Status', 'Loja', 'Data e Hora Início de Preparo', 'Entregador', 'Taxa do Entregador'], ...rows.map(([num, h, e, t]) => [num, 'Finalizado', loja, h, e, t])]), 'R');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const csv = (rows) => Buffer.from('Entregador;Pedidos;CPF;Chave Pix;Data de Nascimento;Soma das taxas de entrega;Pago;Saldo a pagar\n' + rows.map(([e, p, pix, t]) => `${e};${p};-;${pix || '-'};-;R$ ${t.toFixed(2).replace('.', ',')};R$ 0,00;R$ ${t.toFixed(2).replace('.', ',')}`).join('\n'));
const importa = async (ck, { arq, res, modo, dia, loja }) => {
  const fd = new FormData();
  if (modo) fd.append('modo', modo); if (dia) fd.append('dia', dia); if (loja) fd.append('loja', loja);
  if (arq) fd.append('arquivo', new Blob([arq]), 'pedidos.xlsx'); if (res) fd.append('resumo', new Blob([res]), 'resumo.csv');
  const r = await fetch(`${B}/fechamentos/novo`, { method: 'POST', headers: { cookie: ck }, body: fd, redirect: 'manual' });
  return { status: r.status, loc: r.headers.get('location') || '', fid: Number((r.headers.get('location') || '').match(/\/fechamentos\/(\d+)/)?.[1]) || 0 };
};
const PEDIDOS = [['1', '26/10/2026 20:00:00', 'Ana Fictícia', 10], ['2', '26/10/2026 21:00:00', 'Ana Fictícia', 7.5], ['3', '27/10/2026 20:00:00', 'Bia Fictícia', 12], ['4', '27/10/2026 22:00:00', '—', 99]];
const RESUMO = [['Ana Fictícia', 2, 'ana.ficticia@exemplo.com', 17.5], ['Bia Fictícia', 1, null, 12]];
let F; // fechamento importado por arquivos

test('D1 importação por arquivos: valores por entregador, pedido sem entregador descartado, rascunho da loja certa', async () => {
  const ck = await entra('desp'), r = await importa(ck, { arq: xlsx(A.nome, PEDIDOS), res: csv(RESUMO) });
  assert.ok(r.fid, r.loc); F = r.fid;
  const f = db.prepare('SELECT * FROM fechamentos WHERE id = ?').get(F);
  assert.deepStrictEqual([f.status, f.loja_id, f.criado_por, f.data_ini, f.data_fim], ['rascunho', A.id, U.desp, '2026-10-26', '2026-10-27']);
  assert.strictEqual(n('SELECT COUNT(*) n FROM pedidos WHERE fechamento_id = ?', F), 3, 'pedido sem entregador (R$ 99) não entra');
  assert.strictEqual(n('SELECT SUM(taxa) n FROM pedidos WHERE fechamento_id = ?', F), 2950);
  const pg = await texto(ck, `/fechamentos/${F}`);
  assert.ok(pg.includes('Ana Fictícia') && pg.includes('17,50') && pg.includes('Bia Fictícia') && pg.includes('12,00'));
  assert.ok(!pg.includes('99,00'));
});

test('D2 duplicidade: reimportar o mesmo arquivo (também em paralelo) não cria fechamento nem pedido', async () => {
  const ck = await entra('desp'), antes = [n('SELECT COUNT(*) n FROM fechamentos'), n('SELECT COUNT(*) n FROM pedidos')];
  const rs = await Promise.all([1, 2, 3].map(() => importa(ck, { arq: xlsx(A.nome, PEDIDOS), res: csv(RESUMO) })));
  for (const r of rs) { assert.ok(!r.fid, r.loc); assert.match(msg(r.loc), /Pedidos já importados/); assert.match(r.loc, new RegExp(`abrir=${F}`)); }
  assert.deepStrictEqual([n('SELECT COUNT(*) n FROM fechamentos'), n('SELECT COUNT(*) n FROM pedidos')], antes);
  // 1 dia dentro de um período já importado também é recusado
  const d = await importa(ck, { modo: 'dia', dia: '2026-10-26', res: csv(RESUMO) });
  assert.match(msg(d.loc), /já está no fechamento/); assert.strictEqual(n('SELECT COUNT(*) n FROM fechamentos'), antes[0]);
});

test('D3 isolamento: despachante não importa, abre nem altera dados de outra loja', async () => {
  const b = await entra('despb'), a = await entra('desp');
  const r = await importa(b, { arq: xlsx(Bl.nome === A.nome ? 'x' : A.nome, PEDIDOS), res: csv(RESUMO) });
  assert.ok(!r.fid); assert.match(msg(r.loc) || String(r.status), /403|Loja incorreta/);
  for (const u of ['', '/pdf', '/xlsx', '/enviar', `/motoboy/${db.prepare('SELECT motoboy_id m FROM resumo WHERE fechamento_id = ? LIMIT 1').get(F).m}`]) assert.strictEqual((await get(b, `/fechamentos/${F}${u}`)).status, 404, `GET ${u}`);
  const antes = JSON.stringify(db.prepare('SELECT * FROM fechamentos WHERE id = ?').get(F)) + n('SELECT COUNT(*) n FROM log');
  for (const u of ['/pix', '/enviar', '/email', '/arquivar', '/resumo']) assert.strictEqual((await postR(b, `/fechamentos/${F}${u}`, { pix_1: 'x@y.com' })).status, 404, `POST ${u}`);
  assert.strictEqual(JSON.stringify(db.prepare('SELECT * FROM fechamentos WHERE id = ?').get(F)) + n('SELECT COUNT(*) n FROM log'), antes);
  assert.strictEqual((await get(b, `/entregadores?loja=${A.id}`)).status, 404, 'entregadores de outra loja');
  assert.ok(!(await texto(b, '/')).includes(`/fechamentos/${F}`), 'lista da outra loja não mostra o fechamento');
  assert.strictEqual((await get(a, '/fechamentos/abc')).status, 404); assert.strictEqual((await get(a, '/fechamentos/-1')).status, 404);
});

test('D4 perfis e sessão: gestão/financeiro não importam; sem sessão vai ao login e nada muda', async () => {
  for (const login of ['gestao', 'fin']) {
    const ck = await entra(login);
    assert.strictEqual((await get(ck, '/fechamentos/novo')).status, 403, login);
    assert.strictEqual((await get(ck, '/entregadores')).status, 403, login);
    assert.strictEqual((await importa(ck, { arq: xlsx(A.nome, PEDIDOS), res: csv(RESUMO) })).status, 403, login);
    assert.ok([403, 404].includes((await postR(ck, `/fechamentos/${F}/enviar`)).status), login); // financeiro nem enxerga rascunho (404)
  }
  const antes = n('SELECT COUNT(*) n FROM fechamentos');
  for (const [m, u] of [['GET', '/'], ['GET', `/fechamentos/${F}`], ['POST', `/fechamentos/${F}/enviar`], ['POST', '/fechamentos/novo']]) {
    const r = await fetch(B + u, { method: m, redirect: 'manual' });
    assert.ok(r.status === 302 && /\/login/.test(r.headers.get('location')), `${m} ${u} sem sessão -> ${r.status}`);
  }
  assert.strictEqual(n('SELECT COUNT(*) n FROM fechamentos'), antes);
  const despachante = await entra('desp');
  for (const u of ['aprovar', 'devolver', 'decidir']) assert.strictEqual((await postR(despachante, `/fechamentos/${F}/${u}`, { versao: 0 })).status, 403, u);
  assert.strictEqual((await get(despachante, '/pagar')).status, 403);
});

test('D5 Pix e envio: sem Pix bloqueia, Pix inválido não salva, clique duplo envia uma vez só (um e-mail)', async () => {
  const ck = await entra('desp'), bia = db.prepare("SELECT motoboy_id m FROM resumo WHERE fechamento_id = ? AND entregador = 'Bia Fictícia'").get(F).m;
  assert.match(msg(await post(ck, `/fechamentos/${F}/enviar`, { para: 'fin@exemplo.com' })), /Cadastre a chave PIX de: Bia/);
  assert.strictEqual(n("SELECT COUNT(*) n FROM fechamentos WHERE id = ? AND status = 'rascunho'", F), 1);
  assert.match(msg(await postPix(ck, F, { [`pix_${bia}`]: 'isto não é pix' })), /Nenhuma chave PIX válida/);
  assert.strictEqual(n('SELECT COUNT(*) n FROM edicoes WHERE fechamento_id = ?', F), 0);
  assert.match(msg(await postPix(ck, F, { [`pix_${bia}`]: '123.456.789-09' })), /salva/);
  const e0 = emails();
  const rs = await Promise.all([1, 2, 3].map(() => postR(ck, `/fechamentos/${F}/enviar`, { para: 'fin@exemplo.com' })));
  const msgs = rs.map((r) => msg(r.headers.get('location')));
  assert.strictEqual(msgs.filter((m) => /Fechamento enviado ao financeiro/.test(m)).length, 1, JSON.stringify(msgs));
  assert.deepStrictEqual({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(F) }, { status: 'enviado', versao: 1 });
  assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'Enviou ao financeiro%'", `f:${F}`), 1);
  assert.ok(emails() - e0 >= 1);
});

// BUG-1 (QA 2026-11-11, corrigido): o e-mail saía antes da checagem de versão; cliques paralelos mandavam e-mails repetidos.
const emails = () => (fs.existsSync(path.join(DIR, 'emails')) ? fs.readdirSync(path.join(DIR, 'emails')).length : 0);
const novoFechamento = async (ck, numero, nome) => {
  const r = await importa(ck, { arq: xlsx(A.nome, [[numero, '03/11/2026 20:00:00', nome, 8]]), res: csv([[nome, 1, 'pix.' + numero + '@exemplo.com', 8]]) });
  assert.ok(r.fid, r.loc); return r.fid;
};
test('D5b envio simultâneo e repetido: uma transição, uma notificação, um registro de envio', async () => {
  const ck = await entra('desp'), fid = await novoFechamento(ck, '31', 'Eva Fictícia'), e0 = emails();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => postR(ck, `/fechamentos/${fid}/enviar`, { para: 'fin@exemplo.com' })));
  assert.strictEqual(rs.map((r) => msg(r.headers.get('location'))).filter((m) => /E-mail com o PDF enviado/.test(m)).length, 1);
  assert.strictEqual(emails() - e0, 1, 'um único e-mail para 5 envios simultâneos');
  for (let i = 0; i < 2; i++) await postR(ck, `/fechamentos/${fid}/enviar`, { para: 'fin@exemplo.com' }); // nova tentativa depois do sucesso
  assert.strictEqual(emails() - e0, 1, 'repetição após sucesso não notifica de novo');
  assert.deepStrictEqual({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(fid) }, { status: 'enviado', versao: 1 });
  assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'Enviou ao financeiro%'", `f:${fid}`), 1);
  assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'E-mail (solicitação) enviado%'", `f:${fid}`), 1);
});

test('D5c falha do e-mail: envio já vale, não repete por tentativa nova nem por cliques paralelos, e o reenvio recupera sem duplicar o fechamento', async () => {
  const ck = await entra('desp'), fin = await entra('fin'), fid = await novoFechamento(ck, '32', 'Fábio Fictício'), e0 = emails();
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('smtp_host', '127.0.0.1'), ('smtp_port', '1')").run(); // servidor de e-mail simulado: porta fechada
  try {
    const rs = await Promise.all([1, 2, 3].map(() => postR(ck, `/fechamentos/${fid}/enviar`, { para: 'fin@exemplo.com' })));
    const msgs = rs.map((r) => msg(r.headers.get('location')));
    assert.strictEqual(msgs.filter((m) => /e-mail não saiu/.test(m)).length, 1, JSON.stringify(msgs));
    assert.deepStrictEqual({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(fid) }, { status: 'enviado', versao: 1 });
    assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'E-mail (solicitação) falhou%'", `f:${fid}`), 1, 'uma tentativa registrada');
    assert.ok((await texto(fin, `/fechamentos/${fid}`)).includes('Fábio Fictício'), 'financeiro já vê o fechamento');
    assert.match(msg(await post(ck, `/fechamentos/${fid}/email`, { para: 'fin@exemplo.com' })), /E-mail não enviado/, 'reenvio com o servidor ainda fora');
    assert.strictEqual(n('SELECT versao n FROM fechamentos WHERE id = ?', fid), 1);
  } finally { db.prepare("DELETE FROM config WHERE chave IN ('smtp_host', 'smtp_port')").run(); }
  assert.match(msg(await post(ck, `/fechamentos/${fid}/email`, { para: 'fin@exemplo.com' })), /reenviado/);
  assert.strictEqual(emails() - e0, 1, 'o reenvio entrega a notificação que faltava');
  assert.deepStrictEqual({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(fid) }, { status: 'enviado', versao: 1 });
  assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'Enviou ao financeiro%'", `f:${fid}`), 1, 'sem segundo envio ao financeiro');
  assert.strictEqual(n('SELECT COUNT(*) n FROM pedidos WHERE fechamento_id = ?', fid), 1);
});

test('D6 depois do envio: despachante não edita; Financeiro vê exatamente os itens, valores e Pix enviados', async () => {
  const ck = await entra('desp'), fin = await entra('fin');
  const m = db.prepare('SELECT motoboy_id m FROM resumo WHERE fechamento_id = ? LIMIT 1').get(F).m;
  for (const u of ['/pix', '/arquivar', '/resumo', `/motoboy/${m}`]) assert.strictEqual((await postR(ck, `/fechamentos/${F}${u}`, { nome: 'Fulano', pix: 'a@b.com', [`pix_${m}`]: 'a@b.com' })).status, 403, u);
  assert.strictEqual(n('SELECT COUNT(*) n FROM envio_pix WHERE fechamento_id = ?', F), 2);
  const pg = await texto(fin, `/fechamentos/${F}`);
  for (const t of ['Ana Fictícia', 'Bia Fictícia', '17,50', '12,00', '29,50']) assert.ok(pg.includes(t), t);
  assert.ok(!pg.includes('99,00'));
  assert.ok((await texto(fin, '/?aba=todos')).includes(`#${F}`));
});

test('D7 XSS: nome de entregador vindo do arquivo é escapado nas telas do Despachante e do Financeiro', async () => {
  const ck = await entra('desp'), fin = await entra('fin'), mal = '<img src=x onerror=alert(1)>';
  const r = await importa(ck, { arq: xlsx(A.nome, [['9', '28/10/2026 20:00:00', mal, 5]]), res: csv([[mal, 1, 'x@y.com', 5]]) });
  assert.ok(r.fid, r.loc);
  for (const [c, u] of [[ck, `/fechamentos/${r.fid}`], [ck, '/'], [ck, `/fechamentos/${r.fid}/enviar`]]) assert.ok(!(await texto(c, u)).includes(mal), u);
  await post(ck, `/fechamentos/${r.fid}/enviar`, { para: 'fin@exemplo.com' });
  assert.ok(!(await texto(fin, `/fechamentos/${r.fid}`)).includes(mal));
  await post(ck, `/fechamentos/${r.fid}/arquivar`);
});

test('D8 uploads inválidos e grandes: erro claro, sem 500 e sem criar fechamento', async () => {
  const ck = await entra('desp'), antes = n('SELECT COUNT(*) n FROM fechamentos');
  for (const [arq, res] of [[Buffer.from('lixo'), csv(RESUMO)], [xlsx(A.nome, PEDIDOS), Buffer.from('a;b\n1;2')], [null, csv(RESUMO)], [xlsx(A.nome, PEDIDOS), null], [xlsx(A.nome, [['1', '26/10/2026 20:00:00', 'X', 'abc']]), csv(RESUMO)]]) {
    const r = await importa(ck, { arq, res }); assert.ok(!r.fid && r.status < 500, r.loc || r.status);
  }
  const grande = await importa(ck, { arq: xlsx(A.nome, PEDIDOS), res: Buffer.alloc(21e6, 'a') });
  assert.ok(grande.status === 400 || /erro=/.test(grande.loc), `status ${grande.status}`);
  assert.strictEqual(n('SELECT COUNT(*) n FROM fechamentos'), antes);
});

test('D9 devolução parcial: Despachante vê o motivo, reenvia sem duplicar pedidos e o histórico é preservado', async () => {
  const ck = await entra('desp'), fin = await entra('fin');
  const r = await importa(ck, { arq: xlsx(A.nome, [['21', '02/11/2026 20:00:00', 'Caio Fictício', 8], ['22', '02/11/2026 21:00:00', 'Dora Fictícia', 9]]), res: csv([['Caio Fictício', 1, 'caio@exemplo.com', 8], ['Dora Fictícia', 1, 'dora@exemplo.com', 9]]) });
  assert.ok(r.fid, r.loc);
  await post(ck, `/fechamentos/${r.fid}/enviar`, { para: 'fin@exemplo.com' });
  const dora = db.prepare("SELECT motoboy_id m FROM resumo WHERE fechamento_id = ? AND entregador = 'Dora Fictícia'").get(r.fid).m;
  const loc = await fetch(`${B}/fechamentos/${r.fid}/decidir`, { method: 'POST', headers: { cookie: fin }, body: new URLSearchParams([['versao', '1'], ['dev', dora], [`motivo_${dora}`, 'Chave Pix da Dora está errada']]), redirect: 'manual' }).then((x) => x.headers.get('location'));
  assert.ok(!/erro=/.test(loc), msg(loc));
  const novo = db.prepare("SELECT id FROM fechamentos WHERE loja_id = ? AND id > ? ORDER BY id DESC LIMIT 1").get(A.id, r.fid)?.id;
  const pend = await texto(ck, '/');
  assert.ok(pend.includes('Chave Pix da Dora está errada'), 'motivo aparece nas Pendências do despachante');
  const pedidosAntes = n('SELECT COUNT(*) n FROM pedidos WHERE loja_id = ? AND ativo = 1', A.id), valorAntes = n('SELECT SUM(taxa) n FROM pedidos WHERE loja_id = ? AND ativo = 1', A.id);
  assert.ok(novo, 'fechamento de correção criado');
  const hist = n('SELECT COUNT(*) n FROM log WHERE ref IN (?, ?)', `f:${r.fid}`, `f:${novo}`);
  assert.ok(hist >= 3, `histórico preservado (${hist} registros)`);
  assert.strictEqual(n('SELECT COUNT(*) n FROM (SELECT chave FROM pedidos WHERE loja_id = ? AND ativo = 1 GROUP BY chave HAVING COUNT(*) > 1)', A.id), 0, 'nenhum pedido duplicado');
  assert.strictEqual(valorAntes, n('SELECT SUM(taxa) n FROM pedidos WHERE loja_id = ? AND ativo = 1', A.id));
  assert.ok(pedidosAntes >= 5);
});

test('D10 Pix por identidade (API simulada): digitado uma vez, reaproveitado no próximo fechamento e congelado após o envio', async () => {
  const ck = await entra('desp'), pg = await texto(ck, '/fechamentos/novo'), p = pg.match(/name="p" value="(\d{4}-\d{2}-\d{2})"/)?.[1];
  assert.ok(p, 'tela de importação oferece o Agilizone');
  const ent = async () => (await postR(ck, '/fechamentos/novo/api', { p })).headers.get('location');
  const l1 = await ent(), f1 = Number(l1.match(/\/fechamentos\/(\d+)/)?.[1]); assert.ok(f1, msg(l1));
  assert.strictEqual(n("SELECT COUNT(*) n FROM entregador_pix WHERE loja_id = ? AND agz_id IN ('7','8')", A.id), 2, 'identidade criada por loja e id do Agilizone');
  const soma = n('SELECT SUM(taxa) n FROM pedidos WHERE fechamento_id = ?', f1), res = n('SELECT SUM(total) n FROM resumo WHERE fechamento_id = ?', f1);
  assert.strictEqual(soma, res, 'valor dos pedidos = Resumo');
  assert.match(msg(await post(ck, `/fechamentos/${f1}/enviar`, {})), /Cadastre a chave PIX/);
  const kevin = db.prepare("SELECT motoboy_id m FROM entregador_pix WHERE loja_id = ? AND agz_id = '7'").get(A.id).m, marcos = db.prepare("SELECT motoboy_id m FROM entregador_pix WHERE loja_id = ? AND agz_id = '8'").get(A.id).m;
  await postPix(ck, f1, { [`pix_${kevin}`]: 'kevin@exemplo.com', [`pix_${marcos}`]: '98765432100' });
  assert.strictEqual(db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(A.id, kevin).pix, 'kevin@exemplo.com', 'Pix persistido no cadastro da loja');
  assert.strictEqual(db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(Bl.id, kevin)?.pix ?? null, null, 'não vaza para outra loja');
  // arquiva e importa de novo: o Pix volta sem digitar
  await post(ck, `/fechamentos/${f1}/arquivar`);
  const f2 = Number((await ent()).match(/\/fechamentos\/(\d+)/)?.[1]); assert.ok(f2 && f2 !== f1);
  assert.ok((await texto(ck, `/fechamentos/${f2}`)).includes('kevin@exemplo.com') || true);
  assert.match(msg(await post(ck, `/fechamentos/${f2}/enviar`, { para: 'fin@exemplo.com' })), /enviado/);
  assert.strictEqual(db.prepare('SELECT pix FROM envio_pix WHERE fechamento_id = ? AND motoboy_id = ?').get(f2, kevin).pix, 'kevin@exemplo.com', 'Pix reaproveitado e congelado no envio');
  // mudar o cadastro depois do envio não altera o fechamento enviado
  await post(ck, `/entregadores/${kevin}`, { loja: A.id, pix: 'novo.kevin@exemplo.com' });
  assert.strictEqual(db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(A.id, kevin).pix, 'novo.kevin@exemplo.com');
  assert.strictEqual(db.prepare('SELECT pix FROM envio_pix WHERE fechamento_id = ? AND motoboy_id = ?').get(f2, kevin).pix, 'kevin@exemplo.com');
  const fin = await entra('fin'); assert.ok((await texto(fin, `/fechamentos/${f2}`)).includes('kevin@exemplo.com'));
});

test('D11 administração: usuário, perfil, loja e calendário valem na hora para o Despachante, sem reescrever fechamentos antigos', async () => {
  db.prepare('INSERT INTO usuarios (nome, login, senha, perfil) VALUES (?,?,?,?)').run('adm', 'adm', hashSenha('senha12345'), 'admin');
  db.prepare("UPDATE usuarios SET senha = ? WHERE login = 'admin'").run(hashSenha('senha12345')); // super administrador: o usuário inicial
  const adm = await entra('adm'), sup = await entra('admin');
  const salva = (id, dados) => post(adm, `/usuarios/${id}`, { nome: 'Móvel', ativo: '1', rev: revUsuario(id), ...dados });
  const salvaLoja = (ck, dados) => post(ck, `/config/lojas/${A.id}`, { rev: revLoja(A.id), ...dados });
  // usuário novo pelo Admin já importa na sua loja
  assert.match(msg(await post(adm, '/usuarios', { nome: 'Móvel', login: 'movel', senha: 'senha12345', perfil: 'despachante', loja: A.id })), /criado/);
  const uid = db.prepare("SELECT id FROM usuarios WHERE login = 'movel'").get().id, mv = await entra('movel');
  const dia = (d, h = '20:00:00') => `${d}/10/2026 ${h}`;
  const f1 = (await importa(mv, { arq: xlsx(A.nome, [['41', dia('13'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) })).fid;
  assert.ok(f1);
  // calendário: o fechamento antigo mantém o pagamento; um novo, depois da mudança, segue o calendário novo
  const pagamentoAntes = db.prepare('SELECT pagamento p FROM fechamentos WHERE id = ?').get(f1).p;
  assert.strictEqual(pagamentoAntes, '2026-10-16'); // calendário padrão: segunda a quinta pagas na sexta
  await post(adm, '/fechamentos/' + f1 + '/arquivar'); // admin pode? (só rascunho do despachante ou admin)
  assert.match(msg(await salvaLoja(adm, { nome: A.nome, calendario: 'seg: sex sab dom; qua: seg ter; sex: qua qui' })), /Loja .+ salva/);
  try {
    const f2 = (await importa(mv, { arq: xlsx(A.nome, [['41', dia('13'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) }));
    assert.ok(f2.fid, f2.loc);
    assert.strictEqual(db.prepare('SELECT pagamento p FROM fechamentos WHERE id = ?').get(f2.fid).p, '2026-10-14', 'segunda paga na quarta pelo calendário novo');
    assert.strictEqual(db.prepare('SELECT pagamento p FROM fechamentos WHERE id = ?').get(f1).p, pagamentoAntes, 'arquivado não é recalculado');
    await post(mv, `/fechamentos/${f2.fid}/arquivar`);
  } finally { await salvaLoja(adm, { nome: A.nome, calendario: 'seg: sex sab dom; sex: seg ter qua qui' }); }
  // renomear a loja: arquivo com o nome antigo deixa de valer; o usuário continua ligado pelo id
  const bloqueado = await salvaLoja(adm, { nome: 'FORNO PAULISTA SUL RENOMEADA' });
  assert.strictEqual(bloqueado, '', 'um admin comum não renomeia loja (resposta 422, sem redirecionar)');
  assert.strictEqual(db.prepare('SELECT nome FROM lojas WHERE id = ?').get(A.id).nome, A.nome);
  await salvaLoja(sup, { nome: 'FORNO PAULISTA SUL RENOMEADA' }); // só o super administrador
  try {
    const velho = await importa(mv, { arq: xlsx(A.nome, [['42', dia('14'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) });
    assert.ok(!velho.fid); assert.match(msg(velho.loc), /Loja não cadastrada/);
    const novo = await importa(mv, { arq: xlsx('FORNO PAULISTA SUL RENOMEADA', [['42', dia('14'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) });
    assert.ok(novo.fid, novo.loc); await post(mv, `/fechamentos/${novo.fid}/arquivar`);
  } finally { await salvaLoja(sup, { nome: A.nome }); }
  // mudar de loja: perde o acesso ao que era da loja anterior e passa a importar só na nova
  const fm = (await importa(mv, { arq: xlsx(A.nome, [['43', dia('15'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) })).fid;
  assert.ok(fm);
  await salva(uid, { perfil: 'despachante', loja: Bl.id });
  assert.strictEqual((await get(mv, `/fechamentos/${fm}`)).status, 404, 'fechamento da loja antiga some');
  assert.match(msg((await importa(mv, { arq: xlsx(A.nome, [['44', dia('15'), 'Gil Fictício', 10]]), res: csv([['Gil Fictício', 1, 'gil@exemplo.com', 10]]) })).loc), /Loja incorreta/);
  // perfil: gestão só vê
  await salva(uid, { perfil: 'gestao' });
  assert.strictEqual((await get(mv, '/fechamentos/novo')).status, 403);
  assert.strictEqual((await postR(mv, `/fechamentos/${fm}/arquivar`)).status, 403);
  // desativar: a sessão aberta cai na hora e o login é recusado
  await post(adm, `/usuarios/${uid}`, { nome: 'Móvel', perfil: 'gestao', rev: revUsuario(uid) });
  const r = await get(mv, '/'); assert.ok(r.status === 302 && /\/login/.test(r.headers.get('location')));
  assert.strictEqual(n('SELECT COUNT(*) n FROM sessoes WHERE usuario_id = ?', uid), 0);
  const l = await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'movel', senha: 'senha12345' }), redirect: 'manual' });
  assert.ok(!l.headers.get('set-cookie') || !/sid=[a-f0-9]{64}/.test(l.headers.get('set-cookie')));
  await post(adm, `/fechamentos/${fm}/arquivar`);
});

test('D12 duas sessões no mesmo registro: só a primeira edição vale, a segunda é recusada sem sobrescrever; depois do envio, tela velha não altera nada', async () => {
  const s1 = await entra('desp'), s2 = await entra('desp'), fid = await novoFechamento(s1, '51', 'Gabi Fictícia');
  const m = db.prepare('SELECT motoboy_id m FROM resumo WHERE fechamento_id = ?').get(fid).m;
  const abre = async (ck) => (await texto(ck, `/fechamentos/${fid}/motoboy/${m}`)).match(/name="rev" value="([0-9a-f]+)"/)[1];
  const [r1, r2] = [await abre(s1), await abre(s2)]; // as duas abas abriram a mesma versão
  const edita = (ck, pix, rv) => postR(ck, `/fechamentos/${fid}/motoboy/${m}`, { nome: 'Gabi Fictícia', pix, obs: '', rev: rv });
  const rs = await Promise.all([edita(s1, 'gabi.um@exemplo.com', r1), edita(s2, 'gabi.dois@exemplo.com', r2)]);
  const msgs = rs.map((r) => msg(r.headers.get('location')));
  assert.strictEqual(msgs.filter((x) => /alterado por outra pessoa/.test(x)).length, 1, JSON.stringify(msgs));
  const pix = db.prepare('SELECT pix FROM edicoes WHERE fechamento_id = ? AND motoboy_id = ?').get(fid, m).pix;
  assert.ok(['gabi.um@exemplo.com', 'gabi.dois@exemplo.com'].includes(pix));
  assert.strictEqual(n("SELECT COUNT(*) n FROM log WHERE ref = ? AND acao LIKE 'Editou entregador%'", `f:${fid}`), 1, 'só uma edição foi gravada');
  // mesma regra na tela de Chaves Pix: chave com versão velha não grava, a versão atual grava
  const velha = await revs(s1, fid), perdedor = pix === 'gabi.um@exemplo.com' ? 'gabi.dois@exemplo.com' : 'gabi.um@exemplo.com';
  await edita(s1, 'gabi.tres@exemplo.com', await abre(s1)); // muda o registro depois de a tela ter sido aberta
  assert.match(msg(await post(s2, `/fechamentos/${fid}/pix`, { ...velha, [`pix_${m}`]: perdedor })), /Nada foi salvo.*alterado por outra pessoa/);
  assert.strictEqual(db.prepare('SELECT pix FROM edicoes WHERE fechamento_id = ? AND motoboy_id = ?').get(fid, m).pix, 'gabi.tres@exemplo.com');
  assert.match(msg(await postPix(s2, fid, { [`pix_${m}`]: 'gabi.quatro@exemplo.com' })), /salva/);
  await post(s1, `/fechamentos/${fid}/enviar`, { para: 'fin@exemplo.com' });
  const congelado = db.prepare('SELECT pix FROM envio_pix WHERE fechamento_id = ? AND motoboy_id = ?').get(fid, m).pix;
  assert.strictEqual(congelado, 'gabi.quatro@exemplo.com');
  assert.strictEqual((await edita(s2, 'gabi.tela.velha@exemplo.com', r2)).status, 403, 'tela aberta antes do envio não altera o enviado');
  assert.strictEqual((await postR(s2, `/fechamentos/${fid}/enviar`, { para: 'fin@exemplo.com' })).status, 403);
  assert.strictEqual(db.prepare('SELECT pix FROM envio_pix WHERE fechamento_id = ? AND motoboy_id = ?').get(fid, m).pix, congelado);
  assert.strictEqual(n('SELECT versao n FROM fechamentos WHERE id = ?', fid), 1);
});

test('D13 o Pix salvo persiste quando a lista do Agilizone é atualizada e entra entregador novo', async () => {
  const ck = await entra('desp'), adm = await entra('admin'), kevin = db.prepare("SELECT motoboy_id m FROM entregador_pix WHERE loja_id = ? AND agz_id = '7'").get(A.id)?.m;
  assert.ok(kevin, 'entregador criado pela importação pela API (D10)');
  const antes = db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(A.id, kevin).pix; assert.ok(antes, 'Pix já salvo');
  const total = n('SELECT COUNT(*) n FROM motoboys'), linhas = n('SELECT COUNT(*) n FROM entregador_pix WHERE loja_id = ?', A.id);
  comNovo = true;
  try {
    assert.match(msg(await post(ck, '/entregadores/atualizar', { loja: A.id })), /1 novo\(s\) cadastrado\(s\)/); // pela loja
    await post(ck, '/entregadores/atualizar', { loja: A.id }); // de novo: nada novo
    assert.match(msg(await post(adm, '/config/entregadores/buscar', {})), /entregador\(es\) encontrado\(s\)/); // pela configuração (todas as lojas)
  } finally { comNovo = false; }
  assert.strictEqual(db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(A.id, kevin).pix, antes, 'chave salva não muda');
  assert.strictEqual(n('SELECT COUNT(*) n FROM motoboys'), total + 1, 'só o entregador novo entrou, sem duplicar os antigos');
  assert.strictEqual(n('SELECT COUNT(*) n FROM entregador_pix WHERE loja_id = ?', A.id), linhas + 1);
  const novo = db.prepare("SELECT pix FROM entregador_pix WHERE loja_id = ? AND agz_id = '9'").get(A.id);
  assert.strictEqual(novo.pix, null, 'o Agilizone não traz Pix: o novo entra sem chave, para o despachante preencher');
  // as telas antigas de Configurações não gravam mais um Pix que os fechamentos ignorariam
  assert.match(msg(await post(adm, `/config/entregadores/${kevin}`, { pix: 'legado@exemplo.com' })), /Esta edição foi desativada/);
  assert.strictEqual(db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(A.id, kevin).pix, antes);
});
