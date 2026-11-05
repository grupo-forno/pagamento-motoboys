// Financeiro: acesso só a fechamentos enviados da sua loja e integridade das decisões (versão, duplicidade, reenvio).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fin-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const PORT = 3900 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, F1, F2;
const ids = {};

before(async () => {
  const loja = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%SUL'").get().id, outra = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%DIRCEU'").get().id;
  const user = (login, perfil, l) => db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l);
  ids.desp = Number(user('desp', 'despachante', loja).lastInsertRowid);
  user('fin', 'financeiro', null); user('fin2', 'financeiro', outra);
  for (const n of ['Ana', 'Bia', 'Caio']) ids[n] = Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(n).lastInsertRowid);
  const fech = (status, versao) => Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, criado_por, versao, enviado_em) VALUES (?, '2026-10-20', '2026-10-21', ?, ?, ?, '2026-10-22 09:00:00')").run(loja, status, ids.desp, versao).lastInsertRowid);
  F1 = fech('enviado', 1); F2 = fech('rascunho', 0);
  for (const f of [F1, F2]) {
    let k = 0;
    for (const [n, v] of [['Ana', 1000], ['Bia', 2000], ['Caio', 3000]]) {
      db.prepare("INSERT INTO pedidos (fechamento_id, loja_id, chave, dia, entregador, motoboy_id, taxa) VALUES (?,?,?,'2026-10-20',?,?,?)").run(f, loja, `${f}-${k++}`, n, ids[n], v);
      // Caio: Resumo diferente da soma dos dias, sem justificativa → bloqueado para aprovação.
      db.prepare('INSERT INTO resumo (fechamento_id, entregador, motoboy_id, total, pix) VALUES (?,?,?,?,?)').run(f, n, ids[n], n === 'Caio' ? 2500 : v, `${n.toLowerCase()}@pix.com`);
    }
  }
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0' } });
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Motoboys') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login) => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = async (ck, url) => fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' });
const post = async (ck, url, dados) => (await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '';
const aprovacoes = () => db.prepare('SELECT * FROM aprovacoes WHERE fechamento_id = ? ORDER BY motoboy_id').all(F1);
const status = () => ({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(F1) });

test('financeiro não acessa fechamento não enviado nem de outra loja', async () => {
  const fin = await entra('fin'), fin2 = await entra('fin2');
  for (const u of ['', '/pdf', '/csv']) assert.strictEqual((await get(fin, `/fechamentos/${F2}${u}`)).status, 404, `rascunho${u}`);
  assert.strictEqual((await get(fin2, `/fechamentos/${F1}`)).status, 404);
  const fila = await (await get(fin, '/?aba=todos')).text();
  assert.ok(fila.includes(`#${F1}`) && !fila.includes(`#${F2}<`));
  assert.strictEqual((await get(fin, `/fechamentos/${F1}`)).status, 200);
});

test('aprovação parcial: bloqueia divergência, grava valor/PIX/versão e recusa duplicada ou desatualizada', async () => {
  const fin = await entra('fin');
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 0, m: ids.Ana }), /erro=/);
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, m: ids.Caio }), /erro=/);
  assert.strictEqual(aprovacoes().length, 0);
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, uma: ids.Ana }), /ok=/);
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, uma: ids.Ana }), /erro=/);
  const [a] = aprovacoes();
  assert.deepStrictEqual([aprovacoes().length, a.valor, a.pix, a.versao], [1, 1000, 'ana@pix.com', 1]);
  assert.deepStrictEqual(status(), { status: 'enviado', versao: 1 });
});

test('decisões concorrentes sobre o mesmo entregador geram uma só aprovação', async () => {
  const fin = await entra('fin');
  const r = await Promise.all([1, 2, 3].map(() => post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, m: ids.Bia })));
  assert.strictEqual(r.filter((x) => x.includes('ok=')).length, 1);
  assert.strictEqual(aprovacoes().length, 2);
});

test('devolução exige motivo, preserva aprovações e o reenvio mantém as decisões', async () => {
  const fin = await entra('fin'), desp = await entra('desp');
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Caio, motivo: '' }), /erro=/);
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Ana, motivo: 'Valor errado' }), /erro=/); // já aprovado
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Caio, motivo: 'Confira o Resumo do Caio' }), /ok=|erro=/);
  assert.strictEqual(status().status, 'rascunho');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM devolucoes WHERE fechamento_id = ? AND motoboy_id = ? AND versao = 1').get(F1, ids.Caio).n, 1);
  assert.strictEqual(aprovacoes().length, 2);
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, m: ids.Caio }), /erro=/); // devolvido: nada a decidir
  assert.match(await post(desp, `/fechamentos/${F1}/enviar`, { para: 'financeiro@teste.com' }), /fechamentos/);
  assert.deepStrictEqual(status(), { status: 'enviado', versao: 2 });
  assert.strictEqual(aprovacoes().length, 2);
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, m: ids.Caio }), /erro=/); // tela da versão antiga
});
