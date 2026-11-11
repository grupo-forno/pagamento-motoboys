// Regressões do redesign do Admin: Usuários, Configurações, rótulos de Fechamentos e isolamento visual dos outros perfis.
// Banco isolado, dados fictícios, e-mail com falha simulada por SMTP em porta fechada.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-admin-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const PORT = 4500 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, A, L2;

before(async () => {
  A = db.prepare("SELECT id, nome FROM lojas WHERE nome LIKE '%SUL'").get(); L2 = db.prepare("SELECT id, nome FROM lojas WHERE nome LIKE '%DIRCEU'").get();
  const user = (login, perfil, l) => Number(db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l).lastInsertRowid);
  db.prepare("UPDATE usuarios SET senha = ? WHERE login = 'admin'").run(hashSenha('senha12345')); // super administrador: o usuário inicial
  user('adm', 'admin', null); user('desp', 'despachante', A.id); user('fin', 'financeiro', null); user('gestao', 'gestao', null);
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1' } });
  srv.stderr.on('data', () => {});
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login, senha = 'senha12345') => { const r = await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha }), redirect: 'manual' }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
const get = (ck, url) => fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' });
const postR = (ck, url, dados = {}) => fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' });
const campo = (html, nome) => new RegExp(`name="${nome}"[^>]*value="([^"]*)"`).exec(html)?.[1];
const n = (sql, ...p) => db.prepare(sql).get(...p).n;
const crypto = require('node:crypto'), { PADRAO } = require('./agenda');
const rev = (...c) => crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 12);
const revUsuario = (id) => { const u = db.prepare('SELECT nome, perfil, loja_id, ativo FROM usuarios WHERE id = ?').get(id); return rev(u.nome, u.perfil, u.loja_id, u.ativo); };
const revLoja = (id) => { const l = db.prepare('SELECT nome, calendario FROM lojas WHERE id = ?').get(id); return rev(l.nome, l.calendario || PADRAO); };

test('U1 usuário novo: erros por campo, valores preservados (sem a senha) e nada gravado', async () => {
  const adm = await entra('adm'), antes = n('SELECT COUNT(*) n FROM usuarios');
  const r = await postR(adm, '/usuarios', { login: 'DESP', nome: '', perfil: 'despachante', loja: '', senha: 'curta' });
  const h = await r.text();
  assert.strictEqual(r.status, 422);
  for (const t of ['Já existe um usuário com este login.', 'Informe o nome.', 'O despachante precisa de uma loja.', 'A senha precisa ter 8 caracteres ou mais.']) assert.ok(h.includes(t), t);
  assert.ok(h.includes('data-abrir'), 'painel reabre');
  assert.strictEqual(n('SELECT COUNT(*) n FROM usuarios'), antes);
  assert.ok(!h.includes('value="curta"'), 'senha não volta para a tela');
  const ok = await postR(adm, '/usuarios', { login: 'Novo.Fin', nome: 'Novo Fin', perfil: 'financeiro', loja: '', senha: 'senha12345' });
  assert.strictEqual(ok.status, 302);
  const u = db.prepare("SELECT login, perfil, loja_id FROM usuarios WHERE login = 'novo.fin'").get();
  assert.deepStrictEqual({ ...u }, { login: 'novo.fin', perfil: 'financeiro', loja_id: null }, 'financeiro sem loja = todas as lojas; login em minúsculas');
});

