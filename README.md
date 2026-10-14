# Tech Woman — plataforma do evento

Plataforma web do **Tech Woman**, encontro presencial para mulheres em tecnologia (14/11/2026). Conecta participantes a mentoras de acordo com trajetória e objetivos de carreira:

- **Landing** (`/`) com informações do evento, agenda e palestrantes publicados pela equipe.
- **Inscrição de participantes** (`/inscricao`): diagnóstico de carreira em etapas (objetivo, momento, interesses, habilidades), consentimento explícito e não pré-marcado, e sugestão de mentoras compatíveis com vaga. A reserva respeita a capacidade de cada mentora.
- **Cadastro de mentoras** (`/mentora`): trajetória, especialidades (mesmo vocabulário da inscrição), disponibilidade e capacidade. Prazo configurável por `MENTOR_DEADLINE`.
- **Consulta individual**: cada inscrição recebe um link com token aleatório (só o hash fica no banco) que mostra o estado e o par escolhido/aprovado.
- **Painel da equipe** (`/admin`): inscrições, mentoras, pontuação e motivos do match, vagas, aprovar/rejeitar/reatribuir; edição do evento em `/admin/evento`.

Status: **prova de conceito (POC)** para demonstração. Demo publicada: https://tech-woman.dellanio.com

Stack: Next.js 15 (App Router) + React 19, SQLite (better-sqlite3 + Drizzle), e-mail opcional via Amazon SES. Nenhum serviço externo é obrigatório para rodar.

## Como rodar localmente

Pré-requisitos: Node.js 24 (recomendado) e pnpm 10 (`corepack enable` ou `npm i -g pnpm`).

```bash
cp .env.example .env
# edite .env: troque ADMIN_PASSWORD (mín. 16 caracteres) e SESSION_SECRET (mín. 32 caracteres)
pnpm i
pnpm dev
```

Abra http://localhost:3000. O login de `/admin` usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` do seu `.env` (o usuário é criado no boot quando `LOCAL_SEED=1`, com hash scrypt).

O banco SQLite é criado em `./data/` (não versionado). Para recomeçar do zero, apague a pasta `data/`.

Se o pnpm bloquear scripts nativos, o `pnpm-workspace.yaml` já autoriza apenas `better-sqlite3` e `sharp`; rode `pnpm rebuild better-sqlite3`.

### Com Docker

```bash
cp .env.example .env   # e edite as duas credenciais
docker compose up --build
```

Sobe em http://localhost:3000 com o banco em `./data/`.

### Build de produção sem Docker

```bash
BUILDING=1 NEXT_TELEMETRY_DISABLED=1 pnpm build
```

`BUILDING=1` usa SQLite em memória durante a pré-renderização (não grava nada). Para iniciar o standalone, copie `.next/static` para `.next/standalone/.next/static` e `public` para `.next/standalone/public`, exporte as variáveis do `.env` (com `DATABASE_PATH` absoluto) e rode `node .next/standalone/server.js`.

## Variáveis de ambiente (`.env.example`)

| Variável | Padrão no exemplo | Para que serve |
|---|---|---|
| `DATABASE_PATH` | `./data/tech-woman.db` | Caminho do arquivo SQLite. |
| `LOCAL_SEED` | `1` | Cria o usuário admin a partir de `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Só para uso local; em servidor use `0` (também bloqueia o envio por SES). |
| `ADMIN_EMAIL` | `admin@techwoman.local` | Login da equipe no `/admin`. |
| `ADMIN_PASSWORD` | placeholder | **Obrigatório trocar** (≥ 16 caracteres). A aplicação recusa o placeholder. |
| `SESSION_SECRET` | placeholder | **Obrigatório trocar** (≥ 32 caracteres aleatórios). Assina o cookie de sessão. |
| `EMAIL_MODE` | `mock` | `mock` = nenhum e-mail é enviado; a tela mostra “NÃO ENVIADA — simulação local”. `ses` só envia se todas as flags `SES_*` estiverem configuradas; faltando qualquer uma, registra `unavailable-not-sent` e não chama a AWS. |
| `SES_*`, `APP_ORIGIN` | comentadas | Envio real via Amazon SES (região, remetente e flags de verificação de identidade/IAM/conta). Deixe comentadas no desenvolvimento. |
| `ANALYTICS_PROVIDER` | `none` | Sem analytics. |
| `MENTOR_DEADLINE` | `2026-10-31T02:59:59.999Z` | Fim do cadastro de mentoras (30/10 23h59, horário de Brasília). |
| `DEMO_MENTORS` | `0` | `1` cria oito mentoras **fictícias** rotuladas “Demonstração” (e-mails `@exemplo.invalid`, três vagas cada); o admin pode desativá-las em lote. |

Opcionais fora do exemplo: `ALLOW_LOCAL_HTTP=1` (permite cookie de sessão sem HTTPS em `NODE_ENV=production` — só em localhost), `PORT`, `HOSTNAME`.

Nunca versione `.env` nem a pasta `data/` (já estão no `.gitignore`). Todos os dados de exemplo são sintéticos.

## Estrutura

```
src/app/            páginas e rotas de API (Next.js App Router)
  admin/            painel da equipe e editor do evento
  inscricao/        diagnóstico, sugestões e consulta individual
  mentora/          cadastro de mentoras
  api/              endpoints (participant, mentor, choice, state, admin/*)
  face/             animação de abertura da arte "Perfil 1"
src/lib/            banco (db.ts), autenticação, regras de match/reserva (service.ts), e-mail, evento
public/arte/        ilustrações em traço geradas para o projeto
public/fonts/       DM Sans, Lora e Oswald (Google Fonts, SIL OFL) autohospedadas
reference.css       tokens de design; bradesco.css aplica o tema vermelho institucional
scripts/            gerador das variantes claras da arte (lê o arquivo-mestre do design, que não está neste repositório)
```

## Como contribuir

1. Abra uma *issue* descrevendo o problema ou a melhoria antes de mudanças grandes.
2. Crie um branch a partir de `main` (`feat/...`, `fix/...`) e faça commits pequenos com mensagens claras, em português, no estilo `feat: ...`, `fix: ...`, `docs: ...`.
3. Antes de abrir o *pull request*, confira que o build passa (`BUILDING=1 pnpm build`) e teste a jornada: inscrição → cadastro de mentora → escolha → painel admin, em desktop e mobile.
4. Não inclua dados reais de participantes/mentoras, `.env`, bancos `.db` ou credenciais em commits, issues ou capturas de tela.
5. Abra o PR para `main` dizendo o que mudou e como testou (prints ajudam em mudanças visuais).

## Licença

Ainda **sem licença definida**: por enquanto todos os direitos são reservados ao autor. Uma licença será adicionada quando o responsável pelo projeto decidir.
