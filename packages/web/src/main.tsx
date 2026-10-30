import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setUnauthorizedHandler } from "./lib/api";
import { keys, queryClient } from "./lib/queries";
import { pinToVisualViewport } from "./lib/viewport";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Any 401 means the device session is gone (revoked or expired): show the signed-out screen.
setUnauthorizedHandler(() => queryClient.setQueryData(keys.me, null));

pinToVisualViewport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
