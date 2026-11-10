const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new DatabaseSync(path.join(DIR, 'motoboys.db'));
const USUARIOS = (nome) => `CREATE TABLE IF NOT EXISTS ${nome} (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, login TEXT NOT NULL UNIQUE COLLATE NOCASE, senha TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','gestao','financeiro','despachante','motoboy')),
  loja_id INTEGER REFERENCES lojas, ativo INTEGER NOT NULL DEFAULT 1, email TEXT,
  motoboy_id INTEGER UNIQUE REFERENCES motoboys);`;
// ativo = 0 quando o fechamento é arquivado: o índice pedidos_validos impede o mesmo pedido em dois fechamentos válidos.
const PEDIDOS = (nome) => `CREATE TABLE IF NOT EXISTS ${nome} (
  id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  loja_id INTEGER NOT NULL, chave TEXT NOT NULL, numero TEXT, dia TEXT NOT NULL, entregador TEXT,
  motoboy_id INTEGER REFERENCES motoboys, taxa INTEGER NOT NULL, status TEXT, ativo INTEGER NOT NULL DEFAULT 1);`;
// Editar ou remover um ajuste não apaga: marca substituido_em e a versão antiga fica no histórico.
const AJUSTES = (nome) => `CREATE TABLE IF NOT EXISTS ${nome} (
  id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys, dia TEXT NOT NULL, valor_informado INTEGER,
  valor_final INTEGER NOT NULL CHECK (valor_final >= 0), justificativa TEXT NOT NULL, criado_por INTEGER,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), substituido_em TEXT, substituido_por INTEGER);`;

// Migração da 1ª versão (usuarios sem perfil motoboy/email): recria a tabela mantendo os dados.
// Segue o procedimento do SQLite (cria nova, copia, apaga antiga, renomeia) para não quebrar as FKs de sessoes.
const antigo = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'usuarios'").get()?.sql;
if (antigo && !antigo.includes("'motoboy'")) {
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    db.exec(`${USUARIOS('usuarios_novo')}
      INSERT INTO usuarios_novo (id, nome, login, senha, perfil, loja_id, ativo) SELECT id, nome, login, senha, perfil, loja_id, ativo FROM usuarios;
      DROP TABLE usuarios;
      ALTER TABLE usuarios_novo RENAME TO usuarios;
      COMMIT;`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log('Banco atualizado para a nova versão (usuarios).');
}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS lojas (id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE COLLATE NOCASE);
${USUARIOS('usuarios')}
CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios ON DELETE CASCADE, expira INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS motoboys (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, cpf TEXT, pix TEXT, ativo INTEGER NOT NULL DEFAULT 1);
-- nome do entregador no Agilizone (por loja) -> motoboy cadastrado
CREATE TABLE IF NOT EXISTS apelidos (
  loja_id INTEGER NOT NULL REFERENCES lojas, nome TEXT NOT NULL COLLATE NOCASE,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys, PRIMARY KEY (loja_id, nome));
CREATE TABLE IF NOT EXISTS fechamentos (
  id INTEGER PRIMARY KEY, loja_id INTEGER NOT NULL REFERENCES lojas, data_ini TEXT NOT NULL, data_fim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','enviado','pago')),
  criado_por INTEGER REFERENCES usuarios, criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), arquivo TEXT);
${PEDIDOS('pedidos')}
${AJUSTES('ajustes')}
CREATE TABLE IF NOT EXISTS evidencias (
  id INTEGER PRIMARY KEY, ajuste_id INTEGER NOT NULL REFERENCES ajustes ON DELETE CASCADE,
  arquivo TEXT NOT NULL, nome TEXT NOT NULL, tipo TEXT);
-- PIX de cada motoboy congelado no envio ao financeiro (o PDF enviado e a tela mostram o mesmo)
CREATE TABLE IF NOT EXISTS envio_pix (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, motoboy_id INTEGER NOT NULL, pix TEXT,
  PRIMARY KEY (fechamento_id, motoboy_id));
-- nome/PIX corrigidos pelo despachante, só neste fechamento (vencem o que veio do Agilizone)
CREATE TABLE IF NOT EXISTS edicoes (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, motoboy_id INTEGER NOT NULL, nome TEXT, pix TEXT,
  PRIMARY KEY (fechamento_id, motoboy_id));
-- diferença com o Resumo aceita conscientemente pelo despachante (vale só para aquele valor de diferença)
CREATE TABLE IF NOT EXISTS aceites (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, motoboy_id INTEGER NOT NULL,
  diferenca INTEGER NOT NULL, justificativa TEXT NOT NULL, criado_por INTEGER,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), PRIMARY KEY (fechamento_id, motoboy_id));
