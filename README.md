# RodJuris

Aplicativo web pessoal para advogados, inspirado no [Jurify](https://github.com/ma-serra/jurify-app). Com ele você pode:

- **Gerenciar processos judiciais:** cadastro com o número CNJ, validação do dígito verificador e preenchimento automático de tribunal, vara, classe e assunto pelo DataJud.
- **Monitorar publicações:** consulta automática ao **DJEN / Comunica PJe** (Diário de Justiça Eletrônico Nacional), por processo e, se quiser, pelo seu **número da OAB**.
- **Acompanhar andamentos:**
  - processos do **TJMG no PJe:** lidos direto da **Consulta Pública do PJe**, mais rápido, sem esperar o DataJud. O app detecta quando o processo é migrado para o eproc;
  - demais processos: pelo **DataJud** (API Pública do CNJ), com novas tentativas automáticas quando ele estiver instável.
- **Receber sugestões de prazo** (eproc), sempre marcadas como "Sugestão — confirme a data":
  - **intimação pendente:** lembrete "Tomar ciência" no limite da ciência tácita (10 dias corridos, Lei 11.419/2006, art. 5º, §3º). Ele é concluído sozinho quando você abre a intimação no eproc;
  - **andamento "intimação… Prazo: N dias – Status: ABERTO" para o cliente cadastrado:** lembrete com a data mais cedo possível (ciência no mesmo dia), em dias úteis, descontando fins de semana, feriados nacionais e o recesso de 20/12 a 20/1. Não considera feriados locais nem prazos em dobro: confira sempre.
- **Registrar providências** de cada processo, numa aba própria:
  - cada registro tem data, hora (opcional), tipo (envio a setor, solicitação/ofício, cumprimento de decisão, audiência, reunião, petição, outro) e descrição;
  - há um lembrete opcional na data (ex.: audiências);
  - os registros podem ser editados e excluídos.
- **Fluxos e orientações** (menu "Fluxos"), para guardar as regras e rotinas de trabalho:
  - cada fluxo tem título, assunto, passo a passo (um passo por linha, numerado automaticamente), regras e orientações (com **negrito**, listas com "-" e links) e referências;
  - assuntos funcionam como pastas (abas no topo e "Organizar assuntos"), com busca em todo o conteúdo;
  - favoritos ⭐ no topo, data de atualização e botão "Copiar texto".
- **Anotações gerais** (menu "Anotações"), para processos que você não precisa acompanhar:
  - cada anotação tem título, nº do processo e nº SEI (opcionais), etiquetas e texto livre;
  - subdivisão por **tipo de ação / assunto** (como pastas): abas no topo, agrupamento em "Todas" e a janela "Organizar tipos", para renomear, juntar ou remover;
  - busca por qualquer palavra e filtro por etiqueta;
  - dá para fixar as mais importantes no topo;
  - não há monitoramento nem avisos;
  - o botão "Passar a acompanhar" transforma a anotação em processo monitorado.
- **Audiências** (menu próprio):
  - cada audiência tem nº do processo, nº SEI, data, hora, tipo/local/link, partes e observações;
  - gera um lembrete automático com a antecedência escolhida (1 h a 1 semana);
  - a lista se divide em "Próximas" e "Realizadas";
  - aparece no Painel ("Próximas audiências") e como etiqueta no processo cadastrado com o mesmo número.
- **Número do processo SEI** vinculado a cada processo judicial: botão de copiar, busca pelo número e página **Processos SEI** com todos os números cadastrados em processos, anotações e audiências.
- **Acompanhar o cumprimento de liminares deferidas:**
  - **situação:** pendente, em andamento, cumprida parcialmente ou cumprida;
  - **dados:** prazo para cumprimento (com calculadora em dias úteis, dias corridos ou horas), setor/responsável a cobrar e multa fixada;
  - **histórico de providências**, com data;
  - **lembretes automáticos:** um do prazo final (aviso 2 dias antes) e cobranças periódicas a cada N dias úteis (padrão 3). Todos são concluídos sozinhos ao marcar "cumprida";
  - **onde aparece:** quadro "Liminares pendentes de cumprimento" no Painel e filtro na lista de processos.
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

### eproc do TJMG (opcional, recomendado para quem tem processos no eproc)

Com o seu login de advogado, o RodJuris usa o **webservice oficial do eproc (MNI 2.2.2)** para:
- ler as **movimentações** dos processos do eproc direto do tribunal, sem depender do DataJud;
- listar, de hora em hora, as **intimações e citações pendentes** e avisar as novas.

Para ativar, na Vercel (Settings → Environment Variables), crie:
- `EPROC_USUARIO`: o seu usuário de login no eproc do TJMG;
- `EPROC_SENHA`: a sua senha do eproc.

Depois, faça o **Redeploy** e confira em **Ajustes → Testar conexões**.

> **Segurança e prazos**
> - As credenciais ficam só nas variáveis secretas da Vercel. Nunca vão para o banco, o código ou o GitHub.
> - O app usa apenas operações de **leitura** (`consultarProcesso` sem documentos e `consultarAvisosPendentes`).
> - Ele **nunca** usa `consultarTeorComunicacao`, que registraria a ciência da intimação. A ciência só acontece quando você abre a comunicação no eproc.

Para desligar: `EPROC_TJMG=0`. A leitura da Consulta Pública do PJe do TJMG pode ser desligada com `PJE_TJMG=0`.

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
  pje_tjmg.js     leitura da Consulta Pública do PJe do TJMG (desligue com PJE_TJMG=0)
  eproc_mni.js    webservice oficial do eproc do TJMG (MNI 2.2.2), só leitura
  classes_cnj.js  nomes oficiais das classes (TPU/SGT do CNJ), guardados no banco
  prazos.js       estimativa de prazos em dias úteis (para sugestões)
  cumprimento.js  cumprimento de liminares: lembretes de prazo e de cobrança
  audiencia.js    audiências (menu próprio) → lembrete automático
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
- Tudo fica no **seu** banco de dados (Supabase na Vercel, ou PGlite no servidor próprio). Nenhum dado é enviado a terceiros além das consultas ao CNJ (número do processo/OAB) e do envio de e-mail pelo seu SMTP.
- Faça backup regular da pasta `dados/`.
