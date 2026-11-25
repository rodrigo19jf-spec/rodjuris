# RodJuris

Aplicativo web pessoal para advogados, inspirado no [Jurify](https://github.com/ma-serra/jurify-app). Com ele você pode:

- **Gerenciar processos judiciais:** cadastro com o número CNJ, validação do dígito verificador e preenchimento automático de tribunal, vara, classe e assunto pelo DataJud.
- **Monitorar publicações:** consulta automática ao **DJEN / Comunica PJe** (Diário de Justiça Eletrônico Nacional), por processo e, se quiser, pelo seu **número da OAB**.
- **Acompanhar andamentos:** movimentações processuais vindas do **DataJud** (API Pública do CNJ).
- **Cadastrar lembretes e prazos:** tipos prazo, audiência, reunião e lembrete, com aviso antecipado (na hora, 15 min, 1 h, 1 dia, 1 semana…).
- **Usar a agenda:** calendário mensal com todos os compromissos.
- **Receber avisos** dentro do app (sininho), **por e-mail** e por **notificação no celular** (push).
- **Instalar no celular** como aplicativo (PWA), sem precisar de loja de apps.

As duas fontes de dados são **públicas e gratuitas** (CNJ). Você não precisa contratar Escavador, Jusbrasil ou outro serviço.

## Como funciona o monitoramento

1. Ao cadastrar um processo com "Monitorar" marcado, o app busca publicações dos últimos 180 dias e todos os andamentos. Esse histórico é guardado como **já lido**, para você não receber uma enxurrada de avisos antigos.
2. Depois disso, a cada **4 horas** (o intervalo pode ser mudado em *Ajustes*), o app consulta de novo cada processo monitorado. Cada publicação ou andamento **novo** gera um aviso no app, um e-mail e uma notificação push.
3. Se você informar sua **OAB/UF** em *Ajustes*, o app também avisa sobre qualquer publicação no DJEN em seu nome, mesmo de processos que ainda não estão cadastrados. Elas aparecem com um botão "Cadastrar processo".
4. O botão **Verificar agora** faz a consulta na hora.
5. Os lembretes são verificados a cada minuto e avisam com a antecedência que você escolheu.

> **Limitações:** processos em segredo de justiça não aparecem no DJEN nem no DataJud. O DataJud pode levar alguns dias para refletir uma movimentação. O app **não substitui** a conferência oficial dos prazos nos sistemas dos tribunais.

## Como rodar no seu computador

É preciso ter o [Node.js 22](https://nodejs.org/) ou mais recente.

```bash
npm install
```

```bash
npm start
```

Abra <http://localhost:3000>. No primeiro acesso o app pede para você **criar uma senha**.

Os dados ficam na pasta `dados/pg`. Faça backup dessa pasta.

## Como colocar no ar (Vercel, grátis — recomendado)

> **Importante:** o DJEN só aceita acessos de servidores **no Brasil**. Na Vercel, o projeto já vem configurado para rodar em São Paulo (`gru1`, veja `vercel.json`).

1. Na Vercel, importe este repositório (**Add New → Project**, *Framework Preset*: **Other**).
2. **Banco de dados:** no projeto, aba **Storage** → **Create Database** → **Supabase**.
   - Região **South America (São Paulo)**.
   - Conecte ao projeto. A variável `POSTGRES_URL` é criada sozinha.
3. **Variáveis** (Settings → Environment Variables):
   - `CRON_SECRET` = uma senha longa e aleatória, só para o agendador;
   - `TZ_APP` = `America/Sao_Paulo`.
4. **Redeploy:** aba Deployments → ⋯ → **Redeploy**.
5. **Agendador** (lembretes e monitoramento): crie uma conta grátis em <https://cron-job.org> e um *cronjob*:
   - URL: `https://SEU-PROJETO.vercel.app/api/cron?chave=SEU_CRON_SECRET`
   - Execução: **a cada 5 minutos**.

   A Vercel também chama essa rota 1 vez por dia, como reserva (`crons` em `vercel.json`).
6. Abra o site, crie sua senha e confira em **Ajustes**:
   - **Testar conexão com o CNJ**;
   - o status do **Agendador automático**.

Sem `POSTGRES_URL`/`DATABASE_URL`, o app usa um Postgres embutido (PGlite) gravado em `./dados/pg`. É o modo usado no computador local e em VPS.

## Alternativa: servidor próprio (VPS no Brasil)

> **Importante:** o DJEN só aceita acessos de servidores **no Brasil**. Serviços como Railway, Render e Heroku ficam no exterior e não funcionam para as publicações.

Use uma VPS com Ubuntu 24.04 numa região brasileira, por exemplo **Vultr São Paulo** (~US$ 5–6/mês) ou **Oracle Cloud São Paulo** (plano grátis). Conectado como `root` (por SSH), rode:

```bash
curl -fsSL https://raw.githubusercontent.com/rodrigo19jf-spec/rodjuris/main/deploy/instalar.sh | bash
```

O script:
- instala o Docker e libera as portas 80 e 443;
- sobe o app com **HTTPS automático** (Caddy + Let's Encrypt) num endereço grátis do tipo `https://203-0-113-10.sslip.io`;
- **testa a conexão com o DJEN e o DataJud**.

Para usar um domínio próprio, aponte o domínio para o IP do servidor e rode:

```bash
curl -fsSL https://raw.githubusercontent.com/rodrigo19jf-spec/rodjuris/main/deploy/instalar.sh | DOMINIO=meudominio.com.br bash
```

Para **atualizar**, rode o mesmo comando de novo. Os dados ficam em `/opt/rodjuris/dados`; faça backup dessa pasta.

Para testar a conexão com o CNJ a qualquer momento:

```bash
cd /opt/rodjuris/deploy && docker compose exec app node server/diagnostico.js
```

## Configurar o e-mail

Em *Ajustes* → *Avisos por e-mail*, informe o servidor SMTP. Com Gmail:

| Campo | Valor |
|---|---|
| Servidor | `smtp.gmail.com` |
| Porta | `587` |
| Usuário | seu e-mail do Gmail |
| Senha | uma **senha de app** (Conta Google → Segurança → Verificação em duas etapas → Senhas de app) |

Use o botão **Enviar e-mail de teste** para conferir. Se preferir, configure por variáveis de ambiente (veja `.env.example`).

## Estrutura

```
server/
  index.js        servidor comum (local/VPS) com relógio interno a cada minuto
api/index.js      ponto de entrada na Vercel (todas as rotas /api)
  app.js          API REST + autenticação por senha
  db.js           banco PostgreSQL (Supabase/Neon na Vercel; PGlite embutido no modo local)
  cnj.js          número CNJ: validação, formatação, tribunal
  fontes.js       clientes DJEN (Comunica PJe) e DataJud
  monitor.js      verificação de publicações, andamentos e lembretes
  notificador.js  avisos no app, e-mail (nodemailer) e push (web-push)
public/           frontend PWA (HTML/CSS/JS puro, sem etapa de build)
test/             testes automatizados (APIs do CNJ simuladas)
```

```bash
npm test
```

## Privacidade e segurança

- O app é **de uso individual**: protegido por senha, com sessão de 30 dias e limite de tentativas de login.
- Tudo fica no **seu** servidor (SQLite). Nenhum dado é enviado a terceiros além das consultas ao CNJ (número do processo/OAB) e do envio de e-mail pelo seu SMTP.
- Faça backup regular da pasta `dados/`.
