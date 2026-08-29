import { handleAssistantRequest } from "@/lib/ai/assistant-service";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleAssistantRequest(request);
}
