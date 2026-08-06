# Production operations

## Deployment ownership

Use one automatic deployment path:

```text
main -> Cloudflare Workers Builds -> npx wrangler deploy
```

Cloudflare Builds configuration:

```text
Production branch: main
Build command:      <empty>
Deploy command:     npx wrangler deploy
Root directory:     <empty>
```

The GitHub workflow **Manual Cloudflare Worker Deploy** is a fallback and does
not run on push.

## Required secrets

Configure these as encrypted secrets:

- `ADMIN`
- `KEY`
- `UUID`
- `PROXYIP`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the manual fallback

## Runtime policy

```text
PRELOAD_RACE_DIAL=0
TCP_CONCURRENT_DIAL=1
PROXY_CONCURRENT_DIAL=1
OFF_LOG=1
URL=1101
```

The connection-attempt timeout is 3000 ms. This is a failure ceiling, not the
normal response-time target. Do not increase dial concurrency and timeout in the
same release.

## Release checks

Before merging:

```bash
npm install
npm run validate
```

After deployment:

1. Verify `/healthz` returns HTTP 200 and the expected version.
2. Verify `HEAD /` returns `X-Worker-Route: local-root`.
3. Test WebSocket, gRPC and XHTTP clients.
4. Compare post-deployment error rate, p50/p95 duration and connection success.
5. Filter Observability from the deployment timestamp so historical errors are
   not attributed to the new version.

## Rollback

Use Cloudflare Deployments to promote the previous known-good Worker version.
Do not repair a production outage by increasing speculative dial concurrency.
