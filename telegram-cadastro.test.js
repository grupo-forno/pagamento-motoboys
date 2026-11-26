// Cadastro automático no Telegram: link com código secreto; "/start <código>" cadastra, código errado não, "/parar" remove.
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
const cfg = (k) => db.prepare('SELECT valor FROM config WHERE chave = ?').get(k)?.valor ?? '';
const msg = (id, text, chat) => ({ update_id: id, message: { chat: { id: chat, first_name: chat === 111 ? 'Ana' : 'Intruso' }, text } });

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

test('link de cadastro, /start com código cadastra, código errado não, /parar remove', async () => {
  const ck = (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'adm', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const loc = decodeURIComponent((await fetch(`${B}/config/automacao/link`, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams({ hora_fechamento: '06:00', hora_corte: '05:00' }), redirect: 'manual' })).headers.get('location'));
  assert.match(loc, /Link de cadastro pronto/, loc);
  const codigo = cfg('telegram_convite');
  assert.ok(codigo.length >= 12);
  const tela = await (await fetch(`${B}/config?aba=alertas`, { headers: { cookie: ck } })).text();
  assert.ok(tela.includes(`https://t.me/meubot?start=${codigo}`), 'tela mostra o link');
  assert.ok(!tela.includes(TOKEN), 'sem o token na tela');

  updates = [msg(10, `/start ${codigo}`, 111), msg(11, '/start errado', 222), msg(12, '/start', 333)];
  assert.ok(await espera(() => cfg('telegram_chat') === '111'), 'Ana cadastrada');
  assert.deepStrictEqual(JSON.parse(cfg('telegram_nomes')), { 111: 'Ana' });
  assert.ok(await espera(() => msgs.some((m) => String(m.chat_id) === '111' && /Cadastrado/.test(m.text))), 'confirmação para Ana');
  assert.ok(await espera(() => msgs.filter((m) => ['222', '333'].includes(String(m.chat_id))).length === 2), 'sem código: só orienta');
  assert.ok(msgs.filter((m) => String(m.chat_id) !== '111').every((m) => /abra o link de cadastro/.test(m.text)));
  assert.strictEqual(cfg('telegram_chat'), '111', 'ninguém mais entrou');
  // o mesmo /start de novo não duplica
  updates = [...updates, msg(13, `/start ${codigo}`, 111)];
  assert.ok(await espera(() => msgs.filter((m) => /já estava cadastrado/.test(m.text)).length === 1));
  assert.strictEqual(cfg('telegram_chat'), '111');
  // alerta chega em quem está cadastrado
  assert.ok((await (await fetch(`${B}/config/automacao/teste`, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams({ hora_fechamento: '06:00', hora_corte: '05:00', telegram_chat: '111' }), redirect: 'manual' })).headers.get('location')).length > 0);
  assert.ok(msgs.some((m) => String(m.chat_id) === '111' && /Teste do sistema/.test(m.text)));
  // /parar remove
  updates = [...updates, msg(14, '/parar', 111)];
  assert.ok(await espera(() => cfg('telegram_chat') === ''), 'Ana removida');
  // link novo invalida o antigo
  await fetch(`${B}/config/automacao/link-novo`, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams({ hora_fechamento: '06:00', hora_corte: '05:00', telegram_chat: '' }), redirect: 'manual' });
  assert.notStrictEqual(cfg('telegram_convite'), codigo);
});
