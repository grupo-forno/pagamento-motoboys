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
      // Bia: Resumo diferente da soma dos dias (só aviso, não trava). Caio: sem chave PIX (trava a aprovação).
      db.prepare('INSERT INTO resumo (fechamento_id, entregador, motoboy_id, total, pix) VALUES (?,?,?,?,?)').run(f, n, ids[n], n === 'Bia' ? 1900 : v, n === 'Caio' ? null : `${n.toLowerCase()}@pix.com`);
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
  for (const u of ['', '/pdf', '/xlsx']) assert.strictEqual((await get(fin, `/fechamentos/${F2}${u}`)).status, 404, `rascunho${u}`);
  assert.strictEqual((await get(fin2, `/fechamentos/${F1}`)).status, 404);
  const fila = await (await get(fin, '/?aba=todos')).text();
  assert.ok(fila.includes(`#${F1}`) && !fila.includes(`#${F2}<`));
  assert.strictEqual((await get(fin, `/fechamentos/${F1}`)).status, 200);
});

test('conferência: tabela, lista e detalhe leem os mesmos dados (JSON) e o rodapé bate com o total', async () => {
  const fin = await entra('fin');
  const pag = await (await get(fin, `/fechamentos/${F1}`)).text();
  const m = pag.match(/<script type="application\/json" id="fc-dados">([\s\S]*?)<\/script>/);
  assert.ok(m, 'dados embutidos');
  const d = JSON.parse(m[1]);
  assert.strictEqual(d.itens.length, 3);
  assert.strictEqual(d.itens.reduce((t, i) => t + i.bruto + i.oc - i.pago, 0), d.itens.reduce((t, i) => t + i.total, 0));
  for (const id of ['fc-resumo', 'fc-dia', 'dlg-det', 'fc-q']) assert.ok(pag.includes(`id="${id}"`), id);
  const dp = await (await get(await entra('desp'), `/fechamentos/${F1}`)).text();
  assert.ok(dp.includes('id="fc-dados"') && /"decide":false/.test(dp) && !dp.includes('data-linha=') && !dp.includes('data-dec='), 'despachante vê a mesma tabela, sem aprovar nem devolver');
});

test('aprovação parcial: bloqueia item sem PIX, grava valor/PIX/versão e recusa duplicada ou desatualizada', async () => {
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

test('devolução de fechamento aprovado em parte: aprovados ficam no original, o resto vira novo fechamento', async () => {
  const fin = await entra('fin'), desp = await entra('desp');
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Caio, motivo: '' }), /erro=/);
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Ana, motivo: 'Valor errado' }), /erro=/); // já aprovado
  assert.match(await post(fin, `/fechamentos/${F1}/devolver`, { versao: 1, m: ids.Caio, motivo: 'Confira o Resumo do Caio' }), /ok=|erro=/);
  // Original: só Ana e Bia (aprovados), fechado como aprovado.
  assert.deepStrictEqual(status(), { status: 'pago', versao: 1 });
  assert.strictEqual(aprovacoes().length, 2);
  assert.deepStrictEqual(db.prepare('SELECT DISTINCT motoboy_id m FROM pedidos WHERE fechamento_id = ? ORDER BY 1').all(F1).map((x) => x.m), [ids.Ana, ids.Bia]);
  // Restante: só Caio, devolvido à loja, com pedidos, Resumo e o registro da devolução.
  const F3 = db.prepare('SELECT id FROM fechamentos WHERE origem_id = ?').get(F1).id;
  const st3 = () => ({ ...db.prepare('SELECT status, versao FROM fechamentos WHERE id = ?').get(F3) });
  assert.deepStrictEqual(st3(), { status: 'rascunho', versao: 1 });
  assert.deepStrictEqual(db.prepare('SELECT DISTINCT motoboy_id m FROM pedidos WHERE fechamento_id = ?').all(F3).map((x) => x.m), [ids.Caio]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM resumo WHERE fechamento_id = ?').get(F3).n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM devolucoes WHERE fechamento_id = ? AND motoboy_id = ?').get(F3, ids.Caio).n, 1);
  assert.strictEqual((await get(fin, `/fechamentos/${F3}`)).status, 200); // já foi enviado: o financeiro vê
  assert.match(await post(fin, `/fechamentos/${F1}/aprovar`, { versao: 1, m: ids.Caio }), /erro=/); // original fechado
  // A loja reenvia só o restante (depois de informar o PIX do Caio).
  db.prepare("INSERT INTO edicoes (fechamento_id, motoboy_id, pix) VALUES (?, ?, 'caio@pix.com')").run(F3, ids.Caio);
  assert.match(await post(desp, `/fechamentos/${F3}/enviar`, { para: 'financeiro@teste.com' }), /fechamentos/);
  assert.deepStrictEqual(st3(), { status: 'enviado', versao: 2 });
  assert.match(await post(fin, `/fechamentos/${F3}/aprovar`, { versao: 1, m: ids.Caio }), /erro=/); // tela da versão antiga
  assert.match(await post(fin, `/fechamentos/${F3}/aprovar`, { versao: 2, m: ids.Caio }), /ok=/);
  assert.strictEqual(st3().status, 'pago');
});

test('fechamento de 1 dia: só o Resumo, valor do dia = total do Resumo, sem sobreposição', async () => {
  const desp = await entra('desp');
  const envia = async (dia) => {
    const fd = new FormData();
    fd.set('modo', 'dia'); fd.set('dia', dia);
    fd.set('resumo', new Blob(['Entregador;Pedidos;CPF;Chave Pix;Soma das taxas de entrega\r\nDora;3;;dora@pix.com;25,00\r\nEli;2;;eli@pix.com;18,50\r\n']), 'resumo.csv');
    const r = await fetch(B + '/fechamentos/novo', { method: 'POST', headers: { cookie: desp }, body: fd, redirect: 'manual' });
    return r.headers.get('location') || '';
  };
  const loc = await envia('2026-10-18');
  assert.match(loc, /^\/fechamentos\/\d+\?ok=/);
  const id = Number(loc.match(/\/fechamentos\/(\d+)/)[1]);
  const f = db.prepare('SELECT so_resumo, data_ini, data_fim, status FROM fechamentos WHERE id = ?').get(id);
  assert.deepStrictEqual({ ...f }, { so_resumo: 1, data_ini: '2026-10-18', data_fim: '2026-10-18', status: 'rascunho' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM pedidos WHERE fechamento_id = ?').get(id).n, 0);
  const pag = (await (await get(desp, '/fechamentos/' + id)).text()).replace(/ /g, ' ');
  assert.ok(pag.includes('R$ 43,50') && !pag.includes('Registrar divergência'), 'total do dia e sem divergências');
  assert.match(await envia('2026-10-18'), /erro=/); // mesmo dia de novo
  assert.match(await envia('2999-01-01'), /erro=/); // futuro
});

