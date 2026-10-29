import { spawn } from "node:child_process";

export interface TailscaleServe {
  /** https://<machine>.<tailnet>.ts.net:<port>/ */
  url: string;
  stop(): Promise<void>;
}

/**
 * Publish the local port on the tailnet over HTTPS (Tailscale's cert; the mic needs a secure
 * context). Runs `tailscale serve` in the foreground, so the serve entry disappears when it
 * stops, as in prototype/voice-loop/run.sh.
 */
export async function tailscaleServe(httpsPort: number, targetPort: number): Promise<TailscaleServe> {
  const status = Bun.spawnSync(["tailscale", "status", "--json"], { stderr: "pipe" });
  if (status.exitCode !== 0) throw new Error(`tailscale is not running: ${status.stderr.toString().trim()}`);
  const dnsName = (JSON.parse(status.stdout.toString()) as { Self?: { DNSName?: string } }).Self?.DNSName;
  if (!dnsName) throw new Error("tailscale status has no DNS name for this machine");
  const host = dnsName.replace(/\.$/, "");

  const child = spawn("tailscale", ["serve", `--https=${httpsPort}`, `http://127.0.0.1:${targetPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(-1));
  });
  // Foreground serve keeps running; an early exit means it failed (port taken, not permitted).
  const early = await Promise.race([exited, Bun.sleep(1500).then(() => "running" as const)]);
  if (early !== "running") throw new Error(`tailscale serve failed: ${output.trim() || `exit ${early}`}`);

  return {
    url: `https://${host}:${httpsPort}/`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(3000).then(() => child.kill("SIGKILL"))]);
    },
  };
}
