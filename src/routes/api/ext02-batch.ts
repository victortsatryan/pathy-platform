import { createFileRoute } from "@tanstack/react-router";
import { batchBridge } from "@/lib/extractor/actions-bridge.server";

export const Route = createFileRoute("/api/ext02-batch")({
  server: { handlers: { POST: ({ request }) => batchBridge(request) } },
});
