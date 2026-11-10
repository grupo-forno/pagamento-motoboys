// node scripts/revisar-financeiro.cjs: servidor isolado, sem usar ./data/motoboys.db.
// --capturar: requer Playwright resolvível ou PLAYWRIGHT_MODULE; usa Edge headless.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fin-revisao-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_SENHA = 'admin-ficticio-revisao';
const { db, hashSenha } = require('../db');
const fixture = require('../test-support/financeiro-fixture.cjs')(db, hashSenha);
const port = process.env.REVIEW_PORT || '4098', base = `http://127.0.0.1:${port}`;
const servidor = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: port, HOST: '127.0.0.1', ALERTAS: '0', SYNC_ENTREGADORES: '0', EMAIL_SO_ARQUIVO: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
const fechar = () => { servidor.kill(); db.close(); };
process.on('SIGINT', () => { fechar(); process.exit(0); });
process.on('SIGTERM', () => { fechar(); process.exit(0); });
async function capturar() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const pasta = path.join(root, 'data', process.env.REVIEW_BASELINE ? 'financeiro-baseline' : 'financeiro-review');
  fs.mkdirSync(pasta, { recursive: true });
  try {
    for (const perfil of ['desp', 'fin']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.request.post(base + '/login', { form: { login: perfil + '-revisao', senha: fixture.senha } });
      const page = await context.newPage();
      const telas = perfil === 'desp' ? [['pendencias', '/'], ['importar', '/fechamentos/novo'], ['fechamento-desp', `/fechamentos/${fixture.ids.rascunho}`], ['entregadores', '/entregadores']] : [['para-aprovar', '/'], ['detalhe-fin', `/fechamentos/${fixture.ids.parcial}`], ['pagamentos', '/pagar'], ['pagos', '/pagar?aba=pagos&per=tudo']];
      for (const [nome, url] of telas) {
        await page.goto(base + url);
        await page.screenshot({ path: path.join(pasta, nome + '.png') });
      }
      await context.close();
    }
    console.log(`Capturas: ${pasta}`);
  } finally { await browser.close(); }
}
let iniciado = false;
servidor.stdout.on('data', async (chunk) => {
  if (iniciado || !String(chunk).includes('Pagamento Entregadores')) return;
  iniciado = true;
  console.log(`Revisão fictícia em ${base}\nBanco temporário: ${dir}\nLogins: fin-revisao, fin-loja, desp-revisao, gestao-revisao\nSenha fictícia: ${fixture.senha}`);
  if (process.argv.includes('--capturar')) {
    try { await capturar(); } catch (err) { console.error(err); process.exitCode = 1; } finally { fechar(); }
  }
});
servidor.on('exit', (code) => { if (!iniciado && code) process.exitCode = code; });
