// Somente dados fictícios; usado por testes e pela revisão local isolada.
const { soma } = require('../agenda');
module.exports = function fixture(db, hashSenha) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
  const lojas = db.prepare('SELECT id FROM lojas ORDER BY id LIMIT 2').all().map((l) => l.id);
  const senha = 'revisao-ficticia-123';
  const usuarios = {};
  for (const [login, perfil, loja] of [['fin-revisao', 'financeiro', null], ['fin-loja', 'financeiro', lojas[0]], ['desp-revisao', 'despachante', lojas[0]], ['gestao-revisao', 'gestao', null]]) {
    usuarios[login] = Number(db.prepare('INSERT INTO usuarios (nome,login,senha,perfil,loja_id) VALUES (?,?,?,?,?)').run(login, login, hashSenha(senha), perfil, loja).lastInsertRowid);
  }
  const ids = {}, pessoas = [];
  for (let n = 0; n < 3; n++) pessoas.push(Number(db.prepare('INSERT INTO motoboys (nome) VALUES (?)').run(['Ana Fictícia', 'Bia Fictícia', 'Caio Fictício'][n]).lastInsertRowid));
  for (const [nome, status, loja, pagamento, enviado] of [
    ['pendente', 'enviado', lojas[0], hoje, soma(hoje, -2)],
    ['parcial', 'enviado', lojas[0], soma(hoje, -1), soma(hoje, -3)],
    ['devolvido', 'rascunho', lojas[0], hoje, soma(hoje, -2)],
    ['aprovado', 'pago', lojas[0], hoje, soma(hoje, -2)],
    ['vencido', 'pago', lojas[1], soma(hoje, -5), soma(hoje, -8)],
    ['pago', 'pago', lojas[1], soma(hoje, -12), soma(hoje, -14)],
    ['rascunho', 'rascunho', lojas[0], hoje, null],
  ]) {
    const id = Number(db.prepare('INSERT INTO fechamentos (loja_id,data_ini,data_fim,status,versao,enviado_em,enviado_por,criado_por,pagamento,so_resumo) VALUES (?,?,?,?,?,?,?,?,?,1)').run(loja, soma(pagamento, -4), soma(pagamento, -1), status, nome === 'rascunho' ? 0 : 1, enviado && enviado + ' 09:00:00', usuarios['desp-revisao'], usuarios['desp-revisao'], pagamento).lastInsertRowid);
    ids[nome] = id;
    for (const [i, m] of pessoas.entries()) {
      const pix = nome === 'pendente' && i === 2 ? null : `ficticio.${i}@exemplo.com`;
      db.prepare('INSERT INTO resumo (fechamento_id,entregador,motoboy_id,pedidos,total,pix) VALUES (?,?,?,?,?,?)').run(id, ['Ana Fictícia', 'Bia Fictícia', 'Caio Fictício'][i], m, 5, (i + 1) * 1000, pix);
      if (status === 'pago' || (nome === 'parcial' && i === 0)) db.prepare('INSERT INTO aprovacoes (fechamento_id,motoboy_id,valor,pix,versao,aprovado_por) VALUES (?,?,?,?,1,?)').run(id, m, (i + 1) * 1000, pix, usuarios['fin-revisao']);
      if (nome === 'devolvido') db.prepare('INSERT INTO devolucoes (fechamento_id,motoboy_id,versao,valor,pix,motivo,devolvido_por) VALUES (?,?,1,?,?,?,?)').run(id, m, (i + 1) * 1000, pix, 'Confira o período fictício', usuarios['fin-revisao']);
    }
    if (nome === 'devolvido') db.prepare("INSERT INTO log (ref,acao,usuario_id) VALUES (?, 'Devolveu para correção: Confira o período fictício', ?)").run(`f:${id}`, usuarios['fin-revisao']);
    if (nome === 'pago') db.prepare('UPDATE fechamentos SET pago_em = ?, pago_por = ?, lote = 99 WHERE id = ?').run(hoje + ' 10:00:00', usuarios['fin-revisao'], id);
  }
  return { hoje, lojas, ids, pessoas, senha, usuarios };
};
