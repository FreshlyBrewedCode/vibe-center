import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dataDir, FAKE_AGENT, mintLink, ROOT } from "./helpers";

const OAUTH_SERVER = join(ROOT, "packages/server/test/fixtures/oauth-mcp-server.ts");

let proc: ChildProcess | null = null;
let mcpUrl = "";
const base = () => new URL(mcpUrl).origin;

/** The test MCP server with its own OAuth authorization server (auto-approves the consent page). */
test.beforeAll(async () => {
  proc = spawn("bun", [OAUTH_SERVER, "0"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  mcpUrl = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc!.stdout!.on("data", (d: Buffer) => {
      out += String(d);
      const m = /OAUTH_MCP_URL=(\S+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    proc!.on("exit", (code) => reject(new Error(`oauth server exited (${code})`)));
  });
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

const stats = async () => (await fetch(`${base()}/test/stats`)).json() as Promise<{ refreshes: number }>;

test("an OAuth MCP server: sign in, tools for an agent, refresh, revoke, sign in again on a phone", async ({
  page,
}) => {
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  const harness = await (
    await page.request.post("/api/harnesses", {
      data: { name: "Fake OAuth", command: "bun", args: [FAKE_AGENT] },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Keyholder",
        avatar: { emoji: "🔑", color: "#336699" },
        harnessId: harness.id,
        cwd: dataDir,
      },
    })
  ).json();

  // Add the HTTP server: its first connect gets a 401, so it needs a sign-in.
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Add MCP server" }).click();
  await page.getByLabel("Name").fill("secure");
  await page.getByLabel("Transport").click();
  await page.getByRole("option", { name: "HTTP" }).click();
  await page.getByLabel("URL").fill(mcpUrl);
  await page.getByRole("button", { name: "Add server" }).click();
  const row = page.getByTestId("mcp-server-secure");
  await expect(row.getByTestId("mcp-status")).toHaveText("Needs sign-in");
  await page.screenshot({ path: "test-results/mcp-oauth-needs-sign-in.png" });

  // Sign in: a new tab goes to the authorization server, which redirects back to the app's
  // redirect page; that one finishes the sign-in and closes itself.
  const popupOpened = page.context().waitForEvent("page");
  await row.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupOpened;
  await popup.waitForEvent("close");
  await expect(row.getByTestId("mcp-status")).toHaveText("Connected");
  await expect(row.getByTestId("mcp-oauth")).toContainText("Signed in as tester@example.com");
  await expect(row.getByTestId("mcp-oauth")).toContainText("mcp:tools");
  await expect(row).toContainText("2 tools");
  await page.screenshot({ path: "test-results/mcp-oauth-signed-in.png" });
  await expect(page.locator("body")).not.toContainText("access_token");

  // Enable its tools for the agent and call one through the gateway.
  await page.goto(`/agents/${agent.id}/edit`);
  const group = page.getByTestId("tool-group-secure");
  await group.getByRole("switch", { name: "All secure tools" }).click();
  await expect(group).toContainText("2 of 2 on");
  await page.goto(`/agents/${agent.id}`);
  const composer = page.getByLabel("Message");
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  await send("mcp-call secure__whoami {}");
  await expect(page.getByTestId("message-agent").last()).toContainText("Result: you are tester");

  // The access token expires: the next call refreshes it and goes through.
  await fetch(`${base()}/test/expire`, { method: "POST" });
  await send('mcp-call secure__echo {"text":"still here"}');
  await expect(page.getByTestId("message-agent").last()).toContainText("echo: still here");
  expect((await stats()).refreshes).toBe(1);

  // The grant is revoked: the refresh fails, the agent gets a clear error, the card points at Settings.
  await fetch(`${base()}/test/revoke-all`, { method: "POST" });
  await send("mcp-call secure__whoami {}");
  await expect(page.getByTestId("message-agent").last()).toContainText("needs sign-in");
  const hint = page.getByTestId("tool-needs-sign-in").last();
  await expect(hint).toContainText('The "secure" MCP server needs sign-in.');
  await page.screenshot({ path: "test-results/mcp-oauth-dm-needs-sign-in.png" });
  await hint.getByRole("link", { name: "Fix in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await expect(row.getByTestId("mcp-status")).toHaveText("Needs sign-in");

  // On a phone the sign-in is a full-page redirect that comes back to this page.
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await expect(row.getByTestId("mcp-status")).toHaveText("Connected");
  await page.screenshot({ path: "test-results/mcp-oauth-phone.png" });
  await page.goto(`/agents/${agent.id}`);
  await send("mcp-call secure__whoami {}");
  await expect(page.getByTestId("message-agent").last()).toContainText("Result: you are tester");

  // Disconnect: revoked and back to needing a sign-in.
  await page.goto("/settings/mcp");
  await row.getByRole("button", { name: "Disconnect" }).click();
  await expect(row.getByTestId("mcp-status")).toHaveText("Needs sign-in");
});
