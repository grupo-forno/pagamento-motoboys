# Pagamento Entregadores

Sistema web que substitui a planilha de pagamento dos entregadores. Ele lê o relatório exportado do Agilizone.

## Fluxo
1. **Despachante**: no Agilizone, escolhe a loja, abre *Relatório de Pedidos*, preenche o período e clica em *Aplicar filtros*. Na mesma tela exporta **dois arquivos**:
   - *Exportar Pedidos* (`.xlsx`): os pedidos de cada dia. Pedidos sem entregador atrelado são descartados.
   - *Resumo de entregas por entregador* → *Exportar Resumo* (`.csv`): o total certo e a chave PIX de cada entregador.

   Em seguida importa os dois em **Novo fechamento**.
2. Os nomes dos entregadores vêm do Agilizone e são ligados automaticamente. Para pagar só 1 dia, basta o Resumo (modo "Só 1 dia"). Antes de enviar, a tela mostra a loja e o período lidos dos arquivos e "O que falta para enviar".
3. O sistema mostra, por entregador e na mesma linha: **Valor dos pedidos** (Relatório de Pedidos), **Valor do Resumo**, a **diferença** entre os dois e o **Valor a pagar**.
   - **Valor a pagar** = valor dos pedidos + ocorrências do Agilizone − o que já foi pago no Agilizone (coluna "Pago" do Resumo). Ocorrências e já pago entram igualmente nos dois lados, então não explicam uma diferença entre pedidos e Resumo.
   - **Diferença com o Resumo**: a linha fica marcada e a conferência mostra "Revisar diferença". Dá para enviar assim, mas a **justificativa é obrigatória** (mínimo 10 caracteres); ela fica no histórico, vai no e-mail e aparece no topo da tela do financeiro. O valor a pagar segue o Relatório de Pedidos.
   - **PIX**: vem do Resumo. Se faltar, o despachante digita na própria tela do fechamento; sem PIX o envio fica bloqueado.
   - Tela, aprovação, PDF e Excel usam o mesmo cálculo (o Excel traz também Resumo e diferença).
4. **Enviar para aprovação**: o fechamento vai para a fila do financeiro e sai um e-mail com o PDF e a planilha. O e-mail do financeiro é obrigatório, e antes de enviar um popup mostra para quem vai (e a justificativa, se houver) para o despachante reconfirmar. O e-mail sai primeiro: se falhar (ou se não houver servidor de e-mail configurado), **nada é enviado**, o fechamento continua com a loja e o despachante pode baixar o PDF e o Excel na mesma tela. O PDF traz Resumo, diferença e justificativa. "Reenviar e-mail" só manda o e-mail de novo, sem reabrir nem duplicar o fechamento.
5. **Financeiro, em "Para aprovar"**: aprova todos, ou marca quem devolver (cada um com motivo). Aprovar **não é pagar**.
   - **Devolução**: os devolvidos saem do fechamento e vão para um fechamento novo, ligado ao original, para a loja corrigir. No popup o financeiro escolhe o que fazer com os não devolvidos: **aprovar o pagamento deles** agora ou **deixar aguardando aprovação** no fechamento original. Se todos forem devolvidos, o fechamento inteiro volta à loja. O despachante vê motivo e pessoas em Pendências, com o botão "Corrigir devolução".
   - Cada decisão confere a versão: uma tela desatualizada não aprova nem devolve.
6. **Financeiro, em "Pagamentos"**: cada fechamento aprovado mostra quem recebe, com o **PIX registrado na aprovação** (não o cadastro atual) e o botão "Copiar PIX". A transferência é feita no banco, fora do sistema; depois o financeiro marca os fechamentos e clica em **Registrar pagamento** (vários juntos viram um lote). O servidor recusa a seleção inteira se o fechamento já tiver pagamento registrado, se o valor mudou ou se a aprovação/PIX mudou desde que a tela foi aberta. "Desfazer registro de pagamento" só tira a marcação no sistema; a transferência feita no banco continua valendo.

Estados mostrados: Falta importar · Em conferência · Aguardando aprovação · Devolvido para correção · Aprovado, a pagar · Pago. No banco, `status = 'pago'` quer dizer **aprovado** (nome legado, mantido para não migrar dados); o pagamento efetivo é `pago_em`/`lote`.

Perfis (entregadores não acessam o sistema):
- **TI/Admin**: tudo, inclusive usuários e **Configurações** (e-mail, destinatários, lojas). Na primeira vez, a tela inicial mostra um checklist de configuração.
- **Gestão**: só vê (aguardando aprovação, aprovado a pagar e pago).
- **Financeiro**: aprova ou devolve em "Para aprovar" e registra pagamentos em "Pagamentos" (só lojas do seu cadastro, se houver).
- **Despachante**: só a própria loja; importa, confere, completa PIX, envia e corrige devoluções.

