// Cliente da API v3 do Agilizone (Consumo de Pedidos, somente leitura): https://docs.agilizone.com/?spec=openapi-v3.yaml
// Cada loja tem o próprio Client ID/Secret (lojas.agz_client_id / agz_client_secret). O token vale 24h e fica só em memória.
const { diaOperacional } = require('./importar');

const base = () => (process.env.AGILIZONE_URL || 'https://api.agilizone.com/agilizone/v3').replace(/\/$/, '');
const erro = (msg) => Object.assign(new Error(msg), { publico: true });
// Credenciais só no ambiente do servidor (nunca no banco nem na tela): AGILIZONE_<LOJA>_ID e AGILIZONE_<LOJA>_SECRET,
// com <LOJA> = nome da loja em maiúsculas, sem acento e com _ no lugar de espaços e símbolos (ex.: AGILIZONE_FORNO_PAULISTA_DIRCEU_ID).
const variaveis = (l) => {
  const s = String(l?.nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { id: `AGILIZONE_${s}_ID`, secret: `AGILIZONE_${s}_SECRET` };
};
const credenciais = (l) => {
  const v = variaveis(l), id = (process.env[v.id] || '').trim(), secret = (process.env[v.secret] || '').trim();
  return id && secret ? { id, secret } : null;
};
const configurada = (l) => !!credenciais(l);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = new Map(); // "id:secret" -> { token, exp }

// 429: o Agilizone manda Retry-After. Espera e tenta de novo (até 3 vezes).
async function chama(url, opts) {
  let r;
  for (let i = 0; i < 3; i++) {
    try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) }); } catch { throw erro('Não consegui falar com o Agilizone. Tente de novo em instantes.'); }
    if (r.status !== 429) return r;
    const h = r.headers.get('retry-after'), s = h == null ? 5 : Number(h);
    await espera(Math.min((Number.isFinite(s) ? s : 5) * 1000, 30000));
  }
  return r;
}

async function token(l, renova) {
  const cr = credenciais(l);
  if (!cr) throw erro(`A loja ${l.nome} ainda não tem as credenciais do Agilizone no servidor.`);
  const k = `${cr.id}:${cr.secret}`, c = tokens.get(k);
  if (!renova && c && c.exp > Date.now()) return c.token;
  const r = await chama(`${base()}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: cr.id, clientSecret: cr.secret }) });
  if (r.status === 400 || r.status === 401) throw erro(`O Agilizone recusou as credenciais da loja ${l.nome}. Confira as variáveis ${variaveis(l).id} e ${variaveis(l).secret} no servidor.`);
  if (!r.ok) throw erro(`O Agilizone não respondeu (erro ${r.status}). Tente de novo em instantes.`);
  const j = await r.json();
  tokens.set(k, { token: j.access_token, exp: Date.now() + Math.max((j.expires_in || 3600) - 300, 60) * 1000 });
  return j.access_token;
}

async function get(l, caminho, params) {
  const url = `${base()}${caminho}?${new URLSearchParams(params)}`;
  for (let t = 0; t < 2; t++) {
    const r = await chama(url, { headers: { Authorization: `Bearer ${await token(l, t > 0)}` } });
    if (r.status === 401 && t === 0) continue; // token vencido: pega outro e repete
    if (r.status === 400) throw erro('O Agilizone recusou o período pedido (a janela máxima é de cerca de 3 meses).');
    if (!r.ok) throw erro(`O Agilizone não respondeu (erro ${r.status}). Tente de novo em instantes.`);
    return r.json();
  }
}

// Todos os pedidos da loja entre de e ate (ISO com fuso), página por página (máx. 100 por página).
async function pedidos(l, de, ate) {
  const todos = [];
  for (let page = 1; page <= 100; page++) {
    const j = await get(l, '/orders', { from: de, to: ate, page, pageSize: 100 });
    todos.push(...j.data);
    if (!j.data.length || todos.length >= j.total) return todos;
  }
  throw erro('Pedidos demais para uma importação só. Importe um período menor.');
}

// Pedidos da API -> os mesmos campos que o importador de arquivos produz (lerRelatorio / lerResumo).
// Só entram pedidos finalizados e com entregador. O dia é o dia operacional no fuso da loja.
// de/ate: primeiro e último dia (aaaa-mm-dd) do período; pedido de fora (borda da virada) é ignorado.
function paraImportacao(orders, { tz = 'America/Fortaleza', de = '0000-01-01', ate = '9999-12-31' } = {}) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = (iso) => { const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`; };
  const lista = [], por = new Map();
  let semEntregador = 0, naoFinalizados = 0, fora = 0;
  for (const o of orders) {
    if (o.status !== 'COMPLETED') { naoFinalizados++; continue; }
    if (!o.deliveryman) { semEntregador++; continue; }
    if (typeof o.deliverymanFee !== 'number') throw erro('O Agilizone não liberou a taxa do entregador para esta loja. Peça ao desenvolvedor do Agilizone para liberar o escopo DELIVERYMAN_FEES.');
    const dia = diaOperacional(local(o.createdAt));
    if (!dia) throw erro(`Pedido ${o.orderDisplayNumber} sem data válida.`);
    if (dia < de || dia > ate) { fora++; continue; }
    const taxa = Math.round(o.deliverymanFee * 100), e = o.deliveryman, nome = String(e.name || '').trim() || `Entregador ${e.id}`;
    // O número reinicia todo dia; a chave é o id do pedido no Agilizone.
    lista.push({ numero: String(o.orderDisplayNumber), chave: `agz:${o.id}`, dia, entregador: nome, agzId: e.id, taxa, status: 'Finalizado' });
    const r = por.get(e.id) || { entregador: nome, agzId: e.id, pedidos: 0, cpf: null, pix: null, total: 0, pago: 0, ocorrencias: 0, qtdOc: 0 };
    r.pedidos++; r.total += taxa; por.set(e.id, r);
  }
  return { pedidos: lista, resumo: [...por.values()], semEntregador, naoFinalizados, fora };
}

// Teste de conexão (Configurações > Lojas): pega o token e olha os últimos pedidos.
async function testa(l) {
  const ate = new Date(), de = new Date(ate.getTime() - 7 * 864e5);
  const j = await get(l, '/orders', { from: de.toISOString(), to: ate.toISOString(), page: 1, pageSize: 5 });
  return { total: j.total, taxa: j.data.length ? j.data.every((o) => typeof o.deliverymanFee === 'number') : null };
}

module.exports = { configurada, variaveis, pedidos, paraImportacao, testa };