-- aprovação do financeiro por motoboy (todos com valor aprovados → fechamento 'pago' = Aprovado)
CREATE TABLE IF NOT EXISTS aprovacoes (fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, motoboy_id INTEGER NOT NULL,
  aprovado_por INTEGER, aprovado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), PRIMARY KEY (fechamento_id, motoboy_id));
-- entregadores devolvidos pelo financeiro, por versão enviada (valor e PIX considerados, motivo e quem foi avisado)
CREATE TABLE IF NOT EXISTS devolucoes (id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  motoboy_id INTEGER NOT NULL, versao INTEGER NOT NULL, valor INTEGER, pix TEXT, motivo TEXT NOT NULL, devolvido_por INTEGER,
  devolvido_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), para TEXT);
-- alertas por e-mail já disparados (um por chave), para não repetir
CREATE TABLE IF NOT EXISTS alertas (chave TEXT PRIMARY KEY, enviado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), resultado TEXT);
-- "Resumo de entregas por entregador" do Agilizone: total confiável por entregador no período
CREATE TABLE IF NOT EXISTS resumo (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, entregador TEXT NOT NULL,
  motoboy_id INTEGER REFERENCES motoboys, pedidos INTEGER, total INTEGER NOT NULL, cpf TEXT, pix TEXT, pago INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fechamento_id, entregador));
