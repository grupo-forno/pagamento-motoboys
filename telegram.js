// Alertas pelo Telegram (bot). O token NUNCA fica na tela nem no banco: só na variável TELEGRAM_BOT_TOKEN (servidor, ou .env no computador local).
// Quem recebe: pessoas que mandam /start ao bot ficam em "Pedidos para receber" até um administrador aprovar (tabela telegram_dest).
// Ids antigos digitados à mão (config telegram_chat / TELEGRAM_CHAT_ID) continuam valendo.
const { cfg } = require('./relatorio');
const { db } = require('./db');

const BASE = () => (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
const grava = (k, v) => db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));
const legado = () => String(cfg('telegram_chat') || '').split(/[\s,;]+/).filter(Boolean);
const aprovados = () => db.prepare("SELECT * FROM telegram_dest WHERE status = 'aprovado' ORDER BY aprovado_em, pediu_em").all();
const pendentes = () => db.prepare("SELECT * FROM telegram_dest WHERE status = 'pendente' ORDER BY pediu_em").all();
const ids = () => [...new Set([...aprovados().map((x) => x.chat_id), ...legado()])];
const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const configurado = () => !!(token() && ids().length);

async function api(metodo, corpo) {
  const t = token();
  if (!t) throw new Error('Token do bot do Telegram não configurado (variável TELEGRAM_BOT_TOKEN no servidor).');
  let r;
  try { r = await fetch(`${BASE()}/bot${t}/${metodo}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('Não consegui falar com o Telegram.'); } // sem a URL na mensagem: ela leva o token
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`Telegram recusou: ${j.description || `erro ${r.status}`}`);
  return j.result;
}

// Retorna { enviado: true } (chegou em ao menos um chat) ou { enviado: false, motivo } (nunca lança: um alerta que falha não pode derrubar o fechamento).
async function avisar(texto) {
  if (!configurado()) return { enviado: false, motivo: 'Telegram não configurado' };
  const rs = await Promise.allSettled(ids().map((chat_id) => api('sendMessage', { chat_id, text: String(texto).slice(0, 4000), disable_web_page_preview: true })));
  const falha = rs.find((r) => r.status === 'rejected');
  return rs.some((r) => r.status === 'fulfilled') ? { enviado: true } : { enviado: false, motivo: falha?.reason?.message || 'erro' };
}
const paraChat = (chat_id, text) => api('sendMessage', { chat_id, text }).catch(() => {}); // mensagem a uma pessoa; falha não importa

// Usuário do bot (para o link t.me/<bot>); guardado depois da primeira consulta.
async function botUser() {
  const bid = token().split(':')[0]; // trocou o bot (token novo): esquece o usuário e a posição de leitura do bot anterior
  if (bid && cfg('telegram_bot_id') !== bid) { grava('telegram_bot_id', bid); grava('telegram_bot_user', ''); grava('telegram_offset', '0'); }
  let u = cfg('telegram_bot_user');
  if (!u && token()) { u = (await api('getMe', {})).username || ''; if (u) grava('telegram_bot_user', u); }
  return u;
}

// ---- Aprovação de quem quer receber ----
const aprova = (id, usuario) => db.prepare("UPDATE telegram_dest SET status = 'aprovado', aprovado_em = datetime('now','localtime'), aprovado_por = ? WHERE chat_id = ? AND status = 'pendente'").run(usuario ?? null, String(id)).changes > 0;
function remove(id) { // recusa um pedido ou remove quem já recebe (inclui id antigo digitado à mão)
  id = String(id);
  const n = db.prepare('DELETE FROM telegram_dest WHERE chat_id = ?').run(id).changes, l = legado();
  if (l.includes(id)) { grava('telegram_chat', l.filter((x) => x !== id).join(',')); return true; }
  return n > 0;
}
const nomeDe = (c) => c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id);

// Lê as mensagens novas do bot: "/start" cria um pedido (a aprovar), "/parar" tira a pessoa. Retorna o que aconteceu nesta rodada.
async function sincroniza() {
  if (!token()) return [];
  await botUser().catch(() => {});
  const off = Number(cfg('telegram_offset')) || 0, eventos = [];
  const up = await api('getUpdates', { offset: off || undefined, limit: 50, timeout: 0, allowed_updates: ['message'] });
  for (const u of up) {
    const m = u.message, chat = m?.chat, cmd = /^\/(start|parar)(?:@\w+)?(?:\s+\S+)?$/i.exec(String(m?.text || '').trim());
    grava('telegram_offset', u.update_id + 1);
    if (!chat || !cmd) continue;
    const id = String(chat.id), nome = nomeDe(chat), tipo = chat.type === 'private' ? 'conversa' : 'grupo', row = db.prepare('SELECT status FROM telegram_dest WHERE chat_id = ?').get(id);
    if (cmd[1].toLowerCase() === 'parar') {
      if (remove(id)) { eventos.push({ id, nome, acao: 'saiu dos alertas' }); await paraChat(id, 'Pronto: você não receberá mais os alertas. Para voltar, envie /start.'); }
      continue;
    }
    if (row?.status === 'aprovado' || legado().includes(id)) { await paraChat(id, '✅ Você já recebe os alertas do Pagamento de Entregadores. Para sair, envie /parar.'); continue; }
    if (row) { await paraChat(id, 'Seu pedido já foi enviado e está aguardando aprovação.'); continue; }
    db.prepare("INSERT INTO telegram_dest (chat_id, nome, tipo, status) VALUES (?, ?, ?, 'pendente')").run(id, nome, tipo);
    eventos.push({ id, nome, acao: 'pediu para receber os alertas' });
    await paraChat(id, 'Pedido enviado! Assim que um administrador aprovar, você começa a receber os alertas aqui.');
    if (ids().length) await avisar(`🔔 ${nome} pediu para receber os alertas. Aprove em Configurações › Alertas.`);
  }
  return eventos;
}

module.exports = { avisar, configurado, ids, legado, aprovados, pendentes, aprova, remove, botUser, paraChat, sincroniza };
