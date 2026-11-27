// Fechamento automático: no dia de pagamento, sem pendências envia sozinho; com pendência não envia e avisa no Telegram (uma vez).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-auto-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const PORT = 4800 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
const { variaveis } = require('./agilizone');
const D = '2026-11-23'; // segunda: todas as lojas pagam
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
let srv, mock, tg, web; const msgs = [];
const espera = async (cond, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const envios = () => db.prepare('SELECT * FROM envios').all();

before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/auth/token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 86400 }));
    if (req.url.startsWith('/stores')) return res.end(JSON.stringify({ data: [{ id: 's1', name: 'Loja' }], page: 1, pageSize: 100, total: 1 }));
    const de = new Date(new URL(req.url, 'http://x').searchParams.get('from')).getTime();
    const o = (id, e, fee, h) => ({ id, orderDisplayNumber: id, status: 'COMPLETED', deliveryman: e, deliverymanFee: fee, createdAt: new Date(de + h * 36e5).toISOString() });
    const data = [o('a1', { id: 7, name: 'Kevin' }, 7.5, 3), o('a2', { id: 7, name: 'Kevin' }, 10, 30), o('a3', { id: 8, name: 'Marcos' }, 6, 4)];
    res.end(JSON.stringify({ data, page: 1, pageSize: 100, total: data.length }));
  });
  tg = http.createServer((req, res) => { // Telegram de mentira
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === `/bot${TOKEN}/sendMessage`) msgs.push(JSON.parse(b));
      if (req.url === `/bot${TOKEN}/getUpdates`) return res.end(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 987, first_name: 'Vic', last_name: 'Teste' } } }] }));
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  web = http.createServer((req, res) => { // App da Web do script (de mentira): marca como gravado o que está na fila
    req.on('data', () => {}); req.on('end', () => { db.prepare("UPDATE drive_fila_envios SET drive_id = '1GravadoPeloScript01' WHERE drive_id IS NULL").run(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, gravados: 1, falhas: 0 })); });
  });
  await Promise.all([mock, tg, web].map((s) => new Promise((ok) => s.listen(0, '127.0.0.1', ok))));
  const set = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?)');
  for (const [k, v] of [['auto_fechamento', '1'], ['hora_fechamento', '00:00'], ['telegram_chat', '42'], ['email_para', 'fin@exemplo.com']]) set.run(k, v);
  const creds = Object.fromEntries(db.prepare('SELECT * FROM lojas').all().flatMap((l) => [[variaveis(l).id, 'cid'], [variaveis(l).secret, 's']]));
  db.prepare("INSERT INTO usuarios (nome, login, senha, perfil) VALUES ('Adm', 'adm', ?, 'admin')").run(hashSenha('senha12345'));
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1',
    TELEGRAM_BOT_TOKEN: TOKEN, DRIVE_SCRIPT_SEGREDO: 'segredo-de-teste-com-mais-de-24-caracteres', DRIVE_SCRIPT_URL: `http://127.0.0.1:${web.address().port}`, AGORA_TESTE: `${D} 13:00`, FECHAMENTO_PASSO_MS: '300', FECHAMENTO_RETRY_MS: '800', TELEGRAM_API_URL: `http://127.0.0.1:${tg.address().port}`,
    AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, ...creds } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
});
after(async () => { await new Promise((ok) => { srv.on('exit', ok); srv.kill(); }); mock.close(); tg.close(); web.closeAllConnections(); web.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('com cadastro incompleto: não envia, avisa no Telegram e não repete o mesmo aviso', async () => {
  assert.ok(await espera(() => msgs.some((m) => /NÃO foi enviado/.test(m.text))), 'alerta no Telegram');
  const m = msgs.find((x) => /NÃO foi enviado/.test(x.text));
  assert.strictEqual(String(m.chat_id), '42');
  assert.match(m.text, /23\/11\/2026/);
  assert.match(m.text, /falta nome completo/);
  await new Promise((r) => setTimeout(r, 2500)); // várias tentativas com o mesmo problema
  assert.strictEqual(envios().length, 0, 'nada enviado');
  assert.strictEqual(msgs.filter((x) => /NÃO foi enviado/.test(x.text)).length, 1, 'o mesmo problema avisa uma vez só');
});

test('corrigido o cadastro: envia sozinho (e-mail + planilha) e confirma no Telegram, uma vez', async () => {
  db.prepare("UPDATE motoboys SET nome_completo = 'Entregador Teste ' || id, cpf = '07790030396'").run();
  assert.ok(await espera(() => envios().length === 1), 'envio automático');
  const e = envios()[0];
  assert.strictEqual(e.pagamento, D);
  assert.strictEqual(e.enviado_por, null, 'feito pelo sistema, sem usuário');
  assert.ok(fs.existsSync(path.join(DIR, 'envios', `${D}.xlsx`)), 'planilha guardada');
  assert.ok(fs.readdirSync(path.join(DIR, 'emails')).length >= 1, 'e-mail gerado');
  assert.ok(await espera(() => msgs.some((m) => /^✅ 23-11-2026 - MOTOBOYS enviado automaticamente/.test(m.text))), 'confirmação no Telegram');
  const m = msgs.find((x) => /^✅ 23-11-2026/.test(x.text));
  assert.match(m.text, /Confira o e-mail/);
  assert.match(m.text, /Planilha salva no Google Drive/); // Drive gravado na hora, junto do e-mail
  assert.ok(db.prepare('SELECT drive_id FROM drive_fila_envios').get().drive_id, 'planilha gravada no Drive');
  await new Promise((r) => setTimeout(r, 2000));
  assert.strictEqual(envios().length, 1, 'não envia de novo');
  assert.strictEqual(msgs.filter((x) => /^✅/.test(x.text)).length, 1);
});

test('Configurações: teste do Telegram e validação (o token nunca volta na tela)', async () => {
  const ck = (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'adm', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const post = async (url, dados) => decodeURIComponent((await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '');
  const base = { auto_fechamento: '1', hora_fechamento: '12:30', telegram_chat: '42' };
  const antes = msgs.length;
  assert.match(await post('/config/automacao/teste', base), /Mensagem de teste enviada/);
  assert.ok(msgs.length > antes && /Teste do sistema/.test(msgs.at(-1).text));
  assert.match(await post('/config/automacao', { ...base, hora_fechamento: '25:99' }), /Horário inválido/);
  assert.match(await post('/config/automacao', { ...base, telegram_chat: 'abc' }), /Chat ID inválido/);
  const tela = await (await fetch(`${B}/config?aba=alertas`, { headers: { cookie: ck } })).text();
  assert.ok(tela.includes('Envio automático do fechamento') && !tela.includes(TOKEN), 'tela sem o token');
});

test('teste agendado: roda o fluxo de verdade, manda só ao e-mail de teste, não registra nada e avisa no Telegram uma vez', async () => {
  const ck = (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'adm', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const post = async (url, dados) => decodeURIComponent((await fetch(B + url, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '');
  const base = { auto_fechamento: '1', hora_fechamento: '12:30', telegram_chat: '42', teste_data: D, teste_email: 'eu@exemplo.com' };
  assert.match(await post('/config/automacao/agendar-teste', { ...base, teste_hora: '12:00' }), /já passou/); // agora = 13:00
  assert.match(await post('/config/automacao/agendar-teste', { ...base, teste_hora: '13:30', teste_email: 'ruim' }), /e-mail válido/);
  assert.match(await post('/config/automacao/agendar-teste', { ...base, teste_hora: '13:30' }), /Teste agendado para hoje às 13:30/);
  assert.ok((await (await fetch(`${B}/config?aba=alertas`, { headers: { cookie: ck } })).text()).includes('Agendado para hoje às'), 'tela mostra o agendamento');
  // na hora marcada (simulada: o relógio do teste está em 13:00, então marcamos 12:59 direto)
  db.prepare("UPDATE config SET valor = ? WHERE chave = 'teste_auto'").run(JSON.stringify({ dia: D, hora: '12:59', data: D, email: 'eu@exemplo.com' }));
  const antes = fs.readdirSync(path.join(DIR, 'emails')).length;
  assert.ok(await espera(() => msgs.some((m) => /^🧪 TESTE automático OK/.test(m.text))), 'resultado no Telegram');
  assert.strictEqual(envios().length, 1, 'não registra envio');
  const novos = fs.readdirSync(path.join(DIR, 'emails')).slice(antes).map((f) => fs.readFileSync(path.join(DIR, 'emails', f), 'utf8'));
  assert.strictEqual(novos.length, 1);
  assert.match(novos[0], /Subject: \[TESTE\] 23-11-2026 - MOTOBOYS/);
  assert.match(novos[0], /To: eu@exemplo.com/);
  assert.ok(!novos[0].includes('fin@exemplo.com'), 'o financeiro não recebe');
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(msgs.filter((m) => /^🧪 TESTE automático OK/.test(m.text)).length, 1, 'roda uma vez só');
});