-- configurações editáveis pela TI (e-mail, destinatários...)
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY, quando TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  usuario_id INTEGER, ref TEXT, acao TEXT NOT NULL);
`);

// Colunas adicionadas depois da tabela existir em bancos já em uso.
const temColuna = (t, c) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
if (!temColuna('resumo', 'pago')) db.exec('ALTER TABLE resumo ADD COLUMN pago INTEGER NOT NULL DEFAULT 0');
if (!temColuna('lojas', 'calendario')) db.exec('ALTER TABLE lojas ADD COLUMN calendario TEXT'); // dias de pagamento (agenda.js)
// As credenciais do Agilizone ficam só no ambiente do servidor (agilizone.js), nunca no banco.
if (temColuna('lojas', 'agz_client_id')) db.exec('UPDATE lojas SET agz_client_id = NULL, agz_client_secret = NULL');
if (!temColuna('motoboys', 'agz_id')) db.exec('ALTER TABLE motoboys ADD COLUMN agz_id INTEGER; CREATE UNIQUE INDEX IF NOT EXISTS motoboys_agz ON motoboys (agz_id) WHERE agz_id IS NOT NULL'); // id do entregador no Agilizone
if (!temColuna('fechamentos', 'arquivado_em')) db.exec('ALTER TABLE fechamentos ADD COLUMN arquivado_em TEXT'); // arquivado: fora da lista e não conta como válido
// Tabelas com UNIQUE fixo da versão anterior: recria sem ele (procedimento do SQLite), copiando os dados.
function recria(nome, criar) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${nome}')`).all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    db.exec(`${criar(nome + '_novo')} INSERT INTO ${nome}_novo (${cols}) SELECT ${cols} FROM ${nome}; DROP TABLE ${nome}; ALTER TABLE ${nome}_novo RENAME TO ${nome}; COMMIT;`);
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  console.log(`Banco atualizado para a nova versão (${nome}).`);
}
if (!temColuna('pedidos', 'ativo')) recria('pedidos', PEDIDOS);
if (!temColuna('ajustes', 'substituido_em')) recria('ajustes', AJUSTES);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pedidos_validos ON pedidos (loja_id, chave) WHERE ativo = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ajustes_vigentes ON ajustes (fechamento_id, motoboy_id, dia) WHERE substituido_em IS NULL;`);
if (!temColuna('fechamentos', 'pagamento')) db.exec('ALTER TABLE fechamentos ADD COLUMN pagamento TEXT'); // data do pagamento a que se refere
// versao: quantas vezes foi enviado ao financeiro (0 = nunca enviado; o financeiro só vê versao > 0).
if (!temColuna('fechamentos', 'versao')) {
  db.exec('ALTER TABLE fechamentos ADD COLUMN versao INTEGER NOT NULL DEFAULT 0; ALTER TABLE fechamentos ADD COLUMN enviado_em TEXT; ALTER TABLE fechamentos ADD COLUMN enviado_por INTEGER;');
  const env = "FROM log WHERE ref = 'f:' || fechamentos.id AND acao LIKE 'Enviou ao financeiro%'";
  db.exec(`UPDATE fechamentos SET versao = (SELECT COUNT(*) ${env}), enviado_em = (SELECT MAX(quando) ${env}), enviado_por = (SELECT usuario_id ${env} ORDER BY id DESC LIMIT 1);
    UPDATE fechamentos SET versao = 1 WHERE versao = 0 AND status <> 'rascunho';`);
}
// Ocorrências do Agilizone (acréscimo ou desconto, sem data): valor e quantidade por entregador.
if (!temColuna('resumo', 'ocorrencias')) db.exec('ALTER TABLE resumo ADD COLUMN ocorrencias INTEGER NOT NULL DEFAULT 0; ALTER TABLE resumo ADD COLUMN qtd_oc INTEGER NOT NULL DEFAULT 0');
// so_resumo: fechamento de 1 dia importado só com o Resumo de entregas (sem Relatório de Pedidos).
if (!temColuna('fechamentos', 'so_resumo')) db.exec('ALTER TABLE fechamentos ADD COLUMN so_resumo INTEGER NOT NULL DEFAULT 0');
// origem_id: fechamento criado com os entregadores não aprovados quando o financeiro devolve um fechamento aprovado em parte.
if (!temColuna('fechamentos', 'origem_id')) db.exec('ALTER TABLE fechamentos ADD COLUMN origem_id INTEGER');
// Aprovação guarda o valor, o PIX e a versão aprovados: se mudarem num reenvio, o item volta para análise.
if (!temColuna('aprovacoes', 'valor')) db.exec('ALTER TABLE aprovacoes ADD COLUMN valor INTEGER; ALTER TABLE aprovacoes ADD COLUMN pix TEXT; ALTER TABLE aprovacoes ADD COLUMN versao INTEGER;');

// Pago de verdade (marcado pelo financeiro) e observação do despachante por entregador.
if (!temColuna('aprovacoes', 'pago_em')) db.exec('ALTER TABLE aprovacoes ADD COLUMN pago_em TEXT; ALTER TABLE aprovacoes ADD COLUMN pago_por INTEGER;');
// Pagamento por fechamento: pago_em/pago_por e o lote (fechamentos pagos juntos).
if (!temColuna('fechamentos', 'pago_em')) db.exec('ALTER TABLE fechamentos ADD COLUMN pago_em TEXT; ALTER TABLE fechamentos ADD COLUMN pago_por INTEGER; ALTER TABLE fechamentos ADD COLUMN lote INTEGER;');
if (!temColuna('edicoes', 'obs')) db.exec('ALTER TABLE edicoes ADD COLUMN obs TEXT');
// Justificativa do despachante para enviar com diferença entre Relatório de Pedidos e Resumo (obrigatória nesse caso).
if (!temColuna('fechamentos', 'justificativa')) db.exec('ALTER TABLE fechamentos ADD COLUMN justificativa TEXT');

for (const nome of ['FORNO PAULISTA DIRCEU', 'FORNO PAULISTA DOM SEVERINO ATIVA', 'FORNO PAULISTA SUL', 'Forno Paulista Centro de Distribuição Leste'])
  db.prepare('INSERT OR IGNORE INTO lojas (nome) VALUES (?)').run(nome);
// Calendário inicial: DIRCEU paga seg/qua/sex; as demais seg/sex (editável em Configurações).
const { PADRAO, PADRAO_DIRCEU } = require('./agenda');
db.prepare("UPDATE lojas SET calendario = CASE WHEN nome LIKE '%DIRCEU%' THEN ? ELSE ? END WHERE calendario IS NULL").run(PADRAO_DIRCEU, PADRAO);

function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  return sal + ':' + crypto.scryptSync(senha, sal, 64).toString('hex');
}
function confereSenha(senha, salvo) {
  const [sal, hash] = String(salvo).split(':');
  const a = crypto.scryptSync(senha, sal, 64), b = Buffer.from(hash || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

if (!db.prepare('SELECT 1 FROM usuarios').get()) {
  const senha = process.env.ADMIN_SENHA || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO usuarios (nome, login, senha, perfil) VALUES ('Administrador','admin',?,'admin')").run(hashSenha(senha));
  console.log(`\n>>> Usuário inicial criado: login "admin", senha "${senha}" (para trocar: Usuários, no menu)\n`);
}

const log = (usuarioId, ref, acao) => db.prepare('INSERT INTO log (usuario_id, ref, acao) VALUES (?,?,?)').run(usuarioId, ref, acao);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DIR, UPLOADS, hashSenha, confereSenha, log, tx };
