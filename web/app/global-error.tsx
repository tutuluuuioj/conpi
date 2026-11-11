"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body className="bg-[#0b0f19] text-white flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#121827] border border-[#1f293d] rounded-2xl p-6 text-center shadow-xl space-y-4">
          <div className="w-12 h-12 rounded-full bg-indigo-500/10 text-indigo-400 mx-auto flex items-center justify-center text-xl font-bold">
            !
          </div>
          <h2 className="text-xl font-semibold">Something went wrong</h2>
          <p className="text-sm text-gray-400">
            {error?.message || "An unexpected error occurred. Please refresh the page to reload the latest version."}
          </p>
          <div className="pt-2 flex justify-center gap-3">
            <button
              onClick={() => reset()}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-[#1f293d] hover:bg-[#28354f] text-gray-200 text-sm font-medium transition-all"
            >
              Reload Page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
