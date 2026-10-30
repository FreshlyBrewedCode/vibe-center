import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
const UPSTREAM = join(ROOT, "packages/server/test/fixtures/stdio-mcp-server.ts");
const dataDir = process.env.VC_E2E_DATA_DIR!;

function mintLink(): string {
  const out = execFileSync("bun", ["packages/server/src/cli.ts", "link", "--data-dir", dataDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const m = /(http:\/\/localhost:\d+\/login#token=\S+)/.exec(out);
  if (!m?.[1]) throw new Error(`no link in output:\n${out}`);
  return m[1];
}

test("add an MCP server, enable its tools for an agent, call one through the gateway", async ({ page }) => {
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();

  // An agent on the fake ACP harness (it calls MCP tools on keywords).
  const harness = await (
    await page.request.post("/api/harnesses", {
      data: { name: "Fake MCP", command: "bun", args: [FAKE_AGENT] },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Toolie",
        avatar: { emoji: "🧰", color: "#aa6622" },
        harnessId: harness.id,
        cwd: dataDir,
      },
    })
  ).json();

  // Settings → MCP servers → add a stdio server with a secret env var.
  await page.getByRole("link", { name: "Settings" }).click();
  // The sidebar has an "MCP servers" link too (straight to this page); use the settings nav.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "MCP servers" })
    .click();
  await expect(page.getByTestId("mcp-server-builtin")).toContainText("Built-in");
  await page.getByRole("button", { name: "Add MCP server" }).click();
  await page.getByLabel("Name").fill("upstream");
  await page.getByLabel("Command").fill("bun");
  await page.getByLabel("Arguments (one per line)").fill(UPSTREAM);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Environment name").fill("SECRET_TOKEN");
  await page.getByLabel("Environment value").fill("e2e-secret-value-9876");
  await page.getByRole("button", { name: "Add server" }).click();
  const row = page.getByTestId("mcp-server-upstream");
  await expect(row.getByTestId("mcp-status")).toHaveText("Connected");
  await expect(row).toContainText("6 tools");
  await expect(row).toContainText("Secrets: SECRET_TOKEN");
  await expect(page.locator("body")).not.toContainText("e2e-secret-value");

  // The agent's Tools section: built-ins on, the new server off until enabled.
  await page.goto(`/agents/${agent.id}/edit`);
  const group = page.getByTestId("tool-group-upstream");
  await expect(group).toContainText("0 of 6 on");
  await group.getByRole("switch", { name: "All upstream tools" }).click();
  await expect(group).toContainText("6 of 6 on");
  await group.getByRole("button", { name: /upstream/ }).click();
  await group.getByRole("switch", { name: "upstream__env" }).click();
  await expect(group).toContainText("5 of 6 on");
  await page.screenshot({ path: "test-results/agent-tools.png", fullPage: true });

  // In the DM: the agent sees exactly its enabled tools and calls one through the gateway.
  await page.goto(`/agents/${agent.id}`);
  const composer = page.getByLabel("Message");
  await composer.fill("mcp-list");
  await composer.press("Enter");
  const reply = page.getByTestId("message-agent").last();
  await expect(reply).toContainText("upstream__echo");
  await expect(reply).not.toContainText("upstream__env");
  await expect(reply).toContainText("memory_save");

  await composer.fill('mcp-call upstream__add {"a":2,"b":3}');
  await composer.press("Enter");
  await expect(page.getByTestId("message-agent").last()).toContainText("Result: 5");
  const card = page.getByTestId("tool-call").last();
  await expect(card).toContainText("upstream · add");
  await card.locator("summary").click();
  await expect(card.getByTestId("gateway-call")).toContainText("via MCP gateway");
  await expect(card.getByTestId("gateway-call")).toContainText('"a": 2');

  // A memory saved through the built-in tools shows up in the Memories view.
  await composer.fill('mcp-call memory_save {"content":"The e2e run remembers this"}');
  await composer.press("Enter");
  await expect(page.getByTestId("message-agent").last()).toContainText("Saved memory");
  await page.getByRole("link", { name: "Memories" }).click();
  await expect(page.getByTestId("memory")).toContainText("The e2e run remembers this");
  await page.screenshot({ path: "test-results/memories.png" });
});
