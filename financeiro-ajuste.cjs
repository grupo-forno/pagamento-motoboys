const fs=require('fs');let s=fs.readFileSync('server.js','utf8');
s=s.replace("/^\\/(\\?[\\w=&%.+-]*)?$/.test(v)","/^\\/(?:pagar)?(\\?[\\w=&%.+-]*)?$/.test(v)");
s=s.replace("trilha: [[u.perfil === 'financeiro' ? 'Para aprovar' : inicio(u), voltar]", "trilha: [[voltar.startsWith('/pagar') ? 'Pagamentos' : u.perfil === 'financeiro' ? 'Para aprovar' : inicio(u), voltar]");
s=s.replace('<a href="/fechamentos/${f.id}"><b>#${f.id}</b></a>', '<a href="${detalheFin(f, aqui)}"><b>#${f.id}</b></a>');
fs.writeFileSync('server.js',s);
let u=fs.readFileSync('ui.js','utf8');u=u.replace("v.textContent='Chave PIX copiada: '+b.dataset.copiar", "v.textContent=b.dataset.copiarNome?'Pix de '+b.dataset.copiarNome+' copiado':'Chave PIX copiada: '+b.dataset.copiar");fs.writeFileSync('ui.js',u);
