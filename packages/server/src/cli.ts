#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LINK_TOKEN_TTL_MS } from "./auth/auth.ts";
import { DEFAULT_HTTPS_PORT, DEFAULT_PORT, dataPaths, resolveDataDir } from "./config.ts";
import { type LinkResponse, requestLink, startControlServer } from "./control.ts";
import { WEB_DIST } from "./http/static.ts";
import { createServer } from "./server.ts";
import { type TailscaleServe, tailscaleServe } from "./tailscale.ts";

const HELP = `Usage: vibe-center <command> [options]

Commands:
  start     Start the server and print a sign-in link
  link      Print a fresh sign-in link for the running server

Options:
  --data-dir <dir>     Data directory (default ~/.vibe-center, env VIBE_CENTER_DATA_DIR)
  --port <n>           Local HTTP port, loopback only (start; default ${DEFAULT_PORT})
  --https-port <n>     Tailnet HTTPS port for \`tailscale serve\` (start; default ${DEFAULT_HTTPS_PORT})
  --local              Don't publish on the tailnet; localhost only (start)
  --dev                Serve the web app from Vite with HMR (start)
  --no-probe           Don't probe harnesses on start (start)
`;

const WEB_DIR = join(import.meta.dir, "../../web");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      "https-port": { type: "string" },
      local: { type: "boolean", default: false },
      dev: { type: "boolean", default: false },
      "no-probe": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  const dataDir = resolveDataDir(values["data-dir"]);

  if (command === "link") {
    printLink(await requestLink(dataPaths(dataDir).controlSocket));
    return 0;
  }
  if (command !== "start") {
    console.error(`unknown command: ${command}\n\n${HELP}`);
    return 1;
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = Number(values.port ?? process.env.VIBE_CENTER_PORT ?? DEFAULT_PORT);
  const httpsPort = Number(values["https-port"] ?? DEFAULT_HTTPS_PORT);
  const cleanups: (() => unknown)[] = [];
  const cleanup = async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error(e);
      }
    }
  };

  // Bind the control socket first: it refuses to start a second server on the same data dir.
  let link = (): LinkResponse => {
    throw new Error("starting");
  };
  const control = await startControlServer(dataPaths(dataDir).controlSocket, { link: () => link() });
  cleanups.push(() => control.stop());

  try {
    if (!values.dev && !existsSync(join(WEB_DIST, "index.html"))) {
      console.log("Building the web app (first start)…");
      const build = Bun.spawnSync(["bun", "run", "build"], {
        cwd: WEB_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (build.exitCode !== 0) throw new Error("web build failed");
    }

    const app = createServer({
      dataDir,
      port,
      webDist: values.dev ? null : WEB_DIST,
      probeOnStart: !values["no-probe"],
    });
    cleanups.push(() => app.stop());

    // In dev mode Vite serves the SPA (with HMR) and proxies /api and /ws to the app port.
    let webPort = app.port;
    if (values.dev) {
      webPort = app.port + 1;
      const vite = await startVite(webPort, app.port);
      cleanups.push(() => stopChild(vite));
    }

    let ts: TailscaleServe | null = null;
    if (!values.local) {
      try {
        ts = await tailscaleServe(httpsPort, webPort);
        app.services.setPublicUrl(ts.url);
        cleanups.push(() => ts?.stop());
      } catch (e) {
        console.warn(`Not published on the tailnet (${(e as Error).message}). Use --local to skip this.`);
      }
    }

    const localUrl = `http://localhost:${webPort}/`;
    link = (): LinkResponse => {
      const token = app.services.auth.mintLinkToken();
      const path = `login#token=${token}`;
      return {
        url: `${ts?.url ?? localUrl}${path}`,
        localUrl: `${localUrl}${path}`,
        expiresInMinutes: LINK_TOKEN_TTL_MS / 60_000,
      };
    };
    console.log(`\nVibe Center is running${values.dev ? " (dev)" : ""}. Data: ${dataDir}`);
    printLink(link());
    console.log("Ctrl+C to stop. `vibe-center link` prints a new link.\n");
  } catch (e) {
    await cleanup();
    throw e;
  }

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      console.log("\nStopping…");
      void cleanup().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

function printLink(l: LinkResponse): void {
  console.log(`\n  Sign in:  ${l.url}`);
  if (l.localUrl !== l.url) console.log(`  (local)   ${l.localUrl}`);
  console.log(`  The link works once and expires in ${l.expiresInMinutes} minutes.\n`);
}

async function startVite(port: number, apiPort: number): Promise<ChildProcess> {
  const child = spawn("bun", ["x", "vite", "--port", String(port), "--strictPort"], {
    cwd: WEB_DIR,
    env: { ...process.env, VC_API_PORT: String(apiPort) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("vite exited");
    const ok = await fetch(`http://127.0.0.1:${port}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return child;
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error("vite did not start within 10 s");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(3000).then(() => child.kill("SIGKILL"))]);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`vibe-center: ${(e as Error).message}`);
    process.exit(1);
  },
);
