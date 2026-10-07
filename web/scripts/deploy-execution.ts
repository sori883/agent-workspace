import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";

async function run() {
  if (process.argv[2] !== "--deploy" || process.argv.length !== 3) throw new Error("Choose --deploy after closing legacy admission.");
  const root = resolve("../ax-local");
  if (!existsSync(resolve(root, ".state/execution/managed"))) throw new Error("Legacy admission must be retired first.");
  const versions = JSON.parse(readFileSync(resolve(root, "versions.json"), "utf8"));
  for (const name of ["execution", "worker_controlled", "runner_task", "ax_server_runtime"]) if (!/^localhost:5001\/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$/.test(versions[name] ?? "")) throw new Error("Pinned execution images are required.");
  const auth = readAuthConfig();
  if (!auth.database.caPath || auth.database.port !== 55432 || !["localhost", "127.0.0.1"].includes(auth.database.host)) throw new Error("This helper targets the local Docker database.");
  const pool = createPool(auth);
  try {
    const { rows } = await pool.query("SELECT accepting FROM ax_control WHERE id");
    if (rows.length !== 1 || rows[0].accepting) throw new Error("Application admission must be closed.");
    const unresolved = await pool.query("SELECT 1 FROM ax_runs WHERE NOT resolved OR invalid LIMIT 1");
    if (unresolved.rows.length) throw new Error("Unresolved executions require the separate retirement and recovery procedure.");
  } finally { await pool.end(); }
  const kubectl = (args: string[], input?: unknown) => execFileSync("kubectl", ["--context", "kind-ax-local", ...args], {
    env: { ...process.env, KUBECONFIG: resolve(root, "kubeconfig") },
    input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  const configuration = {
    ax: { address: "127.0.0.1:8080", plaintext_loopback: true },
    direct_guest: { ca_path: "/run/podidentity/trust-bundle.pem", client_bundle_path: "/run/podidentity/credential-bundle.pem", server_identity: "spiffe://cluster.local/ns/ax-demo/sa/default" },
    substrate: { address: "api.ate-system.svc:443", server_name: "api.ate-system.svc", ca_path: "/run/servicedns-ca/trust-bundle.pem", bearer_path: "/var/run/secrets/ateapi/token" },
    secret_group_read: true, atespace: "ax-demo", image: versions.runner_task,
    interactive: { image: versions.runner_task, atespace: "ax-runtime", guest_identity: "spiffe://cluster.local/ns/ax-demo/sa/default" },
    allowed_hosts: ["generativelanguage.googleapis.com"], call_timeout_seconds: 15, lifecycle_timeout_seconds: 180,
    controller_id: "ax-local-controller", database: { host: "host.docker.internal", port: 55432, database: auth.database.database, user: "ax_execution",
      password_path: "/run/execution-database/password", ca_path: "/run/execution-database/ca.pem", server_name: "localhost", schema: "public" },
  };
  const resources = { apiVersion: "v1", kind: "List", items: [
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "ax-execution-guest", namespace: "ax-demo" }, spec: {
      podSelector: { matchLabels: { "ate.dev/worker-pool": "ax-local" } }, policyTypes: ["Ingress"],
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ax-system" } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "ax-server" } } }], ports: [{ protocol: "TCP", port: 443 }] }],
    } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "ax-execution", namespace: "ax-system" }, data: { "config.json": JSON.stringify(configuration) } },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "ax-execution-database", namespace: "ax-system" }, type: "Opaque", stringData: {
      password: readFileSync(resolve(root, ".state/postgres/secrets/ax_execution.password"), "utf8").trim(),
      "ca.pem": readFileSync(auth.database.caPath, "utf8"),
    } },
  ] };
  kubectl(["apply", "-f", "-"], resources);
  kubectl(["-n", "ax-demo", "patch", "workerpool", "ax-local", "--type=merge", "--patch-file=/dev/stdin"], { spec: { workerImage: versions.worker_controlled } });
  const deployment = JSON.parse(kubectl(["-n", "ax-system", "get", "deployment", "ax-server", "-o", "json"]));
  deployment.spec.template.metadata.annotations = { ...deployment.spec.template.metadata.annotations,
    "ax.local/execution-settings-sha256": createHash("sha256").update(JSON.stringify(resources.items)).digest("hex") };
  const pod = deployment.spec.template.spec;
  const ax = pod.containers.find((container: { name: string }) => container.name === "ax-server");
  if (!ax) throw new Error("Expected AX container not found.");
  ax.image = versions.ax_server_runtime;
  ax.args = ax.args.map((argument: string) => argument.startsWith("--addr=") ? "--addr=127.0.0.1:8080" : argument);
  ax.env = (ax.env ?? []).filter((entry: { name: string }) => !["ADDR", "ATENET_ROUTER_ADDR", "AX_DISABLE_CREDENTIAL_ATESPACES"].includes(entry.name));
  ax.env.push({ name: "AX_DISABLE_CREDENTIAL_ATESPACES", value: "ax-runtime" });
  delete ax.readinessProbe;
  delete ax.livenessProbe;
  delete ax.ports;
  pod.containers = pod.containers.filter((container: { name: string }) => container.name !== "execution");
  pod.containers.push({ name: "execution", image: versions.execution, imagePullPolicy: "IfNotPresent", args: ["-config", "/etc/execution/config.json"],
    securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
    readinessProbe: { exec: { command: ["/ax-controller", "-healthcheck"] }, initialDelaySeconds: 2, periodSeconds: 5 },
    livenessProbe: { exec: { command: ["/ax-controller", "-healthcheck"] }, initialDelaySeconds: 15, periodSeconds: 10 },
    resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    volumeMounts: [
      { name: "execution-config", mountPath: "/etc/execution", readOnly: true },
      { name: "execution-database", mountPath: "/run/execution-database", readOnly: true },
      { name: "execution-identity", mountPath: "/run/podidentity", readOnly: true },
      { name: "ate-token", mountPath: "/var/run/secrets/ateapi", readOnly: true },
      { name: "servicedns-ca", mountPath: "/run/servicedns-ca", readOnly: true },
    ],
  });
  pod.securityContext = { ...pod.securityContext, fsGroup: 65532 };
  pod.terminationGracePeriodSeconds = 30;
  for (const volume of pod.volumes) if (volume.name === "ate-token") volume.projected.defaultMode = 0o440;
  pod.volumes = pod.volumes.filter((volume: { name: string }) => !["execution-config", "execution-database", "execution-identity"].includes(volume.name));
  pod.volumes.push(
    { name: "execution-config", configMap: { name: "ax-execution" } },
    { name: "execution-database", secret: { secretName: "ax-execution-database", defaultMode: 0o440 } },
    { name: "execution-identity", projected: { defaultMode: 0o440, sources: [
      { podCertificate: { signerName: "podidentity.podcert.ate.dev/identity", keyType: "ECDSAP256", credentialBundlePath: "credential-bundle.pem" } },
      { clusterTrustBundle: { signerName: "podidentity.podcert.ate.dev/identity", labelSelector: { matchLabels: { "podcert.ate.dev/canarying": "live" } }, path: "trust-bundle.pem" } },
    ] } },
  );
  delete deployment.metadata.managedFields;
  delete deployment.status;
  deployment.spec.strategy = { type: "Recreate" };
  kubectl(["replace", "-f", "-"], deployment);
  kubectl(["-n", "ax-system", "delete", "service", "ax-server", "--ignore-not-found"]);
  console.info("Managed execution deployment requested. Verify readiness and direct-connection denial before opening admission.");
}
try { await run(); }
catch { console.error("Managed deployment stopped. Admission remains closed; inspect local deployment status."); process.exitCode = 1; }
