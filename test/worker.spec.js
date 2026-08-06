import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports.default;

describe("production entrypoint", () => {
  it("serves the health endpoint without bindings or network access", async () => {
    const response = await worker.fetch("https://openai-api.top/healthz");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-worker-version")).toBe("2026-08-06-arch-v4");
    expect(body).toMatchObject({
      status: "ok",
      service: "openai-api-top",
      version: "2026-08-06-arch-v4",
    });
  });

  it("serves the configured root page locally", async () => {
    const response = await worker.fetch("https://openai-api.top/");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-worker-route")).toBe("local-root");
    expect(response.headers.get("x-worker-version")).toBe("2026-08-06-arch-v4");
    expect(await response.text()).toContain("Error 1101");
  });

  it("returns an empty body for HEAD probes", async () => {
    const response = await worker.fetch(new Request("https://openai-api.top/", {
      method: "HEAD",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-worker-route")).toBe("local-root");
    expect(await response.text()).toBe("");
  });

  it("handles concurrent local probes without request state leakage", async () => {
    const responses = await Promise.all([
      worker.fetch("https://openai-api.top/healthz"),
      worker.fetch("https://openai-api.top/"),
      worker.fetch("https://openai-api.top/healthz"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(new Set(responses.map((response) => response.headers.get("x-request-id"))).size).toBe(3);
  });
});
