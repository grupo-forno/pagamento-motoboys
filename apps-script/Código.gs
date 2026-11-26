/**
 * App Entregadores → pasta MOTOBOYS do Google Drive.
 *
 * A cada execução (acionador de 5 em 5 minutos) o script:
 *   1. pede ao app a lista de fechamentos pendentes;
 *   2. para cada um: se já existe na pasta um arquivo com o nome exato, só confirma; senão baixa o .xlsx,
 *      valida (HTTP 200, assinatura de .xlsx, tamanho e SHA-256) e grava na pasta;
 *   3. só depois de gravar, confirma ao app com o ID do arquivo no Drive.
 * Se algo falhar em um fechamento, ele continua pendente (será tentado de novo) e o script segue com os demais.
 * Sem refresh_token e sem implantação como App da Web: o script roda como a conta que o autorizou (Editora na pasta).
 *
 * Propriedades do script (Configurações do projeto > Propriedades do script):
 *   APP_URL   endereço do app, sem barra no fim (ex.: https://entregadores.exemplo.com.br)
 *   SEGREDO   o mesmo valor da variável DRIVE_SCRIPT_SEGREDO do servidor (mínimo 24 caracteres)
 *   PASTA_ID  ID da pasta MOTOBOYS (o trecho depois de /folders/ na URL da pasta)
 */

var MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
var NOME_VALIDO = /^\d{2}-\d{2}-\d{4}-motoboys\d+\.xlsx$/;
var TAMANHO_MINIMO = 1000; // um .xlsx válido nunca é menor que isso

/** Função do acionador. */
function sincronizar() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn('Outra execução está em andamento; esta foi ignorada.');
    return;
  }
  try {
    var cfg = configuracao_();
    var pasta = DriveApp.getFolderById(cfg.pastaId);
    var resp = chamar_(cfg, 'get', '/api/drive/pendentes');
    if (resp.getResponseCode() !== 200) throw new Error('Lista de pendentes: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
    var pendentes = JSON.parse(resp.getContentText()).pendentes || [];
    console.log(pendentes.length + ' fechamento(s) pendente(s).');
    var gravados = 0, falhas = 0;
    pendentes.forEach(function (p) {
      try {
        processar_(cfg, pasta, p);
        gravados++;
      } catch (e) {
        falhas++;
        console.error('Fechamento ' + p.id + ' (' + p.arquivo + ') segue pendente: ' + e.message);
        avisarFalha_(cfg, p.id, e.message);
      }
    });
    console.log('Concluído: ' + gravados + ' confirmado(s), ' + falhas + ' com falha.');
  } finally {
    lock.releaseLock();
  }
}

/** Grava (ou reconhece) o arquivo de um fechamento e confirma ao app. Lança erro se algo não estiver certo. */
function processar_(cfg, pasta, p) {
  var nome = String(p.arquivo || '');
  if (!/^\d+$/.test(String(p.id)) || !NOME_VALIDO.test(nome)) throw new Error('item inválido recebido do app: ' + JSON.stringify(p));

  // Nome exato já na pasta (gravação anterior cuja confirmação falhou, ou arquivo colocado à mão): não cria outro.
  var existentes = pasta.getFilesByName(nome);
  var arquivo = existentes.hasNext() ? existentes.next() : null;
  if (arquivo && existentes.hasNext()) console.warn('Há mais de um arquivo chamado ' + nome + ' na pasta; usando o primeiro (' + arquivo.getId() + ').');

  if (!arquivo) {
    var dl = chamar_(cfg, 'get', p.download || '/api/drive/fechamentos/' + p.id + '/xlsx');
    var blob = validarDownload_(dl, nome);
    arquivo = pasta.createFile(blob.setName(nome));
    console.log('Gravado ' + nome + ' (' + arquivo.getId() + ').');
  } else {
    console.log(nome + ' já existe na pasta (' + arquivo.getId() + '); só confirmando.');
  }

  // Só confirma depois de gravado. Se falhar aqui, o próximo ciclo acha o nome e apenas confirma.
  var conf = chamar_(cfg, 'post', '/api/drive/fechamentos/' + p.id + '/confirmar', { driveId: arquivo.getId() });
  if (conf.getResponseCode() !== 200) throw new Error('confirmação recusada: HTTP ' + conf.getResponseCode() + ' ' + conf.getContentText().slice(0, 200));
}

/** HTTP 200, assinatura "PK" de .xlsx, tamanho mínimo e SHA-256 igual ao informado pelo app. Devolve o Blob. */
function validarDownload_(resp, nome) {
  if (resp.getResponseCode() !== 200) throw new Error('download: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  var bytes = resp.getContent();
  if (bytes.length < TAMANHO_MINIMO) throw new Error('download: arquivo pequeno demais (' + bytes.length + ' bytes)');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new Error('download: não é um .xlsx (assinatura inválida)');
  var esperado = (resp.getHeaders()['X-Content-SHA256'] || resp.getHeaders()['x-content-sha256'] || '').toLowerCase();
  if (esperado) {
    var obtido = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    if (obtido !== esperado) throw new Error('download corrompido (SHA-256 diferente do informado)');
  }
  return Utilities.newBlob(bytes, MIME_XLSX, nome);
}

function avisarFalha_(cfg, id, mensagem) {
  try {
    chamar_(cfg, 'post', '/api/drive/fechamentos/' + id + '/falha', { erro: mensagem });
  } catch (e) {
    console.warn('Não consegui registrar a falha no app: ' + e.message);
  }
}

function chamar_(cfg, metodo, caminho, corpo) {
  var opcoes = { method: metodo, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + cfg.segredo } };
  if (corpo) { opcoes.contentType = 'application/json'; opcoes.payload = JSON.stringify(corpo); }
  return UrlFetchApp.fetch(cfg.url + caminho, opcoes);
}

function configuracao_() {
  var props = PropertiesService.getScriptProperties();
  var cfg = { url: (props.getProperty('APP_URL') || '').replace(/\/+$/, ''), segredo: props.getProperty('SEGREDO') || '', pastaId: props.getProperty('PASTA_ID') || '' };
  var faltam = [];
  if (!cfg.url) faltam.push('APP_URL');
  if (!cfg.segredo) faltam.push('SEGREDO');
  if (!cfg.pastaId) faltam.push('PASTA_ID');
  if (faltam.length) throw new Error('Cadastre nas Propriedades do script: ' + faltam.join(', '));
  return cfg;
}

/** Teste sem gravar nada: confere as propriedades, o acesso à pasta e o segredo no app. */
function testarConexao() {
  var cfg = configuracao_();
  console.log('Pasta: ' + DriveApp.getFolderById(cfg.pastaId).getName());
  var resp = chamar_(cfg, 'get', '/api/drive/pendentes');
  console.log('App: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300));
}
