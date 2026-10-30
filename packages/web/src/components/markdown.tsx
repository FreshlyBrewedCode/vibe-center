import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

interface CodeChildProps {
  className?: string;
  children?: ReactNode;
}

/**
 * Agent replies. Raw HTML is not rendered (react-markdown escapes it by default). Prose keeps
 * a 72ch measure (index.css `.markdown`); fenced code goes full width. While streaming, a
 * blinking caret follows the text.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown relative leading-[1.55]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Only fenced blocks reach `pre` (inline code renders a bare `code`), so this is the
          // one place that knows a block exists and can hand it to CodeBlock for highlighting.
          pre(props) {
            const child = Array.isArray(props.children) ? props.children[0] : props.children;
            const codeProps =
              child && typeof child === "object" && "props" in child
                ? (child.props as CodeChildProps)
                : undefined;
            const lang = /language-(\S+)/.exec(codeProps?.className ?? "")?.[1];
            const code = typeof codeProps?.children === "string" ? codeProps.children : null;
            if (code !== null) return <CodeBlock code={code.replace(/\n$/, "")} lang={lang ?? ""} />;
            return <pre>{props.children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-vc-caret bg-primary align-baseline"
        />
      )}
    </div>
  );
}
