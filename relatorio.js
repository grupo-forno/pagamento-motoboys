const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('node:fs');
const path = require('node:path');
const { db, DIR } = require('./db');

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaFmt = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)} ${SEMANA[new Date(d + 'T12:00:00Z').getUTCDay()]}`;
const dataFmt = (d) => d.split('-').reverse().join('/');

// PDF A4 paisagem: tabela motoboy x dia (igual à planilha antiga) + divergências com justificativa.
function gerarPdf(f, g, ajustes) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: `Solicitação de pagamento motoboys ${f.loja}` } });
    const partes = [];
    doc.on('data', (b) => partes.push(b)).on('end', () => resolve(Buffer.concat(partes))).on('error', reject);

    const L = 30, H = 16, FIM = doc.page.height - 40;
    const cols = [{ t: 'MOTOBOY', w: 180 }, { t: 'PIX', w: 140 },
      ...g.dias.map((d) => ({ t: diaFmt(d), w: 0, n: true })), { t: 'TOTAL', w: 80, n: true }];
    const livre = (doc.page.width - 60 - 400) / Math.max(g.dias.length, 1);
    cols.forEach((c) => { if (!c.w) c.w = Math.min(livre, 85); });
    const W = cols.reduce((s, c) => s + c.w, 0);

    let y;
    const linha = (vals, { bold, fundo } = {}) => {
      if (y + H > FIM) { doc.addPage(); y = 30; linha(cols.map((c) => c.t), { bold: true, fundo: '#e5e7eb' }); }
      let x = L;
      if (fundo) doc.rect(L, y, W, H).fill(fundo);
      doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cols.forEach((c, i) => {
        doc.text(String(vals[i] ?? ''), x + 3, y + 4, { width: c.w - 6, align: c.n ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += c.w;
      });
      doc.moveTo(L, y + H).lineTo(L + W, y + H).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      y += H;
    };

    doc.font('Helvetica-Bold').fontSize(15).text(`Solicitação de pagamento · Motoboys · ${f.loja}`, L, 30);
    doc.font('Helvetica').fontSize(10).fillColor('#444')
      .text(`Período: ${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}   ·   ${g.linhas.length} motoboys   ·   Total: ${brl(g.total)}   ·   Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' })}`);
    y = doc.y + 10;
    linha(cols.map((c) => c.t), { bold: true, fundo: '#e5e7eb' });
    for (const l of g.linhas) linha([l.nome, l.pix || 'SEM PIX', ...g.dias.map((d) => (l.dias[d] ? brl(l.dias[d].final) : '–')), brl(l.total)]);
    linha(['TOTAL', '', ...g.dias.map((d) => brl(g.totDia[d])), brl(g.total)], { bold: true, fundo: '#e5e7eb' });

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(`Divergências (${ajustes.length})`, L, y + 18);
    if (!ajustes.length) doc.font('Helvetica').fontSize(9).text('Nenhuma. Valores conforme Agilizone.');
    for (const a of ajustes) {
      if (doc.y > FIM - 40) doc.addPage();
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9).text(
        `${a.motoboy} · ${diaFmt(a.dia)} — Agilizone ${brl(a.agil)}` +
        `${a.valor_informado == null ? '' : ` · motoboy informou ${brl(a.valor_informado)}`} · pago ${brl(a.valor_final)} (${a.valor_final - a.agil >= 0 ? '+' : ''}${brl(a.valor_final - a.agil)})`, L);
      doc.font('Helvetica').text(`${a.justificativa}${a.evidencias ? `  [${a.evidencias} evidência(s) no sistema]` : ''}  — ${a.autor || ''}`, { width: W });
    }
    doc.end();
  });
}

// Configuração de e-mail: tela "Configurações" (tabela config), com as variáveis de ambiente como reserva.
const ENV = { smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER', smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM', app_url: 'APP_URL', email_para: 'EMAIL_PARA', email_copia: 'EMAIL_COPIA' };
const cfg = (k) => db.prepare('SELECT valor FROM config WHERE chave = ?').get(k)?.valor ?? process.env[ENV[k]] ?? '';
const listaEmails = (txt) => String(txt || '').split(/[s,;]+/).map((e) => e.trim()).filter(Boolean);

// Envia; sem servidor configurado, grava o .eml em data/emails e avisa (não lança erro).
// Retorna { enviado: true } ou { salvo: caminho }. Erros do servidor de e-mail são lançados.
async function enviarEmail(msg) {
  const host = cfg('smtp_host'), porta = Number(cfg('smtp_port') || 587);
  const from = cfg('smtp_from') || cfg('smtp_user') || 'motoboys@localhost';
  if (!host) {
    const info = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ from, ...msg });
    const pasta = path.join(DIR, 'emails');
    fs.mkdirSync(pasta, { recursive: true });
    const arq = path.join(pasta, `${Date.now()}.eml`);
    fs.writeFileSync(arq, info.message);
    return { salvo: arq };
  }
  const t = nodemailer.createTransport({ host, port: porta, secure: porta === 465, auth: cfg('smtp_user') ? { user: cfg('smtp_user'), pass: cfg('smtp_pass') } : undefined, connectionTimeout: 15000 });
  await t.sendMail({ from, ...msg });
  return { enviado: true };
}

module.exports = { gerarPdf, enviarEmail, cfg, listaEmails, brl, diaFmt, dataFmt };
