// Calendário de pagamento dos entregadores por loja.
// Formato editável (Configurações): "seg: sex sab dom; sex: seg ter qua qui"
//   = paga na segunda referente a sexta, sábado e domingo; paga na sexta referente a segunda a quinta.
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const NOMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const PADRAO = 'seg: sex sab dom; sex: seg ter qua qui';
const PADRAO_DIRCEU = 'seg: sex sab dom; qua: seg ter; sex: qua qui';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const diaSemana = (t) => {
  const i = DIAS.indexOf(semAcento(t).slice(0, 3));
  if (i < 0) throw new Error(`Dia da semana desconhecido: "${t}"`);
  return i;
};

// "seg: sex sab dom; sex: seg ter qua qui" -> [{ pag: 1, ref: [5, 6, 0] }, { pag: 5, ref: [1, 2, 3, 4] }]
function lerCalendario(txt) {
  const ciclos = String(txt || '').split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).map((parte) => {
    const [pag, refs] = parte.split(':');
    if (refs == null) throw new Error(`Use o formato "dia do pagamento: dias de referência" (em "${parte}")`);
    const ref = refs.split(/[\s,]+/).filter(Boolean).map(diaSemana);
    if (!ref.length) throw new Error(`Faltam os dias de referência em "${parte}"`);
    return { pag: diaSemana(pag), ref };
  });
  if (!ciclos.length) throw new Error('Informe pelo menos um dia de pagamento.');
  const usados = ciclos.flatMap((c) => c.ref);
  if (new Set(usados).size !== usados.length) throw new Error('Um mesmo dia de referência aparece em dois pagamentos.');
  return ciclos;
}
const textoCalendario = (ciclos) => ciclos.map((c) => `${NOMES[c.pag]} → ${c.ref.map((d) => NOMES[d].toLowerCase()).join(', ')}`).join(' · ');

const dt = (d) => new Date(d + 'T12:00:00Z');
const soma = (d, n) => { const x = dt(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const semana = (d) => dt(d).getUTCDay();

// Dias de referência de um pagamento na data P: a ocorrência mais recente, antes de P, de cada dia da lista.
function diasReferencia(ciclos, P) {
  const c = ciclos.find((x) => x.pag === semana(P));
  if (!c) return null;
  return c.ref.map((r) => soma(P, -((semana(P) - r + 7) % 7 || 7))).sort();
}

// Data do pagamento que cobre o dia d (o primeiro pagamento depois de d que inclui d na referência).
function pagamentoDoDia(ciclos, d) {
  for (let i = 1; i <= 7; i++) {
    const P = soma(d, i), ref = diasReferencia(ciclos, P);
    if (ref && ref.includes(d)) return P;
  }
  return null;
}

// Pagamentos com data entre ini e fim (inclusive), com o período de referência de cada um.
function pagamentosEntre(ciclos, ini, fim) {
  const r = [];
  for (let P = ini; P <= fim; P = soma(P, 1)) {
    const ref = diasReferencia(ciclos, P);
    if (ref) r.push({ pagamento: P, ini: ref[0], fim: ref[ref.length - 1], dias: ref });
  }
  return r;
}

module.exports = { PADRAO, PADRAO_DIRCEU, NOMES, lerCalendario, textoCalendario, diasReferencia, pagamentoDoDia, pagamentosEntre, soma, semana };
