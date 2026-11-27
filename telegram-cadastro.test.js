// Telegram: /start cria um pedido a aprovar; o administrador aprova ou recusa; só aprovados recebem; /parar sai.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-tgc-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const PORT = 4800 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
let srv, tg; const msgs = []; let updates = [];
const espera = async (cond, ms = 15000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const dest = () => db.prepare('SELECT chat_id, nome, tipo, status FROM telegram_dest ORDER BY chat_id').all().map((x) => ({ ...x }));
const para = (id) => msgs.filter((m) => String(m.chat_id) === String(id)).map((m) => m.text);
const msg = (uid, text, chat, extra = {}) => ({ update_id: uid, message: { chat: { id: chat, first_name: chat === 111 ? 'Ana' : 'Beto', type: 'private', ...extra }, text } });

before(async () => {
  tg = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const j = b ? JSON.parse(b) : {};
      if (req.url === `/bot${TOKEN}/sendMessage`) msgs.push(j);
      if (req.url === `/bot${TOKEN}/getMe`) return res.end(JSON.stringify({ ok: true, result: { username: 'meubot' } }));
      if (req.url === `/bot${TOKEN}/getUpdates`) return res.end(JSON.stringify({ ok: true, result: updates.filter((u) => u.update_id >= (j.offset || 0)) }));
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((ok) => tg.listen(0, '127.0.0.1', ok));
  db.prepare("INSERT INTO usuarios (nome, login, senha, perfil) VALUES ('Adm', 'adm', ?, 'admin')").run(hashSenha('senha12345'));
  db.prepare("INSERT INTO config (chave, valor) VALUES ('telegram_token', ?)").run(TOKEN);
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '', SYNC_ENTREGADORES: '0', FECHAMENTO_PASSO_MS: '300', TELEGRAM_API_URL: `http://127.0.0.1:${tg.address().port}` } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); tg.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('link do bot, /start vira pedido, aprovar/recusar, só aprovados recebem, /parar sai', async () => {
  const ck = (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'adm', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const post = async (u, dados = {}) => decodeURIComponent((await fetch(B + u, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '');
  const tela = async () => (await fetch(`${B}/config?aba=alertas`, { headers: { cookie: ck } })).text();

  // o link do bot aparece sozinho (o app descobre o usuário do bot)
  assert.ok(await espera(() => db.prepare("SELECT valor FROM config WHERE chave = 'telegram_bot_user'").get()?.valor === 'meubot'), 'descobriu o bot');
  let h = await tela();
  assert.ok(h.includes('https://t.me/meubot') && !h.includes('start='), 'link simples, sem código');
  assert.ok(h.includes('Pedidos para receber') && h.includes('Recebem os alertas') && !h.includes(TOKEN));

  // /start de duas pessoas e um grupo: ficam pendentes, ainda não recebem
  updates = [msg(10, '/start', 111), msg(11, '/start@meubot', 222), msg(12, '/start', -500, { title: 'Grupo Financeiro', type: 'group' }), msg(13, 'oi', 333)];
  assert.ok(await espera(() => dest().length === 3), 'três pedidos');
  assert.deepStrictEqual(dest().map((x) => [x.chat_id, x.nome, x.tipo, x.status]).sort(), [['-500', 'Grupo Financeiro', 'grupo', 'pendente'], ['111', 'Ana', 'conversa', 'pendente'], ['222', 'Beto', 'conversa', 'pendente']]);
  assert.ok(await espera(() => para(111).some((t) => /Pedido enviado/.test(t))));
  assert.strictEqual(para(333).length, 0, 'mensagem que não é /start é ignorada');
  assert.ok((await tela()).includes('Ana') && (await tela()).includes('Aprovar'), 'tela lista os pedidos');
  const antes = msgs.length;
  assert.match(await post('/config/automacao/teste', { hora_fechamento: '06:00', hora_corte: '05:00' }), /Não enviou|não configurado/i); // ninguém aprovado ainda
  assert.strictEqual(msgs.length, antes, 'pendente não recebe alerta');

  // /start repetido não duplica
  updates = [...updates, msg(14, '/start', 111)];
  assert.ok(await espera(() => para(111).some((t) => /já foi enviado/.test(t))));
  assert.strictEqual(dest().length, 3);

  // aprovar Ana, recusar Beto
  assert.match(await post('/config/telegram/aprovar', { id: '111' }), /Ana aprovado/);
  assert.match(await post('/config/telegram/remover', { id: '222' }), /não recebe mais/);
  assert.ok(para(111).some((t) => /Acesso aprovado/.test(t)), 'Ana é avisada');
  assert.deepStrictEqual(dest().map((x) => [x.chat_id, x.status]).sort(), [['-500', 'pendente'], ['111', 'aprovado']]);
  assert.match(await post('/config/telegram/aprovar', { id: '999' }), /não encontrado/);

  // só a aprovada recebe o alerta
  const n0 = msgs.length;
  assert.match(await post('/config/automacao/teste', { hora_fechamento: '06:00', hora_corte: '05:00' }), /Mensagem de teste enviada/);
  const novas = msgs.slice(n0).filter((m) => /Teste do sistema/.test(m.text));
  assert.deepStrictEqual(novas.map((m) => String(m.chat_id)), ['111']);
  assert.ok((await tela()).includes('Remover'));

  // um novo pedido avisa quem já recebe
  updates = [...updates, msg(15, '/start', 444)];
  assert.ok(await espera(() => msgs.some((m) => String(m.chat_id) === '111' && /pediu para receber/.test(m.text))), 'aprovadores são avisados do novo pedido');

  // /parar
  updates = [...updates, msg(16, '/parar', 111)];
  assert.ok(await espera(() => !dest().some((x) => x.chat_id === '111')), 'Ana saiu');
  assert.ok(await espera(() => para(111).some((t) => /não receberá mais/.test(t))));
});
