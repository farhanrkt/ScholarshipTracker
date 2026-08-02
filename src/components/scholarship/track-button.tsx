"use client";

import { useOptimistic, useTransition } from "react";
import { BookmarkCheck, BookmarkPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { trackScholarship, untrackScholarship } from "@/app/actions/targets";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TrackButtonProps {
  scholarshipId: string;
  tracked: boolean;
  className?: string;
  size?: "sm" | "default" | "lg";
  fullWidth?: boolean;
}

export function TrackButton({
  scholarshipId,
  tracked,
  className,
  size = "default",
  fullWidth = false,
}: TrackButtonProps) {
  const [pending, startTransition] = useTransition();
  // Resets to the `tracked` prop automatically once revalidation lands.
  const [optimisticTracked, setOptimisticTracked] = useOptimistic(tracked);

  function handleClick() {
    const next = !optimisticTracked;

    startTransition(async () => {
      setOptimisticTracked(next);

      const result = next
        ? await trackScholarship(scholarshipId)
        : await untrackScholarship(scholarshipId);

      if (!result.success) {
        toast.error(next ? "Could not track it" : "Could not untrack it", {
          description: result.error,
        });
        return;
      }

      toast.success(next ? "Added to your tracker" : "Removed from your tracker", {
        description: next
          ? "Open My tracker to work through the document checklist."
          : undefined,
      });
    });
  }

  return (
    <Button
      type="button"
      size={size}
      variant={optimisticTracked ? "secondary" : "default"}
      onClick={handleClick}
      disabled={pending}
      aria-pressed={optimisticTracked}
      className={cn(fullWidth && "w-full", className)}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : optimisticTracked ? (
        <BookmarkCheck className="size-4" />
      ) : (
        <BookmarkPlus className="size-4" />
      )}
      {optimisticTracked ? "Tracking" : "Track this scholarship"}
    </Button>
  );
}
