"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled client error in route:", error);
    try {
      fetch("/api/debug-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msg: error.message,
          stack: error.stack,
          digest: error.digest,
        }),
      }).catch(() => {});
    } catch {}
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-4 rounded-xl border border-line bg-surface p-6 shadow-2">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand/10 text-brand">
          <span className="text-xl font-bold">!</span>
        </div>
        <h2 className="text-lg font-semibold text-ink">Something went wrong</h2>
        <p className="text-sm text-muted">
          {error.message || "An unexpected error occurred while rendering the page."}
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    </div>
  );
}
