# Tech Woman — plataforma do evento

Plataforma web do **Tech Woman**, encontro presencial para mulheres em tecnologia (14/11/2026). Conecta participantes a mentoras de acordo com trajetória e objetivos de carreira:

- **Landing** (`/`) com informações do evento, agenda e palestrantes publicados pela equipe.
- **Inscrição de participantes** (`/inscricao`): diagnóstico de carreira em etapas (objetivo, momento, interesses, habilidades), depois o cruzamento (só o nome das mentoras compatíveis pelo ranking, ou `(MENTORA)` sem nome de exibição, com troca livre e sem datas) e, por último, e-mail + senha definitiva + confirmação explícita. A conta nasce ativa com o cruzamento escolhido, numa única transação, sem senha temporária nem e-mail. Turmas e reservas (que respeitam a capacidade) vêm depois, na agenda.
- **Cadastro de mentoras** (`/mentora`): trajetória, especialidades (mesmo vocabulário da inscrição), disponibilidade e capacidade. Prazo configurável por `MENTOR_DEADLINE`.
- **Consulta individual**: cada inscrição recebe um link com token aleatório (só o hash fica no banco) que mostra o estado e o par escolhido/aprovado.
- **Painel da equipe** (`/admin`): inscrições, mentoras, pontuação e motivos do match, vagas, aprovar/rejeitar/reatribuir; edição do evento em `/admin/evento`.

Status: **prova de conceito (POC)** para demonstração. Demo publicada: https://tech-woman.dellanio.com

Stack: Next.js 15 (App Router) + React 19, **PostgreSQL 16** (`pg` + Drizzle, schema e migrations versionadas), API HTTP em `/api/v1`, e-mail via Amazon SES (no desenvolvimento, sempre simulado). Nenhum serviço externo é obrigatório para rodar.

## Documentação

| Para quê | Arquivo |
|---|---|
| **Manual para iniciantes** (VSCode, IA, Docker + PostgreSQL, Drizzle, Git/PR/CI, regras, API de Agenda) | [`docs/MANUAL-BEATRIZ.md`](docs/MANUAL-BEATRIZ.md) |
| **DER** (diagrama das tabelas) e dicionário de dados | [`docs/DER.md`](docs/DER.md) · [`docs/DER.svg`](docs/DER.svg) |
| **Exemplos executáveis da API de Agenda** (extensão REST Client do VSCode) | [`docs/agenda-examples.http`](docs/agenda-examples.http) |
| Operação do servidor (corte, backup, recuperação) | [`docs/operations-postgres.md`](docs/operations-postgres.md) |
| Migração SQLite → PostgreSQL (ferramentas offline) | [`scripts/migration/README.md`](scripts/migration/README.md) |

## Como rodar localmente

