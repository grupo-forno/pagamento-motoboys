const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('node:fs');
const path = require('node:path');
const { db, DIR } = require('./db');

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaFmt = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)} ${SEMANA[new Date(d + 'T12:00:00Z').getUTCDay()]}`;
const dataFmt = (d) => d.split('-').reverse().join('/');

// PDF da solicitação de pagamento, na identidade do Grupo Forno (A4 paisagem).
const LOGO = path.join(__dirname, 'public', 'grupo-forno.jpg');
const COR = { laranja: '#DF6D2A', laranjaEsc: '#B8501A', laranjaSoft: '#FDF1EA', preto: '#140A08', cinza: '#6B6360', linha: '#E7E2DF', zebra: '#FAF8F7', verde: '#15803D', vermelho: '#B91C1C' };
const STATUS_PDF = { rascunho: 'Em conferência (rascunho)', enviado: 'Aguardando aprovação do financeiro', pago: 'Aprovado pelo financeiro' };
const NOMES_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaLongoPdf = (d) => `${NOMES_DIA[new Date(d + 'T12:00:00Z').getUTCDay()]} ${dataFmt(d)}`;

// A fonte do PDF (Helvetica) só tem Latin-1: emoji e símbolos raros viram lixo. Remove.
const limpa = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022]/g, '').replace(/ {2,}/g, ' ').trim();

function gerarPdf(f0, g0, ajustes0) {
  const f = { ...f0, loja: limpa(f0.loja) };
  const g = { ...g0, linhas: g0.linhas.map((l) => ({ ...l, nome: limpa(l.nome), pix: l.pix && limpa(l.pix), aceite: l.aceite && { ...l.aceite, justificativa: limpa(l.aceite.justificativa) } })) };
  const ajustes = ajustes0.map((a) => ({ ...a, motoboy: limpa(a.motoboy), justificativa: limpa(a.justificativa), autor: limpa(a.autor) }));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 30, bottom: 40, left: 30, right: 30 }, bufferPages: true,
      info: { Title: `Solicitação de pagamento · Motoboys · ${f.loja}`, Author: 'Grupo Forno' } });
    const partes = [];
    doc.on('data', (b) => partes.push(b)).on('end', () => resolve(Buffer.concat(partes))).on('error', reject);

    const L = 30, R = doc.page.width - 30, W = R - L, FIM = doc.page.height - 50;
    const ultimo = (re) => db.prepare('SELECT l.acao, l.quando, u.nome FROM log l LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE l.ref = ? AND l.acao LIKE ? ORDER BY l.id DESC').get(`f:${f.id}`, re);
    const envio = ultimo('Enviou ao financeiro%'), aprov = ultimo('Aprovou a solicitação%');
    const quando = (x) => (x ? `${x.nome || 'Sistema'} · ${dataFmt(x.quando.slice(0, 10))} ${x.quando.slice(11, 16)}` : '—');
    const gerado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' });
    const pend = g.linhas.filter((l) => l.confere === 'pendente'), aceitos = g.linhas.filter((l) => l.confere === 'aceito');
    const conferencia = !g.temResumo ? 'Sem Resumo do Agilizone' : pend.length ? `${pend.length} motoboy(s) diferente(s) do Resumo` : g.linhas.some((l) => l.confere !== 'ok') ? 'Diferenças explicadas por divergência ou justificativa' : 'Bate com o Resumo do Agilizone';
    const aPagar = g.linhas.filter((l) => l.total > 0);

    // ---- cabeçalho (repete em toda página)
    const cabecalho = () => {
      if (fs.existsSync(LOGO)) doc.image(LOGO, L - 6, 22, { height: 34 }); else doc.font('Helvetica-Bold').fontSize(16).fillColor(COR.preto).text('GRUPO FORNO', L, 30);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(COR.preto).text('SOLICITAÇÃO DE PAGAMENTO · MOTOBOYS', L, 28, { width: W, align: 'right', characterSpacing: 0.5 });
      doc.font('Helvetica').fontSize(9.5).fillColor(COR.cinza).text(`${f.loja}${f.pagamento ? ` · pagamento de ${diaLongoPdf(f.pagamento)}` : ''}`, L, 46, { width: W, align: 'right' });
      doc.rect(L, 64, W, 2.5).fill(COR.laranja);
      return 78;
    };
    let y = cabecalho();

    // ---- blocos de resumo
    const bloco = (x, w, rotulo, valor, { destaque, tam = 12 } = {}) => {
      doc.roundedRect(x, y, w, 46, 5).fillAndStroke(destaque ? COR.laranjaSoft : '#FFFFFF', destaque ? '#F6CFB7' : COR.linha);
      doc.font('Helvetica').fontSize(7.5).fillColor(COR.cinza).text(rotulo.toUpperCase(), x + 10, y + 8, { width: w - 20, characterSpacing: 0.6 });
      doc.font('Helvetica-Bold').fontSize(destaque ? 16 : tam).fillColor(destaque ? COR.laranjaEsc : COR.preto).text(valor, x + 10, y + (destaque ? 21 : 23), { width: w - 20, lineBreak: false, ellipsis: true });
    };
    const gap = 8, bw = (W - gap * 4) / 5;
    bloco(L, bw, 'Loja', f.loja, { tam: 10 });
    bloco(L + (bw + gap), bw, 'Pagamento previsto', f.pagamento ? diaLongoPdf(f.pagamento) : '—', { tam: 11 });
    bloco(L + (bw + gap) * 2, bw, 'Período das entregas', `${dataFmt(f.data_ini)} a ${dataFmt(f.data_fim)}`, { tam: 11 });
    bloco(L + (bw + gap) * 3, bw, 'Motoboys a pagar', String(aPagar.length));
    bloco(L + (bw + gap) * 4, bw, 'Total a pagar', brl(g.total), { destaque: true });
    y += 56;
    const meta = [['Situação', STATUS_PDF[f.status] || f.status], ['Enviado por', quando(envio)], ['Aprovado por', quando(aprov)], ['Conferência', conferencia], ['Gerado em', gerado]];
    const mw = W / meta.length;
    meta.forEach(([k, v], i) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(COR.cinza).text(k.toUpperCase(), L + i * mw, y, { width: mw - 8, characterSpacing: 0.6 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(k === 'Conferência' && pend.length ? COR.vermelho : COR.preto).text(v, L + i * mw, y + 10, { width: mw - 8, lineBreak: false, ellipsis: true });
    });
    y += 40;

    // ---- tabela por motoboy e dia
    const cols = [{ t: '#', w: 22, n: true }, { t: 'Motoboy', w: 170 }, { t: 'Chave PIX', w: 130 },
      ...g.dias.map((d) => ({ t: diaFmt(d), w: 0, n: true, dia: d })), { t: 'Total', w: 78, n: true }, ...(g.temResumo ? [{ t: 'Resumo', w: 78, n: true }] : [])];
    const livre = (W - cols.reduce((s, c) => s + c.w, 0)) / Math.max(g.dias.length, 1);
    cols.forEach((c) => { if (!c.w) c.w = Math.min(livre, 95); });
    const TW = cols.reduce((s, c) => s + c.w, 0), H = 18;
    const titulo = (t) => { doc.rect(L, y, 3, 13).fill(COR.laranja); doc.font('Helvetica-Bold').fontSize(11).fillColor(COR.preto).text(t, L + 9, y + 1); y += 20; };
    const novaPagina = () => { doc.addPage(); y = cabecalho(); };
    const cabTabela = () => {
      doc.rect(L, y, TW, H).fill(COR.preto);
      let x = L;
      for (const c of cols) { doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(c.t, x + 5, y + 5.5, { width: c.w - 10, align: c.n ? 'right' : 'left', lineBreak: false }); x += c.w; }
      y += H;
    };
    titulo('Valores por motoboy e por dia');
    cabTabela();
    g.linhas.forEach((l, i) => {
      if (y + H > FIM) { novaPagina(); cabTabela(); }
      if (i % 2) doc.rect(L, y, TW, H).fill(COR.zebra);
      let x = L;
      for (const c of cols) {
        let v, cor = COR.preto, bold = false;
        if (c.t === '#') { v = String(i + 1); cor = COR.cinza; }
        else if (c.t === 'Motoboy') { v = l.nome; bold = true; }
        else if (c.t === 'Chave PIX') { v = l.pix || 'SEM PIX'; if (!l.pix) cor = COR.vermelho; }
        else if (c.dia) {
          const cel = l.dias[c.dia]; v = cel ? brl(cel.final) : '–';
          if (cel?.ajuste) { doc.rect(x + 1, y + 1, c.w - 2, H - 2).fill(COR.laranjaSoft); cor = COR.laranjaEsc; bold = true; v += ' *'; }
          if (!cel) cor = '#B5ADA9';
        } else if (c.t === 'Total') { v = brl(l.total); bold = true; }
        else { v = l.resumo == null ? '–' : brl(l.resumo); cor = l.confere === 'ok' ? COR.verde : l.confere === 'pendente' ? COR.vermelho : COR.laranjaEsc; }
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(cor).text(v, x + 5, y + 5, { width: c.w - 10, align: c.n ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += c.w;
      }
      doc.moveTo(L, y + H).lineTo(L + TW, y + H).strokeColor(COR.linha).lineWidth(0.5).stroke();
      y += H;
    });
    if (y + H + 4 > FIM) { novaPagina(); cabTabela(); }
    doc.rect(L, y, TW, H + 2).fill(COR.laranjaSoft);
    let x = L;
    for (const c of cols) {
      const v = c.t === 'Motoboy' ? 'TOTAL' : c.dia ? brl(g.totDia[c.dia]) : c.t === 'Total' ? brl(g.total) : c.t === 'Resumo' ? brl(g.linhas.reduce((s, l) => s + (l.resumo || 0), 0)) : '';
      doc.font('Helvetica-Bold').fontSize(9).fillColor(c.t === 'Total' ? COR.laranjaEsc : COR.preto).text(v, x + 5, y + 6, { width: c.w - 10, align: c.n ? 'right' : 'left', lineBreak: false });
      x += c.w;
    }
    y += H + 8;
    doc.font('Helvetica').fontSize(7.5).fillColor(COR.cinza).text(`* Valor corrigido pelo despachante (ver Divergências).${g.temResumo ? '  Coluna Resumo: verde = bate com o Agilizone; laranja = diferença explicada (divergência ou justificativa); vermelho = diferente.' : ''}`, L, y);
    y += 18;

    // ---- divergências
    if (y + 60 > FIM) novaPagina();
    titulo(`Divergências registradas (${ajustes.length})`);
    if (!ajustes.length) { doc.font('Helvetica').fontSize(9).fillColor(COR.cinza).text('Nenhuma. Todos os valores conforme o Relatório de Pedidos do Agilizone.', L, y); y += 18; }
    for (const a of ajustes) {
      const just = `"${a.justificativa}"`;
      const hj = doc.font('Helvetica').fontSize(8.5).heightOfString(just, { width: W - 24 });
      const h = 34 + hj;
      if (y + h > FIM) novaPagina();
      doc.roundedRect(L, y, W, h, 4).fillAndStroke('#FFFFFF', COR.linha);
      doc.rect(L, y, 3, h).fill(COR.laranja);
      const dif = a.valor_final - a.agil;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COR.preto).text(`${a.motoboy} · ${diaLongoPdf(a.dia)}`, L + 12, y + 7, { continued: true })
        .font('Helvetica').fontSize(8.5).fillColor(COR.cinza).text(`     Agilizone ${brl(a.agil)}${a.valor_informado == null ? '' : `  ·  motoboy informou ${brl(a.valor_informado)}`}  ·  a pagar `, { continued: true })
        .font('Helvetica-Bold').fillColor(COR.preto).text(brl(a.valor_final), { continued: true })
        .font('Helvetica-Bold').fillColor(dif > 0 ? COR.verde : dif < 0 ? COR.vermelho : COR.cinza).text(`  (${dif > 0 ? '+' : ''}${brl(dif)})`);
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COR.preto).text(just, L + 12, y + 21, { width: W - 24 });
      doc.font('Helvetica').fontSize(7.5).fillColor(COR.cinza).text(`Registrado por ${a.autor || '—'} em ${dataFmt(a.criado_em.slice(0, 10))} ${a.criado_em.slice(11, 16)}${a.evidencias ? ` · ${a.evidencias} evidência(s) anexada(s) no sistema` : ''}`, L + 12, y + h - 12, { width: W - 24 });
      y += h + 6;
    }

    // ---- diferenças com o Resumo aceitas
    if (aceitos.length) {
      if (y + 50 > FIM) novaPagina();
      y += 6; titulo(`Diferenças com o Resumo aceitas pelo despachante (${aceitos.length})`);
      for (const l of aceitos) {
        if (y + 26 > FIM) novaPagina();
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COR.preto).text(`${l.nome}: paga ${brl(l.total)} (Resumo ${brl(l.resumo)})`, L + 9, y, { continued: true })
          .font('Helvetica').fillColor(COR.cinza).text(`  —  ${l.aceite.justificativa}`, { width: W - 18 });
        y = doc.y + 6;
      }
    }

    // ---- assinaturas
    if (y + 70 > FIM) novaPagina();
    y = Math.max(y + 24, FIM - 50);
    const sw = (W - 40) / 2;
    [['Despachante responsável', envio?.nome], ['Financeiro (aprovação)', aprov?.nome]].forEach(([t, n], i) => {
      const sx = L + i * (sw + 40);
      doc.moveTo(sx, y + 22).lineTo(sx + sw, y + 22).strokeColor(COR.preto).lineWidth(0.6).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(COR.cinza).text(`${t}${n ? ` · ${n}` : ''}`, sx, y + 26, { width: sw, align: 'center' });
    });

    // ---- rodapé com paginação
    const total = doc.bufferedPageRange().count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // escrever no rodapé sem abrir página nova
      const fy = doc.page.height - 26;
      doc.moveTo(L, fy - 6).lineTo(R, fy - 6).strokeColor(COR.linha).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(COR.cinza)
        .text(`Grupo Forno · Pagamento de motoboys · ${f.loja} · gerado em ${gerado}`, L, fy, { width: W / 2, lineBreak: false })
        .text(`Página ${i + 1} de ${total}`, L + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// Configuração de e-mail: tela "Configurações" (tabela config), com as variáveis de ambiente como reserva.
const ENV = { smtp_host: 'SMTP_HOST', smtp_port: 'SMTP_PORT', smtp_user: 'SMTP_USER', smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM', app_url: 'APP_URL', email_para: 'EMAIL_PARA', email_copia: 'EMAIL_COPIA' };
const cfg = (k) => db.prepare('SELECT valor FROM config WHERE chave = ?').get(k)?.valor ?? process.env[ENV[k]] ?? '';
const listaEmails = (txt) => String(txt || '').split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);

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
