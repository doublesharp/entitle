import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
await access("/Volumes/Scratch");
const root = "/Volumes/Scratch/entitle";
await mkdir(`${root}/data/local`, { recursive: true });
await writeFile(
  ".npmrc",
  `# Machine-local cache paths; never copied into Docker builds.\nstore-dir=${root}/cache/pnpm\nvirtual-store-dir=${root}/cache/virtual-store\n`,
  { flag: "wx", mode: 0o600 },
).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});
await writeFile(
  ".env",
  `NODE_ENV=development\nPUBLIC_ORIGIN=http://localhost:3211\nPORT=3211\nAPP_SECRET=${randomBytes(32).toString("hex")}\nOPERATOR_TOKEN=${randomBytes(32).toString("base64url")}\nDATA_DIR=${root}/data/local\nBUILD_DIR=${root}/build/main\nLOCAL_BILLING=true\nDEPLOYMENT_MODE=standalone\nSTANDALONE_OWNER_EMAIL=owner@example.test\nSMTP_HOST=127.0.0.1\nSMTP_PORT=1025\nMAIL_FROM=licenses@example.test\n`,
  { flag: "wx", mode: 0o600 },
);
console.log("Created .env with local-only secrets and billing fixtures. Run node scripts/local-s3.ts up, then load its generated integration.env alongside .env when starting the app.");
