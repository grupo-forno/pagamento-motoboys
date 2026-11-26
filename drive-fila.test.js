// API do Apps Script (pasta MOTOBOYS no Drive): autenticação por segredo, fila persistente, download validável e confirmação idempotente.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-drive-'));
process.env.DATA_DIR = DIR;
const { db } = require('./db');
const SEGREDO = 'segredo-de-teste-com-mais-de-24-caracteres', PORT = 4800 + Math.floor(Math.random() * 90), B = `http://127.0.0.1:${PORT}`;
let srv, fid;

const api = (u, o = {}, seg = SEGREDO) => fetch(B + u, { ...o, headers: { ...(seg ? { authorization: `Bearer ${seg}` } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) } });
const sobe = async (env) => {
  srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', ...env } });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((ok, erro) => { srv.stdout.on('data', (d) => String(d).includes('Pagamento Entregadores') && ok()); srv.on('exit', erro); });
};
const para = () => new Promise((ok) => { srv.on('exit', ok); srv.kill(); });

before(() => {
  const loja = db.prepare('SELECT id FROM lojas LIMIT 1').get().id;
  fid = db.prepare("INSERT INTO fechamentos (loja_id, data_ini, data_fim, status, versao, pagamento) VALUES (?, '2026-11-20', '2026-11-22', 'enviado', 1, '2026-11-26')").run(loja).lastInsertRowid;
  db.prepare('INSERT INTO drive_fila (fechamento_id, arquivo) VALUES (?, ?)').run(fid, `26-11-2026-motoboys${fid}.xlsx`);
});
after(async () => { if (srv && srv.exitCode === null && srv.signalCode === null) await para(); db.close(); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('sem segredo configurado a API fica desligada (503)', async () => {
  await sobe({ DRIVE_SCRIPT_SEGREDO: '' });
  assert.strictEqual((await api('/api/drive/pendentes')).status, 503);
  await para();
});

test('autenticação, pendentes, download do .xlsx e confirmação repetível', async () => {
  await sobe({ DRIVE_SCRIPT_SEGREDO: SEGREDO });
  assert.strictEqual((await api('/api/drive/pendentes', {}, '')).status, 401, 'sem token');
  assert.strictEqual((await api('/api/drive/pendentes', {}, 'errado-errado-errado-errado-errado')).status, 401, 'token errado');
  const lista = await (await api('/api/drive/pendentes')).json();
  assert.deepStrictEqual(lista.pendentes.map((p) => [p.id, p.arquivo]), [[fid, `26-11-2026-motoboys${fid}.xlsx`]]);
  // download: .xlsx de verdade (zip "PK"), com o mesmo SHA-256 informado no cabeçalho
  const r = await api(lista.pendentes[0].download), buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');
  assert.strictEqual(r.headers.get('x-content-sha256'), crypto.createHash('sha256').update(buf).digest('hex'));
  assert.strictEqual(r.headers.get('x-arquivo'), `26-11-2026-motoboys${fid}.xlsx`);
  // falha informada: continua pendente
  assert.strictEqual((await api(`/api/drive/fechamentos/${fid}/falha`, { method: 'POST', body: JSON.stringify({ erro: 'Drive fora do ar' }) })).status, 200);
  assert.strictEqual((await (await api('/api/drive/pendentes')).json()).pendentes[0].tentativas, 1);
  // confirmação inválida não grava; válida grava; repetida aceita e mantém o primeiro ID
  assert.strictEqual((await api(`/api/drive/fechamentos/${fid}/confirmar`, { method: 'POST', body: JSON.stringify({ driveId: 'x' }) })).status, 400);
  const c1 = await (await api(`/api/drive/fechamentos/${fid}/confirmar`, { method: 'POST', body: JSON.stringify({ driveId: '1AbCdEfGhIjKlMnOp' }) })).json();
  assert.deepStrictEqual(c1, { ok: true, repetido: false, driveId: '1AbCdEfGhIjKlMnOp' });
  const c2 = await api(`/api/drive/fechamentos/${fid}/confirmar`, { method: 'POST', body: JSON.stringify({ driveId: '1OutroIdQualquer99' }) });
  assert.strictEqual(c2.status, 200);
  assert.deepStrictEqual(await c2.json(), { ok: true, repetido: true, driveId: '1AbCdEfGhIjKlMnOp' });
  assert.deepStrictEqual((await (await api('/api/drive/pendentes')).json()).pendentes, [], 'confirmado sai da fila');
  assert.strictEqual((await api('/api/drive/fechamentos/99999/confirmar', { method: 'POST', body: JSON.stringify({ driveId: '1AbCdEfGhIjKlMnOp' }) })).status, 404);
  // a fila é persistente: reiniciar o servidor mantém o estado
  await para(); await sobe({ DRIVE_SCRIPT_SEGREDO: SEGREDO });
  assert.deepStrictEqual((await (await api('/api/drive/pendentes')).json()).pendentes, []);
  assert.strictEqual(db.prepare('SELECT drive_id FROM drive_fila WHERE fechamento_id = ?').get(fid).drive_id, '1AbCdEfGhIjKlMnOp');
  await para();
});
