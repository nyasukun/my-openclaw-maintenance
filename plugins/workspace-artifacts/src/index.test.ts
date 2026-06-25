import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import entry, { renderAppHtml } from "./index.js";
import { parseRunId, proxyHttp, proxyUpgrade, resolveRuntimeConfig } from "./runtime.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("workspace-artifacts", () => {
  it("declares plugin metadata", () => {
    expect(entry.id).toBe("workspace-artifacts");
    expect(entry.name).toBe("Workspace Artifacts");
  });
});

describe("renderAppHtml", () => {
  function extractInlineScript(html: string): string {
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error("no inline <script> in rendered HTML");
    return m[1];
  }

  it("emits a browser script that parses (guards template-literal escaping)", () => {
    const script = extractInlineScript(renderAppHtml("/tmp/workspace"));
    // new Function compiles (parses) the body without executing it; a SyntaxError
    // — e.g. a regex literal whose \/ or \. was eaten by the enclosing template
    // literal — throws here. This is the regression guard for the blank-preview bug.
    expect(() => new Function(script)).not.toThrow();
  });

  it("does not leak unescaped regex slashes into the server-artifact matcher", () => {
    const script = extractInlineScript(renderAppHtml("/tmp/workspace"));
    // The old bug shipped this exact mangled literal in the browser code.
    expect(script).not.toContain("/^artifacts/([a-z0-9][a-z0-9-]*)/artifact.json$/");
    expect(script).toContain('parts[0] !== "artifacts"');
  });
});

describe("parseRunId", () => {
  it("extracts a valid id and ignores the rest of the path", () => {
    expect(parseRunId("/run/my-app/assets/x.js")).toBe("my-app");
    expect(parseRunId("/run/app1")).toBe("app1");
  });

  it("rejects invalid, missing, or escaping ids", () => {
    expect(parseRunId("/run/")).toBeNull();
    expect(parseRunId("/run/My-App")).toBeNull(); // uppercase
    expect(parseRunId("/run/../etc")).toBeNull(); // traversal
    expect(parseRunId("/run/-bad")).toBeNull(); // leading hyphen
    expect(parseRunId("/api/file")).toBeNull(); // not a run route
  });
});

describe("resolveRuntimeConfig", () => {
  it("returns safe defaults when unset", () => {
    const cfg = resolveRuntimeConfig(undefined);
    expect(cfg).toMatchObject({ enabled: true, dockerBin: "docker", hostPort: 7080, egress: true });
    expect(cfg.image).toContain("openclaw-artifacts-runtime");
  });

  it("applies overrides", () => {
    const cfg = resolveRuntimeConfig({ runtime: { enabled: false, hostPort: 9000, egress: false, image: "x:1" } });
    expect(cfg).toMatchObject({ enabled: false, hostPort: 9000, egress: false, image: "x:1" });
  });
});

describe("proxyHttp", () => {
  it("forwards the full path and streams the response back", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream saw ${req.url}`);
    });
    const upstreamPort = await listen(upstream);

    const proxy = http.createServer((req, res) => proxyHttp(req, res, upstreamPort));
    const proxyPort = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${proxyPort}/run/my-app/page?x=1`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toBe("upstream saw /run/my-app/page?x=1");

    upstream.close();
    proxy.close();
  });

  it("returns 502 when the upstream is down", async () => {
    // Nothing is listening on this port.
    const proxy = http.createServer((req, res) => proxyHttp(req, res, 1));
    const proxyPort = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/run/app/`);
    expect(res.status).toBe(502);
    proxy.close();
  });
});

describe("proxyUpgrade", () => {
  it("proxies a websocket-style upgrade and echoes data", async () => {
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (d) => socket.write(d));
    });
    const upstreamPort = await listen(upstream);

    const proxy = http.createServer();
    proxy.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, upstreamPort));
    const proxyPort = await listen(proxy);

    const result = await new Promise<string>((resolve, reject) => {
      const client = net.connect(proxyPort, "127.0.0.1", () => {
        client.write("GET /run/app/ws HTTP/1.1\r\nHost: x\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
      });
      let buf = "";
      let sentPing = false;
      client.on("data", (d) => {
        buf += d.toString();
        if (!sentPing && buf.includes("101 Switching Protocols")) {
          sentPing = true;
          client.write("ping");
        } else if (sentPing && buf.includes("ping")) {
          client.end();
          resolve(buf);
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("upgrade timed out")), 4000);
    });

    expect(result).toContain("101 Switching Protocols");
    expect(result.trimEnd().endsWith("ping")).toBe(true);

    upstream.close();
    proxy.close();
  });
});
