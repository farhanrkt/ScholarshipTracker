"use client";

import { useState, useTransition } from "react";
import {
  BadgeCheck,
  ExternalLink,
  Loader2,
  Quote,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import { markNeedsCheck, markVerified } from "@/app/actions/review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeVerification, formatDate } from "@/lib/format";
import type { FieldEvidence } from "@/lib/types/extraction";

/**
 * One programme, everything a person needs to confirm it, and the two buttons
 * that record what they decided.
 *
 * The design goal is that verifying a row costs one click and one glance at the
 * portal. That means the quote has to be HERE — a reviewer who has to go
 * digging for what the machine read, and where it read it, will verify one row
 * and stop, which is exactly what happened.
 */

export interface VerifiableScholarship {
  id: string;
  title: string;
  country: string;
  official_portal_url: string;
  source_url: string | null;
  cycle_label: string | null;
  opens_date: string | null;
  deadline_date: string | null;
  verification_status: "unverified" | "ai_extracted" | "verified";
  last_verified_at: string | null;
  is_profiled: boolean;
  /** Quotes from the extraction this row was built from, when there was one. */
  evidence: Record<string, FieldEvidence>;
  extractedBy: string | null;
}

function Field({
  label,
  value,
  evidence,
}: {
  label: string;
  value: string | null;
  evidence?: FieldEvidence;
}) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="text-muted-foreground w-20 shrink-0 text-xs">
          {label}
        </span>
        {value ? (
          <span className="font-medium">{value}</span>
        ) : (
          <span className="text-muted-foreground italic">not published</span>
        )}
      </div>

      {evidence?.quote && (
        <blockquote className="text-muted-foreground border-muted-foreground/30 ml-20 flex gap-1.5 border-l-2 pl-2 text-xs leading-snug">
          <Quote className="mt-0.5 size-3 shrink-0 opacity-50" />
          <span>
            &ldquo;{evidence.quote}&rdquo;
            {evidence.source_url && (
              <a
                href={evidence.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2"
              >
                page
                <ExternalLink className="size-2.5" />
              </a>
            )}
          </span>
        </blockquote>
      )}
    </div>
  );
}

export function VerifyCard({
  scholarship,
}: {
  scholarship: VerifiableScholarship;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(scholarship.verification_status);
  const [checkedAt, setCheckedAt] = useState(scholarship.last_verified_at);

  const verification = describeVerification({
    verification_status: status,
    last_verified_at: checkedAt,
    deadline_date: scholarship.deadline_date,
  });

  function verify() {
    startTransition(async () => {
      const result = await markVerified(scholarship.id);
      if (!result.success) {
        toast.error("Could not mark it verified", { description: result.error });
        return;
      }
      // Optimistic only after the server agreed: the badge is a trust claim,
      // and showing "verified" for a write that failed is the one thing this
      // page must never do.
      setStatus("verified");
      setCheckedAt(new Date().toISOString());
      toast.success(`${scholarship.title} verified`);
    });
  }

  function unverify() {
    startTransition(async () => {
      const result = await markNeedsCheck(scholarship.id);
      if (!result.success) {
        toast.error("Could not change the status", { description: result.error });
        return;
      }
      setStatus(scholarship.source_url ? "ai_extracted" : "unverified");
      if (!scholarship.source_url) setCheckedAt(null);
      toast.success("Sent back for another look");
    });
  }

  return (
    <article className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{scholarship.country}</Badge>
            <Badge
              variant={verification.state === "verified" ? "default" : "outline"}
              className="font-normal"
            >
              {verification.label}
            </Badge>
            {!scholarship.is_profiled && (
              <Badge variant="outline" className="font-normal">
                dates only
              </Badge>
            )}
          </div>
          <h2 className="text-base leading-snug font-semibold tracking-tight">
            {scholarship.title}
          </h2>
        </div>

        {scholarship.extractedBy && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {scholarship.extractedBy}
          </span>
        )}
      </header>

      <div className="divide-y border-y">
        <Field
          label="Cycle"
          value={scholarship.cycle_label}
          evidence={scholarship.evidence.cycle_label}
        />
        <Field
          label="Opens"
          value={scholarship.opens_date}
          evidence={scholarship.evidence.opens_date}
        />
        <Field
          label="Closes"
          value={scholarship.deadline_date}
          evidence={scholarship.evidence.deadline_date}
        />
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        {verification.detail}
      </p>

      <footer className="flex flex-wrap items-center gap-2 border-t pt-3">
        {status === "verified" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={unverify}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            Needs another look
          </Button>
        ) : (
          <Button size="sm" onClick={verify} disabled={pending}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <BadgeCheck className="size-3.5" />
            )}
            Mark verified
          </Button>
        )}

        {checkedAt && status === "verified" && (
          <span className="text-muted-foreground text-xs">
            checked {formatDate(checkedAt)}
          </span>
        )}

        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          nativeButton={false}
          render={
            <a
              href={scholarship.official_portal_url}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <ExternalLink className="size-3.5" />
          Portal
        </Button>

        {scholarship.source_url &&
          scholarship.source_url !== scholarship.official_portal_url && (
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              render={
                <a
                  href={scholarship.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <ExternalLink className="size-3.5" />
              Source page
            </Button>
          )}
      </footer>
    </article>
  );
}
