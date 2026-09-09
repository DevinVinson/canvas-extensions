import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { CanvasHost, MountContext } from "./types";
import styles from "./styles.css?inline";

export function activate(host: CanvasHost): () => void {
  if (host.apiVersion !== "1") throw new Error(`Conversation Search requires Canvas host API 1, received ${host.apiVersion}.`);
  const disposers: Array<() => void> = [];
  for (const pageId of ["search", "operations"]) {
    disposers.push(host.registerPage(pageId, (context: MountContext) => {
      const controller = new AbortController();
      const style = document.createElement("style");
      style.dataset.conversationSearchSidecar = "styles";
      style.textContent = styles;
      const mountPoint = document.createElement("div");
      mountPoint.dataset.conversationSearchSidecar = "root";
      context.container.append(style, mountPoint);
      const root = createRoot(mountPoint);
      root.render(<App host={host} pageId={pageId} path={context.path} navigate={context.navigate} signal={controller.signal} />);
      return () => { controller.abort(); root.unmount(); mountPoint.remove(); style.remove(); };
    }));
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
