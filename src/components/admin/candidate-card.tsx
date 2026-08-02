"use client";

import { useState, useTransition } from "react";
import { Ban, Check, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { promoteCandidate, rejectCandidate } from "@/app/actions/review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ScholarshipCandidate } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const CONFIDENCE_STYLES = {
  high: "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200",
  medium: "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200",
  low: "border-dashed text-muted-foreground",
} as const;

export function CandidateCard({
  candidate,
}: {
  candidate: ScholarshipCandidate;
}) {
  const [pending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<"promoted" | "rejected" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  function handlePromote() {
    startTransition(async () => {
      const result = await promoteCandidate(candidate.id);
      if (!result.success) {
        toast.error("Could not promote", { description: result.error });
        return;
      }
      setResolved("promoted");
      toast.success(`${candidate.programme_name} added`, {
        description: "Dateless and unverified — run npm run extract to fill in its cycle.",
      });
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectCandidate(candidate.id, reason);
      if (!result.success) {
        toast.error("Could not reject", { description: result.error });
        return;
      }
      setResolved("rejected");
      toast.success("Rejected");
    });
  }

  if (resolved) {
    return (
      <article className="text-muted-foreground bg-muted/40 flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm">
        {resolved === "promoted" ? (
          <Check className="size-4" />
        ) : (
          <Ban className="size-4" />
        )}
        {candidate.programme_name} — {resolved}
      </article>
    );
  }

  return (
    <article className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {candidate.host_country && (
              <Badge variant="secondary">{candidate.host_country}</Badge>
            )}
            {candidate.degree_levels.map((level) => (
              <Badge key={level} variant="outline" className="font-normal">
                {level}
              </Badge>
            ))}
            <Badge
              variant="outline"
              className={cn("font-normal", CONFIDENCE_STYLES[candidate.confidence])}
            >
              {candidate.confidence} confidence
            </Badge>
            {candidate.is_fully_funded === true && (
              <Badge variant="secondary">Fully funded</Badge>
            )}
            {candidate.is_fully_funded === false && (
              <Badge variant="outline" className="font-normal">
                Partial funding
              </Badge>
            )}
          </div>
          <h2 className="text-base leading-snug font-semibold tracking-tight">
            {candidate.programme_name}
          </h2>
          {candidate.funder && (
            <p className="text-muted-foreground text-xs">{candidate.funder}</p>
          )}
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          via {candidate.found_via}
        </span>
      </header>

      {candidate.summary && (
        <p className="text-sm leading-relaxed">{candidate.summary}</p>
      )}

      <p className="text-muted-foreground truncate text-xs">{candidate.url}</p>

      <footer className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" onClick={handlePromote} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Add to database
        </Button>

        {rejecting ? (
          <>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why? (optional)"
              className="h-8 max-w-56"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleReject}
              disabled={pending}
            >
              Confirm reject
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRejecting(true)}
            disabled={pending}
          >
            <Ban className="size-3.5" />
            Reject
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          nativeButton={false}
          render={
            <a href={candidate.url} target="_blank" rel="noopener noreferrer" />
          }
        >
          <ExternalLink className="size-3.5" />
          Open page
        </Button>
      </footer>
    </article>
  );
}
