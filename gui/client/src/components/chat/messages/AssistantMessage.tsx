import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantMessage as AssistantMessageModel } from "../../../types/messages";

// Force every markdown link to open externally WITHOUT a Referer, so the cockpit
// URL's ?token=… is never leaked to the destination site.
const MD_COMPONENTS: Components = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function AssistantMessage({ message }: { message: AssistantMessageModel }) {
  return (
    <div className={`msg assistant${message.streaming ? " streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {message.text}
      </ReactMarkdown>
    </div>
  );
}
