// Importação direto da API do Agilizone (servidor de mentira) e credenciais por loja.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-api-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const { variaveis } = require('./agilizone');
const PORT = 3800 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, mock, loja, novoNoAgilizone = false, outroPeriodo = false;

before(async () => {
  // Agilizone de mentira: token só com as credenciais certas; pedidos dentro da janela pedida (from).
  mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/auth/token') {
      let b = ''; req.on('data', (d) => (b += d));
      return req.on('end', () => { const j = JSON.parse(b); if (j.clientId !== 'cid' || j.clientSecret !== 'segredo-api') { res.statusCode = 401; return res.end('{}'); } res.end(JSON.stringify({ access_token: 'tok', expires_in: 86400 })); });
    }
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
    const de = new Date(u.searchParams.get('from')).getTime();
    const o = (id, n, e, fee, h, status = 'COMPLETED') => ({ id: outroPeriodo ? id + de : id, orderDisplayNumber: n, status, deliveryman: e, deliverymanFee: fee, createdAt: new Date(de + h * 36e5).toISOString() });
    const data = [o('x1', '0001', { id: 7, name: 'Kevin' }, 7.5, 9), o('x2', '0002', { id: 7, name: 'Kevin' }, 10, 10), o('x3', '0001', { id: 8, name: 'Marcos' }, 6, 11), o('x4', '0003', { id: 8, name: 'Marcos' }, 9, 11, 'CANCELED'), o('x5', '0004', { id: 9, name: 'Bruna' }, 9, 12, 'CANCELED'), ...(novoNoAgilizone ? [o('x6', '0005', { id: 10, name: 'Novato' }, 9, 13)] : [])];
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  loja = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%SUL'").get().id;
  const user = (login, perfil, l) => db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l);
  user('desp', 'despachante', loja); user('adm', 'admin', null);
  // Credenciais só no ambiente do servidor (variáveis derivadas do nome da loja), nunca no banco.
  const v = variaveis(db.prepare('SELECT nome FROM lojas WHERE id = ?').get(loja));
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1', AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, [v.id]: 'cid', [v.secret]: 'segredo-api' } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); mock.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login) => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = async (ck, url) => (await fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' })).text();
const revs = async (ck, fid) => Object.fromEntries([...(await get(ck, `/fechamentos/${fid}`)).matchAll(/name="(rev_\d+)" value="([0-9a-f]+)"/g)].map((m) => [m[1], m[2]]));
const post = async (ck, url, dados) => (await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '';

test('credenciais: só no ambiente do servidor; a tela não tem campo nem valor, só o nome das variáveis, e a conexão é testada', async () => {
  const adm = await entra('adm');
  const tela = await get(adm, '/config?aba=lojas');
  assert.ok(!tela.includes('segredo-api') && !tela.includes('agz_client') && !tela.includes('name="cid"') && tela.includes('Testar conexão'));
  const outra = db.prepare('SELECT nome FROM lojas WHERE id <> ? ORDER BY id LIMIT 1').get(loja);
  assert.ok(tela.includes(variaveis(outra).id), 'loja sem credencial mostra qual variável definir');
  assert.match(await post(adm, `/config/lojas/${loja}/agilizone`, {}), /ok=/);
});

test('importa pelo Agilizone: pedidos, total por entregador, id ligado e PIX do cadastro; segunda vez é recusada', async () => {
  db.prepare("INSERT INTO motoboys (nome, pix) VALUES ('Kevin', 'kevin@pix.com')").run(); // homônimo legado: não pode herdar identidade nem Pix só pelo nome
  const desp = await entra('desp');
  const tela = await get(desp, '/fechamentos/novo');
  assert.ok(tela.includes('Importar direto do Agilizone') && tela.includes('Enviar arquivos (alternativa)'));
  const p = /name="p" value="([\d-]+)"/.exec(tela)[1];
  const loc = await post(desp, '/fechamentos/novo/api', { loja, p });
  const fid = Number((/^\/fechamentos\/(\d+)\?/.exec(loc) || [])[1]);
  assert.ok(fid, `redirect: ${loc}`);
  assert.deepStrictEqual(db.prepare('SELECT chave FROM pedidos WHERE fechamento_id = ? ORDER BY chave').all(fid).map((x) => x.chave), ['agz:x1', 'agz:x2', 'agz:x3']);
  assert.deepStrictEqual(db.prepare('SELECT entregador, pedidos, total FROM resumo WHERE fechamento_id = ? ORDER BY entregador').all(fid).map((x) => [x.entregador, x.pedidos, x.total]), [['Kevin', 2, 1750], ['Marcos', 1, 600]]);
  assert.deepStrictEqual(db.prepare('SELECT nome, agz_id FROM motoboys WHERE agz_id IS NOT NULL ORDER BY nome').all().map((x) => [x.nome, x.agz_id]), [['Kevin', 7], ['Marcos', 8]]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM motoboys WHERE nome = 'Kevin'").get().n, 2);
  const pag = await get(desp, `/fechamentos/${fid}`);
  assert.ok(!pag.includes('kevin@pix.com'), 'não herda PIX de homônimo sem id confirmado');
  const kevin = db.prepare('SELECT id FROM motoboys WHERE agz_id = 7').get().id;
  assert.match(await post(desp, `/fechamentos/${fid}/pix`, { ...(await revs(desp, fid)), ['pix_' + kevin]: 'kevin@pix.com' }), /ok=/);
  assert.ok((await get(desp, `/fechamentos/${fid}`)).includes('kevin@pix.com'));
  assert.match(await post(desp, '/fechamentos/novo/api', { loja, p }), /erro=/);
});

test('Entregadores: busca todos no Agilizone (cadastra quem falta, com o id), lista os sem PIX e o PIX salvo persiste', async () => {
  const adm = await entra('adm');
  assert.match(await post(adm, '/config/entregadores/buscar', {}), /ok=/);
  const b = db.prepare('SELECT id, nome, pix FROM motoboys WHERE agz_id = 9').get();
  assert.deepStrictEqual([b.nome, b.pix], ['Bruna', null]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM motoboys WHERE agz_id IN (7, 8)').get().n, 2, 'quem já existe não duplica');
  const sem = await get(await entra('desp'), '/entregadores?f=sem'); // o filtro "sem Pix" é da tela por loja
  assert.ok(sem.includes('Bruna') && sem.includes('Marcos'), 'filtro Sem PIX');
  assert.match(await post(adm, `/config/entregadores/${b.id}`, { pix: 'bruna@pix.com', cpf: '' }), /desativada/); // a edição em Configurações não grava mais
  assert.strictEqual(db.prepare('SELECT pix FROM motoboys WHERE id = ?').get(b.id).pix, null);
  const antes = db.prepare('SELECT COUNT(*) n FROM motoboys').get().n;
  await post(adm, '/config/entregadores/buscar', {}); // buscar de novo não duplica nem mexe no que já existe
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM motoboys').get().n, antes);
});

test('página de Entregadores da loja: lista, salva PIX com autoria, isola outras lojas e cadastra entregador novo do Agilizone', async () => {
  const desp = await entra('desp');
  const pag = await get(desp, '/entregadores');
  assert.ok(['Kevin', 'Marcos', 'Bruna'].every((n) => pag.includes(n)) && pag.includes('Atualizar do Agilizone'));
  const marcos = db.prepare("SELECT id FROM motoboys WHERE nome = 'Marcos'").get().id;
  assert.match(await post(desp, `/entregadores/${marcos}`, { pix: '5,587E+12' }), /erro=/);
  assert.match(await post(desp, `/entregadores/${marcos}`, { pix: 'marcos@pix.com' }), /ok=/);
  const m = db.prepare('SELECT pix, pix_por FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(loja, marcos);
  assert.deepStrictEqual([m.pix, m.pix_por > 0], ['marcos@pix.com', true]);
  assert.ok((await get(desp, '/entregadores')).includes('marcos@pix.com'), 'a chave persiste');
  const alheio = Number(db.prepare("INSERT INTO motoboys (nome) VALUES ('De Outra Loja')").run().lastInsertRowid);
  assert.strictEqual((await fetch(`${B}/entregadores/${alheio}`, { method: 'POST', headers: { cookie: desp }, body: new URLSearchParams({ pix: 'x@y.com' }), redirect: 'manual' })).status, 404);
  assert.ok(!(await get(desp, '/entregadores')).includes('De Outra Loja'));
  novoNoAgilizone = true; // entregador novo no Agilizone: entra sozinho ao atualizar
  assert.match(await post(desp, '/entregadores/atualizar', {}), /ok=/);
  assert.ok((await get(desp, '/entregadores')).includes('Novato'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM motoboys WHERE agz_id = 10').get().n, 1);
});

test('cadastro de Pix por loja: PIX inválido é recusado, loja alheia não altera e Configurações não grava', async () => {
  const adm = await entra('adm'), desp = await entra('desp');
  const id = db.prepare("SELECT id FROM motoboys WHERE nome = 'Marcos'").get().id;
  const envia = async (ck, pix) => (await fetch(`${B}/entregadores/${id}`, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams({ loja, pix }), redirect: 'manual' }));
  const pixAtual = () => db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(loja, id)?.pix ?? null;
  const antes = pixAtual();
  assert.match((await envia(desp, '5,587E+12')).headers.get('location'), /erro=/);
  assert.strictEqual(pixAtual(), antes, 'chave inválida não grava');
  assert.match((await envia(desp, '+5586995344508')).headers.get('location'), /ok=/);
  assert.strictEqual(pixAtual(), '+5586995344508');
  assert.match((await fetch(`${B}/config/entregadores/${id}`, { method: 'POST', headers: { cookie: adm }, body: new URLSearchParams({ pix: 'legado@pix.com' }), redirect: 'manual' })).headers.get('location'), /desativada/);
  assert.strictEqual(pixAtual(), '+5586995344508', 'Configurações não altera o Pix usado nos fechamentos');
  db.prepare('UPDATE entregador_pix SET pix = ? WHERE loja_id = ? AND motoboy_id = ?').run(antes, loja, id); // devolve o estado para os testes seguintes
});

test('Pix por loja: lote parcial, edição individual, nova importação, divergência e congelamento no envio', async () => {
  const desp = await entra('desp'), adm = await entra('adm');
  const f1 = db.prepare('SELECT * FROM fechamentos ORDER BY id LIMIT 1').get();
  const kevin = db.prepare('SELECT id FROM motoboys WHERE agz_id = 7').get().id;
  const marcos = db.prepare('SELECT id FROM motoboys WHERE agz_id = 8').get().id;
  const cadastrado = (id, l = loja) => db.prepare('SELECT pix FROM entregador_pix WHERE loja_id = ? AND motoboy_id = ?').get(l, id)?.pix;
  const parcial = await post(desp, `/fechamentos/${f1.id}/pix`, {...(await revs(desp, f1.id)), ['pix_' + kevin]: 'novo.kevin@exemplo.com', ['pix_' + marcos]: 'invalida'});
  assert.match(parcial, /ok=/);
  assert.strictEqual(new URL(parcial,B).hash,'#pix', 'salvar retorna à aba Pix com o aviso fora do fragmento');
  assert.strictEqual(cadastrado(kevin), 'novo.kevin@exemplo.com');
  assert.strictEqual(cadastrado(marcos), 'marcos@pix.com', 'uma chave inválida não perde o salvamento parcial nem altera cadastro');
  assert.ok((await get(desp, `/fechamentos/${f1.id}`)).includes('novo.kevin@exemplo.com'), 'recarregar mantém a edição');
  const cadastro = await get(desp, '/entregadores?q=Kevin');
  assert.ok(cadastro.includes('••••••.com') && cadastro.includes('Editar Pix'));
  const revKevin = (await get(desp, `/fechamentos/${f1.id}/motoboy/${kevin}`)).match(/name="rev" value="([0-9a-f]+)"/)[1]; // a tela de edição manda a versão que o usuário viu
  assert.match(await post(desp, `/fechamentos/${f1.id}/motoboy/${kevin}`, {nome:'Kevin', pix:'individual@exemplo.com', obs:'', rev: revKevin}), /ok=/);
  assert.strictEqual(cadastrado(kevin), 'individual@exemplo.com');

  // Um segundo período real da agenda; o mock usa ids de pedidos diferentes.
  outroPeriodo = true;
  const importar = await get(desp, '/fechamentos/novo');
  const p = /name="p" value="([\d-]+)"/.exec(importar)[1];
  const loc = await post(desp, '/fechamentos/novo/api', {loja, p});
  const f2 = Number((/^\/fechamentos\/(\d+)\?/.exec(loc) || [])[1]);
  assert.ok(f2 && f2 !== f1.id, loc);
  assert.ok((await get(desp, `/fechamentos/${f2}`)).includes('individual@exemplo.com'), 'importação sem Pix usa o cadastro da loja');
  db.prepare('UPDATE resumo SET pix = ? WHERE fechamento_id = ? AND motoboy_id = ?').run('agilizone@exemplo.com', f2, kevin);
  assert.ok((await get(desp, `/fechamentos/${f2}`)).includes('Divergência com o cadastro'));
  assert.match(await post(desp, `/fechamentos/${f2}/enviar`, {para:'financeiro@exemplo.com'}), /erro=/, 'divergência bloqueia até revisão explícita');
  assert.strictEqual(cadastrado(kevin), 'individual@exemplo.com');
  await post(desp, `/fechamentos/${f2}/pix`, {...(await revs(desp, f2)), ['pix_' + kevin]:'revisado@exemplo.com', ['pix_' + marcos]:'marcos@pix.com'});
  const novato = db.prepare('SELECT id FROM motoboys WHERE agz_id = 10').get().id;
  await post(desp, `/fechamentos/${f2}/pix`, {...(await revs(desp, f2)), ['pix_' + novato]:'novato@exemplo.com'});
  assert.match(await post(desp, `/fechamentos/${f2}/enviar`, {para:'financeiro@exemplo.com'}), /ok=/);
  assert.strictEqual(db.prepare('SELECT status FROM fechamentos WHERE id = ?').get(f2).status, 'enviado');
  const filtro = await post(desp, `/entregadores/${kevin}`, {pix:'futuro@exemplo.com', q:'Kev', f:'sem'});
  assert.match(filtro, /q=Kev/); assert.match(filtro, /f=sem/);
  assert.strictEqual(cadastrado(kevin), 'futuro@exemplo.com');
  assert.ok((await get(desp, `/fechamentos/${f2}`)).includes('revisado@exemplo.com'), 'enviado preserva chave anterior');
  assert.strictEqual(db.prepare('SELECT pix FROM envio_pix WHERE fechamento_id = ? AND motoboy_id = ?').get(f2, kevin).pix, 'revisado@exemplo.com');
  const outra = db.prepare('SELECT id FROM lojas WHERE id <> ? LIMIT 1').get(loja).id;
  db.prepare('INSERT INTO loja_motoboys VALUES (?,?)').run(outra, kevin);
  db.prepare('INSERT INTO entregador_pix (loja_id,motoboy_id,agz_id,pix) VALUES (?,?,?,?)').run(outra,kevin,'7','outra@exemplo.com');
  const acesso = await fetch(`${B}/entregadores/${kevin}`, {method:'POST',headers:{cookie:desp},body:new URLSearchParams({loja:outra,pix:'invasao@exemplo.com'}),redirect:'manual'});
  assert.strictEqual(acesso.status,404);
  assert.strictEqual((await fetch(`${B}/entregadores?loja=${outra}`, {headers:{cookie:desp},redirect:'manual'})).status,404);
  await post(adm, `/entregadores/${kevin}`, {loja:outra,pix:'outra.editada@exemplo.com'});
  assert.strictEqual(cadastrado(kevin), 'futuro@exemplo.com');
  assert.strictEqual(cadastrado(kevin,outra), 'outra.editada@exemplo.com');
  const pendente = Number(db.prepare("INSERT INTO motoboys (nome) VALUES ('Kevin')").run().lastInsertRowid);
  db.prepare('INSERT INTO loja_motoboys VALUES (?,?)').run(loja,pendente);
  assert.match(await post(desp, `/entregadores/${pendente}`, {pix:'sem.id@exemplo.com'}), /erro=/);
  assert.strictEqual(cadastrado(pendente),undefined);
});
