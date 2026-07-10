import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Force every markdown link to open externally WITHOUT a Referer, so the cockpit URL's
// ?token=… is never leaked to the destination site. Shared by the chat bubble and the
// Operator Loop weekly brief — wrap the output in a `.assistant-prose` container for styling.
const MD_COMPONENTS: Components = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** Render trusted local markdown (GFM) with token-safe external links. */
export function MarkdownBlock({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
