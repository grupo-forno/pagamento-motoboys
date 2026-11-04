const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('node:fs');
const path = require('node:path');
const { DIR } = require('./db');

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaFmt = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)} ${SEMANA[new Date(d + 'T12:00:00Z').getUTCDay()]}`;
const dataFmt = (d) => d.split('-').reverse().join('/');

// PDF A4 paisagem: tabela motoboy x dia (igual à planilha antiga) + divergências com justificativa.
function gerarPdf(f, g, ajustes) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: `Pagamento motoboys ${f.loja}` } });
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

    doc.font('Helvetica-Bold').fontSize(15).text(`Pagamento de motoboys · ${f.loja}`, L, 30);
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

// Sem SMTP_HOST configurado, o e-mail é gravado em data/emails/*.eml (desenvolvimento).
const transporte = process.env.SMTP_HOST
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  : nodemailer.createTransport({ streamTransport: true, buffer: true });

async function enviarEmail(msg) {
  const info = await transporte.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER || 'motoboys@localhost', ...msg });
  if (!process.env.SMTP_HOST) {
    const pasta = path.join(DIR, 'emails');
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, `${Date.now()}.eml`), info.message);
  }
}

module.exports = { gerarPdf, enviarEmail, brl, diaFmt, dataFmt };
