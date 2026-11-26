// Modo teste LOCAL (MODO_TESTE_LOCAL=1): envia o fechamento com cadastro incompleto, com [TESTE] no assunto e sem registrar nada.
// Em produção (NODE_ENV=production) o interruptor é ignorado.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-teste-'));
process.env.DATA_DIR = DIR;
const { db, hashSenha } = require('./db');
const { variaveis } = require('./agilizone');
const D = '2026-11-23';
let mock, creds; const servidores = [];

const sobe = async (extra) => {
  const PORT = 4900 + Math.floor(Math.random() * 90);
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1', MODO_TESTE_LOCAL: '1',
    AGILIZONE_URL: `http://127.0.0.1:${mock.address().port}`, ...creds, ...extra } });
  srv.stderr.on('data', (d) => process.stderr.write(d)); servidores.push(srv);
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
  const B = `http://127.0.0.1:${PORT}`;
  const ck = (await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ login: 'adm', senha: 'senha12345' }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  return { srv, get: (u) => fetch(B + u, { headers: { cookie: ck } }), post: async (u, dados) => decodeURIComponent((await fetch(B + u, { method: 'POST', headers: { cookie: ck }, body: new URLSearchParams(dados), redirect: 'manual' })).headers.get('location') || '') };
};
const para = (s) => new Promise((ok) => { s.on('exit', ok); s.kill(); });
const emails = () => (fs.existsSync(path.join(DIR, 'emails')) ? fs.readdirSync(path.join(DIR, 'emails')) : []);

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
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  creds = Object.fromEntries(db.prepare('SELECT * FROM lojas').all().flatMap((l) => [[variaveis(l).id, 'cid'], [variaveis(l).secret, 's']]));
  db.prepare("INSERT INTO config (chave, valor) VALUES ('email_para', 'fin@exemplo.com')").run();
  db.prepare("INSERT INTO usuarios (nome, login, senha, perfil) VALUES ('Adm', 'adm', ?, 'admin')").run(hashSenha('senha12345'));
});
after(async () => { for (const s of servidores) if (s.exitCode === null && s.signalCode === null) await para(s); mock.close(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('modo teste local: envia sem cadastro completo, com [TESTE], sem registrar nada e podendo reenviar', async () => {
  const s = await sobe({ NODE_ENV: 'development' });
  const h = await (await s.get(`/conferencia?d=${D}`)).text();
  assert.ok(h.includes('MODO TESTE LOCAL'), 'aviso do modo teste');
  const aba = db.prepare("SELECT id FROM lojas WHERE nome LIKE '%SUL'").get().id;
  assert.ok((await (await s.get(`/conferencia?d=${D}&aba=${aba}`)).text()).includes('Incompleto (teste)'), 'entregador sem cadastro aparece como incompleto');
  for (let i = 0; i < 2; i++) { // duas vezes: nada fica registrado
    assert.match(await s.post('/conferencia/enviar', { d: D, ok: '1' }), /TESTE enviado por e-mail para fin@exemplo.com/);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM envios').get().n, 0, 'nada registrado');
  assert.strictEqual(emails().length, 2);
  const eml = fs.readFileSync(path.join(DIR, 'emails', emails()[0]), 'utf8');
  assert.match(eml, /Subject: \[TESTE\] 23-11-2026 - MOTOBOYS/);
  assert.match(eml, /TESTE LOCAL/);
  // a prévia da planilha sai com o apelido do Agilizone e documento em branco
  const r = await s.get(`/conferencia/planilha?d=${D}`);
  const linhas = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await r.arrayBuffer())).Sheets.Planilha1, { header: 1, raw: true });
  assert.ok(linhas.some((l) => l[1] === 'KEVIN' && (l[2] === '' || l[2] === undefined)), JSON.stringify(linhas.slice(0, 3)));
  await para(s.srv);
});

test('em produção o interruptor é ignorado: continua bloqueando cadastro incompleto', async () => {
  const s = await sobe({ NODE_ENV: 'production' });
  const h = await (await s.get(`/conferencia?d=${D}`)).text();
  assert.ok(!h.includes('MODO TESTE LOCAL'));
  const antes = emails().length;
  assert.match(await s.post('/conferencia/enviar', { d: D, ok: '1' }), /pendência|Nada foi enviado/);
  assert.strictEqual(emails().length, antes, 'nenhum e-mail novo');
  await para(s.srv);
});