test('U2 edição: login imutável, senha vazia mantém a atual, perfil sem loja zera a loja, troca de senha desconecta', async () => {
  // usuário próprio: o teste troca a senha e não pode afetar os outros testes
  const adm = await entra('adm'), id = Number(db.prepare("INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES ('Alvo', 'alvo', ?, 'despachante', ?)").run(hashSenha('senha12345'), A.id).lastInsertRowid);
  const hash = db.prepare('SELECT senha FROM usuarios WHERE id = ?').get(id).senha, sessao = await entra('alvo');
  assert.strictEqual((await postR(adm, `/usuarios/${id}`, { login: 'outro', nome: 'Desp Renomeado', perfil: 'despachante', loja: A.id, senha: '', ativo: '1', rev: revUsuario(id) })).status, 302);
  const u = db.prepare('SELECT login, nome, senha FROM usuarios WHERE id = ?').get(id);
  assert.deepStrictEqual([u.login, u.nome, u.senha], ['alvo', 'Desp Renomeado', hash], 'login não muda; senha vazia mantém');
  assert.strictEqual((await get(sessao, '/')).status, 200, 'sessão continua depois de salvar sem senha');
  assert.strictEqual((await postR(adm, `/usuarios/${id}`, { nome: 'Desp Renomeado', perfil: 'gestao', loja: A.id, ativo: '1', rev: revUsuario(id) })).status, 302);
  assert.strictEqual(db.prepare('SELECT loja_id FROM usuarios WHERE id = ?').get(id).loja_id, null, 'gestão não guarda loja');
  await postR(adm, `/usuarios/${id}`, { nome: 'Desp Renomeado', perfil: 'despachante', loja: A.id, senha: 'novasenha123', ativo: '1', rev: revUsuario(id) });
  assert.strictEqual((await get(sessao, '/')).status, 302, 'trocar a senha derruba a sessão aberta');
  const r = await postR(adm, `/usuarios/${id}`, { nome: 'X', perfil: 'despachante', loja: '', senha: 'abc', ativo: '1', rev: revUsuario(id) });
  assert.strictEqual(r.status, 422); const h = await r.text();
  assert.ok(h.includes('O despachante precisa de uma loja.') && h.includes('A senha precisa ter 8 caracteres ou mais.'));
  assert.strictEqual(db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(id).nome, 'Desp Renomeado', 'edição inválida não grava nada');
});

test('U3 o Admin não remove o próprio acesso', async () => {
  const adm = await entra('adm'), id = db.prepare("SELECT id FROM usuarios WHERE login = 'adm'").get().id;
  for (const dados of [{ nome: 'adm', perfil: 'admin', ativo: '' }, { nome: 'adm', perfil: 'gestao', ativo: '1' }]) {
    const r = await postR(adm, `/usuarios/${id}`, { ...dados, rev: revUsuario(id) });
    assert.strictEqual(r.status, 422); assert.ok((await r.text()).includes('Você não pode remover seu próprio acesso de admin.'));
  }
  assert.deepStrictEqual({ ...db.prepare('SELECT perfil, ativo FROM usuarios WHERE id = ?').get(id) }, { perfil: 'admin', ativo: 1 });
});

test('C1 Configurações: e-mail e porta inválidos voltam com erro junto ao campo e sem gravar; teste de envio registra o resultado real', async () => {
  const adm = await entra('adm');
  const r = await postR(adm, '/config', { email_para: 'ok@exemplo.com, ruim', smtp_port: 'abc', smtp_host: 'smtp.exemplo.com' });
  const h = await r.text();
  assert.strictEqual(r.status, 422);
  assert.ok(h.includes('E-mail inválido: ruim') && h.includes('Porta inválida'));
  assert.ok(h.includes('ok@exemplo.com, ruim') && h.includes('value="abc"'), 'valores digitados voltam');
  assert.strictEqual(n("SELECT COUNT(*) n FROM config WHERE chave = 'smtp_host'"), 0);
  assert.strictEqual((await postR(adm, '/config/teste', { para: 'sem-arroba' })).status, 422);
  // SMTP simulado: porta fechada
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('smtp_host', '127.0.0.1'), ('smtp_port', '1')").run();
  try {
    const t = await postR(adm, '/config/teste', { para: 'quem@exemplo.com' });
    assert.match(decodeURIComponent(t.headers.get('location')), /recusou/);
    assert.match(db.prepare("SELECT acao FROM log WHERE ref = 'config' AND acao LIKE 'Teste de e-mail%' ORDER BY id DESC").get().acao, /recusado pelo servidor/);
    const pg = await (await get(adm, '/config?aba=email')).text();
    assert.ok(pg.includes('Último teste de envio') && pg.includes('Não enviado'));
  } finally { db.prepare("DELETE FROM config WHERE chave IN ('smtp_host', 'smtp_port')").run(); }
});

