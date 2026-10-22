// Local fixture only. Usage: node scripts/local-s3.ts up|stop|status|prepare|bucket|build
// `up` writes a private Scratch integration.env; pass it with Node --env-file.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
} from "@aws-sdk/client-s3";

const execute = promisify(execFile);
const release = "RELEASE.2025-10-15T17-29-55Z";
const moduleVersion = "v0.0.0-20251015172955-9e49d5e7a648";
const moduleSum = "h1:6TdolSCLSs2nwm8i0PpWDqf9iX2Ty9WQK8wmr7dCnUM=";
const commit = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a";
const scratch = resolve(
  process.env.SCRATCH_ROOT ?? "/Volumes/Scratch/entitle",
);
if (!scratch.startsWith("/Volumes/Scratch/"))
  throw Error("SCRATCH_ROOT must be a project directory on /Volumes/Scratch");
await access("/Volumes/Scratch");
const port = Number(process.env.LOCAL_S3_PORT ?? 19000);
if (!Number.isInteger(port) || port < 1024 || port > 65534)
  throw Error("LOCAL_S3_PORT must be between 1024 and 65534");
const root = `${scratch}/data/local-s3`,
  binary = `${scratch}/cache/minio/bin/minio`;
const go = process.env.GO_BINARY ?? "/opt/homebrew/bin/go";
const endpoint = `http://127.0.0.1:${port}`,
  bucket = "entitle-local";
const environment = `${root}/integration.env`,
  state = `${root}/native-process.json`;
const buildLog = `${scratch}/reports/minio-source-build.log`,
  serverLog = `${scratch}/reports/minio-native.log`;
