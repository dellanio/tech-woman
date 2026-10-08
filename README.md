# Tech Woman — protótipo local (WP-001/002)

Uma aplicação Next.js + SQLite para o evento presencial Tech Woman. A jornada participante → mentora → decisão admin → consulta individual funciona localmente. **Localmente e-mails não são enviados**: o estado é `NÃO ENVIADA — simulação local`.

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

O bootstrap admin usa hash scrypt e somente `LOCAL_SEED=1`. Para produção futura, desative `LOCAL_SEED`, não reutilize dados nem credenciais locais, configure HTTPS e segredo exclusivo. Não há deploy, agenda automática, nem conteúdo do evento inventado neste pacote. Datas, duração, local, programação e palestrantes dependem da confirmação e do editor do WP-004.

## Confirmação de inscrição / SES (WP-002)

No ambiente local mantenha `EMAIL_MODE=mock` e `LOCAL_SEED=1`, inclusive no Compose. Inscrição válida grava `consent_version=v1`, `consent_at` UTC e uma tentativa `mock-not-sent`; a página de consulta lê a tentativa persistida. Sem consentimento explícito ou com campos inválidos nada é gravado. Mutações admin exigem sessão `owner`; leitura admite `owner` ou `member`. O cookie é HttpOnly/SameSite Strict e Secure em HTTPS (`ALLOW_LOCAL_HTTP=1` exclusivamente local).

O operador já confirmou identidade do domínio `dellanio.com` e conta SES em produção na região `us-east-1`; **permissão IAM de envio no destino e credenciais do processo ainda não foram confirmadas**. Portanto não ativar envio aqui. No deploy autorizado, devops confirma acesso e política restrita a `ses:SendEmail`/From, provisiona credenciais do processo fora do git e configura `EMAIL_MODE=ses`, `SES_SEND_ENABLED=1`, `SES_IDENTITY_VERIFIED=1`, `SES_IAM_AUTHORIZED=1`, `SES_ACCOUNT_PRODUCTION=1`, `SES_REGION=us-east-1`, `SES_FROM=no-reply@dellanio.com`, `APP_ORIGIN=https://tech-woman.dellanio.com`, `LOCAL_SEED=0`, `ALLOW_LOCAL_HTTP=0`. Estes flags **não substituem** inspeção operacional da identidade/IAM/conta. Qualquer pré-requisito ausente deixa `unavailable-not-sent` e não chama AWS. A aceitação API armazena `MessageId` e mostra “ACEITA PELO SES — entrega ao destinatário não confirmada”; resposta de erro/ambígua mostra “ACEITE NÃO CONFIRMADO — o envio pode ter ocorrido”, sem repetir automaticamente. A prova de envio real fica para o devops em ambiente autorizado, sem usar credenciais do host no sandbox.
