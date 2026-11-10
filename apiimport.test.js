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
let srv, mock, loja;

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
    const o = (id, n, e, fee, h, status = 'COMPLETED') => ({ id, orderDisplayNumber: n, status, deliveryman: e, deliverymanFee: fee, createdAt: new Date(de + h * 36e5).toISOString() });
    const data = [o('x1', '0001', { id: 7, name: 'Kevin' }, 7.5, 9), o('x2', '0002', { id: 7, name: 'Kevin' }, 10, 10), o('x3', '0001', { id: 8, name: 'Marcos' }, 6, 11), o('x4', '0003', { id: 8, name: 'Marcos' }, 9, 11, 'CANCELED'), o('x5', '0004', { id: 9, name: 'Bruna' }, 9, 12, 'CANCELED')];
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  loja = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%SUL'").get().id;
  const user = (login, perfil, l) => db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l);
  user('desp', 'despachante', loja); user('adm', 'admin', null);
  // Credenciais só no ambiente do servidor (variáveis derivadas do nome da loja), nunca no banco.
  const v = variaveis(db.prepare('SELECT nome FROM lojas WHERE id = ?').get(loja));
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', EMAIL_SO_ARQUIVO: '1', AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, [v.id]: 'cid', [v.secret]: 'segredo-api' } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); mock.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login) => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = async (ck, url) => (await fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' })).text();
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
  db.prepare("INSERT INTO motoboys (nome, pix) VALUES ('Kevin', 'kevin@pix.com')").run(); // já cadastrado por nome: ganha o id do Agilizone
  const desp = await entra('desp');
  const tela = await get(desp, '/fechamentos/novo');
  assert.ok(tela.includes('Importar direto do Agilizone') && tela.includes('Importar por arquivo (alternativa)'));
  const p = /name="p" value="([\d-]+)"/.exec(tela)[1];
  const loc = await post(desp, '/fechamentos/novo/api', { loja, p });
  const fid = Number((/^\/fechamentos\/(\d+)\?/.exec(loc) || [])[1]);
  assert.ok(fid, `redirect: ${loc}`);
  assert.deepStrictEqual(db.prepare('SELECT chave FROM pedidos WHERE fechamento_id = ? ORDER BY chave').all(fid).map((x) => x.chave), ['agz:x1', 'agz:x2', 'agz:x3']);
  assert.deepStrictEqual(db.prepare('SELECT entregador, pedidos, total FROM resumo WHERE fechamento_id = ? ORDER BY entregador').all(fid).map((x) => [x.entregador, x.pedidos, x.total]), [['Kevin', 2, 1750], ['Marcos', 1, 600]]);
  assert.deepStrictEqual(db.prepare('SELECT nome, agz_id FROM motoboys WHERE agz_id IS NOT NULL ORDER BY nome').all().map((x) => [x.nome, x.agz_id]), [['Kevin', 7], ['Marcos', 8]]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM motoboys WHERE nome = 'Kevin'").get().n, 1);
  const pag = await get(desp, `/fechamentos/${fid}`);
  assert.ok(pag.includes('kevin@pix.com'), 'PIX vem do cadastro');
  assert.match(await post(desp, '/fechamentos/novo/api', { loja, p }), /erro=/);
});

test('Entregadores: busca todos no Agilizone (cadastra quem falta, com o id), lista os sem PIX e o PIX salvo persiste', async () => {
  const adm = await entra('adm');
  assert.match(await post(adm, '/config/entregadores/buscar', {}), /ok=/);
  const b = db.prepare('SELECT id, nome, pix FROM motoboys WHERE agz_id = 9').get();
  assert.deepStrictEqual([b.nome, b.pix], ['Bruna', null]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM motoboys WHERE agz_id IN (7, 8)').get().n, 2, 'quem já existe não duplica');
  const sem = await get(adm, '/config?aba=entregadores&f=sem');
  assert.ok(sem.includes('Bruna') && !sem.includes('Kevin'), 'filtro Sem PIX');
  assert.match(await post(adm, `/config/entregadores/${b.id}`, { pix: 'bruna@pix.com', cpf: '', f: 'sem' }), /f=sem/);
  await post(adm, '/config/entregadores/buscar', {}); // buscar de novo não mexe no PIX salvo
  assert.strictEqual(db.prepare('SELECT pix FROM motoboys WHERE id = ?').get(b.id).pix, 'bruna@pix.com');
});

test('cadastro de entregadores: só o admin altera; PIX inválido é recusado', async () => {
  const adm = await entra('adm'), desp = await entra('desp');
  const id = db.prepare("SELECT id FROM motoboys WHERE nome = 'Marcos'").get().id;
  const envia = async (ck, pix) => (await fetch(`${B}/config/entregadores/${id}`, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams({ pix, cpf: '' }), redirect: 'manual' }));
  assert.strictEqual((await envia(adm, '5,587E+12')).status, 400);
  assert.match((await envia(adm, '+5586995344508')).headers.get('location'), /ok=/);
  assert.strictEqual(db.prepare('SELECT pix FROM motoboys WHERE id = ?').get(id).pix, '+5586995344508');
  assert.ok([403, 404].includes((await envia(desp, 'outro@pix.com')).status));
  assert.strictEqual(db.prepare('SELECT pix FROM motoboys WHERE id = ?').get(id).pix, '+5586995344508');
});
