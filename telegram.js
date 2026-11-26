// Alertas pelo Telegram (bot). Token e chats ficam em Configurações (ou TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no servidor).
// Cadastro automático: quem abre o link de convite (t.me/<bot>?start=<código>) e toca em Iniciar é cadastrado para receber os alertas.
const crypto = require('node:crypto');
const { cfg } = require('./relatorio');
const { db } = require('./db');

const BASE = () => (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
const ids = () => [...new Set(String(cfg('telegram_chat') || '').split(/[\s,;]+/).filter(Boolean))];
const configurado = () => !!(cfg('telegram_token') && ids().length);
const grava = (k, v) => db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor').run(k, String(v));
const nomes = () => { try { return JSON.parse(cfg('telegram_nomes') || '{}'); } catch { return {}; } };

async function api(metodo, corpo) {
  const token = cfg('telegram_token');
  if (!token) throw new Error('Token do bot do Telegram não configurado.');
  let r;
  try { r = await fetch(`${BASE()}/bot${token}/${metodo}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000) }); }
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

// Quem falou com o bot (para descobrir o chat id): [{ id, nome }]
async function chats() {
  const up = await api('getUpdates', { limit: 100 }), por = new Map();
  for (const u of up) { const c = (u.message || u.channel_post || u.my_chat_member)?.chat; if (c) por.set(String(c.id), { id: String(c.id), nome: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '(sem nome)' }); }
  return [...por.values()];
}

// ---- Cadastro automático por link de convite ----
const convite = (novo = false) => { // código secreto do link; sem ele ninguém se cadastra só por achar o bot
  let c = cfg('telegram_convite');
  if (!c || novo) { c = crypto.randomBytes(12).toString('base64url'); grava('telegram_convite', c); }
  return c;
};
async function link() { // https://t.me/<bot>?start=<código>
  if (!cfg('telegram_token')) return '';
  let u = cfg('telegram_bot_user');
  if (!u) { u = (await api('getMe', {})).username || ''; if (u) grava('telegram_bot_user', u); }
  return u ? `https://t.me/${u}?start=${convite()}` : '';
}
const nomeDe = (c) => c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id);
const responde = (chat_id, text) => api('sendMessage', { chat_id, text }).catch(() => {});

// Lê as mensagens novas: "/start <código>" cadastra o chat; "/parar" descadastra. Retorna os cadastrados/removidos nesta rodada.
async function sincroniza() {
  if (!cfg('telegram_token')) return [];
  const off = Number(cfg('telegram_offset')) || 0, eventos = [];
  const up = await api('getUpdates', { offset: off || undefined, limit: 50, timeout: 0, allowed_updates: ['message'] });
  for (const u of up) {
    const m = u.message, texto = String(m?.text || '').trim(), chat = m?.chat;
    grava('telegram_offset', u.update_id + 1);
    if (!chat) continue;
    const id = String(chat.id), lista = ids(), cmd = /^\/(start|parar)(?:@\w+)?(?:\s+(\S+))?$/i.exec(texto);
    if (!cmd) continue;
    if (cmd[1].toLowerCase() === 'parar') {
      if (lista.includes(id)) { grava('telegram_chat', lista.filter((x) => x !== id).join(',')); eventos.push({ id, nome: nomeDe(chat), acao: 'removido' }); await responde(id, 'Pronto: você não receberá mais os alertas. Para voltar, use o link de cadastro do sistema.'); }
      continue;
    }
    if (cmd[2] && cmd[2] === cfg('telegram_convite')) {
      if (!lista.includes(id)) { grava('telegram_chat', [...lista, id].join(',')); grava('telegram_nomes', JSON.stringify({ ...nomes(), [id]: nomeDe(chat) })); eventos.push({ id, nome: nomeDe(chat), acao: 'cadastrado' }); }
      await responde(id, lista.includes(id) ? '✅ Você já estava cadastrado(a) para receber os alertas do Pagamento de Entregadores.' : '✅ Cadastrado(a)! Você vai receber aqui os alertas do Pagamento de Entregadores (envios e erros). Para sair, envie /parar.');
    } else await responde(id, 'Para receber os alertas, abra o link de cadastro que está no sistema (Configurações > Alertas > Telegram).');
  }
  return eventos;
}

module.exports = { avisar, chats, configurado, ids, nomes, convite, link, sincroniza };
