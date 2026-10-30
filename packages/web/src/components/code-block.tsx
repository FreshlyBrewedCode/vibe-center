import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Fenced code highlighting, kept light: highlight.js's core ships with no languages built in,
// and each language grammar below is its own dynamic import, so a chat full of bash snippets
// never pulls in the Python or Rust grammars. Unknown/missing languages just render as plain text.
let core: typeof import("highlight.js/lib/core").default | null = null;
const loaded = new Set<string>();

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  jsx: () => import("highlight.js/lib/languages/javascript"),
  tsx: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/bash"),
  zsh: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  html: () => import("highlight.js/lib/languages/xml"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  toml: () => import("highlight.js/lib/languages/ini"),
  ini: () => import("highlight.js/lib/languages/ini"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
};

const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  cs: "csharp",
  rb: "ruby",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
  dockerfile: "dockerfile",
};

async function highlight(code: string, lang: string): Promise<string | null> {
  const name = ALIASES[lang] ?? lang;
  const load = LOADERS[name];
  if (!load) return null;
  if (!core) core = (await import("highlight.js/lib/core")).default;
  if (!loaded.has(name)) {
    const mod = await load();
    // biome-ignore lint/suspicious/noExplicitAny: highlight.js's language modules are untyped
    core.registerLanguage(name, mod.default as any);
    loaded.add(name);
  }
  try {
    return core.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** A fenced code block: a header with the language and a copy button, lazily highlighted. */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHtml(null);
    let cancelled = false;
    highlight(code, lang.toLowerCase()).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-8 items-center justify-between border-line border-b px-3.5 font-mono text-2xs text-muted-foreground">
        <span>{lang || "text"}</span>
        <button
          type="button"
          aria-label="Copy code"
          className={cn(
            "-mr-1.5 flex h-6 items-center gap-1 rounded-md px-1.5 font-sans text-2xs transition-colors hover:bg-muted hover:text-foreground",
            copied && "text-presence-working hover:text-presence-working",
          )}
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="vc-scroll max-w-full overflow-x-auto rounded-none border-0 bg-transparent px-3.5 py-3 font-mono text-[11.5px] leading-[1.55] sm:text-[12.5px]">
        {html !== null ? (
          <>
            {/* highlight.js escapes the source text itself and only adds its own <span> tags, so
              this never interprets anything from the code as markup. */}
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is pre-escaped */}
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          </>
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
