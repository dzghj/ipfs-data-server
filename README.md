# ipfs-data-server

## Monitoring and cron hooks

- Health probe: GET /health
- Protected cron endpoint: POST /api/internal/run-resend-check
  - Header: x-internal-secret: <value>
  - Set INTERNAL_API_SECRET in Render

## Database migration

Run the SQL migration in your Postgres database:

```bash
psql "$DATABASE_URL" -f migrations/001_create_nominee_access_sends.sql
```

## Render cron job setup

Create a separate Render cron service for the resend job. The cron runner calls your backend endpoint with the internal secret.

### Required env vars

- `CRON_TARGET_URL` = `https://<your-render-web-service>/api/internal/run-resend-check`
- `INTERNAL_API_SECRET` = same value used by the web service

### Render config

The repository now contains a standalone runner in [newServer/ipfs-data-server/cron-runner.js](newServer/ipfs-data-server/cron-runner.js) and a Render example in [newServer/ipfs-data-server/render.yaml](newServer/ipfs-data-server/render.yaml).

### Schedule

In Render, set the cron schedule to something like:

```text
0 * * * *
```

That runs once per hour.
