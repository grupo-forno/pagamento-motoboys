# Pagamento Motoboys

Sistema web que substitui a planilha de pagamento dos motoboys. Ele lê o relatório exportado do Agilizone.

## Fluxo
1. **Despachante**: no Agilizone, escolhe a loja, abre *Relatório de Pedidos*, preenche o período e clica em *Aplicar filtros*. Na mesma tela exporta **dois arquivos**:
   - *Exportar Pedidos* (`.xlsx`): os pedidos de cada dia.
   - *Resumo de entregas por entregador* → *Exportar Resumo* (`.csv`): o total certo de cada motoboy.

   Em seguida importa os dois em **Novo fechamento**. O sistema confere a soma dos dias de cada motoboy com o Resumo. Se não bater, a linha fica marcada como "Não bate com o Resumo" e o fechamento não pode ser enviado até o despachante registrar a diferença no dia certo. O PIX e o CPF que estiverem no Resumo são cadastrados automaticamente em quem ainda não tem (nunca sobrescrevem um valor já cadastrado).
2. Na primeira vez, o despachante liga cada nome do Agilizone a um motoboy cadastrado. Nas importações seguintes isso já sai automático.
3. O sistema mostra o valor por motoboy e por dia (soma da coluna *Taxa do Entregador*). Se o motoboy informou outro valor, o despachante clica no dia e registra a **divergência**: valor informado, valor final, justificativa e evidências.
4. **Enviar ao financeiro**: só funciona quando todos os motoboys com valor a receber têm chave PIX.
5. **Financeiro**: marca cada motoboy como pago ou devolve o fechamento para correção. Quando todos estão pagos, o fechamento fica como "Pago".

Perfis:
- **TI/Admin**: tudo, inclusive usuários.
- **Gestão**: só vê.
- **Financeiro**: vê tudo e paga. Quando o fechamento é enviado, recebe **e-mail com o PDF** no endereço cadastrado em Usuários.
- **Despachante**: só a própria loja. Cria o acesso dos motoboys na ficha de cada um.
- **Motoboy**: vê só os próprios valores por dia. Se algo não bate, informa o valor e a explicação. O fechamento só pode ser enviado depois que o despachante confere todas essas informações.

Regras:
- Um pedido não entra em dois fechamentos.
- Pedido iniciado antes das 05:00 conta no dia anterior.
- Mudanças de PIX e ações nos fechamentos ficam no histórico.

## Rodar
Requer Node 22.13 ou mais novo.
```bash
npm install
npm start
```
Na primeira execução, o terminal mostra a senha do usuário `admin`. Também dá para definir essa senha com `ADMIN_SENHA`.

Abra http://localhost:3080.

Variáveis: `PORT` (padrão 3080), `HOST`, `DATA_DIR` (banco SQLite e evidências, padrão `./data`), `COOKIE_SECURE=1` quando estiver atrás de HTTPS, `APP_URL` (link que vai no e-mail, ex.: `https://motoboys.seudominio.com.br`).

E-mail: `SMTP_HOST`, `SMTP_PORT` (587 ou 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. No Google Workspace, use `smtp.gmail.com`, porta 587 e uma **senha de app** da conta. Sem `SMTP_HOST`, os e-mails são salvos em `data/emails/` em vez de enviados, o que serve para testar.

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

# E-mail: crie /etc/motoboys.env com APP_URL=..., SMTP_HOST=..., SMTP_USER=..., SMTP_PASS=... (uma por linha)
sudo nano /etc/motoboys.env && sudo chmod 600 /etc/motoboys.env

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
