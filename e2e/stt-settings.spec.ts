import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { mintLink, ROOT } from "./helpers";

// Settings → Voice → Speech-to-text model against a stand-in for the STT server's catalog API
// (services/speech-gpu: /v1/stt/models…), so downloads and switches are deterministic and the
// shared GPU server isn't touched. The app proxies it, as it would a server on another machine.

type Status = "absent" | "downloading" | "ready" | "loading" | "active";
interface FakeModel {
  id: string;
  name: string;
  status: Status;
  vocab: boolean;
  until: number;
  next: Status;
}

function fakeSttServer() {
  const models: FakeModel[] = [
    {
      id: "parakeet",
      name: "Parakeet TDT 0.6B v2",
      status: "active",
      vocab: false,
      until: 0,
      next: "active",
    },
    {
      id: "whisper",
      name: "Whisper large-v3 turbo",
      status: "absent",
      vocab: true,
      until: 0,
      next: "absent",
    },
  ];
  const tick = () => {
    for (const m of models)
      if (m.until && Date.now() >= m.until) {
        m.status = m.next;
        m.until = 0;
      }
  };
  const view = (m: FakeModel) => {
    const left = m.until ? Math.max(0, m.until - Date.now()) : 0;
    return {
      id: m.id,
      name: m.name,
      backend: m.vocab ? "faster-whisper" : "onnx-asr",
      download_mb: 1600,
      disk_mb: m.status === "absent" || m.status === "downloading" ? 0 : 1500,
      vram_mb: 1300,
      latency_ms: m.vocab ? 185 : 50,
      wer: m.vocab ? 3.6 : 3.0,
      languages: m.vocab ? ["multilingual (99)"] : ["en"],
      accuracy: "test model",
      supports_vocabulary: m.vocab,
      recommended: !m.vocab,
      status: m.status,
      progress:
        m.status === "downloading"
          ? { phase: "download", done_bytes: 2000 - left, total_bytes: 2000, fraction: 1 - left / 2000 }
          : null,
      error: null,
    };
  };
  const server: Server = createServer((req, res) => {
    tick();
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (url === "/v1/stt/models") {
      const active = models.find((m) => m.status === "active")?.id ?? null;
      const loading = models.find((m) => m.status === "loading")?.id ?? null;
      return send(200, { active, loading, default: "parakeet", models: models.map(view), runtimes: {} });
    }
    const m = models.find((x) => url.startsWith(`/v1/stt/models/${x.id}`));
    if (!m) return send(404, { detail: "Not Found" });
    if (url.endsWith("/download") && req.method === "POST") {
      Object.assign(m, { status: "downloading", until: Date.now() + 2000, next: "ready" });
    } else if (url.endsWith("/activate")) {
      if (m.status !== "ready") return send(409, { detail: "download it first" });
      for (const o of models) if (o.status === "active") Object.assign(o, { status: "ready" });
      Object.assign(m, { status: "loading", until: Date.now() + 1000, next: "active" });
    } else if (req.method === "DELETE") {
      if (m.status === "active") return send(409, { detail: "it is the active model" });
      Object.assign(m, { status: "absent", until: 0 });
    }
    return send(202, view(m));
  });
  return new Promise<{ url: string; server: Server }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    }),
  );
}

test("speech-to-text: download a model with progress, switch to it, vocabulary, language, offline", async ({
  page,
}) => {
  const stt = await fakeSttServer();
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "New agent" }).first()).toBeVisible();
  const before = await (await page.request.get("/api/voice/settings")).json();
  await page.request.patch("/api/voice/settings", { data: { sttUrl: stt.url } });
  try {
    await page.goto("/settings/voice");
    const list = page.getByTestId("stt-models");
    await expect(list).toBeVisible();
    const parakeet = page.getByTestId("stt-model-parakeet");
    const whisper = page.getByTestId("stt-model-whisper");
    await expect(parakeet).toHaveAttribute("data-status", "active");
    await expect(parakeet.getByText("In use")).toBeVisible();
    await expect(parakeet.getByText("Recommended")).toBeVisible();
    await expect(page.getByTestId("stt-vocabulary-support")).toContainText("can't use a custom vocabulary");

    // download: a progress bar, then it can be used
    await whisper.getByRole("button", { name: /Download/ }).click();
    await expect(page.getByTestId("stt-progress-whisper")).toBeVisible();
    await expect(whisper).toHaveAttribute("data-status", "ready", { timeout: 10_000 });
    const section = page.locator("section").filter({ has: page.getByText("Speech-to-text model") });
    await section.screenshot({ path: join(ROOT, "test-results", "stt-settings-downloaded.png") });

    // switch: loading, then in use; the vocabulary note follows the active model
    await whisper.getByRole("button", { name: "Use" }).click();
    await expect(whisper).toHaveAttribute("data-status", "active", { timeout: 10_000 });
    await expect(parakeet).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("stt-vocabulary-support")).toContainText("Whisper large-v3 turbo uses it");

    // vocabulary and language are saved in the app's voice settings
    await page.getByLabel(/Custom vocabulary/).fill("Vibe Center\nPipecat, Tailscale");
    await page.getByRole("button", { name: "Save vocabulary" }).click();
    await expect
      .poll(async () => (await (await page.request.get("/api/voice/settings")).json()).sttVocabulary)
      .toEqual(["Vibe Center", "Pipecat", "Tailscale"]);
    await page.getByRole("combobox", { name: "Speech language" }).click();
    await page.getByRole("option", { name: "Detect automatically" }).click();
    await expect
      .poll(async () => (await (await page.request.get("/api/voice/settings")).json()).sttLanguage)
      .toBe("");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await section.screenshot({
      path: join(ROOT, "test-results", "stt-settings.png"),
      animations: "disabled",
    });

    // delete the one not in use
    await parakeet.getByRole("button", { name: /Delete/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(parakeet).toHaveAttribute("data-status", "absent");

    // the server goes away: the section says so instead of a list
    const closed = new Promise<void>((r) => stt.server.close(() => r()));
    stt.server.closeAllConnections();
    await closed;
    await page.reload();
    await expect(page.getByTestId("stt-models-offline")).toContainText("offline");
  } finally {
    if (stt.server.listening) stt.server.close();
    await page.request.patch("/api/voice/settings", {
      data: { sttUrl: before.sttUrl, sttVocabulary: before.sttVocabulary, sttLanguage: before.sttLanguage },
    });
  }
});
