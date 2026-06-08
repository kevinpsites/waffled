# Nook task runner — requires `just` (https://github.com/casey/just) + Docker.
# No `just`? Run the underlying `docker compose ...` commands directly.

compose := "docker compose -f infra/compose/docker-compose.yml --env-file infra/compose/.env"

# list recipes
default:
    @just --list

# first-time: create your local .env from the template
setup:
    @test -f infra/compose/.env && echo "infra/compose/.env already exists" || (cp infra/compose/.env.example infra/compose/.env && echo "→ created infra/compose/.env")

# build images (api)
build:
    {{compose}} build

# start the stack (detached)
up:
    {{compose}} up -d

# stop the stack
down:
    {{compose}} down

# follow logs
logs:
    {{compose}} logs -f

# service status
ps:
    {{compose}} ps

# open a psql shell
psql:
    {{compose}} exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# apply DB migrations against the running local stack (needs `npm install` in apps/api)
migrate:
    set -a && . infra/compose/.env && set +a && cd apps/api && DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB" npm run migrate

# mint a local dev JWT (prints only the token). e.g. `export TOKEN=$(just token)`
# pass flags through: `just token --household <uuid> --sub dev:kelly`
token *ARGS:
    {{compose}} run --rm --no-deps -T api node dist/mint-token.js {{ARGS}}

# run the api test suite (Vitest + Testcontainers; needs Docker running)
test:
    cd apps/api && npm test

# DANGER: stop and wipe local volumes (destroys local db)
nuke:
    {{compose}} down -v
