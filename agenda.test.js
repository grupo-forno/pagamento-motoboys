const test = require('node:test');
const assert = require('node:assert');
const { PADRAO, PADRAO_DIRCEU, lerCalendario, diasReferencia, pagamentoDoDia, pagamentosEntre } = require('./agenda');

// Novembro/2026: dom 01, seg 02, ter 03, qua 04, qui 05, sex 06, sáb 07, dom 08, seg 09.
const padrao = lerCalendario(PADRAO), dirceu = lerCalendario(PADRAO_DIRCEU);

test('lê o calendário', () => {
  assert.deepEqual(padrao, [{ pag: 1, ref: [5, 6, 0] }, { pag: 5, ref: [1, 2, 3, 4] }]);
  assert.deepEqual(lerCalendario('Quarta: Segunda, Terça'), [{ pag: 3, ref: [1, 2] }]);
  assert.throws(() => lerCalendario('seg sex'), /formato/);
  assert.throws(() => lerCalendario('seg: sex; qua: sex'), /dois pagamentos/);
  assert.throws(() => lerCalendario('xyz: seg'), /desconhecido/);
});

test('padrão: segunda paga sex/sáb/dom; sexta paga seg a qui', () => {
  assert.deepEqual(diasReferencia(padrao, '2026-11-09'), ['2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual(diasReferencia(padrao, '2026-11-06'), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  assert.equal(diasReferencia(padrao, '2026-11-04'), null); // quarta não é dia de pagamento
  assert.equal(pagamentoDoDia(padrao, '2026-11-01'), '2026-11-02'); // domingo -> segunda seguinte
  assert.equal(pagamentoDoDia(padrao, '2026-11-03'), '2026-11-06'); // terça -> sexta
});

test('DIRCEU: quarta paga seg/ter; sexta paga qua/qui; segunda paga sex/sáb/dom', () => {
  assert.deepEqual(diasReferencia(dirceu, '2026-11-04'), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(diasReferencia(dirceu, '2026-11-06'), ['2026-11-04', '2026-11-05']);
  assert.equal(pagamentoDoDia(dirceu, '2026-11-02'), '2026-11-04');
  assert.equal(pagamentoDoDia(dirceu, '2026-11-05'), '2026-11-06');
  assert.deepEqual(pagamentosEntre(dirceu, '2026-11-02', '2026-11-09').map((p) => p.pagamento), ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09']);
});
