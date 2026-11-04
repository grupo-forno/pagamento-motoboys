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
-- UNIQUE(loja_id, chave) impede pagar o mesmo pedido em dois fechamentos
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  loja_id INTEGER NOT NULL, chave TEXT NOT NULL, numero TEXT, dia TEXT NOT NULL, entregador TEXT,
  motoboy_id INTEGER REFERENCES motoboys, taxa INTEGER NOT NULL, status TEXT, UNIQUE (loja_id, chave));
CREATE TABLE IF NOT EXISTS ajustes (
  id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys, dia TEXT NOT NULL, valor_informado INTEGER,
  valor_final INTEGER NOT NULL CHECK (valor_final >= 0), justificativa TEXT NOT NULL, criado_por INTEGER,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE (fechamento_id, motoboy_id, dia));
CREATE TABLE IF NOT EXISTS evidencias (
  id INTEGER PRIMARY KEY, ajuste_id INTEGER NOT NULL REFERENCES ajustes ON DELETE CASCADE,
  arquivo TEXT NOT NULL, nome TEXT NOT NULL, tipo TEXT);
CREATE TABLE IF NOT EXISTS pagamentos (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, motoboy_id INTEGER NOT NULL,
  valor INTEGER NOT NULL, pix TEXT, pago_por INTEGER, pago_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (fechamento_id, motoboy_id));
-- "Resumo de entregas por entregador" do Agilizone: total confiável por entregador no período
CREATE TABLE IF NOT EXISTS resumo (
  fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE, entregador TEXT NOT NULL,
  motoboy_id INTEGER REFERENCES motoboys, pedidos INTEGER, total INTEGER NOT NULL, cpf TEXT, pix TEXT, pago INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fechamento_id, entregador));
-- configurações editáveis pela TI (e-mail, destinatários...)
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
-- valor que o próprio motoboy informou no sistema; o despachante resolve com um ajuste
CREATE TABLE IF NOT EXISTS reclamacoes (
  id INTEGER PRIMARY KEY, fechamento_id INTEGER NOT NULL REFERENCES fechamentos ON DELETE CASCADE,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys, dia TEXT NOT NULL, valor INTEGER NOT NULL, obs TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','resolvida')),
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE (fechamento_id, motoboy_id, dia));
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY, quando TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  usuario_id INTEGER, ref TEXT, acao TEXT NOT NULL);
`);

// Colunas adicionadas depois da tabela existir em bancos já em uso.
if (!db.prepare("SELECT 1 FROM pragma_table_info('resumo') WHERE name = 'pago'").get()) db.exec('ALTER TABLE resumo ADD COLUMN pago INTEGER NOT NULL DEFAULT 0');

for (const nome of ['FORNO PAULISTA DIRCEU', 'FORNO PAULISTA DOM SEVERINO ATIVA', 'FORNO PAULISTA SUL', 'Forno Paulista Centro de Distribuição Leste'])
  db.prepare('INSERT OR IGNORE INTO lojas (nome) VALUES (?)').run(nome);

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
  console.log(`\n>>> Usuário inicial criado: login "admin", senha "${senha}" (troque em "Minha senha")\n`);
}

const log = (usuarioId, ref, acao) => db.prepare('INSERT INTO log (usuario_id, ref, acao) VALUES (?,?,?)').run(usuarioId, ref, acao);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DIR, UPLOADS, hashSenha, confereSenha, log, tx };
