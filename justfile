# Waffled task runner — requires `just` (https://github.com/casey/just) + Docker.
# No `just`? Run the underlying `docker compose ...` commands directly.

compose := "docker compose -f infra/compose/docker-compose.yml --env-file infra/compose/.env"

# list recipes
default:
    @just --list

# first-time: create your local .env from the template + enable the git hooks
setup:
    @test -f infra/compose/.env && echo "infra/compose/.env already exists" || (cp infra/compose/.env.example infra/compose/.env && echo "→ created infra/compose/.env")
    @git config core.hooksPath .githooks && echo "→ git hooks enabled (.githooks): pre-push runs typechecks + web tests"

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

# import a folder of Markdown recipes into a household. e.g. `just import-recipes ~/Documents/Recipes/recipeFiles/Noodles`
import-recipes folder *ARGS:
    set -a && . infra/compose/.env && set +a && cd apps/api && DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB" npx tsx scripts/import-recipes.ts "{{folder}}" {{ARGS}}

# mint a local dev JWT (prints only the token). e.g. `export TOKEN=$(just token)`
# pass flags through: `just token --household <uuid> --sub dev:kelly`
token *ARGS:
    {{compose}} run --rm --no-deps -T api node dist/mint-token.js {{ARGS}}

# run the api test suite (Vitest + Testcontainers; needs Docker running)
test:
    cd apps/api && npm test

# run the api from source with hot reload (tsx watch) against the compose Postgres.
# Frees :3000 by stopping the containerized api; `just up` brings the container back.
api:
    #!/usr/bin/env bash
    set -euo pipefail
    {{compose}} stop api >/dev/null 2>&1 || true
    set -a; . infra/compose/.env; set +a
    cd apps/api && DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB" npm run dev

# run the web app dev server (Vite; proxies /api to the local api on :3000)
web:
    cd apps/web && npm run dev

