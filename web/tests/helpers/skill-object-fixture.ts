import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

export async function startSkillObjectFixture() {
  const objects = new Map<string, Buffer>();
  const operations: string[] = [];
  const server = createServer(async (request, response) => {
    if (!request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") || !request.headers["x-amz-date"]) {
      response.writeHead(403).end(); return;
    }
    const key = request.url!;
    operations.push(request.method!);
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) { response.writeHead(412).end(); return; }
      objects.set(key, Buffer.concat(chunks)); response.writeHead(200).end(); return;
    }
    const content = objects.get(key);
    if (request.method !== "GET" || !content) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Length": content.length }).end(content);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { objects, operations,
    settings: { endpoint: `http://127.0.0.1:${address.port}`, bucket: "app-skills", region: "us-east-1", forcePathStyle: true,
      accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", storeId: "fixture-skills", allowInsecureHttp: true },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
