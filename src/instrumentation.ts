export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { writeLog } = await import("@/lib/observability/logger");
    writeLog("info", "application.instrumentation_registered", {
      action: "startup",
      outcome: "SUCCESS",
    });
  }
}
