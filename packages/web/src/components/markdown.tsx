import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent replies. Raw HTML is not rendered (react-markdown escapes it by default). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
