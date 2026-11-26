// Conferência geral: todas as lojas do dia, cadastro com nome completo e CPF/CNPJ, planilha no modelo e envio.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-conf-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const { variaveis } = require('./agilizone');
const CONF = require('./conferencia');
const PORT = 4700 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
const D = '2026-11-23'; // segunda: SUL paga sex/sab/dom
let srv, mock, sul;
const TK = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`; // token do painel (falso)

before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/stores')) return res.end(JSON.stringify({ data: [{ id: '6a03160245f42a2cff69ab95', name: 'Loja' }], page: 1, pageSize: 100, total: 1 }));
    if (req.url === '/auth/login') { let b = ''; req.on('data', (c) => (b += c)); return req.on('end', () => { const j = JSON.parse(b); if (j.email !== 'painel@exemplo.com' || j.password !== 'segredo') { res.statusCode = 401; return res.end('{}'); } res.end(JSON.stringify({ jwt: TK })); }); }
    if (req.url.startsWith('/occurrences')) { // como o painel: exige deliverymanId (sem ele, 400)
      const q = new URL(req.url, 'http://x').searchParams;
      if (!q.get('deliverymanId')) { res.statusCode = 400; return res.end('{"message":"deliverymanId is required"}'); }
      return res.end(req.headers.authorization === `Bearer ${TK}` && q.get('deliverymanId') === '7' ? JSON.stringify([{ id: 'o1', deliverymanId: '7', value: 250, name: 'Outros', description: 'retirada virou entrega', reversesId: null }]) : '[]');
    }
    if (req.url.startsWith('/auth/token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 86400 }));
    const de = new Date(new URL(req.url, 'http://x').searchParams.get('from')).getTime();
    const o = (id, e, fee, h) => ({ id, orderDisplayNumber: id, status: 'COMPLETED', deliveryman: e, deliverymanFee: fee, createdAt: new Date(de + h * 36e5).toISOString() });
    const data = [o('a1', { id: 7, name: 'Kevin' }, 7.5, 3), o('a2', { id: 7, name: 'Kevin' }, 10, 30), o('a3', { id: 8, name: 'Marcos' }, 6, 4)];
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  sul = db.prepare("SELECT * FROM lojas WHERE nome LIKE '%SUL'").get();
  const v = variaveis(sul);
  const creds = Object.fromEntries(db.prepare('SELECT * FROM lojas').all().flatMap((l) => [[variaveis(l).id, 'cid'], [variaveis(l).secret, 's']])); // todas conectadas (Agilizone falso)
  db.prepare("INSERT INTO config (chave, valor) VALUES ('email_para', 'fin@exemplo.com')").run();
  db.prepare("UPDATE lojas SET agz_store_id = '6a03160245f42a2cff69ab95'").run(); // storeId do painel (o da API oficial é outro)
  db.prepare("UPDATE lojas SET agz_store_id = '8afa395c-8fe9-454c-af3b-61fba2b7e08a' WHERE nome LIKE '%DOM SEVERINO%'").run(); // UUID da API: o sistema ignora e limpa
  db.prepare('INSERT INTO usuarios (nome, login, senha, perfil) VALUES (?,?,?,?)').run('Conf', 'conf', hashSenha('senha12345'), 'conferente');
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1', AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, AGILIZONE_LEDGER_URL: `http://127.0.0.1:${mock.address().port}`, AGILIZONE_AUTH_URL: `http://127.0.0.1:${mock.address().port}`, AGILIZONE_PAINEL_EMAIL: 'painel@exemplo.com', AGILIZONE_PAINEL_SENHA: 'segredo', ...creds } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); mock.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const entra = async () => (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'conf', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const get = (ck, url) => fetch(B + url, { headers: { cookie: ck }, redirect: 'manual' });
const post = async (ck, url, dados) => decodeURIComponent((await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '');

test('formata CPF/CNPJ e título', () => {
  assert.strictEqual(CONF.docFmt('07790030396'), '077.900.303-96');
  assert.strictEqual(CONF.docFmt('12345678000199'), '12.345.678/0001-99');
  assert.strictEqual(CONF.titulo(D), '23-11-2026 - MOTOBOYS');
  assert.ok(!CONF.docValido('123'));
});

test('conferente: vê todas as lojas, completa o cadastro (CNPJ) e envia a planilha no modelo', async () => {
  const ck = await entra();
  assert.strictEqual((await get(ck, '/')).headers.get('location'), '/conferencia');
  let h = await (await get(ck, `/conferencia?d=${D}`)).text();
  assert.ok(h.includes('Lojas que pagam') && h.includes('Automático'), 'aba geral');
  assert.ok(h.includes('falta nome completo'), 'bloqueia sem nome completo/CPF');
  assert.ok(/<button class="btn btn-pri" disabled>/.test(h), 'envio bloqueado');
  // completa o cadastro (um com CNPJ); os mesmos ids do Agilizone aparecem em todas as lojas do teste
  for (const [agz, nome, doc] of [[7, 'Kevin Souza Lima', '077.900.303-96'], [8, 'Marcos Transportes LTDA', '12.345.678/0001-99']]) {
    const x = db.prepare('SELECT motoboy_id id, loja_id FROM entregador_pix WHERE agz_id = ?').get(String(agz));
    const loc = await post(ck, `/entregadores/${x.id}`, { loja: x.loja_id, volta: 'conferencia', d: D, aba: 'geral', nome_completo: nome, cpf: doc, pix: `${agz}@pix.com` });
    assert.match(loc, /dados salvos/, loc);
  }
  assert.match(await post(ck, '/entregadores/1', { loja: sul.id, nome_completo: 'Só', cpf: '123', pix: 'a@b.com' }), /CPF deve ter 11|nome completo|não encontrado/);
  // automático: taxas da API + ocorrência do painel (Kevin 17,50 + 2,50)
  h = await (await get(ck, `/conferencia?d=${D}&aba=${sul.id}`)).text();
  assert.ok(h.includes('taxas + ocorrências'), h.match(/badge [a-z]+">Automático[^]{0,300}/)?.[0]);
  assert.match(h, /<b>R\$\s20,00<\/b>/, 'ocorrência automática somada');
  // Resumo de cada loja: Kevin com 1 ocorrência de R$ 2,50 (o valor a pagar vem do Resumo)
  const csv = 'Entregador;Pedidos;Soma das taxas de entrega;Ocorrências;Ocorrências + Taxas;Pago\nKevin;2;17,50;1;20,00;0,00\nMarcos;1;6,00;0;6,00;0,00\n';
  for (const { id } of db.prepare('SELECT id FROM lojas').all()) {
    const fd = new FormData(); fd.set('d', D); fd.set('loja', id); fd.set('resumo', new Blob([csv]), 'resumo.csv');
    const loc = decodeURIComponent((await fetch(B + '/conferencia/resumo', { method: 'POST', headers: { cookie: ck }, body: fd, redirect: 'manual' })).headers.get('location'));
    assert.match(loc, /Resumo importado: 2/, loc);
  }
  const um = db.prepare('SELECT id FROM lojas LIMIT 1').get().id; // remover volta ao automático; reimporta em seguida
  assert.match(await post(ck, '/conferencia/resumo/remover', { d: D, loja: um }), /voltaram ao automático/);
  { const fd = new FormData(); fd.set('d', D); fd.set('loja', um); fd.set('resumo', new Blob([csv]), 'resumo.csv'); await fetch(B + '/conferencia/resumo', { method: 'POST', headers: { cookie: ck }, body: fd, redirect: 'manual' }); }
  h = await (await get(ck, `/entregadores?ver=todas`)).text();
  assert.ok(h.includes('12.345.678/0001-99') && h.includes('Marcos Transportes LTDA'), 'lista todas as lojas com CNPJ');
  const loc = await post(ck, '/conferencia/enviar', { d: D, ok: '1' });
  assert.match(loc, /enviado por e-mail/, loc);
  const e = db.prepare('SELECT * FROM envios WHERE pagamento = ?').get(D);
  const nLojas = db.prepare('SELECT COUNT(*) n FROM lojas').get().n; // todas pagam na segunda
  assert.strictEqual(e.linhas, 2 * nLojas);
  assert.strictEqual(e.total, 2600 * nLojas);
  const r = await get(ck, `/conferencia/planilha?d=${D}`);
  assert.match(r.headers.get('content-disposition'), /23-11-2026 - MOTOBOYS\.xlsx/);
  const bytes = Buffer.from(await r.arrayBuffer()), wb = XLSX.read(bytes), linhas = XLSX.utils.sheet_to_json(wb.Sheets.Planilha1, { header: 1, raw: true });
  assert.deepStrictEqual(wb.SheetNames, ['Planilha1']);
  assert.deepStrictEqual(linhas[0], ['VENCIMENTO', 'NOME', 'CPF/CNPJ', 'DESCRIÇÃO', 'CATEGORIA', 'CENTRO DE CUSTO', 'VALOR']);
  // como no modelo: data em número (46349 = 23/11/2026), DESCRIÇÃO com o espaço no fim em Leste e Sul, valor negativo
  assert.ok(linhas.some((l) => JSON.stringify(l) === JSON.stringify([46349, 'KEVIN SOUZA LIMA', '077.900.303-96', 'Motoboys Sul ', 'Motoboys', 'SUL', -20])), JSON.stringify(linhas.slice(0, 3)));
  assert.ok(linhas.some((l) => l[2] === '12.345.678/0001-99' && l[5] === 'LESTE' && l[3] === 'Motoboys Leste '), 'centro de custo da Leste');
  assert.ok(linhas.some((l) => l[5] === 'DIRCEU' && l[3] === 'Motoboys Dirceu'), 'Dirceu sem espaço no fim');
  const ordem = []; for (const l of linhas.slice(1)) if (ordem.at(-1) !== l[5]) ordem.push(l[5]);
  assert.deepStrictEqual(ordem, ['LESTE', 'DIRCEU', 'SUL', 'DOM SEVERINO'], 'ordem das lojas do modelo');
  const fm = XLSX.read(bytes, { cellNF: true }).Sheets.Planilha1;
  assert.strictEqual(fm['G2'].z, '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-', 'formato contábil do modelo');
  assert.strictEqual(fm['A2'].z, 'm/d/yy');
  assert.match(await post(ck, '/conferencia/enviar', { d: D, ok: '1' }), /já foi enviado/);
});
