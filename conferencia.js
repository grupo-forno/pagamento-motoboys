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

// ---- Planilha de importação do financeiro: segue À RISCA o modelo "PLANILHA IMPORTAÇÃO - Motoboys.xlsx" ----
// Aba "Planilha1"; colunas VENCIMENTO | NOME | CPF/CNPJ | DESCRIÇÃO | CATEGORIA | CENTRO DE CUSTO | VALOR.
// VENCIMENTO = data (número, formato m/d/yy do Excel); VALOR = negativo, formato contábil; larguras e estilos do modelo
// (modelo-planilha/styles.xml e theme1.xml são os do próprio modelo). O .xlsx é montado direto (sem biblioteca): cada
// célula e cada espaço seguem o modelo.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const MODELO = (f) => fs.readFileSync(path.join(__dirname, 'modelo-planilha', f));
// DESCRIÇÃO exata do modelo (note o espaço no fim em Leste e Sul). Outro centro de custo: "Motoboys <Nome>".
const DESCRICAO = { LESTE: 'Motoboys Leste ', DIRCEU: 'Motoboys Dirceu', SUL: 'Motoboys Sul ' };
const ORDEM_CENTROS = ['LESTE', 'DIRCEU', 'SUL']; // ordem das lojas no modelo; as demais vêm depois, em ordem alfabética
const CABECALHO = ['VENCIMENTO', 'NOME', 'CPF/CNPJ', 'DESCRIÇÃO', 'CATEGORIA', 'CENTRO DE CUSTO', 'VALOR'];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CAB = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function zip(entradas) { // [[nome, Buffer]] -> .zip (deflate)
  const locais = [], centrais = []; let off = 0;
  for (const [nome, dados] of entradas) {
    const n = Buffer.from(nome), c = zlib.deflateRawSync(dados), crc = zlib.crc32(dados) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(c.length, 18); h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(n.length, 26);
    const e = Buffer.alloc(46); e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0800, 8); e.writeUInt16LE(8, 10); e.writeUInt16LE(0x21, 14);
    e.writeUInt32LE(crc, 16); e.writeUInt32LE(c.length, 20); e.writeUInt32LE(dados.length, 24); e.writeUInt16LE(n.length, 28); e.writeUInt32LE(off, 42);
    locais.push(h, n, c); centrais.push(e, n); off += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(centrais), fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10); fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(off, 16);
  return Buffer.concat([...locais, cd, fim]);
}

// linhas: [{ centro, nome, doc, valor (centavos) }] -> buffer .xlsx no modelo
function planilha(pagamento, linhas) {
  const [a, m, d] = pagamento.split('-').map(Number);
  const venc = Date.UTC(a, m - 1, d) / 864e5 + 25569; // número de série do Excel (sem fuso)
  const rank = (c) => { const i = ORDEM_CENTROS.indexOf(c); return i < 0 ? ORDEM_CENTROS.length : i; };
  const ord = [...linhas].map((l) => ({ ...l, centro: String(l.centro).toUpperCase(), nome: String(l.nome).toUpperCase() }))
    .sort((x, y) => rank(x.centro) - rank(y.centro) || x.centro.localeCompare(y.centro) || x.nome.localeCompare(y.nome, 'pt-BR') || y.valor - x.valor);
  const textos = [], idx = new Map();
  const t = (s) => { if (!idx.has(s)) { idx.set(s, textos.length); textos.push(s); } return idx.get(s); };
  const cel = (ref, valor, s) => (typeof valor === 'number' ? `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${valor}</v></c>` : `<c r="${ref}"${s ? ` s="${s}"` : ''} t="s"><v>${t(valor)}</v></c>`);
  const linha = (n, cs) => `<row r="${n}" spans="1:7">${cs.join('')}</row>`;
  const rows = [linha(1, CABECALHO.map((h, i) => cel(`${'ABCDEFG'[i]}1`, h, i === 6 ? 1 : 0)))];
  ord.forEach((l, i) => {
    const n = i + 2;
    rows.push(linha(n, [cel(`A${n}`, venc, 3), cel(`B${n}`, l.nome), cel(`C${n}`, docFmt(l.doc)), cel(`D${n}`, DESCRICAO[l.centro] ?? `Motoboys ${capital(l.centro)}`),
      cel(`E${n}`, 'Motoboys'), cel(`F${n}`, l.centro), cel(`G${n}`, -l.valor / 100, 1)]));
  });
  const sheet = `${CAB}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:G${ord.length + 1}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/><cols><col min="1" max="1" width="12.109375" bestFit="1" customWidth="1"/><col min="2" max="2" width="41.88671875" bestFit="1" customWidth="1"/><col min="3" max="3" width="17.6640625" bestFit="1" customWidth="1"/><col min="4" max="5" width="14.44140625" bestFit="1" customWidth="1"/><col min="6" max="6" width="14.44140625" customWidth="1"/><col min="7" max="7" width="8.88671875" style="1"/></cols><sheetData>${rows.join('')}</sheetData><pageMargins left="0.511811024" right="0.511811024" top="0.78740157499999996" bottom="0.78740157499999996" header="0.31496062000000002" footer="0.31496062000000002"/><pageSetup paperSize="9" orientation="portrait"/></worksheet>`;
  const strings = `${CAB}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${textos.length}" uniqueCount="${textos.length}">${textos.map((s) => `<si><t${s !== s.trim() ? ' xml:space="preserve"' : ''}>${xml(s)}</t></si>`).join('')}</sst>`;
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', P = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return zip([
    ['[Content_Types].xml', `${CAB}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `${CAB}<Relationships xmlns="${P}"><Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="${P}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${CAB}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><workbookPr defaultThemeVersion="202300"/><bookViews><workbookView xWindow="-108" yWindow="-108" windowWidth="23256" windowHeight="13896"/></bookViews><sheets><sheet name="Planilha1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${CAB}<Relationships xmlns="${P}"><Relationship Id="rId3" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId4" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
    ['xl/theme/theme1.xml', MODELO('theme1.xml')],
    ['xl/styles.xml', MODELO('styles.xml')],
    ['xl/sharedStrings.xml', Buffer.from(strings)],
    ['docProps/core.xml', `${CAB}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Pagamento de Entregadores</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`],
    ['docProps/app.xml', `${CAB}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Pagamento de Entregadores</Application></Properties>`],
  ].map(([n, c]) => [n, Buffer.isBuffer(c) ? c : Buffer.from(c)]));
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
