const XLSX = require('xlsx');

const erro = (msg) => Object.assign(new Error(msg), { publico: true });

// Horários da virada do dia, num lugar só.
// VIRADA_H: pedido iniciado antes desta hora conta no dia anterior (usado no cálculo).
// FILTRO_HORA: horário sugerido para o filtro do Agilizone (só orientação nas telas).
// Regra da operação (06/11/2026): o dia vai das 06:00 às 06:00 do dia seguinte (lojas abrem 15h–23h; a madrugada
// fica com o dia anterior). Ex.: segunda a quinta = segunda 06:00 até sexta 06:00. Antes era 05:00; o que já foi importado não muda.
const VIRADA_H = 6, FILTRO_HORA = '06:00';
// Dia operacional: pedido iniciado de madrugada (antes de VIRADA_H) conta no dia anterior.
function diaOperacional(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (+m[4] < VIRADA_H) d.setUTCDate(d.getUTCDate() - 1);
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
  const sa = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cab = (linhas[0] || '').split(';').map((s) => sa(s.trim()));
  const col = (n) => cab.indexOf(sa(n));
  if (col('Entregador') < 0 || col('Soma das taxas de entrega') < 0)
    throw erro('Este arquivo não parece o "Resumo de entregas por entregador" do Agilizone. Use o .csv baixado em "Exportar Resumo", sem abrir e salvar de novo em outro formato.');
  const limpa = (v) => { const s = String(v ?? '').trim(); return s && s !== '-' && s !== '—' ? s : null; };
  const rows = linhas.slice(1).map((l) => {
    const c = l.split(';');
    const total = centavos(c[col('Soma das taxas de entrega')]);
    if (Number.isNaN(total)) throw erro(`Resumo: valor inválido para ${c[col('Entregador')]}.`);
    const pago = col('Pago') < 0 ? 0 : centavos(c[col('Pago')]) || 0; // acerto já feito no Agilizone
    // Ocorrências (acréscimos ou descontos do Agilizone): "Ocorrências + Taxas" menos "Soma das taxas". Arquivo antigo não tem: 0.
    const comOc = col('Ocorrências + Taxas') < 0 ? total : centavos(c[col('Ocorrências + Taxas')]);
    if (Number.isNaN(comOc)) throw erro(`Resumo: valor de ocorrências inválido para ${c[col('Entregador')]}.`);
    return { entregador: String(c[col('Entregador')] ?? '').trim(), pedidos: Number(c[col('Pedidos')]) || 0, cpf: limpa(c[col('CPF')]), pix: limpa(c[col('Chave Pix')]), total, pago, ocorrencias: comOc - total, qtdOc: col('Ocorrências') < 0 ? 0 : Number(c[col('Ocorrências')]) || 0 };
  }).filter((r) => r.entregador);
  if (!rows.length) throw erro('O Resumo de entregas está vazio.');
  return rows;
}

// Formato de chave PIX: e-mail, chave aleatória (UUID) ou número (CPF, CNPJ, celular com ou sem +55).
function pixValido(p) {
  const s = String(p || '').trim(), d = s.replace(/\D/g, '');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  return /^[\d.\-/()+\s]+$/.test(s) && [10, 11, 12, 13, 14].includes(d.length);
}

module.exports = { VIRADA_H, FILTRO_HORA, lerRelatorio, lerResumo, diaOperacional, centavos, valorDigitado, pixValido };