test('C2 Lojas: nome duplicado e calendário inválido não gravam; renomear preserva fechamentos e usuários', async () => {
  const adm = await entra('adm'), cal = db.prepare('SELECT calendario FROM lojas WHERE id = ?').get(A.id).calendario;
  let r = await postR(await entra('admin'), `/config/lojas/${A.id}`, { nome: L2.nome, calendario: 'seg: sex', rev: revLoja(A.id) }); // super administrador: o nome duplicado é o que barra
  assert.strictEqual(r.status, 422); assert.ok((await r.text()).includes('Já existe uma loja com esse nome.'));
  r = await postR(adm, `/config/lojas/${A.id}`, { nome: A.nome, calendario: 'seg: sex; ter: sex', rev: revLoja(A.id) });
  const h = await r.text(); assert.strictEqual(r.status, 422);
  assert.ok(h.includes('Um mesmo dia de referência aparece em dois pagamentos') && h.includes('data-abrir') && h.includes('value="seg: sex; ter: sex"'));
  assert.strictEqual(db.prepare('SELECT calendario FROM lojas WHERE id = ?').get(A.id).calendario, cal);
  const f = Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim) VALUES (?, '2026-10-26', '2026-10-27')").run(A.id).lastInsertRowid);
  const desp = db.prepare("SELECT id FROM usuarios WHERE login = 'desp'").get().id;
  assert.strictEqual((await postR(await entra('admin'), `/config/lojas/${A.id}`, { nome: 'LOJA RENOMEADA', calendario: 'seg: sex sab dom; sex: seg ter qua qui', rev: revLoja(A.id) })).status, 302, 'o super administrador renomeia');
  assert.deepStrictEqual([db.prepare('SELECT loja_id FROM fechamentos WHERE id = ?').get(f).loja_id, db.prepare('SELECT loja_id FROM usuarios WHERE id = ?').get(desp).loja_id], [A.id, A.id]);
  await postR(await entra('admin'), `/config/lojas/${A.id}`, { nome: A.nome, rev: revLoja(A.id) });
});

test('F1 Fechamentos do Admin: rótulos de período e pagamento, escopo dos indicadores, "Aprovados" e "Pagos" separados; outros perfis sem o que é só do Admin', async () => {
  db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim) VALUES (?, '2026-10-12', '2026-10-13')").run(A.id); // a tabela só aparece com fechamentos
  const adm = await (await get(await entra('adm'), '/')).text();
  assert.match(adm, /<body class="[^"]*admin operacional/);
  for (const t of ['Pagamento previsto', 'Período das entregas', 'Aprovados, sem pagamento registrado', 'Pagos (registrados)', 'Indicadores de todas as lojas e períodos', 'id="agenda-rec"']) assert.ok(adm.includes(t), t);
  assert.match(await (await get(await entra('gestao'), '/')).text(), /<body class="[^"]*admin operacional/);
  const desp = await (await get(await entra('desp'), '/')).text(), fin = await (await get(await entra('fin'), '/')).text();
  assert.match(desp, /<body class="[^"]*despachante operacional/); assert.match(fin, /<body class="[^"]*financeiro operacional/);
  for (const h of [desp, fin]) assert.ok(!h.includes('agenda-rec') && !h.includes('Indicadores de todas as lojas'), 'sem elementos do Admin');
  assert.match(await (await get(await entra('adm'), '/pagar')).text(), /<body class="[^"]*financeiro operacional/, 'Pagamentos segue o Financeiro');
});

test('P1 acesso: perfis sem permissão não abrem Usuários nem Configurações', async () => {
  for (const login of ['desp', 'fin', 'gestao']) { const ck = await entra(login); for (const u of ['/usuarios', '/config', '/config?aba=lojas']) assert.strictEqual((await get(ck, u)).status, 403, `${login} ${u}`); assert.strictEqual((await postR(ck, '/usuarios', { login: 'x', nome: 'x', perfil: 'admin', senha: 'senha12345' })).status, 403); }
});

