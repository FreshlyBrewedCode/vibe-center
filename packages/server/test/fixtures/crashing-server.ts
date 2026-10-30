// Plays a server that dies without cleaning up (the test SIGKILLs it): starts the fake agent in
// stubborn mode, tracked in `<run dir>`, prints the pids and waits.
import { join } from "node:path";
import { AcpProcess } from "../../src/acp/process.ts";
import { ProcessRegistry } from "../../src/procs.ts";

const [runDir, pidFile] = process.argv.slice(2) as [string, string];
const registry = new ProcessRegistry(runDir);
const proc = await AcpProcess.start(
  {
    command: process.execPath,
    args: [join(import.meta.dir, "../fake-agent.ts")],
    env: { FAKE_ACP_STUBBORN: "all", FAKE_ACP_CHILD_PID_FILE: pidFile },
    cwd: import.meta.dir,
  },
  { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
  { tracker: registry },
);
console.log(JSON.stringify({ leader: proc.pid }));
setInterval(() => {}, 1 << 30);