# seed a demo household + members + chores + a grocery item; print a kiosk token
# (needs the stack up + migrated)
seed:
    #!/usr/bin/env bash
    set -euo pipefail
    TOKEN=$({{compose}} run --rm --no-deps -T api node dist/mint-token.js --sub 'dev|demo')
    H="Authorization: Bearer $TOKEN"; J="Content-Type: application/json"
    curl -s -X POST -H "$H" -H "$J" -d '{"name":"Demo Family","timezone":"America/Chicago","person":{"name":"Kevin","avatarEmoji":"🐻","colorHex":"#2F7FED"}}' localhost:3000/api/households >/dev/null || true
    for m in \
      '{"name":"Kelly","memberType":"adult","isAdmin":true,"avatarEmoji":"🦊","colorHex":"#E0548B"}' \
      '{"name":"Wally","memberType":"kid","avatarEmoji":"🐢","colorHex":"#25A368"}' \
      '{"name":"Lottie","memberType":"kid","avatarEmoji":"🦄","colorHex":"#8A5CF0"}'; do
      curl -s -X POST -H "$H" -H "$J" -d "$m" localhost:3000/api/persons >/dev/null || true
    done
    PERSONS=$(curl -s -H "$H" localhost:3000/api/persons)
    wally=$(echo "$PERSONS" | python3 -c "import sys,json;print(next(p['id'] for p in json.load(sys.stdin)['persons'] if p['name']=='Wally'))")
    lottie=$(echo "$PERSONS" | python3 -c "import sys,json;print(next(p['id'] for p in json.load(sys.stdin)['persons'] if p['name']=='Lottie'))")
    for c in \
      "{\"title\":\"Feed the dog\",\"emoji\":\"🐶\",\"personId\":\"$wally\",\"rewardAmount\":2}" \
      "{\"title\":\"Make your bed\",\"emoji\":\"🛏️\",\"personId\":\"$wally\",\"rewardAmount\":1}" \
      "{\"title\":\"Set the table\",\"emoji\":\"🍽️\",\"personId\":\"$lottie\",\"rewardAmount\":2}"; do
      curl -s -X POST -H "$H" -H "$J" -d "$c" localhost:3000/api/chores >/dev/null || true
    done
    curl -s -X POST -H "$H" -H "$J" -d '{"name":"Bananas"}' localhost:3000/api/lists/grocery/items >/dev/null || true
    # recipes + plan this week's dinners
    recipes=(
      '{"title":"Sheet-Pan Salmon","emoji":"🐟","cookTimeMinutes":25,"servings":4}'
      '{"title":"Chorizo Tacos","emoji":"🌮","cookTimeMinutes":30,"servings":5}'
      '{"title":"Madras Lentils","emoji":"🍛","cookTimeMinutes":40,"servings":4}'
      '{"title":"Honey-Garlic Wings","emoji":"🍗","cookTimeMinutes":35,"servings":4}'
      '{"title":"Ravioli & Sausage Bake","emoji":"🍝","cookTimeMinutes":35,"servings":5}'
    )
    ings=(
      '{"ingredients":[{"name":"Salmon fillets","amount":4,"unit":"count"},{"name":"Asparagus","amount":1,"unit":"bunch"},{"name":"Lemon"},{"name":"Olive oil"}]}'
      '{"ingredients":[{"name":"Corn tortillas","amount":8,"unit":"count"},{"name":"Chorizo","amount":1,"unit":"lb"},{"name":"Cotija cheese"},{"name":"Cilantro"}]}'
      '{"ingredients":[{"name":"Red lentils","amount":2,"unit":"cup"},{"name":"Coconut milk","amount":1,"unit":"can"},{"name":"Garam masala"},{"name":"Onion"}]}'
      '{"ingredients":[{"name":"Chicken wings","amount":2,"unit":"lb"},{"name":"Honey","amount":0.25,"unit":"cup"},{"name":"Garlic"},{"name":"Soy sauce"}]}'
      '{"ingredients":[{"name":"Ravioli","amount":1,"unit":"lb"},{"name":"Italian sausage","amount":1,"unit":"lb"},{"name":"Marinara","amount":1,"unit":"jar"},{"name":"Mozzarella"}]}'
    )
    ids=()
    for i in 0 1 2 3 4; do
      rid=$(curl -s -X POST -H "$H" -H "$J" -d "${recipes[$i]}" localhost:3000/api/recipes | python3 -c "import sys,json;print(json.load(sys.stdin)['recipe']['id'])")
      ids+=("$rid")
      curl -s -X POST -H "$H" -H "$J" -d "${ings[$i]}" "localhost:3000/api/recipes/$rid/ingredients" >/dev/null || true
    done
    for i in 0 1 2 3 4; do
      d=$(date -v+"$i"d +%Y-%m-%d)
      curl -s -X POST -H "$H" -H "$J" -d "{\"date\":\"$d\",\"mealType\":\"dinner\",\"recipeId\":\"${ids[$i]}\"}" localhost:3000/api/meals/plan >/dev/null || true
    done
    # today's calendar events
    kevin=$(echo "$PERSONS" | python3 -c "import sys,json;print(next(p['id'] for p in json.load(sys.stdin)['persons'] if p['name']=='Kevin'))")
    kelly=$(echo "$PERSONS" | python3 -c "import sys,json;print(next(p['id'] for p in json.load(sys.stdin)['persons'] if p['name']=='Kelly'))")
    t=$(date +%Y-%m-%d)
    for ev in \
      "{\"title\":\"Swim lessons\",\"startsAt\":\"${t}T13:30:00Z\",\"personId\":\"$wally\"}" \
      "{\"title\":\"Psychiatrist appt\",\"startsAt\":\"${t}T18:30:00Z\",\"personId\":\"$kevin\"}" \
      "{\"title\":\"Tele-health call\",\"startsAt\":\"${t}T22:30:00Z\",\"personId\":\"$kelly\"}" \
      "{\"title\":\"Dance recital tickets\",\"startsAt\":\"${t}T17:00:00Z\",\"allDay\":true,\"personId\":\"$lottie\"}"; do
      curl -s -X POST -H "$H" -H "$J" -d "$ev" localhost:3000/api/events >/dev/null || true
    done
    echo "Seeded. In the kiosk browser console, run:"
    echo "  localStorage.setItem('waffled.token', '$TOKEN'); location.reload()"

# DANGER: stop and wipe local volumes (destroys local db)
nuke:
    {{compose}} down -v
