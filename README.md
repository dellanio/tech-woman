# Tech Woman — protótipo local (WP-001)

Uma aplicação Next.js + SQLite para o evento presencial Tech Woman. A jornada participante → mentora → decisão admin → consulta individual funciona localmente. **E-mails não são enviados**: todo estado de e-mail é `NÃO ENVIADA — simulação local`.

## Início rápido

Na pasta `repo/`, configure `.env` a partir de `.env.example`: substitua `ADMIN_PASSWORD` (mínimo de 16 caracteres, única para o ambiente) e `SESSION_SECRET` (mínimo de 32 caracteres), sem deixar os placeholders. Exemplo: `cp .env.example .env` e edite os dois campos. `.env` e o banco `data/` não são versionados. Nunca use estas credenciais/dados sintéticos em produção.

Com Docker disponível: `docker compose up --build`. Acesse `http://localhost:3000`. O único serviço é a aplicação; SQLite fica em `repo/data/`. Esta opção não foi executada no sandbox do builder porque o comando `docker` não está instalado aqui.

Sem Docker: `pnpm install && pnpm dev` (Node 24 recomendado). Também sobe em `http://localhost:3000`. Após instalar, `pnpm dev` é o único comando necessário. Se o pnpm bloquear scripts nativos, o projeto inclui `pnpm-workspace.yaml` autorizando somente `better-sqlite3` e `sharp`; execute `pnpm rebuild better-sqlite3`.

Build de produção local: `BUILDING=1 NEXT_TELEMETRY_DISABLED=1 pnpm build`. O `BUILDING=1` usa SQLite apenas em memória durante a pré-renderização concorrente, sem gerar inscrições. Para iniciar o standalone: copie `.next/static` para `.next/standalone/.next/static` e `public` para `.next/standalone/public`, depois exporte as variáveis de `.env` (em especial `DATABASE_PATH` absoluto, `LOCAL_SEED=1`, `ALLOW_LOCAL_HTTP=1` somente em localhost, `HOSTNAME=0.0.0.0`, `PORT=3000`) e rode `node .next/standalone/server.js`. No Compose isso já está configurado.

## Jornada demonstrável

1. Landing `/` → “Quero participar” → `/inscricao`: escolha objetivo e momento, depois interesses, habilidades, e-mail e consentimento não pré-marcado. Protocolo e link de consulta aparecem na tela; nenhum e-mail foi enviado.
2. `/mentora`: informe e-mail, trajetória, especialidades do mesmo vocabulário, disponibilidade descritiva, capacidade e consentimento.
3. `/admin`: use `ADMIN_EMAIL` e `ADMIN_PASSWORD` de `.env`, examine pontuação/motivos/vagas e aprove ou rejeite. Sem login a API nega dados e decisões; capacidade é rechecável transacionalmente.
4. Abra o link individual da etapa 1; somente o token aleatório daquele cadastro revela seu estado e eventual par aprovado. A inscrição não reserva horário.

O bootstrap admin usa hash scrypt e somente `LOCAL_SEED=1`. Para produção futura, desative `LOCAL_SEED`, não reutilize dados nem credenciais locais, configure HTTPS e segredo exclusivo. Não há SES, deploy, agenda automática, nem conteúdo do evento inventado neste pacote. Datas, duração, local, programação e palestrantes dependem da confirmação e do editor do WP-004.
