export const WORKER_VERSION = "2026-08-06-arch-v4";
const HEALTH_PATH = "/healthz";
const ROOT_PATH = "/";
const MAX_IDEMPOTENT_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 50;
const RETRY_JITTER_MS = 75;
const MAX_ERROR_MESSAGE_LENGTH = 768;
const MAX_STACK_LENGTH = 2048;
const TRANSIENT_NETWORK_ERROR = /(?:network connection lost|internal error|daemondown|connection (?:reset|closed|terminated|timeout)|connect(?:ion)? timed out|socket (?:is )?closed|fetch failed)/i;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function limitText(value, maximumLength) {
  const text = String(value ?? "");
  return text.length > maximumLength ? `${text.slice(0, maximumLength)}…` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isEnabled(value) {
  return value === "1" || value === "true" || value === true;
}

function getErrorSummary(error, includeStack = false) {
  if (error instanceof Error) {
    return {
      name: limitText(error.name || "Error", 128),
      message: limitText(error.message, MAX_ERROR_MESSAGE_LENGTH),
      ...(includeStack && error.stack
        ? { stack: limitText(error.stack, MAX_STACK_LENGTH) }
        : {}),
    };
  }

  return {
    name: "UnknownError",
    message: limitText(error, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function isWebSocketUpgrade(request) {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

function canRetryRequest(request) {
  return !isWebSocketUpgrade(request)
    && (request.method === "GET" || request.method === "HEAD");
}

function shouldMaterializeResponse(request, path) {
  if (request.method !== "GET" || isWebSocketUpgrade(request)) {
    return false;
  }

  return path === ROOT_PATH
    || path === "/login"
    || path === "/admin"
    || path.startsWith("/admin/");
}

function shouldServeLocalRoot(request, env, path) {
  if (path !== ROOT_PATH
    || (request.method !== "GET" && request.method !== "HEAD")
    || isWebSocketUpgrade(request)) {
    return false;
  }

  return String(env?.URL ?? "").trim().toLowerCase() === "1101";
}

function getRequestId(request) {
  return request.headers.get("cf-ray") || crypto.randomUUID();
}

function responseHeaders(requestId, colo, extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
    "X-Worker-Version": WORKER_VERSION,
    "X-Worker-Colo": colo,
    ...extra,
  };
}

function healthResponse(request, requestId, colo) {
  const headers = responseHeaders(requestId, colo, {
    "Content-Type": "application/json; charset=utf-8",
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(JSON.stringify({
    status: "ok",
    service: "openai-api-top",
    version: WORKER_VERSION,
    request_id: requestId,
    colo,
    timestamp: new Date().toISOString(),
  }), { status: 200, headers });
}

function localRootResponse(request, requestId, colo, host) {
  const headers = responseHeaders(requestId, colo, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=3600",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Worker-Route": "local-root",
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const safeHost = escapeHtml(host);
  const safeRequestId = escapeHtml(requestId);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Error 1101</title>
  <style>
    :root{color-scheme:light dark}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f8;color:#202124}.card{max-width:720px;padding:48px}.code{font-size:64px;font-weight:300;letter-spacing:-2px;margin:0}.subtitle{font-size:24px;margin:8px 0 32px}.meta{font-size:14px;opacity:.7}@media(prefers-color-scheme:dark){body{background:#17191b;color:#eceff1}}
  </style>
</head>
<body>
  <main class="card">
    <h1 class="code">Error 1101</h1>
    <p class="subtitle">Worker threw exception</p>
    <p>The web service for <strong>${safeHost}</strong> is online.</p>
    <p class="meta">Ray ID: ${safeRequestId}</p>
  </main>
</body>
</html>`;

  return new Response(html, { status: 200, headers });
}

function serviceUnavailable(request, requestId, colo) {
  const headers = responseHeaders(requestId, colo, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": "1",
  });

  if (request.method === "HEAD") {
    return new Response(null, { status: 503, headers });
  }

  return new Response(JSON.stringify({
    error: "service_temporarily_unavailable",
    request_id: requestId,
  }), { status: 503, headers });
}

function logFailure({
  request,
  path,
  requestId,
  colo,
  attempts,
  firstError,
  finalError,
  transient,
  debug,
}) {
  const finalSummary = getErrorSummary(finalError, debug);
  const firstSummary = attempts > 1 ? getErrorSummary(firstError, false) : undefined;

  console.error({
    event: "worker_request_failed",
    requestId,
    attempts,
    transient,
    method: request.method,
    path,
    colo,
    errorName: finalSummary.name,
    errorMessage: finalSummary.message,
    ...(finalSummary.stack ? { stack: finalSummary.stack } : {}),
    ...(firstSummary
      ? {
          firstErrorName: firstSummary.name,
          firstErrorMessage: firstSummary.message,
        }
      : {}),
  });
}

async function materializeResponse(response) {
  if (!response.body || response.status === 101) {
    return response;
  }

  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function invokeUpstream(upstreamWorker, request, env, ctx, materialize) {
  if (!upstreamWorker || typeof upstreamWorker.fetch !== "function") {
    throw new TypeError("The upstream Worker does not export a fetch handler");
  }

  const response = await upstreamWorker.fetch(request, env, ctx);
  return materialize ? materializeResponse(response) : response;
}

export function createResilientWorker(upstreamWorker) {
  if (!upstreamWorker || typeof upstreamWorker.fetch !== "function") {
    throw new TypeError("A Worker fetch handler is required");
  }

  return {
    async fetch(request, env, ctx) {
    const requestId = getRequestId(request);
    const colo = request.cf?.colo ?? "unknown";
    const url = new URL(request.url);
    const path = url.pathname;
    const debug = isEnabled(env?.DEBUG);

    if ((request.method === "GET" || request.method === "HEAD")
      && path === HEALTH_PATH) {
      return healthResponse(request, requestId, colo);
    }

    // The configured 1101 camouflage page is fully local. Bypass all KV,
    // external fetch, TCP and upstream initialization for ordinary GET / probes.
    if (shouldServeLocalRoot(request, env, path)) {
      return localRootResponse(request, requestId, colo, url.host);
    }

    const retryAllowed = canRetryRequest(request);
    const materialize = shouldMaterializeResponse(request, path);
    const maximumAttempts = retryAllowed ? MAX_IDEMPOTENT_ATTEMPTS : 1;
    let firstError;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const response = await invokeUpstream(upstreamWorker, request, env, ctx, materialize);

        if (debug && attempt > 1) {
          console.warn({
            event: "worker_request_recovered",
            requestId,
            attempts: attempt,
            method: request.method,
            path,
            colo,
          });
        }

        return response;
      } catch (error) {
        firstError ??= error;
        const summary = getErrorSummary(error, false);
        const transient = TRANSIENT_NETWORK_ERROR.test(summary.message);
        const canTryAgain = retryAllowed
          && transient
          && attempt < maximumAttempts;

        if (canTryAgain) {
          const delay = RETRY_BASE_DELAY_MS * attempt
            + Math.floor(Math.random() * (RETRY_JITTER_MS + 1));
          await sleep(delay);
          continue;
        }

        logFailure({
          request,
          path,
          requestId,
          colo,
          attempts: attempt,
          firstError,
          finalError: error,
          transient,
          debug,
        });
        break;
      }
    }

    return serviceUnavailable(request, requestId, colo);
  },
  };
}