test('L1 renomear loja: só o super administrador (login admin); o painel avisa e bloqueia o campo para os demais', async () => {
  db.prepare("INSERT INTO usuarios (nome, login, senha, perfil) VALUES ('Outro Admin', 'admin2', ?, 'admin')").run(hashSenha('senha12345'));
  const comum = await entra('admin2'), sup = await entra('admin');
  const painel = await (await get(comum, '/config?aba=lojas')).text();
  assert.ok(painel.includes('NÃO RENOMEIE A LOJA'));
  assert.ok(/name="nome"[^>]*readonly/.test(painel), 'campo bloqueado para o admin comum');
  assert.ok(!/name="nome"[^>]*readonly/.test(await (await get(sup, '/config?aba=lojas')).text()), 'o super administrador edita o nome');
  const r = await postR(comum, `/config/lojas/${A.id}`, { nome: 'NOME NOVO', calendario: PADRAO, rev: revLoja(A.id) });
  assert.strictEqual(r.status, 422); assert.ok((await r.text()).includes('Só o super administrador'));
  assert.strictEqual(db.prepare('SELECT nome FROM lojas WHERE id = ?').get(A.id).nome, A.nome);
  assert.strictEqual((await postR(sup, `/config/lojas/${A.id}`, { nome: 'NOME NOVO', calendario: PADRAO, rev: revLoja(A.id) })).status, 302);
  assert.strictEqual(db.prepare('SELECT nome FROM lojas WHERE id = ?').get(A.id).nome, 'NOME NOVO');
  await postR(sup, `/config/lojas/${A.id}`, { nome: A.nome, calendario: PADRAO, rev: revLoja(A.id) });
});

test('E1 edição simultânea: salvar com a versão antiga de usuário ou loja é recusado e nada muda', async () => {
  const adm = await entra('adm'), id = db.prepare("SELECT id FROM usuarios WHERE login = 'fin'").get().id;
  const velha = revUsuario(id);
  assert.strictEqual((await postR(adm, `/usuarios/${id}`, { nome: 'Fin Editado', perfil: 'financeiro', loja: '', ativo: '1', rev: velha })).status, 302);
  const r = await postR(adm, `/usuarios/${id}`, { nome: 'Fin Outro', perfil: 'financeiro', loja: '', ativo: '1', rev: velha });
  assert.match(decodeURIComponent(r.headers.get('location')), /alterado por outra pessoa/);
  assert.strictEqual(db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(id).nome, 'Fin Editado');
  const lv = revLoja(A.id), outro = 'seg: sex sab dom; qua: seg ter; sex: qua qui';
  assert.strictEqual((await postR(adm, `/config/lojas/${A.id}`, { nome: A.nome, calendario: outro, rev: lv })).status, 302);
  const x = await postR(adm, `/config/lojas/${A.id}`, { nome: A.nome, calendario: PADRAO, rev: lv });
  assert.match(decodeURIComponent(x.headers.get('location')), /alterado por outra pessoa/);
  assert.strictEqual(db.prepare('SELECT calendario FROM lojas WHERE id = ?').get(A.id).calendario, outro, 'a edição velha não desfez a nova');
  await postR(adm, `/config/lojas/${A.id}`, { nome: A.nome, calendario: PADRAO, rev: revLoja(A.id) });
});

test('A1 Aprovado e Pago são filtros separados; registrar pagamento é opcional', async () => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const f = (pago) => Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, versao, enviado_em, pagamento, pago_em) VALUES (?, ?, ?, 'pago', 1, ?, ?, ?)").run(A.id, hoje, hoje, hoje + ' 09:00:00', hoje, pago ? hoje + ' 10:00:00' : null).lastInsertRowid);
  const aprovado = f(false), pago = f(true), adm = await entra('adm');
  const lista = async (st) => await (await get(adm, '/?s=' + st)).text();
  const [a, p] = [await lista('aprovado'), await lista('pago')];
  assert.ok(a.includes(`/fechamentos/${aprovado}`) && !a.includes(`/fechamentos/${pago}`), 'Aprovados: só o sem pagamento registrado');
  assert.ok(p.includes(`/fechamentos/${pago}`) && !p.includes(`/fechamentos/${aprovado}`), 'Pagos: só o com transferência registrada');
  assert.ok(a.includes('Aprovados, sem pagamento registrado') && a.includes('Pagos (registrados)'));
});

test('G1 Configurações › Entregadores não edita nem importa Pix; aponta para Entregadores', async () => {
  const adm = await entra('adm'), h = await (await get(adm, '/config?aba=entregadores')).text();
  assert.ok(h.includes('Abrir Entregadores') && h.includes('nunca apaga nem troca'));
  assert.ok(!h.includes('name="cpf"') && !h.includes('/config/entregadores/importar'));
  assert.match(decodeURIComponent((await postR(adm, '/config/entregadores/1', { pix: 'x@y.com' })).headers.get('location')), /desativada/);
});
