"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const isConfigError = error.message.includes("Missing environment variable");

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-24 text-center">
      <TriangleAlert className="text-muted-foreground size-8" />
      <h1 className="text-lg font-semibold tracking-tight">
        {isConfigError ? "Supabase is not configured yet" : "Something went wrong"}
      </h1>

      <p className="text-muted-foreground text-sm leading-relaxed">
        {isConfigError ? (
          <>
            Copy <code className="font-mono text-xs">.env.example</code> to{" "}
            <code className="font-mono text-xs">.env.local</code>, paste in your
            Supabase project URL and anon key, then restart the dev server.
          </>
        ) : (
          error.message
        )}
      </p>

      {!isConfigError && (
        <Button onClick={reset} size="sm">
          Try again
        </Button>
      )}
    </div>
  );
}
