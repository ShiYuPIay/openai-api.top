# openai-api.top Worker

Production Cloudflare Worker for `openai-api.top`, derived from the upstream
`cmliu/edgetunnel` project and maintained as a separate deployment-oriented
codebase.

## Current architecture

The Worker uses ES modules under `src/` instead of a single `_worker.js` file.
The production entrypoint is:

```text
src/index.js
```

Major components:

- resilient HTTP entrypoint and health checks;
- WebSocket, gRPC and XHTTP handlers;
- VLESS, Trojan and Shadowsocks parsing;
- TCP/UDP streaming with bounded queues;
- SOCKS5, HTTP/HTTPS, TURN and SSTP connectors;
- KV-backed admin and subscription configuration;
- Clash, Sing-box and Surge subscription formatting.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module boundaries and
[`docs/DEAD_CODE_AUDIT.md`](docs/DEAD_CODE_AUDIT.md) for the cleanup record.

## Local validation

Requires Node.js 22 or later.

```bash
npm install
npm run validate
```

The validation pipeline performs:

1. JavaScript syntax checks;
2. architecture and circular-dependency checks;
3. Workers runtime tests;
4. Wrangler deployment dry-run;
5. deployment bundle size enforcement.

## Production configuration

`wrangler.toml` is the source of truth. Required encrypted secrets:

```text
ADMIN
KEY
UUID
PROXYIP
```

They must be configured in Cloudflare Variables and Secrets or in the protected
GitHub `production` environment. Never commit their values.

Production networking defaults remain stability-first:

```text
PRELOAD_RACE_DIAL=0
TCP_CONCURRENT_DIAL=1
PROXY_CONCURRENT_DIAL=1
```

Smart Placement is enabled for dynamic upstreams. TCP connection setup uses a
3-second failure ceiling; established streams remain open until either endpoint
closes them.

## Deployment

The primary automatic deployment path is Cloudflare Workers Builds from `main`.
The **Manual Cloudflare Worker Deploy** GitHub workflow is an operator-triggered
fallback.

Health check:

```text
https://openai-api.top/healthz
```

A valid response includes `status: ok`, `X-Request-ID` and `X-Worker-Version`.

## Upstream attribution

This repository contains substantial code derived from `cmliu/edgetunnel` and
its acknowledged upstream projects. The existing repository license remains in
force. Upstream changes are reviewed and ported manually; automatic fork sync is
disabled because it can overwrite production-specific architecture and fixes.
