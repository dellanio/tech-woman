# Manual da Beatriz — Tech Woman (PostgreSQL + Agenda)

> **Status:** rascunho para aprovação do sponsor — **NÃO ENVIADO** à Beatriz (nem por e-mail, nem por mensagem). Só depois do "aprovado" do sponsor este arquivo e o `DER` seguem para ela.
> **Para quem é:** quem está começando. Você **não precisa saber programar** para seguir os capítulos 1 a 4; a partir do 5 vamos devagar.
> **Reflete o código:** este manual foi escrito e **testado** sobre o código já integrado (PostgreSQL 16, Drizzle, API `/api/v1`). Onde o plano antigo e o código divergem, vale o **código** — veja o capítulo 12.
> **Dados deste manual:** tudo é fictício (`@example.invalid`). Nenhuma senha, e-mail real ou endereço de servidor aparece aqui — e **nunca** deve aparecer num arquivo do repositório.

## Sumário

1. [O mapa: SITE × PostgreSQL × pgAdmin](#1-o-mapa-site--postgresql--pgadmin)
2. [Preparar o computador: VSCode, ferramentas e IA](#2-preparar-o-computador-vscode-ferramentas-e-ia)
3. [Baixar o projeto e entender as pastas](#3-baixar-o-projeto-e-entender-as-pastas)
4. [Instalar e rodar no seu computador (Docker + PostgreSQL)](#4-instalar-e-rodar-no-seu-computador-docker--postgresql)
5. [O banco no código: Drizzle, schema e migrations](#5-o-banco-no-código-drizzle-schema-e-migrations)
6. [Git, branches, testes, Pull Request e CI (sem editar a `main`)](#6-git-branches-testes-pull-request-e-ci-sem-editar-a-main)
7. [Regras do negócio (dicionário)](#7-regras-do-negócio-dicionário)
8. [A API de Agenda (`/api/v1`) passo a passo](#8-a-api-de-agenda-apiv1-passo-a-passo)
9. [Consultar dados pelo pgAdmin](#9-consultar-dados-pelo-pgadmin)
10. [E-mails: o que cada estado significa](#10-e-mails-o-que-cada-estado-significa)
11. [Quando algo dá errado](#11-quando-algo-dá-errado)
12. [O que foi testado e o que ainda depende de outras pessoas](#12-o-que-foi-testado-e-o-que-ainda-depende-de-outras-pessoas)
13. [Glossário](#13-glossário)

Arquivos que acompanham este manual: [`DER.md`](DER.md) (diagrama e dicionário de todas as tabelas), [`DER.svg`](DER.svg) (o diagrama renderizado), [`agenda-examples.http`](agenda-examples.http) (roteiro executável da API) e [`operations-postgres.md`](operations-postgres.md) (parte técnica da operação, para quem cuida do servidor).

---

## 1. O mapa: SITE × PostgreSQL × pgAdmin

Três coisas diferentes, que as pessoas costumam misturar. Guarde esta tabela:

| | **SITE** | **PostgreSQL** | **pgAdmin** |
|---|---|---|---|
| O que é | O aplicativo que as pessoas abrem no navegador (`/`, `/inscricao`, `/mentora`, `/login`, `/conta`, `/admin`). | O **banco de dados**: onde tudo fica guardado (contas, mentoras, temas, turmas, reservas). | Um **programa de consulta** do banco para a Beatriz, que abre no navegador. |
| Analogia | O balcão de atendimento. | O arquivo/estoque atrás do balcão. | Uma janela para consultar as prateleiras, sem modificar o estoque. |
| Quem usa | Participantes, mentoras, equipe e administradoras. | Só o site (e o enviador de e-mails) falam com ele. | Pessoas autorizadas, em último caso. |
| Login | E-mail e senha da **conta do site**. | Papéis (roles) do banco: `techwoman_runtime`, `techwoman_migrator`… | Uma conta **própria** do pgAdmin + um papel do banco com permissão limitada. |

### Os papéis do SITE

| Papel | Pode |
|---|---|
| `admin` | Gestão completa **do site** (painel `/admin`, API de administração). **Não** é uma conta do pgAdmin nem um papel do PostgreSQL. |
| `team` (equipe) | Só **consultar** o painel. Não altera nada. |
| `mentor` | Gerir os **próprios** temas e turmas. |
| `participant` | Receber recomendações e **reservar** turmas. |

Uma mesma pessoa (um e-mail) pode ter mais de um papel (ex.: mentora **e** participante). A conta de uma administradora **não aparece** nas telas/rotas comuns de gestão de usuários — isso é proposital, para ninguém se promover a administradora por engano ou por atalho. Tornar alguém administradora é uma operação especial, feita por quem cuida do servidor, fora do site.

### Quem pode mudar o quê

- **Dados do dia a dia** (cadastros, mentoras, participantes): pelo painel `/admin`.
- **Temas, turmas e reservas (a Agenda):** **não existe tela de cadastro de Agenda**. A Agenda é cadastrada pela **API** (capítulo 8) por quem tem permissão. A participante apenas **escolhe** mentora e horário numa tela do site.
- **Estrutura do banco** (criar tabela/coluna): só por **código** (Drizzle + migration, capítulo 5), com revisão num Pull Request.
- **pgAdmin da Beatriz:** somente consulta dos campos permitidos (capítulo 9). Para incluir, alterar ou excluir dados, peça à pessoa administradora responsável pelo site.

> **A regra de ouro:** o site é o caminho principal. O pgAdmin é a ferramenta de exceção e **nunca** é um atalho para contornar uma regra.

---

## 2. Preparar o computador: VSCode, ferramentas e IA

### 2.1 O que instalar (uma vez)

| Programa | Para quê | Como conferir |
|---|---|---|
| **VSCode** | Editor onde você lê e edita o projeto. | Abre o programa. |
| **Git** | Controla o histórico do código. | `git --version` |
| **Node.js 24** | Roda o site em modo desenvolvimento. | `node --version` (v24.x) |
| **pnpm 10** | Instala as bibliotecas do projeto. Depois do Node: `corepack enable`. | `pnpm --version` (10.x) |
| **Docker Desktop** | Roda o PostgreSQL (e o site) em "caixinhas" isoladas, sem instalar o banco no Windows/Mac. | `docker --version` e `docker compose version` |

No **terminal do VSCode** (menu *Terminal → Novo Terminal*) rode esses comandos de conferência. Se algum falhar com "comando não encontrado", feche e reabra o VSCode depois de instalar.

### 2.2 Extensões do VSCode

Abra a aba de extensões (ícone de quadradinhos) e instale:

- **REST Client** (`humao.rest-client`) — executa o arquivo `docs/agenda-examples.http` com um clique.
- **Markdown Preview Mermaid Support** (`bierner.markdown-mermaid`) — mostra o desenho do DER dentro do VSCode.
- **Docker** (`ms-azuretools.vscode-docker`) — vê os contêineres.
- **PostgreSQL** (opcional) ou o próprio pgAdmin — para olhar as tabelas.

### 2.3 Como usar a IA (Copilot, Claude, ChatGPT…) sem se queimar

A IA é uma **ajudante rápida, não a dona do projeto**. Ela erra com confiança. Regras simples:

**Pode:**
- Pedir para **explicar** um arquivo ("explique em português simples o que `src/lib/schema.ts` faz").
- Pedir **um passo pequeno** de cada vez e um **teste** para ele.
- Pedir para **revisar** o que você escreveu e apontar riscos.
- Cole mensagens de erro (depois de retirar qualquer senha/e-mail real delas).

**Nunca:**
- Colar o conteúdo do seu `.env`, senhas, tokens, chaves, endereços de servidores ou **dados reais** de participantes/mentoras em qualquer IA.
- Aceitar alteração em `drizzle/*.sql` **já existentes**, em `.github/workflows/`, em `ops/` ou em `scripts/migration/` sem entender e sem revisão. Esses arquivos protegem o banco e a publicação do site.
- Pedir à IA para "desligar o teste que falha" ou "ignorar o erro de tipo". Teste vermelho é um aviso: conserte a causa.
- Deixar a IA mexer na `main` ou fazer `push` por você.

**Modelo de pedido que funciona:**

```text
Contexto: projeto Next.js + PostgreSQL + Drizzle (Tech Woman).
Quero: <uma coisa pequena e específica>.
Regras: não alterar arquivos em drizzle/ que já existem; não mexer em .github/ nem ops/;
        escrever primeiro um teste; manter português nos textos da tela.
Mostre: só o diff (o que muda), e como eu testo (comando).
```

**Antes de aceitar qualquer mudança da IA**, rode no terminal: `git diff` (veja o que mudou), depois os testes do capítulo 6.

---

## 3. Baixar o projeto e entender as pastas

```bash
git clone <endereço-do-repositório> tech-woman
cd tech-woman
code .
```

(`<endereço-do-repositório>` é o link "Code → HTTPS" da página do projeto no GitHub; o `code .` abre o VSCode nesta pasta.)

| Pasta / arquivo | O que tem | Pode editar? |
|---|---|---|
| `src/app/` | Páginas do site e as **rotas da API** (`src/app/api/v1/...`). | Sim, com cuidado e teste. |
| `src/lib/` | Regras de negócio, acesso ao banco, e-mail, **`schema.ts`** (o desenho do banco em código). | Sim, com teste. |
| `drizzle/` | **Migrations**: arquivos `.sql` que constroem o banco, em ordem. | **Só adicionando arquivo novo.** Nunca altere um que já existe. |
| `scripts/` | Migrador (`migration/migrate.ts`), seed de demonstração, enviador de e-mails. | Raramente. |
| `tests/` | Testes automáticos (Python e TypeScript contra PostgreSQL real). | Sim, é bom adicionar. |
| `docs/` | Este manual, `DER.md`, `DER.svg`, `agenda-examples.http`, `operations-postgres.md`. | Sim. |
| `ops/` e `.github/` | Publicação (deploy) e verificações automáticas. Mexem em **produção**. | **Não**, sem a pessoa responsável pela operação. |
| `.env.example` | Modelo das configurações. **Sem segredos.** | Só para atualizar o modelo. |
| `.env` | **Suas** configurações locais, com senhas. **Nunca vai para o Git** (já está no `.gitignore`). | Só no seu computador. |
| `compose.yaml` | Receita do Docker: banco + migrador + seed + site + enviador de e-mails. | Raramente. |

---

## 4. Instalar e rodar no seu computador (Docker + PostgreSQL)

### 4.1 Criar o seu `.env`

O `.env` guarda as configurações do **seu computador**. Ele nasce de uma cópia do modelo:

```bash
cp .env.example .env
```

No Windows (PowerShell) use `Copy-Item .env.example .env`. Abra o `.env` no VSCode e **troque todo valor que começa com `replace-`** por um valor seu. Para gerar valores aleatórios bons, rode no terminal (um por vez, quantas vezes precisar):

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

| Variável | O que colocar |
|---|---|
| `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `MAILER_PASSWORD` | Uma senha **diferente** em cada (use o comando acima; só letras e números). São as senhas de 4 "usuários" do banco, cada um com poderes mínimos. |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `MAILER_DATABASE_URL` | Já vêm montadas; troque dentro delas o `replace-...-random` **pela mesma senha** da variável correspondente (`RUNTIME_PASSWORD`, `MIGRATOR_PASSWORD`, `MAILER_PASSWORD`). |
| `SESSION_SECRET` | 64 caracteres aleatórios: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `RATE_LIMIT_SECRET` | Outro valor aleatório de 64 caracteres (diferente do anterior). |
| `ADMIN_EMAIL` | Um e-mail **fictício** para a administradora local, por exemplo `admin-local@example.invalid`. |
| `ADMIN_PASSWORD` | Mínimo **16 caracteres**; é a senha da administradora **só do seu computador**. |
| `APP_ORIGIN` | Deixe `http://localhost:3000`. O site recusa escritas vindas de outro endereço. |
| `EMAIL_MODE` e `SES_*` | Deixe como estão: `fake` (nenhum e-mail real sai; o envio é só simulado). |
| `TRUST_PROXY`, `MENTOR_DEADLINE` | Deixe como estão. |
| `RATE_LOGIN_PAIR_PER_MIN`, `RATE_LOGIN_IP_PER_MIN`, `RATE_EMAIL_PER_HOUR`, `RATE_IP_PER_HOUR`, `RATE_RESET_IP_PER_MIN` | Limites de tentativas (login por minuto, pedidos de e-mail por hora…). Deixe como estão. |

> O `.env` **nunca** é enviado ao GitHub nem a uma IA. Se um dia ele vazar, troque todas as senhas.

### 4.2 Subir tudo com um comando

Com o Docker Desktop **aberto**:

```bash
docker compose up --build
```

Na primeira vez demora alguns minutos. O que acontece, em ordem:

1. `postgres` — liga o banco **PostgreSQL 16** e cria os 3 usuários do banco com as senhas do seu `.env`.
2. `migrate` — aplica as **migrations** (cria as tabelas) e termina.
3. `seed` — cria 4 mentoras **fictícias** de demonstração e a **administradora local**, e termina.
4. `app` — liga o **site**. Fica disponível em **http://localhost:3000**.
5. `mailer` — o enviador de e-mails (no modo `fake`, ele só **simula**).

O PostgreSQL fica acessível só no seu computador, em `127.0.0.1:55432`. Para entrar no site como administradora: abra <http://localhost:3000/login> e use `ADMIN_EMAIL` e `ADMIN_PASSWORD` do seu `.env`; depois vá para `/admin`.

**Parar e recomeçar:**

| Quero… | Comando |
|---|---|
| Parar (mantém os dados do seu computador) | `Ctrl+C`, depois `docker compose down` |
| Ligar de novo | `docker compose up` |
| Apagar **todos os dados locais** e começar do zero | `docker compose down -v` ⚠️ (só no seu computador; apaga o volume do banco local) |

### 4.3 Caminho B: banco no Docker, site no VSCode (para mexer no código)

Quando você for editar o código, é melhor rodar o site direto no seu computador (ele recarrega sozinho ao salvar):

```bash
docker compose up -d --build seed
```

Isso liga o banco, aplica as migrations e roda o seed, em segundo plano. Espere o `seed` terminar (`docker compose ps -a` mostra `seed ... exited (0)`; `docker compose logs seed` mostra "Seed local explícito concluído."). Depois:

```bash
pnpm i
pnpm dev
```

Abra <http://localhost:3000>. O `pnpm dev` lê o `DATABASE_URL` do seu `.env` (o usuário `techwoman_runtime`, que só tem as permissões do site).

> Em desenvolvimento, o Next.js lê **todo** o `.env`, inclusive as senhas do migrador e do enviador de e-mails. Em produção isso não acontece: cada processo recebe só a credencial dele. Por isso o `.env` é só local.

### 4.4 Conferir que está tudo certo

| Conferência | Como | Esperado |
|---|---|---|
| Site no ar | abra <http://localhost:3000> | página do evento |
| API respondendo | abra <http://localhost:3000/api/v1/auth/session> | `{"error":{"code":"AUTH_REQUIRED",...}}` (é o esperado: você ainda não entrou) |
| Banco com as tabelas | `docker compose exec postgres psql -U techwoman_bootstrap -d techwoman -c "\dt"` | lista com `app_user`, `topic`, `cohort`, `enrollment`… |
| Migrations aplicadas | `docker compose exec postgres psql -U techwoman_bootstrap -d techwoman -c "select count(*) from internal.schema_migration"` | `27` (ou mais, se novas foram adicionadas) |

---

## 5. O banco no código: Drizzle, schema e migrations

### 5.1 Três ideias

- **`src/lib/schema.ts`** — o desenho do banco **escrito em TypeScript** (uma `pgTable(...)` para cada tabela). O **Drizzle** é a biblioteca que faz o código conversar com o banco usando esse desenho.
- **`drizzle/*.sql`** — as **migrations**: o histórico de mudanças do banco, uma por arquivo, aplicadas **em ordem de nome**. O banco do seu computador, o de testes e o de produção chegam ao mesmo estado aplicando os mesmos arquivos.
- **`pnpm db:migrate`** — o migrador (`scripts/migration/migrate.ts`). Ele guarda o **checksum** de cada arquivo aplicado (tabela `internal.schema_migration`). **Se alguém alterar um arquivo já aplicado, o migrador recusa** ("Migration aplicada diverge da versão registrada"). Por isso: **nunca edite uma migration antiga; crie uma nova.**

### 5.2 Receita: adicionar uma coluna (testada)

Exemplo: queremos uma coluna `color` (texto) na tabela `topic`.

1. **Confira que está tudo em sincronia** antes de começar:
   ```bash
   pnpm exec drizzle-kit generate --name=conferencia
   ```
   Deve responder **"No schema changes, nothing to migrate"**. Se criou arquivo novo, apague-o (`drizzle/…conferencia.sql` e o `snapshot` correspondente) e peça ajuda.
2. **Edite `src/lib/schema.ts`**: na `pgTable('topic', …)` acrescente `color:text('color'),`.
3. **Gere a migration:**
   ```bash
   pnpm exec drizzle-kit generate --name=topic_color
   ```
   Isso cria `drizzle/0004_topic_color.sql` (com `ALTER TABLE "topic" ADD COLUMN "color" text;`) e `drizzle/meta/0004_snapshot.json`.
4. ⚠️ **Renomeie para um nome com carimbo de data/hora maior que o último arquivo**, porque o migrador aplica em ordem alfabética e `0004_…` viria **antes** de `2026…` (e quebraria num banco novo):
   - `drizzle/0004_topic_color.sql` → `drizzle/20261101000000_topic_color.sql`
   - `drizzle/meta/0004_snapshot.json` → `drizzle/meta/20261101000000_snapshot.json`
   - em `drizzle/meta/_journal.json`, troque `"tag": "0004_topic_color"` por `"tag": "20261101000000_topic_color"`.
5. **Confira de novo:** `pnpm exec drizzle-kit generate --name=conferencia` deve voltar a dizer "No schema changes".
6. **Aplique no seu banco local:**
   ```bash
   docker compose run --rm migrate
   ```
   (esse serviço do `compose.yaml` já usa o migrador e aplica também as permissões locais do site). Confira a coluna: `docker compose exec postgres psql -U techwoman_bootstrap -d techwoman -c "\d topic"`.
7. Escreva/ajuste os **testes** (capítulo 6), atualize o `DER.md` e abra o Pull Request.

> Triggers, regras de vaga e permissões do banco **não** nascem do `schema.ts`: estão escritas à mão nos `.sql` de `drizzle/`. Mudanças nelas pedem revisão cuidadosa — não deixe a IA "adivinhar".

### 5.3 O desenho do banco

O mapa visual e o dicionário completo (todas as colunas) estão em [`DER.md`](DER.md) e [`DER.svg`](DER.svg). O resumo:

> uma **conta** (`app_user`) pode ser **participante** e/ou **mentora**; cada mentora oferece **até 2 temas** (`mentor_topic`); cada tema dela tem **turmas** (`cohort`) com horário e até 20 vagas; a participante faz uma **reserva** (`enrollment`) numa turma.

---

## 6. Git, branches, testes, Pull Request e CI (sem editar a `main`)

### 6.1 A política (leia com atenção)

- A `main` é o site **publicado**. Mudanças nela podem disparar a publicação. Por isso: **ninguém edita a `main` diretamente — nem você, nem a IA.** Nada de `git push origin main`, nada de commit estando na `main`, nada de `--force`.
- Todo trabalho acontece num **branch** (uma cópia de trabalho com nome seu) e entra por **Pull Request (PR)**.
- O PR precisa passar pela verificação automática chamada **CI** (job `check`). O PR da conta autorizada de edição é **mesclado automaticamente** quando o CI passa — então só abra o PR quando estiver **pronto e testado**.
- Não existe "aprovação humana" obrigatória no PR; a rede de segurança são **os testes**. Por isso nunca desligue, apague ou "pule" um teste para o CI passar.
- Não mexa em `.github/`, `ops/`, `Dockerfile`, `compose.yaml` ou em migrations já existentes sem a pessoa responsável pela operação.

### 6.2 O dia a dia, passo a passo

```bash
# 1. Comece sempre da main atualizada
git switch main
git pull

# 2. Crie o seu branch (nome curto: tipo/assunto)
git switch -c feat/minha-mudanca

# 3. Edite, teste (6.3), e veja o que mudou
git status
git diff

# 4. Guarde em pequenos commits, com mensagem clara
git add src/lib/schema.ts drizzle/20261101000000_topic_color.sql
git commit -m "feat: adiciona cor ao tema"

# 5. Envie o SEU branch (nunca a main)
git push -u origin feat/minha-mudanca
```

Depois abra o PR no GitHub (o link aparece no terminal após o `push`), escolha **base: `main`** e escreva: **o que mudou**, **como testou** (cole os comandos do 6.3) e, se mexeu na tela, um print. Nunca coloque dados reais, `.env` ou senhas na descrição.

Prefixos de commit usados no projeto: `feat:` (novidade), `fix:` (correção), `docs:` (documentação), `test:` (testes).

### 6.3 Os testes — o que rodar antes do PR

| Comando | O que verifica | Precisa de |
|---|---|---|
| `pnpm typecheck` | Erros de tipos no TypeScript. | só o Node |
| `pnpm test:unit` | Testes Python (regras de publicação, política do repositório). | Python 3 |
| `pnpm build` | O site compila (não usa banco). Rode com `BUILDING=1`. | só o Node |
| `pnpm test:pg` | **Testes contra um PostgreSQL de verdade**: reservas simultâneas, limites, permissões, e-mails. | um PostgreSQL 16 **só de testes** (abaixo), Python 3, `pg_dump`/`pg_restore` (ferramentas do PostgreSQL) e o Docker instalado |
| `pnpm test:e2e` | Fluxo completo: cadastro → e-mail simulado → login → troca de senha → reinício. | PostgreSQL de testes + `pnpm build` |

`test:pg` e `test:e2e` criam e apagam bases e **papéis (roles) `techwoman_*`**, e um dos testes exige que nenhum papel `techwoman*` do servidor seja superusuário. Por isso eles precisam de um **PostgreSQL 16 só para testes** — igual ao que o CI usa — e **nunca** do banco do seu dia a dia (nem do de produção). Com o Docker aberto:

```bash
docker run --rm -d --name tw-test-pg -e POSTGRES_PASSWORD=senha-so-de-teste -p 127.0.0.1:55433:5432 postgres:16
# bash/zsh (no PowerShell: $env:MIGRATION_DATABASE_URL="..." )
export MIGRATION_DATABASE_URL="postgresql://postgres:senha-so-de-teste@127.0.0.1:55433/postgres"
pnpm test:pg
docker stop tw-test-pg   # apaga o banco de testes (a opção --rm remove o contêiner)
```

Se um teste falhar: **leia a mensagem**, descubra se foi a sua mudança, conserte a causa. Não adianta "reexecutar até passar". Se mesmo assim travar, cole o erro (sem segredos) na IA ou peça ajuda.

### 6.4 O CI (verificação automática no GitHub)

Quando você abre um PR, o GitHub roda sozinho o que está em `.github/workflows/ci.yml`: testes Python, tipos, build, **`test:pg` num PostgreSQL 16 temporário**, testes de operação, e2e e a montagem da imagem do site. Se alguma etapa falhar, o PR **fica bloqueado** e você vê o motivo na aba "Checks". Corrija no mesmo branch e dê `git push` de novo: o CI roda outra vez.

---

## 7. Regras do negócio (dicionário)

| Regra | Valor | Onde o banco garante | O que acontece se violar |
|---|---|---|---|
| **Temas por mentora** | no máximo **2** (posição 1 e 2) | `mentor_topic_position_check`, `mentor_topic_position_unique`, `mentor_topic_pair_unique` | API: `409 TOPIC_LIMIT` |
| **Capacidade da turma** | de **1 a 20** vagas | `cohort_capacity_check` | API: `422 INVALID_INPUT` (campo `capacity`) |
| **Capacidade do cadastro da mentora** | `legacyCapacity` de 1 a 50 — é só **compatibilidade**, **não cria turma** | `mentor_capacity_check` | `422` |
| **Fim depois do início** | `endsAt` > `startsAt` | `cohort_time_check` | `422` |
| **Overlap (sobreposição) da mentora** | a mesma mentora não pode ter duas turmas com horários que se cruzam — **mesmo em temas diferentes** e mesmo em rascunho | gatilho `agenda_*` → erro `agenda_mentor_overlap` | `409 SCHEDULE_CONFLICT` |
| **Overlap da participante** | a participante não pode ter duas reservas ativas que se cruzam | `agenda_participant_overlap` | `409 SCHEDULE_CONFLICT` |
| **Horários colados** | 09:00–10:00 e 10:00–11:00 **não** se sobrepõem (o fim é exclusivo) | regra `[início, fim)` | permitido |
| **Reserva única** | uma reserva **ativa** por participante e turma | `enrollment_active_unique` | `409 ALREADY_ENROLLED` |
| **Vagas** | nunca passa da capacidade, mesmo com cliques simultâneos | gatilho `agenda_capacity_exceeded` + trava global `agenda_guard` | `409 COHORT_FULL` |
| **Só reserva em turma aberta e futura** | status `open` e início no futuro | gatilhos | `409 COHORT_NOT_OPEN` |
| **Turma com reservas** | não muda de horário nem de tema | gatilho | `409 COHORT_IN_USE` |
| **Aprovação humana** | **não existe**: escolheu e reservou, está reservado | — | — |

### 7.1 Datas: UTC no armazenamento, America/Recife na tela

- O banco guarda **instantes** (`timestamptz`). A API sempre **devolve em UTC** (termina com `Z`).
- A tela mostra no fuso **America/Recife** (UTC−3, sem horário de verão). Ex.: `09:00` em Recife = `12:00Z`.
- Quem **envia** uma data para a API tem de informar o fuso: `2026-11-14T09:00:00-03:00` ou `2026-11-14T12:00:00Z`. `2026-11-14T09:00:00` (sem fuso) é **recusado** (`422`) para ninguém errar em 3 horas.
- Exemplo real (testado): você manda `09:00–10:00-03:00`; a API devolve `"startsAt":"2026-11-14T12:00:00Z","endsAt":"2026-11-14T13:00:00Z","timeZone":"America/Recife"`.
- `event_content.date` (a data do evento no texto da página) é só um texto, não um instante.

### 7.2 IDs viajam como texto

IDs `bigint` (temas, turmas, reservas, mentoras…) são enviados e recebidos **entre aspas**: `"501"`, nunca `501`. Contas, sessões e jobs usam UUID.

### 7.3 Versão (`ETag` / `If-Match`)

Todo registro editável tem um número `version` que sobe a cada alteração. Ao **ler** um registro, o servidor devolve o cabeçalho `ETag: "3"`. Para **alterar ou apagar**, você manda esse número em `If-Match: "3"`. Se outra pessoa mudou antes de você, a versão não confere e o servidor recusa (`412`) em vez de sobrescrever o trabalho dela.

### 7.4 Senha e recuperação (reset)

- **Cadastro de participante** → diagnóstico, depois o **cruzamento** (só o nome das mentoras compatíveis, com troca; mentora sem nome de exibição aparece apenas como **(MENTORA)**), e por último e-mail + **senha definitiva** + confirmação. A conta já nasce ativa com o cruzamento escolhido; **nenhum e-mail é enviado** e não há senha temporária. Nunca se guarda a senha — só o resultado da "conta matemática" (hash).
- **Cadastro de mentora** (e contas criadas pela equipe ou pendentes de antes) → o site **enfileira** um e-mail com uma **senha temporária** (vale 24 h, uso único).
- **Primeiro login** com a temporária (só para quem recebeu uma) → o site pede para **trocar a senha** (sessão limitada de 10 minutos). A nova senha tem de 12 a 128 caracteres (pode colar de gerenciador, pode ter espaços).
- **Esqueci a senha** (`/recuperar-senha`) → a resposta é **sempre a mesma** (`202`), exista a conta ou não, para ninguém descobrir quem tem cadastro. Se a conta existe, chega um link de redefinição que vale **30 minutos** e **só funciona uma vez**.
- **Limites de tentativas** (por minuto/hora) protegem o login e os pedidos de e-mail; passou do limite → `429` com `Retry-After`.
- Um e-mail que chega atrasado pode estar **inválido**: use sempre o acesso **mais recente**.

### 7.5 Conta de administradora

Fica **invisível** nas telas e rotas comuns (listas, busca por ID, edição, desativação, reset). Pedir o ID dela devolve `404`, como se não existisse. Quem cuida do servidor faz essa promoção por fora do site.

---

## 8. A API de Agenda (`/api/v1`) passo a passo

### 8.1 Conceitos que a API exige (e por quê)

| Conceito | Para que serve | Como se manda |
|---|---|---|
| **Cookie de sessão** `tw_session` | Prova que você fez login. É `HttpOnly`: o navegador guarda e envia sozinho; no REST Client também. | O login (`POST /auth/login`) devolve o cookie. |
| **Origin** | O servidor só aceita escrita se a origem for o `APP_ORIGIN` (`http://localhost:3000`). Protege contra sites maliciosos. | Cabeçalho `Origin: http://localhost:3000` (o navegador já manda; no REST Client/cURL, escreva você). |
| **CSRF** (`X-CSRF-Token`) | Segunda proteção contra pedidos forjados. | `GET /auth/csrf` devolve `data.csrfToken`; mande em todo `POST`/`PATCH`/`DELETE` autenticado. |
| **`Idempotency-Key`** | Se a rede falhar e você repetir um pedido de criação, **não** cria duas coisas. | Um UUID **novo** por criação. Mesma chave + mesmo corpo → mesmo resultado; mesma chave + corpo diferente → `409 IDEMPOTENCY_CONFLICT`. Vale por 24 h. |
| **`If-Match`** | Impede sobrescrever o trabalho de outra pessoa. | Versão lida no `ETag` (7.3). Ausente → `428`; versão velha → `412`. |
| **`Content-Type: application/json`** | O corpo precisa ser JSON. | Cabeçalho em todo `POST`/`PATCH`. |

Formato das respostas (sempre JSON):

```json
{ "data": { "id": "7", "slug": "exemplo-dados", "version": "1" }, "requestId": "…" }
```
```json
{ "data": [ { "id": "7" } ], "page": { "nextCursor": null }, "requestId": "…" }
```
```json
{ "error": { "code": "TOPIC_LIMIT", "message": "Limite de temas atingido.", "fields": [] }, "requestId": "…" }
```

Listas aceitam `?limit=` (padrão 20, máximo 100) e `?cursor=` (o `nextCursor` da página anterior). O `requestId` ajuda a achar o pedido nos registros do servidor — informe-o ao pedir ajuda.

### 8.2 Rodando os exemplos (o caminho mais fácil)

1. Site rodando (capítulo 4) e extensão **REST Client** instalada.
2. Abra [`docs/agenda-examples.http`](agenda-examples.http). As senhas vêm do seu `.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD`); nada de segredo no arquivo.
3. Clique em **Send Request** acima de cada bloco, **na ordem**. Cada bloco tem um comentário dizendo o que ele prova (inclusive os que **devem falhar**, como o terceiro tema, que dá `409`).
4. A Parte 5 (reserva) precisa de uma participante com senha conhecida — veja 8.4.

O arquivo é **repetível**: cada execução cria uma mentora e temas novos (fictícios), então você pode rodá-lo de novo sem conflito. Ele foi executado inteiro contra o site local deste projeto: 38 requisições, todas com o resultado esperado.

### 8.3 Todas as rotas (geradas do código)

A tabela abaixo lista **todas** as rotas de `src/app/api/v1`. "Quem" resume a permissão; o banco confere de novo na hora de gravar.

**Entrada e sessão**

| Método e caminho | O que faz | Quem |
|---|---|---|
| `POST /api/v1/auth/login` | Entra com `{email, password}`; devolve `authenticated` ou `password_change_required` e o cookie. | qualquer pessoa (limitado por tentativas) |
| `GET /api/v1/auth/csrf` | Devolve o token CSRF da sessão. | logada |
| `GET /api/v1/auth/session` | Dados da **própria** sessão (`user`, `state`, `expiresAt`). | logada |
| `POST /api/v1/auth/logout` | Encerra a sessão. `204`. | logada |
| `POST /api/v1/auth/password/change` | Troca a senha `{currentPassword, newPassword}`. | logada (inclusive sessão limitada) |
| `POST /api/v1/auth/password/forgot` | "Esqueci a senha" `{email}` → `202` sempre igual. | qualquer pessoa |
| `POST /api/v1/auth/password/reset` | Define nova senha com o token do e-mail `{token, newPassword}` → `204`. | qualquer pessoa com token válido |

**Cadastros públicos**

| Método e caminho | O que faz | Quem |
|---|---|---|
| `POST /api/v1/registrations/participants/preview` | Cruzamento antes das credenciais: recebe o diagnóstico e devolve só `[{mentor_ref, nome_exibicao}]` das mentoras compatíveis; não grava nada. | qualquer pessoa |
| `POST /api/v1/registrations/participants` | Cadastro de participante (diagnóstico + `mentor_ref` + e-mail + senha + confirmação) → `202` neutro; conta ativa, sem e-mail. | qualquer pessoa |
| `POST /api/v1/registrations/mentors` | Cadastro de mentora → `202` neutro (respeita `MENTOR_DEADLINE`). | qualquer pessoa |
| `POST /api/v1/me/profiles/participant` | Adiciona o perfil de participante à **sua própria** conta. | logada |
| `POST /api/v1/me/profiles/mentor` | Adiciona o perfil de mentora à **sua própria** conta. | logada |

**Agenda: temas, vínculos e turmas**

| Método e caminho | O que faz | Quem |
|---|---|---|
| `GET /api/v1/topics` | Lista temas. | logada |
| `GET /api/v1/topics/{id}` | Lê um tema (devolve `ETag`). | logada |
| `POST /api/v1/topics` | Cria tema `{slug, name, description?}`. | admin |
| `PATCH /api/v1/topics/{id}` | Altera `{name?, description?, active?}` (slug **não muda**). `If-Match`. | admin |
| `DELETE /api/v1/topics/{id}` | Desativa o tema. `If-Match`. | admin |
| `GET /api/v1/mentors/{mentorId}/topics` | Temas da mentora. | admin, equipe e a própria mentora |
| `POST /api/v1/mentors/{mentorId}/topics` | Liga tema à mentora `{topicId, position: 1 ou 2}`. | admin ou a própria mentora |
| `POST /api/v1/mentors/{mentorId}/topics/reorder` | Define a **nova ordem** `{firstId, secondId}`: o 1º vira posição 1, o 2º posição 2 (atômico). | admin ou a própria mentora |
| `GET/PATCH/DELETE /api/v1/mentor-topics/{id}` | Lê / muda a `position` / remove vínculo **sem turmas**. `If-Match` em `PATCH` e `DELETE`. | admin ou a própria mentora |
| `GET /api/v1/mentor-topics/{id}/cohorts` | Turmas desse vínculo. | admin, equipe e a própria mentora |
| `POST /api/v1/mentor-topics/{id}/cohorts` | Cria turma `{startsAt, endsAt, capacity, status: "draft" ou "open"}`. | admin ou a própria mentora |
| `GET /api/v1/cohorts/{id}` | Lê uma turma. | conforme visibilidade |
| `PATCH /api/v1/cohorts/{id}` | Altera `{startsAt?, endsAt?, capacity?, status?}`. `If-Match`. | admin ou a própria mentora |
| `DELETE /api/v1/cohorts/{id}` | Cancela a turma (só sem inscritos ativos). `If-Match`. | admin ou a própria mentora |

**Participante: escolher e reservar**

| Método e caminho | O que faz | Quem |
|---|---|---|
| `GET /api/v1/mentors?eligible=true` | Mentoras com turma aberta futura e vaga (sem e-mail, sem conta). | participante, mentora, admin |
| `GET /api/v1/mentors/{mentorId}` | Uma mentora elegível (404 se não for). | idem |
| `GET /api/v1/mentors/{mentorId}/cohorts` | Turmas abertas e futuras dessa mentora, com `occupied` e `available`. | idem |
| `GET /api/v1/me/recommendations` | `{suggested, others}`: sugeridas (pontuação > 0, com explicação) e as demais (inclui pontuação 0). | participante |
| `GET /api/v1/me/enrollments` | Suas reservas + `legacyMatches` (mentorias antigas, sem horário inventado). | participante |
| `POST /api/v1/me/enrollments` | Reserva `{cohortId}`. `201`. Quem reserva vem da sessão. | participante |
| `DELETE /api/v1/me/enrollments/{id}` | Cancela a **própria** reserva. | participante |

**Administração (painel e API)** — admin escreve; equipe (`team`) só lê.

| Método e caminho | O que faz |
|---|---|
| `GET/POST /api/v1/admin/users` | Lista / cria contas (não-admin). |
| `GET/PATCH/DELETE /api/v1/admin/users/{id}` | Lê / altera / desativa uma conta (não-admin). |
| `POST /api/v1/admin/users/{id}/temporary-password` | Pede nova senha temporária `{confirm:true}` → `202 queued` (nada de senha na resposta). |
| `GET/POST /api/v1/admin/participants` | Lista / cria participantes. |
| `GET/PATCH/DELETE /api/v1/admin/participants/{id}` | Lê / altera / desativa (soft delete). |
| `GET/POST /api/v1/admin/mentors` | Lista / cria mentoras. |
| `GET/PATCH/DELETE /api/v1/admin/mentors/{id}` | Lê / altera / desativa (soft delete). |
| `GET/POST /api/v1/admin/matches` | Lista / cria cruzamentos (sugestão com pontuação calculada pelo servidor). |
| `GET/PATCH/DELETE /api/v1/admin/matches/{id}` | Lê / altera (`PATCH` só `suggested` ou `rejected`) / cancela. |
| `GET /api/v1/admin/enrollments` | Lista reservas. |
| `GET/DELETE /api/v1/admin/enrollments/{id}` | Lê / cancela uma reserva. |
| `POST /api/v1/admin/enrollments/{id}/reassign` | Troca a turma `{cohortId, confirm:true}` (cancela e reserva de novo na mesma transação). |

> Toda criação (`POST` que cria algo) exige `Idempotency-Key`; todo `PATCH`/`DELETE` exige `If-Match`.

### 8.4 Reservar como participante no seu computador

No modo `fake`, a senha temporária **não é entregue** (o e-mail é só simulado). Por isso, para testar a Parte 5 do roteiro, damos uma senha conhecida a uma participante **fictícia** — **somente no banco do seu computador**:

1. Acrescente ao seu `.env` (duas linhas novas; valores fictícios):
   ```bash
   PARTICIPANT_EMAIL=participante-exemplo@example.invalid
   PARTICIPANT_PASSWORD=<uma senha sua, 16+ caracteres>
   ```
2. No roteiro, rode o bloco `createParticipant` (cria a conta; na 2ª vez dá `409`, normal).
3. No terminal, na pasta do projeto, rode o "atalho local":
   ```bash
   pnpm exec tsx --env-file=.env -e "(async () => { const { hashPassword } = require('./src/lib/db'); const { Client } = require('pg'); const c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await c.connect(); const h = await hashPassword(process.env.PARTICIPANT_PASSWORD); const r = await c.query(\"update app_user set password_hash = \$1, status = 'active', must_change_password = false, temporary_password_hash = null where email_key = lower(\$2)\", [h, process.env.PARTICIPANT_EMAIL]); await c.query(\"update email_job set status = 'cancelled' where status = 'queued' and user_id in (select id from app_user where email_key = lower(\$1))\", [process.env.PARTICIPANT_EMAIL]); console.log('contas atualizadas:', r.rowCount); await c.end(); })()"
   ```
   Deve imprimir `contas atualizadas: 1`. (No PowerShell, troque `\$` por `` `$ `` ou use o VSCode "Git Bash".)
4. Continue o roteiro a partir do `participantLogin`.

⚠️ **Isso mexe direto na tabela de contas e só vale para o banco local.** Nunca faça em produção — lá a senha chega por e-mail.

### 8.5 O mesmo com `curl` (opcional)

```bash
# 1. login (guarda o cookie num arquivo)
curl -s -c cookies.txt -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"admin-local@example.invalid","password":"SUA_ADMIN_PASSWORD"}' http://localhost:3000/api/v1/auth/login

# 2. token CSRF
CSRF=$(curl -s -b cookies.txt http://localhost:3000/api/v1/auth/csrf | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.csrfToken")

# 3. criar um tema (Idempotency-Key = UUID novo)
curl -s -b cookies.txt -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -H "X-CSRF-Token: $CSRF" -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d '{"slug":"exemplo-curl","name":"Tema via curl"}' http://localhost:3000/api/v1/topics
```

### 8.6 Lista de erros (códigos que a API devolve)

| HTTP | `error.code` | Significa / o que fazer |
|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_RESET` | Corpo não é JSON válido / link de redefinição inválido ou vencido. |
| 401 | `AUTH_REQUIRED`, `INVALID_CREDENTIALS` | Faça login / e-mail ou senha não conferem (a mensagem é igual de propósito). |
| 403 | `FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED`, `CSRF_REJECTED` | Sem permissão / troque a senha temporária primeiro / faltou `Origin` ou `X-CSRF-Token`. |
| 404 | `NOT_FOUND` | Não existe **ou** você não pode vê-lo (de propósito igual). |
| 409 | `EMAIL_UNAVAILABLE`, `IDENTITY_RECONCILIATION_REQUIRED`, `PROFILE_EXISTS` | E-mail indisponível / cadastro antigo a conferir com a organização / você já tem esse perfil. |
| 409 | `COHORT_FULL`, `COHORT_NOT_OPEN`, `COHORT_IN_USE` | Turma sem vagas / não está aberta / tem reservas e não pode mudar. |
| 409 | `SCHEDULE_CONFLICT`, `ALREADY_ENROLLED`, `TOPIC_LIMIT` | Horário se cruza / reserva já existe / já tem 2 temas. |
| 409 | `IDEMPOTENCY_CONFLICT`, `RETRY_TRANSACTION` | Mesma chave com outro conteúdo / conflito momentâneo, tente de novo. |
| 412 | `VERSION_MISMATCH` | Alguém alterou antes; releia (`GET`) e tente com o novo `ETag`. |
| 422 | `INVALID_INPUT` | Campo inválido ou desconhecido; `error.fields` diz quais. |
| 428 | `PRECONDITION_REQUIRED` | Faltou `If-Match`. |
| 429 | `RATE_LIMITED` | Muitas tentativas; espere o `Retry-After`. |
| 503 | `MAINTENANCE`, `DEPENDENCY_UNAVAILABLE` | Site em manutenção / banco indisponível. |

---

## 9. Consultar dados pelo pgAdmin

O pgAdmin é a **exceção**, não o caminho normal. Em produção ele é configurado **pela pessoa que cuida do servidor** (com login próprio do pgAdmin e uma conta separada do site). Este manual não traz endereços nem senhas; peça-os pelo canal combinado, nunca por e-mail com senha.

O que muda para você ao usar o pgAdmin:

- Sua conta do banco (`techwoman_beatriz`) é **somente leitura**: não inclui, altera ou exclui dados, não cria nem apaga tabelas e não vira "superusuária".
- Você consulta **visões seguras** de participantes e mentoras (`participant_editor`, `mentor_editor`) e as colunas autorizadas de temas, vínculos, turmas e reservas, sem e-mail nem token. Contas, senhas, sessões, fila de e-mails e o arquivo da migração não ficam disponíveis.
- Registros ligados a contas de administradora ficam invisíveis para você.
- Para incluir, alterar ou excluir dados, **peça à pessoa administradora responsável pelo site**; não tente habilitar edição no pgAdmin.
- Toda conexão nova começa com `default_transaction_read_only=on`; além disso, os privilégios de escrita e de uso das sequences foram revogados. Mesmo desligar o modo de transação não concede escrita.
- Cuidado com transações abertas: o banco encerra transações ociosas depois de 30 s para não travar o site.

Para consultar: abra a conexão autorizada no pgAdmin, escolha uma visão segura e use a visualização de dados. No Query Tool, use somente `SELECT` com as colunas permitidas (não `SELECT *` de tabelas com colunas protegidas). A consulta `SHOW transaction_read_only;` deve mostrar `on`. Mensagens de permissão negada ou transação somente leitura são proteções esperadas, não instruções para trocar de conta.

Para estudar o banco sem risco, use o PostgreSQL **do seu computador** (capítulo 4) e o `DER.md`.

---

## 10. E-mails: o que cada estado significa

O site **não envia e-mail dentro do pedido**. Ele grava uma intenção na fila (`email_job`) e um processo separado (**mailer**) envia depois. A tabela mostra o `status` de cada job:

| Estado | Significa | Pode afirmar que a pessoa recebeu? |
|---|---|---|
| `queued` | Na fila, esperando o mailer. | Não |
| `sending` | O mailer está enviando agora (reserva de 60 s). | Não |
| `accepted` | O provedor de e-mail **aceitou** a mensagem. | **Não** — aceito ≠ entregue. Só a pessoa destinatária confirma. |
| `unconfirmed` | Não sabemos se saiu (queda no meio). O sistema tenta de novo gerando **um novo acesso** e invalida o anterior. | Não |
| `failed` | Esgotou as tentativas (máx. 3). | Não |
| `simulated` | **NÃO ENVIADA — simulação.** É o que acontece no seu computador (`EMAIL_MODE=fake`). | Não |
| `cancelled` | Obsoleta (outra mais nova a substituiu, ou a reserva foi cancelada). | Não |

Tipos (`kind`): `registration` (boas-vindas ao cadastro), `temporary_password`, `password_reset`, `reservation` (confirmação de reserva).

Para o seu computador, o mailer já roda com `docker compose up`. No caminho B você pode processar a fila uma vez:

```bash
pnpm exec tsx --env-file=.env scripts/email-worker.ts --once
```

Ele imprime só contagens, por exemplo `{"transport":"discard","claimed":4,"simulated":4,...}`. O envio **real** (Amazon SES) só é ligado pela pessoa responsável pela operação, para destinatários aprovados — nunca no seu computador. Uma reserva confirmada **não** é desfeita porque o e-mail falhou.

---

## 11. Quando algo dá errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `docker compose up` reclama de variável "configure .env local" | Falta preencher alguma variável no `.env`. | Releia 4.1; confira que não sobrou `replace-` em lugar nenhum. |
| `Cannot connect to the Docker daemon` | Docker Desktop fechado. | Abra o Docker Desktop e espere ficar "running". |
| Porta `3000` ou `55432` ocupada | Outro programa usa a porta. | Feche o outro programa (ou o site rodando duas vezes). |
| `Configure SESSION_SECRET em .env` | `SESSION_SECRET` vazio, curto (<32) ou começando com `replace-`. | Gere um novo (4.1). |
| Login do admin local não entra | `ADMIN_PASSWORD` mudou depois do seed (o seed só cria a conta uma vez). | `docker compose down -v` e suba de novo (apaga só os dados locais). |
| `CSRF_REJECTED` na API | Faltou `Origin` igual ao `APP_ORIGIN` ou o `X-CSRF-Token`. | 8.1; busque um token novo em `GET /auth/csrf` depois de cada login. |
| `PRECONDITION_REQUIRED` / `VERSION_MISMATCH` | `If-Match` ausente ou velho. | Faça `GET` e use o `ETag` novo. |
| `TOPIC_LIMIT` | A mentora já tem 2 temas. | Remova um vínculo **sem turmas** ou troque a posição. |
| `SCHEDULE_CONFLICT` | Horários que se cruzam. | Mude o intervalo (horários colados são permitidos). |
| `INVALID_INPUT` com `fields:["datetime"]` | Data sem fuso. | Use `-03:00` ou `Z`. |
| A senha temporária "não chega" no seu computador | O modo `fake` descarta o segredo. | Use o atalho local do 8.4 ou o fluxo de testes (`pnpm test:e2e`). |
| `Migration aplicada diverge da versão registrada` | Alguém editou uma migration que já tinha sido aplicada. | Desfaça a edição (`git restore drizzle/…`) e crie migration **nova**. |
| Migration nova quebra num banco vazio | Nome começando com `0004_…` (vem antes de `2026…`). | Renomeie com carimbo de data (5.2, passo 4). |
| Teste `test:pg` falha só no seu computador | PostgreSQL de testes sem permissão/ocupado. | Use um PostgreSQL só de testes (6.3). |

Quando pedir ajuda, informe: o que você tentou, a mensagem de erro **sem senhas**, e o `requestId` se for erro da API.

---

## 12. O que foi testado e o que ainda depende de outras pessoas

Este manual foi conferido contra o código integrado (revisão `e9d1e32`). Evidência completa em `40-verificacao/evolucao-postgres/WP-006/INDEX.md` do projeto da fábrica.

**Executado de verdade (PostgreSQL 16.15):**

- Tabelas, colunas, tipos, chaves estrangeiras e regras do `DER.md` **lidas do banco migrado** e comparadas com o `schema.ts`; diagrama Mermaid renderizado em `DER.svg`.
- Todas as rotas de `src/app/api/v1` aparecem no capítulo 8; `agenda-examples.http` executado contra o site local (38 requisições, 0 falhas, repetível).
- O caminho iniciante: `.env` a partir do exemplo → papéis do banco (`bootstrap-local.sql`) → `pnpm db:migrate` → seed → site → login → API → e-mail simulado.
- A receita de coluna nova do capítulo 5 (inclusive a armadilha do nome `0004_…`) numa cópia descartável.
- `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, `pnpm test:pg` e `pnpm test:e2e` (resultados na evidência).

**Não executado neste ambiente (precisa de outra pessoa ou de outra máquina):**

- O `docker compose up --build` em si (o ambiente de teste não tinha o Docker ligado): o arquivo foi validado (`docker compose config`) e os mesmos passos rodaram diretamente num PostgreSQL 16. **Ao receber este manual, rode o capítulo 4 uma vez no seu computador e avise se algo divergir.**
- pgAdmin, backup/restauração, permissões no servidor e publicação em produção: dependem da pessoa que cuida do servidor (ver `operations-postgres.md`).
- Envio real de e-mail (Amazon SES) e a verificação de que a mensagem **chegou** a uma pessoa de verdade.
- Execução do CI no GitHub (o CI roda quando o primeiro PR é aberto).

**Onde o código difere do plano antigo (vale o código):**

- `GET /auth/session` devolve `expiresAt` como `2026-10-25 22:10:54+00` (formato do PostgreSQL), não RFC 3339 com `T` e `Z`.
- O código tem um erro a mais, `PROFILE_EXISTS` (409), quando a conta já possui o perfil.
- `POST /mentors/{id}/topics/reorder` interpreta `{firstId, secondId}` como a **nova ordem** (o 1º passa a posição 1).
- Existem `GET /mentors/{mentorId}` e `GET /admin/enrollments` (não previstos no plano).
- Cohorts devolvem também `status` e `mentorTopicId`.

---

## 13. Glossário

| Termo | Em palavras simples |
|---|---|
| **API** | A "porta de serviço" do site: programas conversam com ele por endereços como `/api/v1/topics`. |
| **Branch** | Uma cópia de trabalho do código com nome próprio, para você mexer sem afetar a `main`. |
| **CI** | Verificação automática (testes e build) que o GitHub roda em todo PR. |
| **Commit** | Um "ponto de gravação" do histórico, com mensagem. |
| **Cohort / turma** | Um horário de mentoria de um tema, com vagas (1 a 20). |
| **CSRF** | Ataque em que outro site faz seu navegador agir por você; o token CSRF o impede. |
| **DER** | Diagrama de Entidade-Relacionamento: o mapa das tabelas. |
| **Docker** | Programa que roda aplicativos em "caixinhas" isoladas. |
| **Drizzle** | Biblioteca que liga o código TypeScript ao banco. |
| **ETag / If-Match** | Número de versão de um registro / a prova de que você viu a versão atual. |
| **Hash** | Resultado irreversível de uma "conta matemática" sobre a senha; é o que se guarda. |
| **Idempotência** | Repetir o mesmo pedido não repete o efeito. |
| **Migration** | Arquivo `.sql` que muda o banco de forma versionada. |
| **Overlap** | Dois horários que se cruzam. |
| **PostgreSQL** | O banco de dados. |
| **pgAdmin** | Programa para acessar o PostgreSQL; a conta da Beatriz é somente consulta. |
| **PR (Pull Request)** | Pedido para juntar o seu branch à `main`, onde o CI roda. |
| **Seed** | Dados de demonstração criados de propósito (fictícios). |
| **SITE** | O aplicativo que as pessoas usam no navegador. |
| **UTC** | Horário universal. Recife = UTC−3. |
