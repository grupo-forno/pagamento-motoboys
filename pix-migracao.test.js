// Migração aditiva: banco exclusivamente fictício em diretório temporário.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
test('migração de Pix preserva legado, isola vínculo ambíguo e não sobrescreve cadastro na reinicialização',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mb-pix-migracao-'));
  const executar=()=>{const r=spawnSync(process.execPath,['-e',"require('./db').db.close()"],{cwd:__dirname,env:{...process.env,DATA_DIR:dir,ADMIN_SENHA:'somente-ficticia'},encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  executar();
  let db=new DatabaseSync(path.join(dir,'motoboys.db'));
  const lojas=db.prepare('SELECT id FROM lojas ORDER BY id LIMIT 2').all().map(x=>x.id);
  const a=Number(db.prepare("INSERT INTO motoboys (nome,agz_id,pix) VALUES ('Único fictício',901,'unico@exemplo.com')").run().lastInsertRowid);
  const b=Number(db.prepare("INSERT INTO motoboys (nome,agz_id,pix) VALUES ('Duas lojas fictício',902,'legado@exemplo.com')").run().lastInsertRowid);
  db.prepare('INSERT INTO loja_motoboys VALUES (?,?)').run(lojas[0],a);
  for(const l of lojas)db.prepare('INSERT INTO loja_motoboys VALUES (?,?)').run(l,b);
  db.close();executar();
  db=new DatabaseSync(path.join(dir,'motoboys.db'));
  assert.equal(db.prepare('SELECT pix FROM entregador_pix WHERE motoboy_id = ?').get(a).pix,'unico@exemplo.com');
  assert.deepEqual(db.prepare('SELECT pix FROM entregador_pix WHERE motoboy_id = ?').all(b).map(x=>x.pix),[null,null]);
  assert.equal(db.prepare('SELECT pix FROM motoboys WHERE id = ?').get(b).pix,'legado@exemplo.com');
  db.prepare('UPDATE entregador_pix SET pix = ? WHERE motoboy_id = ?').run('alterado@exemplo.com',a);db.close();executar();
  db=new DatabaseSync(path.join(dir,'motoboys.db'));
  assert.equal(db.prepare('SELECT pix FROM entregador_pix WHERE motoboy_id = ?').get(a).pix,'alterado@exemplo.com');
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
