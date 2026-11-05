const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { lerRelatorio, lerResumo, diaOperacional, centavos, valorDigitado, pixValido } = require('./importar');

test('valor digitado: só formato brasileiro', () => {
  for (const [v, c] of [['152', 15200], ['152,50', 15250], ['12,5', 1250], ['1.500', 150000], ['1.500,00', 150000], ['R$ 1.234,56', 123456], [' 10 ', 1000], ['0', 0]])
    assert.equal(valorDigitado(v), c, v);
  for (const v of ['', '   ', '-5', 'abc', '1e3', '0x10', '12.5', '1.5', '10,999', '1,234.50', '999999999'])
    assert.ok(Number.isNaN(valorDigitado(v)), v);
});

test('datas como célula de data do Excel', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Número', 'Status', 'Loja', 'Data e Hora Início de Preparo', 'Entregador', 'Taxa do Entregador'],
    ['0313', 'Finalizado', 'L', new Date(2026, 10, 2, 22, 58, 14), 'Ana', 6]], { cellDates: true });
  XLSX.utils.book_append_sheet(wb, ws, 'R');
  const r = lerRelatorio(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }));
  assert.equal(r.pedidos[0].dia, '2026-11-02');
});

test('chave do pedido usa a finalização quando falta o início', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Número', 'Loja', 'Data e Hora Início de Preparo', 'Data e Hora Finalizado', 'Entregador', 'Taxa do Entregador'],
    ['0001', 'L', '—', '02/11/2026 20:00:00', 'Ana', '6'], ['0001', 'L', '—', '03/11/2026 20:00:00', 'Ana', '6']]), 'R');
  const r = lerRelatorio(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.notEqual(r.pedidos[0].chave, r.pedidos[1].chave);
});

test('lê resumo de entregadores (CSV do Agilizone)', () => {
  const csv = 'Entregador;Pedidos;CPF;Chave Pix;Data de Nascimento;Soma das taxas de entrega;Pago;Saldo a pagar\n' +
    'Mike Rodrigues;53;02675373362;02675373362;26/05/1988;R$ 1.462,00;R$ 0,00;R$ 1.462,00\n' +
    'Vinícius Amaral ;35;-;-;-;R$ 326,50;R$ 100,00;R$ 226,50\n';
  assert.deepEqual(lerResumo(Buffer.from(csv)), [
    { entregador: 'Mike Rodrigues', pedidos: 53, cpf: '02675373362', pix: '02675373362', total: 146200, pago: 0, ocorrencias: 0, qtdOc: 0 },
    { entregador: 'Vinícius Amaral', pedidos: 35, cpf: null, pix: null, total: 32650, pago: 10000, ocorrencias: 0, qtdOc: 0 },
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

test('pixValido reconhece e-mail, chave aleatória, CPF/CNPJ e celular', () => {
  for (const ok of ['a@b.com', '123e4567-e89b-12d3-a456-426614174000', '021.090.583-23', '+5586994258810', '86999000001', '12.345.678/0001-90']) assert.ok(pixValido(ok), ok);
  for (const ruim of ['', 'forno', '123', 'joao@', '86 9999']) assert.ok(!pixValido(ruim), ruim);
});

test('resumo com ocorrências: acréscimo, desconto e quantidade', () => {
  const csv = 'Entregador;Pedidos;CPF;Chave Pix;Data de Nascimento;Soma das taxas de entrega;Ocorrências;Ocorrências + Taxas;Pago;Saldo a pagar\n' +
    'Lucas Queiroz ;425;-;abc752bd-7365-4cd1-b971-434e5bab4e1e;-;R$ 3.865,00;2;R$ 3.892,00;R$ 0,00;R$ 3.892,00\n' +
    'Kaio;95;06503312300;06503312300;07/07/2000;R$ 820,00;2;R$ 819,00;R$ 0,00;R$ 819,00\n' +
    'Jefferson;322;04536520341;+5586994647248;11/05/1993;R$ 2.787,00;0;R$ 2.787,00;R$ 0,00;R$ 2.787,00\n';
  const r = lerResumo(Buffer.from(csv));
  assert.deepEqual(r.map((x) => [x.total, x.ocorrencias, x.qtdOc]), [[386500, 2700, 2], [82000, -100, 2], [278700, 0, 0]]);
});
