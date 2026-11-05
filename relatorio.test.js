const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'motoboys-teste-'));
process.env.ADMIN_SENHA = 'teste12345';
const { listaEmails } = require('./relatorio');

test('lista de destinatários: vírgula, ponto e vírgula, espaço ou uma por linha', () => {
  assert.deepEqual(listaEmails('financeiro@grupofornopaulista.com'), ['financeiro@grupofornopaulista.com']);
  assert.deepEqual(listaEmails('a@grupofornopaulista.com, b@grupofornopaulista.com;c@x.com\nd@x.com  e@x.com'),
    ['a@grupofornopaulista.com', 'b@grupofornopaulista.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  assert.deepEqual(listaEmails(''), []);
});
