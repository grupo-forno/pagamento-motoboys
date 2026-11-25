// Conferência geral: planilha de importação (modelo do financeiro) e envio ao Google Drive.
const crypto = require('node:crypto');
const XLSX = require('xlsx');

// CPF (11) ou CNPJ (14 dígitos), formatado como na planilha.
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
function docFmt(v) {
  const d = soDigitos(v);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}
const docValido = (v) => [11, 14].includes(soDigitos(v).length);

const titulo = (pagamento) => `${pagamento.split('-').reverse().join('-')} - MOTOBOYS`; // 23-11-2026 - MOTOBOYS
const capital = (s) => String(s).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

// linhas: [{ loja, centro, nome, doc, valor (centavos) }] -> buffer .xlsx no modelo
// VENCIMENTO | NOME | CPF/CNPJ | DESCRIÇÃO | CATEGORIA | CENTRO DE CUSTO | VALOR (negativo, saída)
function planilha(pagamento, linhas) {
  const [a, m, d] = pagamento.split('-').map(Number);
  const venc = Date.UTC(a, m - 1, d) / 864e5 + 25569; // número de série do Excel (sem fuso)
  const dados = [['VENCIMENTO', 'NOME', 'CPF/CNPJ', 'DESCRIÇÃO', 'CATEGORIA', 'CENTRO DE CUSTO', 'VALOR'],
    ...linhas.map((l) => [venc, l.nome.toUpperCase(), docFmt(l.doc), `Motoboys ${capital(l.centro)}`, 'Motoboys', l.centro.toUpperCase(), -l.valor / 100])];
  const ws = XLSX.utils.aoa_to_sheet(dados);
  for (let r = 1; r < dados.length; r++) { ws[XLSX.utils.encode_cell({ r, c: 0 })].z = 'dd/mm/yyyy'; ws[XLSX.utils.encode_cell({ r, c: 6 })].z = '#,##0.00'; }
  ws['!cols'] = [{ wch: 12 }, { wch: 44 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- Google Drive ----
// Credencial (Configurações > Google Drive): JSON de conta de serviço (type "service_account")
// ou de usuário autorizado (type "authorized_user": client_id, client_secret, refresh_token).
// Conta de serviço só grava em Drive compartilhado (não tem cota própria); pasta comum de terceiros: use authorized_user.
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
async function tokenDrive(cred) {
  let corpo;
  if (cred.type === 'service_account') {
    const agora = Math.floor(Date.now() / 1000);
    const cab = b64({ alg: 'RS256', typ: 'JWT' }), dados = b64({ iss: cred.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
    const ass = crypto.createSign('RSA-SHA256').update(`${cab}.${dados}`).sign(cred.private_key).toString('base64url');
    corpo = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${dados}.${ass}` };
  } else if (cred.refresh_token) {
    corpo = { grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token };
  } else throw new Error('Credencial do Google Drive inválida: use o JSON da conta de serviço ou de usuário autorizado (com refresh_token).');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(corpo), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google recusou a credencial do Drive: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}
const pastaId = (txt) => /folders\/([\w-]+)/.exec(txt)?.[1] || String(txt || '').trim();

// Sobe o arquivo na pasta (funciona em "Compartilhados comigo" e em Drive compartilhado). Retorna { id, link }.
async function subirDrive({ credencial, pasta, nome, buffer, mime }) {
  const cred = typeof credencial === 'string' ? JSON.parse(credencial) : credencial;
  const token = await tokenDrive(cred), fronteira = 'motoboys' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name: nome, parents: [pastaId(pasta)] });
  const corpo = Buffer.concat([Buffer.from(`--${fronteira}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${fronteira}\r\nContent-Type: ${mime}\r\n\r\n`), buffer, Buffer.from(`\r\n--${fronteira}--`)]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${fronteira}` }, body: corpo, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || r.status;
    throw new Error(/quota/i.test(msg) ? 'O Drive recusou: conta de serviço não tem espaço próprio. Use um Drive compartilhado ou a credencial de um usuário (authorized_user).' : /not found/i.test(msg) ? 'Pasta do Drive não encontrada: confira o link e se ela foi compartilhada (como Editor) com a conta da credencial.' : `Falha ao enviar ao Drive: ${msg}`);
  }
  return { id: j.id, link: j.webViewLink };
}

module.exports = { planilha, titulo, docFmt, docValido, soDigitos, subirDrive, pastaId };
