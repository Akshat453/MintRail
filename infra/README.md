# infra

- `docker/Dockerfile` builds one Node 22 image for every service. The compose file picks the
  entrypoint: `node api/dist/main-server.js`, `node junction/dist/main-server.js`, a
  `…/main-worker.js`, `node ledger/dist/main.js`, or `node api/dist/main-migrate.js`.
- `../docker-compose.yml` is the local stack: postgres, migrate (+ bootstrap admin), api,
  junction, payments-worker, junction-worker, ledger-worker.
