import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/lib/http/errors";
import {
  AuthenticationError,
  AuthenticationServiceError,
} from "@/lib/auth/session-error";
import { AuthorizationError } from "@/lib/auth/rbac";

afterEach(() => vi.restoreAllMocks());
describe("safe operational error logs", () => {
  it.each([
    new Error("password=never-log"),
    Object.assign(new Error("private connection string"), {
      name: "PostgresError",
    }),
    new AuthenticationServiceError(),
  ])("logs sanitized metadata for a server failure", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = apiError(error, "request-test-123");
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(log).toHaveBeenCalledTimes(1);
    const record = JSON.parse(log.mock.calls[0]![0] as string);
    expect(record).toMatchObject({
      event: "http.request_failed",
      level: "error",
      requestId: "request-test-123",
      outcome: "FAILED",
    });
    expect(record.errorCode).toBeDefined();
    expect(record.errorType).toBeDefined();
    expect(JSON.stringify(record)).not.toMatch(
      /password|never-log|connection string/,
    );
    expect(await response.text()).not.toMatch(
      /password|never-log|connection string/,
    );
  });
  it.each([
    new AuthenticationError("sensitive identity details"),
    new AuthorizationError("sensitive resource details"),
  ])("records access denial separately from server failure", async (error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = apiError(error, "request-denied-123");
    expect(response.status).toBe(error.status);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("sensitive");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive");
  });
});
