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

Os dados ficam no arquivo `dados/jurify.db`. Faça backup dessa pasta.

## Como colocar no ar (Railway)

O monitoramento roda no servidor, então o app precisa ficar ligado 24 horas. O Railway publica direto do GitHub, já com HTTPS. Custa cerca de US$ 5 por mês (plano Hobby).

1. **GitHub:** crie uma conta em <https://github.com/signup> e um repositório **privado** chamado `rodjuris`, sem README.
2. **Envie o código** para esse repositório.
3. **Railway:** entre em <https://railway.com> → *Login* → *Continue with GitHub*. Assine o plano **Hobby**.
4. *New Project* → *Deploy from GitHub repo* → escolha `rodjuris`. O Railway usa o `Dockerfile` e o `railway.json` deste projeto.
5. **Volume (obrigatório, senão os dados se perdem a cada atualização):** no projeto, clique com o botão direito no espaço vazio (ou `Ctrl+K`) → *Volume* → conecte ao serviço `rodjuris` com o caminho de montagem **`/app/dados`**.
6. **Variáveis** (aba *Variables* do serviço):
   - `TZ_APP` = `America/Sao_Paulo`
   - `VAPID_SUBJECT` = `mailto:seu-email@exemplo.com`
7. **Endereço:** *Settings* → *Networking* → *Generate Domain*. Clique no lápis para trocar o nome para `rodjuris` (fica `https://rodjuris.up.railway.app`, se estiver livre).
8. Abra o endereço, **crie sua senha** e vá em *Ajustes*:
   - informe sua OAB/UF;
   - configure o e-mail e clique em *Enviar e-mail de teste*;
   - clique em *Verificar agora* para confirmar que o servidor consegue consultar o CNJ.
9. **No celular:**
   - **Android (Chrome):** abra o endereço, menu ⋮ → *Instalar app*.
   - **iPhone (Safari, iOS 16.4+):** *Compartilhar* → *Adicionar à Tela de Início* e abra pelo ícone.

   Depois, em *Ajustes*, toque em **Ativar neste aparelho** para receber as notificações.

Cada vez que o código for atualizado no GitHub, o Railway publica a nova versão sozinho. Os dados continuam no volume.

### Outra opção: VPS própria

Num servidor com Docker:

```bash
docker compose up -d --build
```

Para ter HTTPS, coloque o [Caddy](https://caddyserver.com/) na frente do app: `seudominio.com.br { reverse_proxy localhost:3000 }`.

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
  index.js        inicia o servidor e os agendamentos (lembretes a cada minuto, monitoramento a cada N horas)
  app.js          API REST + autenticação por senha
  db.js           banco SQLite (node:sqlite, sem dependências nativas)
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
