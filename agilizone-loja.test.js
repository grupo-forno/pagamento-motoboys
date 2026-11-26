// Uma credencial com várias lojas autorizadas: os pedidos de uma loja não podem cair em outra.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let mock, pedidosPedidos = [];
const A = require('./agilizone');
const LOJAS = [{ id: 's-leste', name: 'Forno Paulista Centro de Distribuição Leste' }, { id: 's-dom', name: 'FORNO PAULISTA DOM SEVERINO ATIVA' }];
const ped = (id, loja) => ({ id, store: { id: loja }, status: 'COMPLETED', deliveryman: { id: 1, name: 'X' }, deliverymanFee: 10, createdAt: '2026-11-14T15:00:00Z' });

before(async () => {
  mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/auth/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 86400 }));
    if (u.pathname === '/stores') return res.end(JSON.stringify({ data: LOJAS, page: 1, pageSize: 100, total: 2 }));
    if (u.pathname === '/deliverymen') return res.end(JSON.stringify({ data: [{ id: 1, name: 'Da Leste', stores: [{ storeId: 's-leste' }] }, { id: 2, name: 'Da Dom', stores: [{ storeId: 's-dom' }] }], total: 2 }));
    pedidosPedidos.push(u.searchParams.get('storeId'));
    // credencial ignora o filtro de propósito: o sistema também confere o pedido
    const data = [ped('a', 's-leste'), ped('b', 's-dom'), ped('c', 's-dom')];
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  process.env.AGILIZONE_URL = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

const loja = (nome) => { const l = { nome }; const v = A.variaveis(l); process.env[v.id] = 'cid'; process.env[v.secret] = 's'; return l; };

test('pedidos: só os da loja pedida, mesmo com várias lojas na credencial', async () => {
  const leste = await A.pedidos(loja('Forno Paulista Centro de Distribuição Leste'), '2026-11-13T12:00:00-03:00', '2026-11-16T12:00:59-03:00');
  assert.deepStrictEqual(leste.map((o) => o.id), ['a']);
  assert.strictEqual(pedidosPedidos.at(-1), 's-leste', 'pede à API só a loja certa');
  const dom = await A.pedidos(loja('Forno Paulista Dom Severino Ativa'), '2026-11-13T12:00:00-03:00', '2026-11-16T12:00:59-03:00'); // nome sem diferenciar caixa
  assert.deepStrictEqual(dom.map((o) => o.id), ['b', 'c']);
});

test('entregadores: só os vinculados à loja', async () => {
  const lista = await A.entregadores(loja('Forno Paulista Centro de Distribuição Leste'));
  assert.deepStrictEqual(lista.map((e) => e.id), [1]);
});

test('credencial com várias lojas e nome que não confere: recusa em vez de misturar', async () => {
  await assert.rejects(A.pedidos(loja('Forno Paulista Outra'), '2026-11-13T12:00:00-03:00', '2026-11-16T12:00:59-03:00'), /enxerga 2 lojas/);
});
