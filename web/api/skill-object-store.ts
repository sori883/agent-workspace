import { AwsClient } from "aws4fetch";
import { sha256 } from "../data/canonical";
import { MAX_SKILL_OBJECT_BYTES, type SkillObjectStore } from "../shared/skill-storage-contracts";
import { RunServiceError } from "./run-service";

export interface SkillObjectStoreConfig {
  endpoint: string; bucket: string; region: string; forcePathStyle: boolean;
  accessKeyId: string; secretAccessKey: string; storeId: string; allowInsecureHttp?: boolean;
}
export class S3SkillObjectStore implements SkillObjectStore {
  readonly storeId: string;
  private readonly client: AwsClient;
  private readonly endpoint: URL;
  constructor(private readonly config: SkillObjectStoreConfig, private readonly request: typeof fetch = fetch) {
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.protocol === "http:" && (!config.allowInsecureHttp || !["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(this.endpoint.hostname))) throw new Error("Insecure skill storage endpoint is not allowed");
    if (!["https:", "http:"].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash
      || this.endpoint.pathname !== "/" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.storeId) || !config.region || !config.accessKeyId || !config.secretAccessKey) throw new Error("Invalid skill storage configuration");
    this.storeId = config.storeId;
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: "s3", retries: 0 });
  }
  private url(key: string) {
    if (!/^workspaces\/[0-9a-f-]{36}\/skills\/[0-9a-f-]{36}\/revisions\/[0-9a-f-]{36}\/(?:manifest\.json|SKILL\.md|(?:references|scripts|assets)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*)$/.test(key)) throw new RunServiceError("skill_storage_integrity");
    const url = new URL(this.endpoint);
    if (this.config.forcePathStyle) url.pathname = `/${this.config.bucket}/${key}`;
    else { url.hostname = `${this.config.bucket}.${url.hostname}`; url.pathname = `/${key}`; }
    return url;
  }
  private async send(key: string, init: RequestInit) {
    try {
      const request = this.request;
      return await request(await this.client.sign(this.url(key), { ...init, redirect: "manual", signal: AbortSignal.timeout(5000), aws: { allHeaders: true } }));
    } catch { throw new RunServiceError("skill_storage_unavailable"); }
  }
  async get(key: string, expectedBytes: number): Promise<Uint8Array> {
    if (!Number.isInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_SKILL_OBJECT_BYTES) throw new RunServiceError("skill_storage_integrity");
    const response = await this.send(key, { method: "GET" });
    if (!response.ok) { await response.body?.cancel(); throw new RunServiceError(response.status === 404 ? "skill_storage_integrity" : "skill_storage_unavailable"); }
    const reader = response.body?.getReader();
    if (!reader) throw new RunServiceError("skill_storage_integrity");
    const result = new Uint8Array(expectedBytes); let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > expectedBytes) throw new RunServiceError("skill_storage_integrity");
        result.set(value, offset); offset += value.length;
      }
      if (offset !== expectedBytes) throw new RunServiceError("skill_storage_integrity");
      return result;
    } catch (error) { await reader.cancel().catch(() => {}); throw error instanceof RunServiceError ? error : new RunServiceError("skill_storage_unavailable"); }
    finally { reader.releaseLock(); }
  }
  async putImmutable(key: string, bytes: Uint8Array, mediaType: string) {
    if (bytes.length > MAX_SKILL_OBJECT_BYTES) throw new RunServiceError("skill_storage_integrity");
    const response = await this.send(key, { method: "PUT", headers: { "Content-Type": mediaType, "If-None-Match": "*", "x-amz-content-sha256": await sha256(bytes) }, body: new Uint8Array(bytes) });
    await response.body?.cancel();
    if (!response.ok && response.status !== 412) throw new RunServiceError("skill_storage_unavailable");
    if (await sha256(await this.get(key, bytes.length)) !== await sha256(bytes)) throw new RunServiceError("skill_storage_integrity");
  }
}
