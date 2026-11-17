SHELL := /bin/bash
.DEFAULT_GOAL := help
PNPM ?= pnpm
COMPOSE ?= docker compose
SERVICES := postgres api junction payments-worker junction-worker ledger-worker signal signal-worker depot depot-worker dashboard railyard

.PHONY: help install build up down logs migrate seed demo test test-unit test-integration test-ui coverage parity lint fmt typecheck ci

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies (Node 22, pnpm via corepack)
	corepack enable && $(PNPM) install --frozen-lockfile

build: install ## Compile every package to dist/ (and build both Next.js apps)
	$(PNPM) build

.env:
	cp .env.example .env

up: .env ## Build and start the stack (migrations run first, automatically)
	$(COMPOSE) up -d --build --wait $(SERVICES)

down: ## Stop everything (keeps data)
	$(COMPOSE) down

logs: ## Tail service logs
	$(COMPOSE) logs -f api junction payments-worker junction-worker ledger-worker signal signal-worker depot depot-worker dashboard railyard

migrate: .env ## Apply migrations (adopts M1 databases) + bootstrap Railyard admin; idempotent
	$(COMPOSE) run --rm --build migrate

seed: .env install ## Seed 50 merchants / ~200k payments / 90 days (ARGS=--reset to rebuild)
	$(PNPM) seed $(ARGS)

demo: .env install ## M1 demo + M2 demo (SDK: payment, refund, verified webhooks; settlement + reconciliation)
	$(PNPM) demo
	$(PNPM) demo:m2

test: install ## Unit + integration + e2e (Testcontainers) + UI smoke (Playwright, against `make up seed`)
	$(PNPM) test
	$(MAKE) test-ui

test-unit: install ## Unit tests only (no Docker)
	$(PNPM) test:unit

test-integration: install ## Integration tests only
	$(PNPM) test:integration

test-ui: install ## Playwright smoke for Dashboard + Railyard against the running, seeded stack
	cd dashboard && $(PNPM) exec playwright install chromium >/dev/null
	cd dashboard && MINTRAIL_DASHBOARD_URL=http://localhost:$${MINTRAIL_DASHBOARD_PORT:-3000} $(PNPM) exec playwright test
	cd railyard && MINTRAIL_RAILYARD_URL=http://localhost:$${MINTRAIL_RAILYARD_PORT:-3100} $(PNPM) exec playwright test

coverage: install ## Full suite with the 85% gate on api/ and ledger/
	$(PNPM) coverage

# The harness talks to a running stack in parity mode (instant Junction latency).
parity: .env install ## Run the parity harness (M1 contract + M2 regression goldens) against `make up`
	@echo "expects MINTRAIL_JUNCTION_LATENCY_SCALE=0 on the running stack"
	PARITY_API_URL=http://localhost:$${MINTRAIL_API_PORT:-8000} \
	PARITY_JUNCTION_URL=http://localhost:$${MINTRAIL_JUNCTION_PORT:-8100} \
	PARITY_DB_URL=postgres://mintrail:mintrail@localhost:$${MINTRAIL_PG_PORT:-5432}/mintrail \
	PARITY_DEPOT_URL=http://localhost:$${MINTRAIL_DEPOT_PORT:-8300} \
	$(PNPM) parity

lint: install ## ESLint (incl. mintrail/no-number-money) + Prettier check
	$(PNPM) lint

fmt: install ## Auto-fix lint + format
	$(PNPM) fmt

typecheck: install ## tsc --noEmit for every package, tests, scripts and both UIs
	$(PNPM) typecheck

ci: lint typecheck coverage ## What CI runs (minus the Docker/parity/UI jobs)
