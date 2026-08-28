import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithoutRedirect } from "@/lib/security/safe-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("redirect-safe service egress", () => {
  it("forces redirect:error even when a caller asks to follow", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithoutRedirect("https://service.example.invalid", {
      method: "POST",
      redirect: "follow",
      body: "sensitive payload",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://service.example.invalid",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });
});
