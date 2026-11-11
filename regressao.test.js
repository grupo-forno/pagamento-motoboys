// Regressões da auditoria: divergência Pedidos × Resumo, PIX aprovado em Pagamentos, alcance da devolução,
// erros da importação e horário da virada. Banco isolado e dados fictícios.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-reg-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const { diaOperacional, VIRADA_H, FILTRO_HORA } = require('./importar');
const PORT = 4100 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, loja;
const ids = {};

before(async () => {
  loja = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%SUL'").get().id;
  const user = (login, perfil, l) => Number(db.prepare('INSERT INTO usuarios (nome, login, senha, perfil, loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha('senha12345'), perfil, l).lastInsertRowid);
  ids.desp = user('desp', 'despachante', loja); user('fin', 'financeiro', null);
  for (const n of ['Ana', 'Bia']) ids[n] = Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(n).lastInsertRowid);
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', EMAIL_SO_ARQUIVO: '1' } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async (login) => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login, senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = (ck, url) => fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' });
const texto = async (ck, url) => (await (await get(ck, url)).text()).replace(/ /g, ' ');
const post = async (ck, url, dados) => (await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '';
const msg = (loc) => decodeURIComponent(new URL(loc, B).searchParams.get('ok') || new URL(loc, B).searchParams.get('erro') || '');

// Fechamento enviado com pedidos por entregador: { Ana: [pedidos, resumo] }
function fechamento(valores, ini = '2026-10-20') {
  const f = Number(db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, criado_por, versao, enviado_em) VALUES (?, ?, ?, 'enviado', ?, 1, '2026-10-22 09:00:00')").run(loja, ini, ini, ids.desp).lastInsertRowid);
  let k = 0;
  for (const [n, [ped, res]] of Object.entries(valores)) {
    db.prepare('INSERT INTO pedidos (fechamento_id, loja_id, chave, dia, entregador, motoboy_id, taxa) VALUES (?,?,?,?,?,?,?)').run(f, loja, `${f}-${k++}`, ini, n, ids[n], ped);
    db.prepare('INSERT INTO resumo (fechamento_id, entregador, motoboy_id, total, pix) VALUES (?,?,?,?,?)').run(f, n, ids[n], res, `${n.toLowerCase()}@pix.com`);
    db.prepare('INSERT INTO envio_pix (fechamento_id, motoboy_id, pix) VALUES (?,?,?)').run(f, ids[n], `${n.toLowerCase()}@pix.com`);
  }
  return f;
}

test('virada do dia às 06:00, igual ao filtro do Agilizone, inclusive na troca de mês', () => {
  assert.strictEqual(VIRADA_H, 6); assert.strictEqual(FILTRO_HORA, '06:00');
  assert.strictEqual(diaOperacional('01/11/2026 04:59:59'), '2026-10-31');
  assert.strictEqual(diaOperacional('01/11/2026 05:59:00'), '2026-10-31'); // madrugada fica com o dia anterior
  assert.strictEqual(diaOperacional('01/11/2026 06:00:00'), '2026-11-01');
  // Cada minuto de dois dias seguidos cai em exatamente um dia operacional, em ordem: sem buraco e sem contar duas vezes.
  let ant = null;
  for (let h = 0; h < 48; h++) for (const m of ['00', '59']) {
    const d = diaOperacional(`${h < 24 ? '31/10/2026' : '01/11/2026'} ${String(h % 24).padStart(2, '0')}:${m}:00`);
    assert.ok(!ant || d >= ant); ant = d;
  }
});

test('divergência Pedidos × Resumo: mostra os quatro valores, não bloqueia e PDF/Excel/aprovação usam o mesmo valor', async () => {
  const F = fechamento({ Ana: [1000, 1300] }), fin = await entra('fin');
  const t = await texto(fin, `/fechamentos/${F}`);
  for (const s of ['Valor dos pedidos', 'Valor do Resumo', 'Valor a pagar', 'R$ 10,00', 'R$ 13,00', 'diferença -R$ 3,00']) assert.ok(t.includes(s), s);
  const wb = XLSX.read(Buffer.from(await (await get(fin, `/fechamentos/${F}/xlsx`)).arrayBuffer()));
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets.Pagamento, { header: 1 });
  const cab = linhas[0], ana = linhas.find((l) => l[0] === 'Ana');
  assert.deepStrictEqual([ana[cab.indexOf('Valor do Resumo')], ana[cab.indexOf('Diferença pedidos - Resumo')], ana[cab.indexOf('Total a pagar')]], [13, -3, 10]);
  assert.match(await post(fin, `/fechamentos/${F}/decidir`, { versao: '1' }), /ok=/);
  assert.strictEqual(db.prepare('SELECT valor FROM aprovacoes WHERE fechamento_id = ?').get(F).valor, 1000);
});

test('Pagamentos: mostra o PIX registrado na aprovação, não o cadastro atual', async () => {
  const F = fechamento({ Bia: [2000, 2000] }), fin = await entra('fin');
  assert.match(await post(fin, `/fechamentos/${F}/decidir`, { versao: '1' }), /ok=/);
  db.prepare('UPDATE motoboys SET pix = ? WHERE id = ?').run('cadastro-novo@pix.com', ids.Bia);
  const t = await texto(fin, '/pagar');
  assert.ok(t.includes('data-copiar="bia@pix.com"') && !t.includes('cadastro-novo@pix.com'));
  assert.ok(t.includes('Registrar pagamento') && t.includes('Quem recebe'));
});

test('devolução: devolvidos vão para um fechamento novo; com resto=manter os demais continuam aguardando', async () => {
  const fin = await entra('fin');
  // Opção "deixar aguardando" (popup) e /devolver: Bia fica no original, ainda aguardando aprovação.
  const F = fechamento({ Ana: [1000, 1000], Bia: [2000, 2000] });
  const loc = await post(fin, `/fechamentos/${F}/decidir`, { versao: '1', dev: String(ids.Ana), [`motivo_${ids.Ana}`]: 'Valor errado no dia 20', resto: 'manter' });
  assert.match(loc, /ok=/); assert.match(msg(loc), /continuam aqui, aguardando aprovação/);
  const novo = Number(new URL(loc, B).searchParams.get('lk').match(/^\/fechamentos\/(\d+)\t/)[1]);
  assert.notStrictEqual(novo, F);
  assert.strictEqual(db.prepare('SELECT status FROM fechamentos WHERE id = ?').get(F).status, 'enviado');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM aprovacoes WHERE fechamento_id = ?').get(F).n, 0);
  assert.deepStrictEqual(db.prepare('SELECT entregador FROM pedidos WHERE fechamento_id = ?').all(novo).map((x) => x.entregador), ['Ana']);
  // Opção "aprovar os não devolvidos": Bia aprovada no original.
  const G = fechamento({ Ana: [1000, 1000], Bia: [2000, 2000] }, '2026-10-21');
  assert.match(await post(fin, `/fechamentos/${G}/decidir`, { versao: '1', dev: String(ids.Ana), [`motivo_${ids.Ana}`]: 'Valor errado', resto: 'aprovar' }), /ok=/);
  assert.strictEqual(db.prepare('SELECT status FROM fechamentos WHERE id = ?').get(G).status, 'pago');
  assert.strictEqual(db.prepare('SELECT valor FROM aprovacoes WHERE fechamento_id = ?').get(G).valor, 2000);
  // Despachante: motivo, quem foi devolvido e o botão certo
  const desp = await entra('desp'), p = await texto(desp, '/');
  assert.ok(p.includes('Corrigir devolução') && p.includes('Valor errado no dia 20') && p.includes('<b>Devolvidos:</b> Ana'));
});

test('envio com diferença exige justificativa; o e-mail não bloqueia e a justificativa chega ao financeiro', async () => {
  const F = fechamento({ Ana: [1000, 1300] }, '2026-10-23'), desp = await entra('desp');
  db.prepare("UPDATE fechamentos SET status = 'rascunho', versao = 0 WHERE id = ?").run(F);
  assert.ok((await texto(desp, `/fechamentos/${F}/enviar`)).includes('name="justificativa"'));
  assert.match(msg(await post(desp, `/fechamentos/${F}/enviar`, { para: 'fin@teste.com', justificativa: 'curta' })), /justificativa/);
  assert.strictEqual(db.prepare('SELECT status FROM fechamentos WHERE id = ?').get(F).status, 'rascunho');
  // E-mail que falha (servidor inacessível): o fechamento é enviado mesmo assim e o e-mail pode ser reenviado depois.
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('smtp_host', '127.0.0.1'), ('smtp_port', '1')").run();
  const falhou = await post(desp, `/fechamentos/${F}/enviar`, { para: 'fin@teste.com', justificativa: 'Resumo saiu com filtro diferente' });
  db.prepare("DELETE FROM config WHERE chave IN ('smtp_host', 'smtp_port')").run();
  assert.match(msg(falhou), /o e-mail não saiu/);
  assert.strictEqual(db.prepare('SELECT status FROM fechamentos WHERE id = ?').get(F).status, 'enviado');
  assert.strictEqual((await get(desp, `/fechamentos/${F}/pdf`)).status, 200);
  const fin = await entra('fin');
  assert.ok((await texto(fin, `/fechamentos/${F}`)).includes('Resumo saiu com filtro diferente'));
  // Histórico: busca por entregador e filtro de datas
  const h = await texto(fin, '/historico?q=ana');
  assert.ok(h.includes(`data-href="/fechamentos/${F}"`));
  assert.ok(!(await texto(fin, '/historico?q=ninguem')).includes(`data-href="/fechamentos/${F}"`));
  assert.ok(!(await texto(fin, '/historico?ini=2026-12-01&fim=2026-12-31')).includes(`data-href="/fechamentos/${F}"`));
});

test('importação: erro no modo 1 dia mantém modo e data, fala do arquivo certo e não cita "segundo arquivo"', async () => {
  const desp = await entra('desp'), fd = new FormData();
  fd.set('modo', 'dia'); fd.set('dia', '2026-10-15'); fd.set('resumo', new Blob(['nada;aqui\n1;2']), 'x.csv');
  const loc = (await fetch(`${B}/fechamentos/novo`, { method: 'POST', headers: { cookie: desp }, body: fd, redirect: 'manual' })).headers.get('location');
  assert.match(loc, /modo=dia/); assert.match(loc, /dia=2026-10-15/);
  const t = await texto(desp, loc);
  assert.ok(t.includes('value="2026-10-15"') && t.includes('escolha de novo o Resumo (.csv)') && !t.includes('segundo arquivo'));
});
