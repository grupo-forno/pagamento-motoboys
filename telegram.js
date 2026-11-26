// Alertas pelo Telegram (bot). Token e chat ficam em Configurações (ou TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no servidor).
const { cfg } = require('./relatorio');

const BASE = () => (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
const configurado = () => !!(cfg('telegram_token') && cfg('telegram_chat'));

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

// Retorna { enviado: true } ou { enviado: false, motivo } (nunca lança: um alerta que falha não pode derrubar o fechamento).
async function avisar(texto) {
  if (!configurado()) return { enviado: false, motivo: 'Telegram não configurado' };
  try { await api('sendMessage', { chat_id: cfg('telegram_chat'), text: String(texto).slice(0, 4000), disable_web_page_preview: true }); return { enviado: true }; }
  catch (e) { return { enviado: false, motivo: e.message }; }
}

// Quem falou com o bot (para descobrir o chat id): [{ id, nome }]
async function chats() {
  const up = await api('getUpdates', { limit: 100 }), por = new Map();
  for (const u of up) { const c = (u.message || u.channel_post || u.my_chat_member)?.chat; if (c) por.set(String(c.id), { id: String(c.id), nome: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '(sem nome)' }); }
  return [...por.values()];
}

module.exports = { avisar, chats, configurado };