Regras:
- Um pedido não entra em dois fechamentos (a importação recusa e oferece "Abrir fechamento existente").
- O dia operacional vai das 06:00 às 06:00 do dia seguinte (`VIRADA_H` e `FILTRO_HORA` em importar.js): pedido antes das 06:00 conta no dia anterior. Ex.: segunda a quinta = filtro de segunda 06:00 até sexta 06:00. Fechamentos importados antes desta regra (virada às 05:00) não foram recalculados. O filtro do Agilizone é só orientação: loja e período são lidos dos arquivos.
- Mudanças de PIX e ações nos fechamentos ficam no histórico.

## E-mail (Google Workspace)
Em **Configurações** (login da TI) há o passo a passo. Resumo: numa conta do domínio (ex.: `tecnologia@grupofornopaulista.com`), ative a verificação em duas etapas, crie uma **senha de app** em myaccount.google.com/apppasswords e preencha servidor `smtp.gmail.com`, porta `587`, usuário e senha de app. Depois use **Enviar teste**. Sem servidor configurado, os e-mails ficam salvos em `data/emails/`, não saem e o envio ao financeiro fica bloqueado.

## Rodar
Requer Node 22.13 ou mais novo.
```bash
npm install
npm start
```
Na primeira execução, o terminal mostra a senha do usuário `admin`. Também dá para definir essa senha com `ADMIN_SENHA`.

Abra http://localhost:3080.

Variáveis: `PORT` (padrão 3080), `HOST`, `DATA_DIR` (banco SQLite e evidências, padrão `./data`), `COOKIE_SECURE=1` quando estiver atrás de HTTPS, `APP_URL` (link que vai no e-mail, ex.: `https://motoboys.seudominio.com.br`).

As configurações de e-mail ficam na tela **Configurações**. As variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `EMAIL_PARA` e `APP_URL` servem só como valor inicial quando a tela ainda não foi preenchida.

Para testar mexendo no código: `npm run dev` (reinicia sozinho a cada alteração). Sem servidor de e-mail, use `EMAIL_SO_ARQUIVO=1` para o e-mail salvo em `data/emails/` contar como enviado (só desenvolvimento e testes; nunca em produção).

Testes: `npm test`

## Instalar na VPS (Ubuntu/Debian)
Antes, aponte um domínio (ex.: `motoboys.seudominio.com.br`) para o IP da VPS.

```bash
# Node 24 e Caddy (HTTPS automático)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs caddy

# Usuário do sistema e código em /opt/motoboys
sudo useradd --system --home /opt/motoboys motoboys
sudo git clone <repo> /opt/motoboys   # ou copie a pasta do projeto
cd /opt/motoboys && sudo npm ci --omit=dev
sudo mkdir -p data && sudo chown -R motoboys: data

# Serviço
sudo cp deploy/motoboys.service /etc/systemd/system/
sudo systemctl enable --now motoboys
sudo journalctl -u motoboys | grep 'Usuário inicial'   # senha do admin

# HTTPS: edite o domínio em deploy/Caddyfile antes de copiar
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy

# Backup diário às 3h (guarda 30 dias em /var/backups/motoboys)
sudo chmod +x deploy/backup.sh
echo '0 3 * * * root /opt/motoboys/deploy/backup.sh' | sudo tee /etc/cron.d/motoboys-backup
```

O app escuta só em `127.0.0.1:3000`, e o acesso de fora passa pelo Caddy (HTTPS). Libere no firewall apenas as portas 80 e 443:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Para atualizar a versão:

```bash
cd /opt/motoboys && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart motoboys
```

Copie os backups para fora da VPS de vez em quando (Drive, outro servidor), porque se a VPS morrer os backups vão junto.

## Importação direto do Agilizone (API v3)

As credenciais de cada loja ficam **só nas variáveis de ambiente do servidor** (nunca no banco nem na tela): `AGILIZONE_<LOJA>_ID` e `AGILIZONE_<LOJA>_SECRET`, com o nome da loja em maiúsculas, sem acento e com `_` no lugar de espaços (ex.: `AGILIZONE_FORNO_PAULISTA_DIRCEU_ID`). Em **Configurações > Lojas** aparece o nome exato das variáveis de cada loja e o botão **Testar conexão**. Com a loja conectada, a tela de importar mostra **Importar direto do Agilizone**: busca os pedidos finalizados do período (06:00 a 06:00, horário de Teresina) e a taxa de cada entregador (`deliverymanFee`). A importação por arquivo continua como alternativa.

- A API não traz chave PIX nem CPF: ficam em **Configurações > Entregadores** (dá para carregar de um Resumo .csv). O entregador é ligado pelo id do Agilizone.
- A API não traz Ocorrências nem acertos já feitos ("Já pago"): se precisar deles, anexe o Resumo (.csv) ao fechamento.
- O escopo `DELIVERYMAN_FEES` precisa estar liberado para a credencial; sem ele a importação é recusada.
- Variável opcional `AGILIZONE_URL` (padrão: produção).
