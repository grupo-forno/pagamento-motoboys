const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { lerRelatorio, lerResumo, diaOperacional, centavos } = require('./importar');

test('lê resumo de entregadores (CSV do Agilizone)', () => {
  const csv = 'Entregador;Pedidos;CPF;Chave Pix;Data de Nascimento;Soma das taxas de entrega;Pago;Saldo a pagar\n' +
    'Mike Rodrigues;53;02675373362;02675373362;26/05/1988;R$ 1.462,00;R$ 0,00;R$ 1.462,00\n' +
    'Vinícius Amaral ;35;-;-;-;R$ 326,50;R$ 0,00;R$ 326,50\n';
  assert.deepEqual(lerResumo(Buffer.from(csv)), [
    { entregador: 'Mike Rodrigues', pedidos: 53, cpf: '02675373362', pix: '02675373362', total: 146200 },
    { entregador: 'Vinícius Amaral', pedidos: 35, cpf: null, pix: null, total: 32650 },
  ]);
  assert.equal(lerResumo(Buffer.from(csv, 'latin1'))[1].entregador, 'Vinícius Amaral'); // salvo pelo Excel
  assert.throws(() => lerResumo(Buffer.from('Número;Loja\n1;A')), /Resumo de entregas/);
});

const planilha = (linhas) => {
  const cab = ['Número', 'Status', 'Loja', 'Data e Hora Início de Preparo', 'Data e Hora Finalizado', 'Entregador', 'Taxa do Entregador'];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab, ...linhas]), 'Relatório');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('centavos', () => {
  assert.equal(centavos('7.9'), 790);
  assert.equal(centavos('12,50'), 1250);
  assert.equal(centavos('R$ 1.234,56'), 123456);
  assert.equal(centavos('—'), 0);
  assert.ok(Number.isNaN(centavos('abc')));
});

test('dia operacional: madrugada conta no dia anterior', () => {
  assert.equal(diaOperacional('02/11/2026 22:58:14'), '2026-11-02');
  assert.equal(diaOperacional('03/11/2026 00:30:00'), '2026-11-02');
  assert.equal(diaOperacional('01/12/2026 01:00:00'), '2026-11-30');
  assert.equal(diaOperacional('—'), null);
});

test('lê relatório do Agilizone', () => {
  const r = lerRelatorio(planilha([
    ['0313', 'Finalizado', 'FORNO PAULISTA DIRCEU', '02/11/2026 22:58:14', '02/11/2026 23:31:03', ' Alberto Vitorino', '6'],
    ['0001', 'Finalizado', 'FORNO PAULISTA DIRCEU', '03/11/2026 00:10:00', '', 'Alberto Vitorino', '7.9'],
    ['0002', 'Cancelado', 'FORNO PAULISTA DIRCEU', '01/11/2026 19:00:00', '', ' —', '6'],
  ]));
  assert.equal(r.loja, 'FORNO PAULISTA DIRCEU');
  assert.deepEqual(r.pedidos.map((p) => [p.dia, p.entregador, p.taxa]), [
    ['2026-11-02', 'Alberto Vitorino', 600],
    ['2026-11-02', 'Alberto Vitorino', 790],
    ['2026-11-01', null, 600],
  ]);
});

test('recusa arquivo com várias lojas ou sem colunas', () => {
  assert.throws(() => lerRelatorio(planilha([
    ['1', 'Finalizado', 'A', '01/11/2026 19:00:00', '', 'X', '6'],
    ['2', 'Finalizado', 'B', '01/11/2026 19:00:00', '', 'X', '6'],
  ])), /2 lojas/);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Entregador', 'Pedidos'], ['X', 1]]), 'S');
  assert.throws(() => lerRelatorio(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), /Relatório de Pedidos/);
});
