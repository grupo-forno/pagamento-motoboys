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
// Uma credencial pode autorizar VÁRIAS lojas e /orders devolve todas elas: filtra pela loja do cadastro (storeId + conferência do pedido).
async function pedidos(l, de, ate) {
  const sid = await lojaDoFiltro(l), todos = [];
  const daLoja = (o) => !sid || !o.store?.id || String(o.store.id) === String(sid);
  for (let page = 1; page <= 100; page++) {
    const j = await get(l, '/orders', { from: de, to: ate, page, pageSize: 100, ...(sid ? { storeId: sid } : {}) });
    todos.push(...j.data);
    if (!j.data.length || todos.length >= j.total) return todos.filter(daLoja);
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
  const excluidos = {}; // o que o pagamento deixa de fora, por status: { COMPLETED_SEM_ENTREGADOR|CANCELED|...: { n, valor (centavos) } }
  const exclui = (k, o) => { const x = (excluidos[k] ||= { n: 0, valor: 0 }); x.n++; x.valor += typeof o.deliverymanFee === 'number' ? Math.round(o.deliverymanFee * 100) : 0; };
  for (const o of orders) {
    if (o.status !== 'COMPLETED') { naoFinalizados++; exclui(o.status, o); continue; }
    if (!o.deliveryman) { semEntregador++; exclui('FINALIZADO_SEM_ENTREGADOR', o); continue; }
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
  return { pedidos: lista, resumo: [...por.values()], semEntregador, naoFinalizados, fora, excluidos };
}

// Entregadores que aparecem nos pedidos dos últimos dias (a API não tem lista de entregadores): id e nome mais recente.
// A janela máxima da API é de cerca de 3 meses.
// GET /deliverymen traz todos os vinculados (e cpf/pixKeys se a credencial tiver DELIVERYMAN_PAYOUT); sem o escopo DELIVERYMEN (403), cai nos pedidos.
async function listaDeliverymen(l) {
  const out = [], sid = await lojaDoFiltro(l);
  let vistos = 0; // a parada conta o que a API devolveu, não só o que ficou depois do filtro de loja
  for (let page = 1; page <= 1000; page++) {
    const j = await get(l, '/deliverymen', { page, pageSize: 100 });
    vistos += j.data.length;
    for (const d of j.data) if (!sid || !d.stores?.length || d.stores.some((s) => String(s.storeId) === String(sid))) out.push({ id: d.id, nome: String(d.name || '').trim() || `Entregador ${d.id}`, cpf: d.cpf || null, pix: (d.pixKeys || [])[0] || null });
    if (!j.data.length || vistos >= j.total) return out;
  }
  return out;
}
async function entregadores(l, dias = 80) {
  try { return await listaDeliverymen(l); } catch (e) { if (!/erro 403/.test(e.message)) throw e; }
  const ate = new Date(), de = new Date(ate.getTime() - dias * 864e5), por = new Map();
  for (const o of await pedidos(l, de.toISOString(), ate.toISOString()))
    if (o.deliveryman?.id != null && !por.has(o.deliveryman.id)) por.set(o.deliveryman.id, String(o.deliveryman.name || '').trim() || `Entregador ${o.deliveryman.id}`);
  return [...por].map(([id, nome]) => ({ id, nome }));
}

// Teste de conexão (Configurações > Lojas): pega o token e olha os últimos pedidos.
async function testa(l) {
  const ate = new Date(), de = new Date(ate.getTime() - 7 * 864e5);
  const j = await get(l, '/orders', { from: de.toISOString(), to: ate.toISOString(), page: 1, pageSize: 5 });
  return { total: j.total, taxa: j.data.length ? j.data.every((o) => typeof o.deliverymanFee === 'number') : null };
}

// storeId da loja, pela própria credencial da API oficial (GET /stores): a única loja autorizada, ou a de mesmo nome.
const lojasCache = new Map(); // id da credencial -> { em, lista } (10 min)
const semAc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
async function lojasDaCredencial(l) {
  const k = credenciais(l)?.id, c = lojasCache.get(k);
  if (c && Date.now() - c.em < 600e3) return c.lista;
  const lista = ((await get(l, '/stores', { page: 1, pageSize: 100 })).data || []).filter((s) => s && s.id != null && typeof s.name === 'string');
  lojasCache.set(k, { em: Date.now(), lista });
  return lista;
}
async function storeId(l) {
  const lista = await lojasDaCredencial(l);
  return (lista.length === 1 ? lista[0] : lista.find((s) => semAc(s.name) === semAc(l.nome)))?.id || null;
}
// Qual loja do Agilizone os dados desta loja estão lendo (para a tela mostrar): { id, nome, lojas } ou null.
async function lojaLida(l) {
  try { const sid = await lojaDoFiltro(l), lista = await lojasDaCredencial(l), s = lista.find((x) => String(x.id) === String(sid)); return s ? { id: s.id, nome: s.name, lojas: lista.length } : null; } catch { return null; }
}
// Loja para filtrar pedidos/entregadores. Credencial com várias lojas: só segue se alguma tiver o nome da loja (senão misturaria as lojas).
async function lojaDoFiltro(l) {
  let lista;
  try { lista = await lojasDaCredencial(l); } catch (e) { if (/erro (403|404)/.test(e.message)) return null; throw e; } // sem /stores na credencial: sem filtro
  if (lista.length <= 1) return lista[0]?.id ?? null;
  const s = lista.find((x) => semAc(x.name) === semAc(l.nome));
  if (!s) throw erro(`A credencial de ${l.nome} enxerga ${lista.length} lojas (${lista.map((x) => x.name).join(', ')}) e nenhuma tem esse nome. O nome da loja em Configurações precisa ser igual ao do Agilizone, senão pedidos de lojas diferentes se misturam.`);
  return s.id;
}

// ---- Painel (ledger.agilizone.com): ocorrências dos entregadores ----
// Não é a API oficial: usa o token (Bearer) de um login do painel, que expira. de/ate em ISO.
const LEDGER = () => (process.env.AGILIZONE_LEDGER_URL || 'https://ledger.agilizone.com').replace(/\/$/, '');
function tokenPainelExpira(tk) { try { return JSON.parse(Buffer.from(tk.split('.')[1], 'base64url')).exp * 1000 || null; } catch { return null; } }
// Login automático: AGILIZONE_PAINEL_EMAIL e AGILIZONE_PAINEL_SENHA no servidor (o token dura 7 dias e não há refresh: loga de novo).
// Sem elas, vale o token colado em Configurações (que expira).
const AUTH = () => (process.env.AGILIZONE_AUTH_URL || 'https://auth.agilizone.com').replace(/\/$/, '');
const painelLogin = () => !!(process.env.AGILIZONE_PAINEL_EMAIL && process.env.AGILIZONE_PAINEL_SENHA);
let sessao = null; // { jwt, exp }
async function tokenPainel(manual, renova) {
  if (!painelLogin()) return manual;
  if (!renova && sessao && sessao.exp - Date.now() > 3600e3) return sessao.jwt;
  const r = await chama(`${AUTH()}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: process.env.AGILIZONE_PAINEL_EMAIL, password: process.env.AGILIZONE_PAINEL_SENHA }) });
  if ([400, 401, 403, 422].includes(r.status)) throw erro('O painel do Agilizone recusou o login automático. Confira AGILIZONE_PAINEL_EMAIL e AGILIZONE_PAINEL_SENHA no servidor.');
  if (!r.ok) throw erro(`O login do painel do Agilizone não respondeu (erro ${r.status}).`);
  const jwt = (await r.json()).jwt;
  if (!jwt) throw erro('O login do painel do Agilizone não devolveu o token.');
  sessao = { jwt, exp: tokenPainelExpira(jwt) || Date.now() + 6 * 864e5 };
  return jwt;
}
// O painel pede as ocorrências POR ENTREGADOR (GET /occurrences?storeId&deliverymanId&from&to), igual ao Resumo. ids = entregadores com pedido no período.
async function ocorrencias(storeId, de, ate, manual, ids = []) {
  const from = new Date(de).toISOString(), to = new Date(ate).toISOString();
  const busca = async (id) => {
    const url = `${LEDGER()}/occurrences?${new URLSearchParams({ storeId, deliverymanId: String(id), from, to })}`;
    let r;
    for (let t = 0; t < 2; t++) {
      const tk = await tokenPainel(manual, t > 0);
      if (!tk) throw erro('Painel do Agilizone sem acesso: defina AGILIZONE_PAINEL_EMAIL e AGILIZONE_PAINEL_SENHA no servidor.');
      const exp = tokenPainelExpira(tk);
      if (!painelLogin() && exp && exp < Date.now()) throw erro('O token do painel do Agilizone expirou. Cole um novo em Configurações > Lojas.');
      r = await chama(url, { headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json' } });
      if (!(r.status === 401 && painelLogin() && t === 0)) break; // token vencido: loga de novo e repete
    }
    if (r.status === 401 || r.status === 403) throw erro(`O painel do Agilizone recusou o acesso às ocorrências (erro ${r.status}, storeId ${storeId}): o usuário do painel não tem acesso a esta loja ou o storeId não é o do painel. Confira em Configurações > Lojas.`);
    if (!r.ok) throw erro(`O painel do Agilizone não respondeu às ocorrências (erro ${r.status}: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 160)}). Confira o storeId da loja em Configurações > Lojas.`);
    const lista = await r.json();
    return Array.isArray(lista) ? lista : lista.content || [];
  };
  const todas = [], un = [...new Set(ids.map(String))];
  if (un.length) await tokenPainel(manual); // 1 login antes das buscas em paralelo
  for (let i = 0; i < un.length; i += 6) todas.push(...(await Promise.all(un.slice(i, i + 6).map(busca))).flat());
  const estornadas = new Set(todas.map((o) => o.reversesId).filter(Boolean)); // ocorrência desfeita não conta (nem o estorno)
  const por = new Map(); // deliverymanId -> { valor (centavos), qtd, itens }
  for (const o of todas) {
    if (o.reversesId || estornadas.has(o.id)) continue;
    const k = String(o.deliverymanId), x = por.get(k) || { valor: 0, qtd: 0, itens: [] };
    x.valor += Number(o.value) || 0; x.qtd++; x.itens.push(`${o.name}${o.description ? `: ${o.description}` : ''}`);
    por.set(k, x);
  }
  return por;
}

module.exports = { ocorrencias, storeId, lojaLida, tokenPainelExpira, painelLogin, configurada, variaveis, pedidos, entregadores, paraImportacao, testa };
