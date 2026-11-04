# Pagamento Motoboys

Sistema web que substitui a planilha de pagamento dos motoboys. Ele lê o relatório exportado do Agilizone.

## Fluxo
1. **Despachante**: no Agilizone, escolhe a loja, abre *Relatório de Pedidos*, preenche o período e clica em *Aplicar filtros*. Na mesma tela exporta **dois arquivos**:
   - *Exportar Pedidos* (`.xlsx`): os pedidos de cada dia. Pedidos sem motoboy atrelado são descartados.
   - *Resumo de entregas por entregador* → *Exportar Resumo* (`.csv`): o total certo e a chave PIX de cada motoboy.

   Em seguida importa os dois em **Novo fechamento**.
2. Na primeira vez, o despachante liga cada nome do Agilizone a um motoboy cadastrado. Nas importações seguintes isso já sai automático.
3. O sistema mostra o valor por motoboy e por dia e confere com o Resumo:
   - **Não bate com o Resumo**: a linha fica marcada e o envio é bloqueado até o despachante registrar a diferença no dia certo (a tela já sugere o valor).
   - **PIX**: vem do Resumo e atualiza o cadastro (fica no histórico). Se faltar, o despachante digita na própria tela do fechamento.
   - **Acerto já feito no Agilizone** (coluna "Pago" do Resumo): o sistema avisa para não pagar em dobro.
   - Se um motoboy disser que o valor está errado, o despachante clica no dia e registra a **divergência** (valor, justificativa, evidências).
4. **Enviar ao financeiro**: sai um e-mail com o **PDF da solicitação de pagamento** para os destinatários definidos em Configurações. A tela mostra se o e-mail foi enviado, com botão para reenviar.
5. **Financeiro**: copia o PIX de cada motoboy, paga e marca como pago (um por um ou "Marcar todos como pagos"). Pode devolver ao despachante com o motivo, e o despachante recebe um e-mail.

Perfis (motoboys não acessam o sistema):
- **TI/Admin**: tudo, inclusive usuários e **Configurações** (e-mail, destinatários, lojas).
- **Gestão**: só vê.
- **Financeiro**: vê tudo e paga.
- **Despachante**: só a própria loja; importa, confere, completa PIX e envia.

Regras:
- Um pedido não entra em dois fechamentos.
- Pedido iniciado antes das 05:00 conta no dia anterior.
- Mudanças de PIX e ações nos fechamentos ficam no histórico.

## E-mail (Google Workspace)
Em **Configurações** (login da TI) há o passo a passo. Resumo: numa conta do domínio (ex.: `tecnologia@grupofornopaulista.com`), ative a verificação em duas etapas, crie uma **senha de app** em myaccount.google.com/apppasswords e preencha servidor `smtp.gmail.com`, porta `587`, usuário e senha de app. Depois use **Enviar teste**. Sem servidor configurado, os e-mails ficam salvos em `data/emails/` e não saem.

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

Para testar mexendo no código: `npm run dev` (reinicia sozinho a cada alteração).

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
