const XLSX = require('xlsx');

const erro = (msg) => Object.assign(new Error(msg), { publico: true });

// Dia operacional: pedido iniciado de madrugada (antes das 5h) conta no dia anterior.
// ponytail: corte fixo às 05:00; vira configuração por loja se alguma operar de madrugada.
function diaOperacional(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (+m[4] < 5) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// "7.9" (planilha) ou "12,50" / "1.234,50" (digitado) -> centavos. Vazio/"—" = 0, inválido = NaN.
function centavos(v) {
  const s = String(v ?? '').replace(/R\$|\s/g, '');
  if (!s || s === '—' || s === '-') return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

// Valor digitado por uma pessoa, só no formato brasileiro: "152", "152,50", "1.500", "1.500,00", "R$ 12,5".
// Ponto sem vírgula é milhar ("1.500" = mil e quinhentos). Retorna centavos ou NaN (vazio, negativo, "1e3", acima de R$ 100.000).
function valorDigitado(v) {
  const s = String(v ?? '').replace(/R\$|\s/g, '');
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(s)) return NaN;
  const c = Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
  return c <= 10000000 ? c : NaN;
}

// Lê o .xlsx de "Relatório de Pedidos > Exportar Pedidos" do Agilizone.
function lerRelatorio(buf) {
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch { throw erro('Não consegui ler o arquivo. Envie o .xlsx de "Exportar Pedidos" do Agilizone.'); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Se o Agilizone mandar datas como célula de data (e não texto), formata igual ao texto: dd/mm/aaaa hh:mm:ss.
  for (const k in ws) if (k[0] !== '!' && ws[k].t === 'd') { ws[k].z = 'dd/mm/yyyy hh:mm:ss'; delete ws[k].w; }
  const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
  const cols = ['Número', 'Loja', 'Entregador', 'Taxa do Entregador', 'Data e Hora Início de Preparo'];
  if (!rows.length || cols.some((c) => !(c in rows[0])))
    throw erro('Este arquivo não parece o "Relatório de Pedidos" do Agilizone (faltam colunas como "Taxa do Entregador").');

  const lojas = new Set();
  const pedidos = rows.map((r) => {
    const inicio = String(r['Data e Hora Início de Preparo']).trim(), fim = String(r['Data e Hora Finalizado'] ?? '').trim();
    const dia = diaOperacional(inicio) || diaOperacional(r['Data e Hora Finalizado']);
    if (!dia) throw erro(`Pedido ${r['Número']} sem data válida.`);
    const taxa = centavos(r['Taxa do Entregador']);
    if (Number.isNaN(taxa)) throw erro(`Pedido ${r['Número']}: taxa do entregador inválida (${r['Taxa do Entregador']}).`);
    const ent = String(r['Entregador']).trim();
    lojas.add(String(r['Loja']).trim());
    return {
      numero: String(r['Número']).trim(),
      // Número reinicia todo dia: a chave junta com a hora de início (ou de finalização, se faltar).
      chave: `${String(r['Número']).trim()}|${diaOperacional(inicio) ? inicio : `fim ${fim}`}`,
      dia,
      entregador: ent && ent !== '—' && ent !== '-' ? ent : null,
      taxa,
      status: String(r['Status'] ?? '').trim(),
    };
  });
  if (lojas.size !== 1) throw erro(`O arquivo tem pedidos de ${lojas.size} lojas. Exporte uma loja por vez.`);
  return { loja: [...lojas][0], pedidos };
}

// Lê o CSV de "Resumo de entregas por entregador > Exportar Resumo" do Agilizone.
// É o total confiável por entregador; o Relatório de Pedidos serve para separar por dia.
function lerResumo(buf) {
  let txt = buf.toString('utf8');
  if (txt.includes('�')) txt = buf.toString('latin1'); // CSV salvo de novo pelo Excel
  const linhas = txt.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const cab = (linhas[0] || '').split(';').map((s) => s.trim());
  const col = (n) => cab.indexOf(n);
  if (col('Entregador') < 0 || col('Soma das taxas de entrega') < 0)
    throw erro('O segundo arquivo não parece o "Resumo de entregas por entregador" do Agilizone (o .csv de "Exportar Resumo").');
  const limpa = (v) => { const s = String(v ?? '').trim(); return s && s !== '-' && s !== '—' ? s : null; };
  const rows = linhas.slice(1).map((l) => {
    const c = l.split(';');
    const total = centavos(c[col('Soma das taxas de entrega')]);
    if (Number.isNaN(total)) throw erro(`Resumo: valor inválido para ${c[col('Entregador')]}.`);
    const pago = col('Pago') < 0 ? 0 : centavos(c[col('Pago')]) || 0; // acerto já feito no Agilizone
    return { entregador: String(c[col('Entregador')] ?? '').trim(), pedidos: Number(c[col('Pedidos')]) || 0, cpf: limpa(c[col('CPF')]), pix: limpa(c[col('Chave Pix')]), total, pago };
  }).filter((r) => r.entregador);
  if (!rows.length) throw erro('O Resumo de entregas está vazio.');
  return rows;
}

module.exports = { lerRelatorio, lerResumo, diaOperacional, centavos, valorDigitado };