Pré-requisitos: Docker Desktop, Node.js 24 (recomendado) e pnpm 10 (`corepack enable` ou `npm i -g pnpm`). O passo a passo para iniciantes está no [capítulo 4 do manual](docs/MANUAL-BEATRIZ.md#4-instalar-e-rodar-no-seu-computador-docker--postgresql).

```bash
cp .env.example .env
# edite .env: troque TODO valor "replace-..." (senhas do banco, SESSION_SECRET, RATE_LIMIT_SECRET, ADMIN_PASSWORD)
docker compose up --build
```

Sobe o PostgreSQL 16 (porta local `127.0.0.1:55432`), aplica as migrations, cria 4 mentoras fictícias e a administradora local, e liga o site em http://localhost:3000 (e o enviador de e-mails em modo simulado). O login de `/login` usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` do seu `.env`; depois acesse `/admin`.

Para editar o código com recarga automática (banco no Docker, site no seu computador):

```bash
docker compose up -d --build seed   # banco + migrations + seed, em segundo plano
pnpm i
pnpm dev
```

Os dados locais ficam no volume Docker `pgdata`. Para recomeçar do zero (apaga **só os dados locais**): `docker compose down -v`.

### Comandos úteis

| Comando | O que faz |
|---|---|
| `pnpm dev` | Site em modo desenvolvimento (precisa do banco ligado). |
| `pnpm db:migrate` | Aplica as migrations de `drizzle/` (usa `MIGRATION_DATABASE_URL`). |
| `pnpm seed:demo` | Dados fictícios de demonstração (explícito; nunca roda sozinho). |
| `pnpm exec tsx --env-file=.env scripts/email-worker.ts --once` | Processa a fila de e-mails uma vez (simulada). |
| `pnpm typecheck` | Confere os tipos. |
| `pnpm test:unit` | Testes Python (política do repositório e operação). |
| `pnpm test:pg` | Testes contra PostgreSQL real (exige `MIGRATION_DATABASE_URL` de um PostgreSQL 16 **só de testes**). |
| `pnpm test:e2e` | Fluxo completo crossing → cadastro com senha definitiva (sem e-mail) → login full → restart; o worker de e-mail é exercitado com conta pendente legada (após `pnpm build`). |
| `BUILDING=1 pnpm build` | Build de produção (não consulta o banco). |

### Build de produção sem Docker

```bash
BUILDING=1 NEXT_TELEMETRY_DISABLED=1 pnpm build
```

O build não usa banco nem executa DDL. Para iniciar o standalone, copie `.next/static` para `.next/standalone/.next/static` e `public` para `.next/standalone/public`, exporte as variáveis (cada processo recebe só a credencial dele) e rode `node .next/standalone/server.js`.

## Variáveis de ambiente (`.env.example`)

| Variável | Para que serve |
|---|---|
| `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `RUNTIME_PASSWORD`, `MAILER_PASSWORD` | Senhas dos 4 usuários do PostgreSQL local (administração, migrador, site, enviador). **Obrigatório trocar**, todas diferentes. |
| `DATABASE_URL` | Conexão do **site** (usuário `techwoman_runtime`). |
| `MIGRATION_DATABASE_URL` | Conexão do migrador/seed (só processos offline; nunca o site em produção). |
| `MAILER_DATABASE_URL` | Conexão do enviador de e-mails. |
| `APP_ORIGIN` | Endereço do site; escritas da API de outro endereço são recusadas. |
| `SESSION_SECRET` | ≥ 32 caracteres aleatórios; assina o token CSRF. **Obrigatório trocar.** |
| `RATE_LIMIT_SECRET` | ≥ 32 caracteres aleatórios, independente do anterior; base dos limites de tentativas. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Administradora **local** criada pelo seed (use e-mail `example.invalid`; senha ≥ 16 caracteres). |
| `LOCAL_SEED` | `1` só no desenvolvimento. |
| `EMAIL_MODE` | `fake` = nenhum e-mail real sai (estado `simulated`). `ses` só pela operação, com todas as flags `SES_*` e a lista `SES_RECIPIENT_ALLOWLIST`. |
| `SES_*` | Envio real via Amazon SES; deixe como no exemplo no desenvolvimento. |
| `TRUST_PROXY` | Confiança no proxy (mantenha `0` fora do servidor). |
| `RATE_LOGIN_PAIR_PER_MIN`, `RATE_LOGIN_IP_PER_MIN`, `RATE_EMAIL_PER_HOUR`, `RATE_IP_PER_HOUR`, `RATE_RESET_IP_PER_MIN` | Limites de tentativas (padrões seguros no exemplo). |
| `MENTOR_DEADLINE` | Fim do cadastro de mentoras (30/10 23h59, horário de Brasília). |

Opcionais fora do exemplo: `ALLOW_LOCAL_HTTP=1` (cookie de sessão sem HTTPS em `NODE_ENV=production` — só em localhost), `DEMO_MENTORS`, `PORT`, `HOSTNAME`.

Nunca versione `.env`. Todos os dados de exemplo são sintéticos.

## Estrutura

```
src/app/            páginas e rotas de API (Next.js App Router)
  admin/            painel da equipe e editor do evento
  inscricao/        diagnóstico, sugestões e consulta individual
  mentora/          cadastro de mentoras
  api/              endpoints (participant, mentor, choice, state, admin/*)
  face/             animação de abertura da arte "Perfil 1"
src/lib/            banco (db.ts, schema.ts), identidade/autenticação, Agenda (agenda.ts), recomendações, e-mail, evento
drizzle/            migrations SQL em ordem (nunca edite uma já aplicada)
docs/               manual, DER, exemplos da API e operação
tests/              testes Python e TypeScript contra PostgreSQL real
public/arte/        ilustrações em traço geradas para o projeto
public/fonts/       DM Sans, Lora e Oswald (Google Fonts, SIL OFL) autohospedadas
reference.css       tokens de design; theme.css aplica o tema visual do evento
scripts/            gerador das variantes claras da arte (lê o arquivo-mestre do design, que não está neste repositório)
```

## Como contribuir

1. **Nunca edite a `main` diretamente** (nem `git push origin main`): ela é o site publicado. Trabalhe sempre num branch.
2. Crie um branch a partir da `main` atualizada (`feat/...`, `fix/...`, `docs/...`) e faça commits pequenos, em português, no estilo `feat: ...`, `fix: ...`, `docs: ...`.
3. Antes de abrir o *pull request*, rode `pnpm typecheck`, `pnpm test:unit`, `BUILDING=1 pnpm build` e `pnpm test:pg` (contra um PostgreSQL de testes). Em mudanças de banco: **crie migration nova**, nunca altere uma já aplicada (veja o [capítulo 5 do manual](docs/MANUAL-BEATRIZ.md#5-o-banco-no-código-drizzle-schema-e-migrations)).
4. Não inclua dados reais de participantes/mentoras, `.env`, senhas ou capturas com dados pessoais em commits, issues ou PRs.
5. Abra o PR para `main` dizendo o que mudou e como testou (prints ajudam em mudanças visuais). O CI (job `check`) precisa passar; o PR da conta autorizada é mesclado automaticamente quando passa. Não mexa em `.github/` nem `ops/` sem a pessoa responsável pela operação.

## Licença

Ainda **sem licença definida**: por enquanto todos os direitos são reservados ao autor. Uma licença será adicionada quando o responsável pelo projeto decidir.
