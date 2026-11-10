const test = require('node:test');
const assert = require('node:assert');
const { paraImportacao, pedidos, configurada, variaveis } = require('./agilizone');

const ped = (o) => ({ id: 'a1', orderDisplayNumber: '0001', status: 'COMPLETED', deliveryman: { id: 7, name: 'Kevin' }, deliverymanFee: 7.5, createdAt: '2026-11-09T18:00:00.000Z', ...o });

test('API: taxa em centavos, dia operacional no fuso de Teresina e chave pelo id', () => {
  const r = paraImportacao([
    ped({ id: 'a', createdAt: '2026-11-09T01:56:59.031Z' }), // 22:56 do dia 08
    ped({ id: 'b', createdAt: '2026-11-09T07:00:00.000Z' }), // 04:00 do dia 09: ainda é o dia 08 (virada às 06:00)
    ped({ id: 'c', createdAt: '2026-11-09T09:30:00.000Z', deliverymanFee: 10 }), // 06:30 do dia 09
  ]);
  assert.deepStrictEqual(r.pedidos.map((p) => [p.chave, p.dia, p.taxa]), [['agz:a', '2026-11-08', 750], ['agz:b', '2026-11-08', 750], ['agz:c', '2026-11-09', 1000]]);
  assert.deepStrictEqual([r.resumo[0].pedidos, r.resumo[0].total, r.resumo[0].agzId], [3, 2500, 7]);
});

test('API: ignora cancelados, sem entregador e pedidos fora do período; agrupa por id do entregador', () => {
  const r = paraImportacao([
    ped({ id: 'a' }), ped({ id: 'b', status: 'CANCELED' }), ped({ id: 'c', deliveryman: null }),
    ped({ id: 'd', deliveryman: { id: 8, name: 'Marcos' }, deliverymanFee: 6 }),
    ped({ id: 'e', createdAt: '2026-11-20T18:00:00.000Z' }),
  ], { de: '2026-11-09', ate: '2026-11-10' });
  assert.deepStrictEqual([r.pedidos.length, r.naoFinalizados, r.semEntregador, r.fora], [2, 1, 1, 1]);
  assert.deepStrictEqual(r.resumo.map((x) => [x.entregador, x.total]), [['Kevin', 750], ['Marcos', 600]]);
});

test('API: sem o escopo da taxa do entregador, recusa com aviso claro (não paga zero)', () => {
  const sem = ped({}); delete sem.deliverymanFee;
  assert.throws(() => paraImportacao([sem]), (e) => e.publico && /DELIVERYMAN_FEES/.test(e.message));
});

test('API: lê todas as páginas, manda o token e repete após 429', async () => {
  const antes = global.fetch, chamadas = [];
  let limitou = false;
  global.fetch = async (url, opts = {}) => {
    chamadas.push([String(url), opts.headers?.Authorization]);
    if (String(url).endsWith('/auth/token')) return Response.json({ access_token: 'tok', expires_in: 86400 });
    const pg = Number(new URL(url).searchParams.get('page'));
    if (pg === 2 && !limitou) { limitou = true; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); }
    return Response.json({ data: Array.from({ length: pg === 1 ? 100 : 20 }, (_, i) => ped({ id: `${pg}-${i}` })), page: pg, pageSize: 100, total: 120 });
  };
  try {
    process.env.AGILIZONE_TESTE_ID = 'idpagina'; process.env.AGILIZONE_TESTE_SECRET = 'segredo';
    const l = { nome: 'Teste' };
    assert.ok(configurada(l) && !configurada({ nome: 'Outra Loja' }));
    assert.deepStrictEqual(variaveis({ nome: 'Forno Paulista Distribuição' }), { id: 'AGILIZONE_FORNO_PAULISTA_DISTRIBUICAO_ID', secret: 'AGILIZONE_FORNO_PAULISTA_DISTRIBUICAO_SECRET' });
    const todos = await pedidos(l, '2026-11-01T06:00:00-03:00', '2026-11-08T06:00:00-03:00');
    assert.strictEqual(todos.length, 120);
    assert.ok(chamadas.filter((c) => c[0].includes('/orders')).every((c) => c[1] === 'Bearer tok'));
    assert.strictEqual(chamadas.filter((c) => c[0].endsWith('/auth/token')).length, 1);
  } finally { global.fetch = antes; }
});
