# ADR-0001: Monorepo, one PostgreSQL database, table ownership per service

* Status: accepted
* Date: 2022-06-14
* Deciders: Platform Eng, Staff Eng

## Context

MintRail had six engineers when this was decided. Running separate databases per
service would have cost us cross-service transactions, and those are exactly what keep
"payment captured" and "ledger entry written" consistent.

## Decision

* One repository with one Python distribution (`mintrail`) that contains a package per
  service (`mintrail_common`, `mintrail_ledger`, `mintrail_api`, …).
* One PostgreSQL 16 database, one `MetaData`, and one Alembic history.
* Every table has exactly one owning service. Other services read through the owner's
  service layer and never write the owner's tables directly.

## Consequences

* A payment state change and its ledger postings commit atomically.
* Migrations are serialised through one history, so coordination is cheap now but
  will need attention as the team grows.
* Splitting a service out later means turning its service layer into an API. The
  ownership rule keeps that possible.