const goEnvironment = {
  ...process.env,
  GOPATH: `${scratch}/cache/go`,
  GOBIN: `${scratch}/cache/minio/bin`,
  GOMODCACHE: `${scratch}/cache/go-mod`,
  GOCACHE: `${scratch}/cache/go-build`,
  GOTMPDIR: `${scratch}/tmp/minio-build`,
  TMPDIR: `${scratch}/tmp/minio-build`,
  CLANG_MODULE_CACHE_PATH: `${scratch}/cache/clang`,
  TEST_TELEMETRY_DIR: `${scratch}/cache/go-telemetry`,
  GOTOOLCHAIN: "local",
  GOSUMDB: "sum.golang.org",
  GOPROXY: "https://proxy.golang.org,direct",
  GONOSUMDB: "",
  GONOPROXY: "",
  GOPRIVATE: "",
};
async function directories() {
  for (const path of [
    root,
    `${root}/objects`,
    `${root}/certs`,
    `${root}/config`,
    `${scratch}/cache/minio/bin`,
    `${scratch}/cache/go-mod`,
    `${scratch}/cache/go-build`,
    `${scratch}/cache/clang`,
    `${scratch}/cache/go-telemetry`,
    `${scratch}/tmp/minio-build`,
    `${scratch}/reports`,
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
}
async function credentials() {
  const file = `${root}/credentials.json`;
  try {
    await writeFile(
      file,
      JSON.stringify({
        accessKeyId: "entitle-local",
        secretAccessKey: randomBytes(32).toString("hex"),
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const value = JSON.parse(await readFile(file, "utf8")) as {
    accessKeyId: string;
    secretAccessKey: string;
  };
  if (
    !/^[a-z0-9-]{3,64}$/.test(value.accessKeyId) ||
    !/^[a-f0-9]{64}$/.test(value.secretAccessKey)
  )
    throw Error("Invalid owned local S3 credentials file");
  await chmod(file, 0o600);
  return value;
}
async function prepare() {
  await directories();
  const value = await credentials();
  const lines = {
    TEST_S3_INTEGRATION: "true",
    TEST_S3_ENDPOINT: endpoint,
    TEST_S3_ACCESS_KEY_ID: value.accessKeyId,
    TEST_S3_SECRET_ACCESS_KEY: value.secretAccessKey,
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: value.accessKeyId,
    S3_SECRET_ACCESS_KEY: value.secretAccessKey,
    S3_FORCE_PATH_STYLE: "true",
    S3_ALLOW_HTTP: "true",
    MINIO_ROOT_USER: value.accessKeyId,
    MINIO_ROOT_PASSWORD: value.secretAccessKey,
  };
  await writeFile(
    environment,
    Object.entries(lines)
      .map(([key, item]) => `${key}=${item}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await chmod(environment, 0o600);
  return value;
}
async function binaryMetadata() {
  const { stdout } = await execute(go, ["version", "-m", binary], {
    env: goEnvironment,
  });
  if (
    !stdout.includes(
      `mod\tgithub.com/minio/minio\t${moduleVersion}\t${moduleSum}`,
    )
  )
    throw Error(
      "Local MinIO binary does not match the pinned official Go module",
    );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  return {
    provider: "MinIO",
    release,
    moduleVersion,
    moduleSum,
    commit,
    binary,
    sha256: hash.digest("hex"),
  };
}
async function build() {
  await directories();
  await writeFile(`${scratch}/cache/go-telemetry/mode`, "off\n", {
    mode: 0o600,
  });
  const { stdout } = await execute(go, ["version"], { env: goEnvironment });
  if (!stdout.startsWith("go version go1.27.1 "))
    throw Error("This fixture pins Go 1.27.1; set GO_BINARY to that toolchain");
  try {
    await access(binary);
  } catch {
    const output = await open(buildLog, "a", 0o600);
    try {
      const child = spawn(
        go,
        ["install", `github.com/minio/minio@${moduleVersion}`],
        { env: goEnvironment, stdio: ["ignore", output.fd, output.fd] },
      );
      await new Promise<void>((done, fail) => {
        child.once("error", fail);
        child.once("exit", (code) =>
          code === 0
            ? done()
            : fail(Error(`Pinned MinIO build failed; see ${buildLog}`)),
        );
      });
    } finally {
      await output.close();
    }
  }
  const metadata = await binaryMetadata();
  await writeFile(
    `${scratch}/cache/minio/build.json`,
    JSON.stringify(metadata, null, 2) + "\n",
    { mode: 0o600 },
  );
  return metadata;
}
interface ProcessState {
  pid: number;
  binary: string;
  objects: string;
  endpoint: string;
  sha256: string;
}
async function ownedProcess(): Promise<ProcessState | undefined> {
  let value: ProcessState;
  try {
    value = JSON.parse(await readFile(state, "utf8")) as ProcessState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    value.binary !== binary ||
    value.objects !== `${root}/objects` ||
    value.endpoint !== endpoint
  )
    throw Error("Refusing an unrecognized local S3 process record");
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      await unlink(state);
      return;
    }
    throw error;
  }
  let details: string;
  try {
    const result = await execute("/bin/ps", [
      "-p",
      String(value.pid),
      "-o",
      "stat=",
      "-o",
      "command=",
    ]);
    details = result.stdout.trimStart();
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (
      failure.code === 1 &&
      !failure.stdout?.trim() &&
      !failure.stderr?.trim()
    ) {
      await unlink(state);
      return;
    }
    throw error;
  }
  // An owned server can be a zombie briefly between SIGTERM and reaping.
  if (details.startsWith("Z")) {
    await unlink(state);
    return;
  }
  const command = details.replace(/^\S+\s+/, "");
  if (
    !command.startsWith(`${binary} `) ||
    !command.includes(` ${root}/objects`)
  )
    throw Error("Local S3 PID is owned by another process");
  return value;
}
async function waitReady() {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* The owned provider may still be starting. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Local MinIO did not become ready; see ${serverLog}`);
}
async function initializeBucket() {
  const value = await prepare();
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: value,
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: 3000,
      requestTimeout: 5000,
      throwOnRequestTimeout: true,
      socketTimeout: 3000,
    },
  });
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw error;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    try {
      await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      throw Error("Refusing a local fixture bucket with an existing policy");
    } catch (error) {
      if ((error as { name: string }).name !== "NoSuchBucketPolicy")
        throw error;
    }
    const anonymous = await fetch(`${endpoint}/${bucket}`, {
      signal: AbortSignal.timeout(3000),
    });
    await anonymous.body?.cancel();
    if (anonymous.status !== 403)
      throw Error("Local S3 fixture bucket is not private");
  } finally {
    client.destroy();
  }
}
async function up() {
  const value = await prepare();
  const metadata = await build();
  if (!(await ownedProcess())) {
    const output = await open(serverLog, "a", 0o600);
    try {
      const child = spawn(
        binary,
        [
          "--quiet",
          "--certs-dir",
          `${root}/certs`,
          "--config-dir",
          `${root}/config`,
          "server",
          "--address",
          `127.0.0.1:${port}`,
          "--console-address",
          `127.0.0.1:${port + 1}`,
          `${root}/objects`,
        ],
        {
          detached: true,
          env: {
            ...process.env,
            TMPDIR: `${scratch}/tmp/minio-build`,
            MINIO_ROOT_USER: value.accessKeyId,
            MINIO_ROOT_PASSWORD: value.secretAccessKey,
            MINIO_BROWSER: "off",
            MINIO_UPDATE: "off",
          },
          stdio: ["ignore", output.fd, output.fd],
        },
      );
      await new Promise<void>((done, fail) => {
        child.once("spawn", done);
        child.once("error", fail);
      });
      child.unref();
      await writeFile(
        state,
        JSON.stringify({
          pid: child.pid,
          binary,
          objects: `${root}/objects`,
          endpoint,
          sha256: metadata.sha256,
        }) + "\n",
        { mode: 0o600 },
      );
    } finally {
      await output.close();
    }
  }
  await waitReady();
  await initializeBucket();
  console.log(
    `MinIO fixture ready at ${endpoint}; private bucket ${bucket}.\nPrivate application/test environment file: ${environment}`,
  );
}
async function stop() {
  const value = await ownedProcess();
  if (!value) {
    console.log("No owned native MinIO process is running.");
    return;
  }
  process.kill(value.pid, "SIGTERM");
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      process.kill(value.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      await unlink(state);
      console.log(
        "Stopped owned native MinIO process; fixture data preserved.",
      );
      return;
    }
    // Ownership was checked before SIGTERM. The command can disappear during
    // teardown, so poll existence without sending another signal.
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(
    "Owned MinIO process did not stop; refusing to escalate its signal",
  );
}
const command = process.argv[2] ?? "up";
if (command === "up") await up();
else if (command === "prepare") {
  await prepare();
  console.log(`Prepared private local S3 environment file: ${environment}`);
} else if (command === "build")
  console.log(JSON.stringify(await build(), null, 2));
else if (command === "bucket") {
  await waitReady();
  await initializeBucket();
  console.log(`Verified private local bucket ${bucket}`);
} else if (command === "stop") await stop();
else if (command === "status") {
  const value = await ownedProcess();
  console.log(
    value
      ? `Owned MinIO PID ${value.pid} at ${endpoint}`
      : "Native MinIO is stopped.",
  );
} else
  throw Error(
    "Usage: node scripts/local-s3.ts up|stop|status|prepare|bucket|build",
  );
