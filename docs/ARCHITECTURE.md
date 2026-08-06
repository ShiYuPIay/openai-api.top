# Architecture

## Runtime flow

```text
Cloudflare request
  -> src/index.js
  -> runtime/resilient-worker.js
     - /healthz fast path
     - local GET/HEAD / camouflage path
     - bounded retry for idempotent HTTP requests
     - structured terminal error response
  -> core/worker.js
     - request parsing and route dispatch
     - admin, subscription and protocol selection
  -> handlers/*
     - WebSocket
     - gRPC
     - XHTTP
  -> transport/*
     - TCP/UDP forwarding
     - stream queues and socket lifecycle
  -> proxy/* and tls/*
     - SOCKS5, HTTP CONNECT, HTTPS, TURN, SSTP and TLS
```

## Directory ownership

| Directory | Responsibility |
|---|---|
| `src/core` | Top-level request routing only. |
| `src/handlers` | Protocol-specific HTTP/WebSocket handlers. |
| `src/transport` | Bidirectional data movement and connection lifecycle. |
| `src/protocols` | VLESS, Trojan and Shadowsocks parsing/cryptography. |
| `src/proxy` | Proxy configuration and outbound connector implementations. |
| `src/tls` | The custom TLS client and record/handshake primitives. |
| `src/config` | KV-backed configuration normalization and transport settings. |
| `src/subscriptions` | Subscription source retrieval and client-format patches. |
| `src/network` | DNS-over-HTTPS, address parsing and network classification. |
| `src/runtime` | Small dependency-free primitives, queues, logging and error policy. |
| `src/observability` | Request audit delivery and sensitive-value masking. |
| `src/cloudflare` | Cloudflare account usage integration. |
| `src/http` | Local fallback and camouflage pages. |

## State rules

Request-derived configuration must remain inside the request handler. It must not
be stored in a module-level variable because a Worker isolate can process
multiple requests concurrently.

The only mutable module bindings are deployment-scoped runtime settings derived
from Worker environment variables. `配置运行时()` assigns them deterministically
for each request; it does not retain request identity, headers, URLs or KV data.

## Dependency rules

- Modules may import only through explicit relative ES module imports.
- Circular imports are rejected by `scripts/check-architecture.mjs`.
- No production source module may exceed 800 lines.
- Socket closure is centralized in `runtime/sockets.js`.
- `src/index.js` is the only Wrangler entrypoint.
- `_worker.js` and `worker-entry.js` are prohibited legacy paths.

## Testing

`test/worker.spec.js` runs inside the Workers runtime through Cloudflare's Vitest
integration. It verifies the health endpoint, local root route, HEAD behavior and
concurrent request isolation. Wrangler dry-run remains the final bundle-level
validation.
