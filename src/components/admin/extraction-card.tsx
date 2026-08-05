"use client";

import { useState, useTransition } from "react";
import {
  ArrowRight,
  Ban,
  Check,
  ExternalLink,
  Loader2,
  Quote,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { applyExtraction, rejectExtraction } from "@/app/actions/review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { COVERAGE_LABELS, type CoverageKey } from "@/lib/types/database";
import type { FieldEvidence, PendingExtraction } from "@/lib/types/extraction";

/** Current value → proposed value, so the reviewer sees what actually changes. */
function Change({
  label,
  from,
  to,
  evidence,
}: {
  label: string;
  from: string | null;
  to: string | null;
  evidence?: FieldEvidence;
}) {
  if (to === null) return null;

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="text-muted-foreground w-24 shrink-0 text-xs">
          {label}
        </span>
        {from ? (
          <span className="text-muted-foreground line-through">{from}</span>
        ) : (
          <span className="text-muted-foreground italic">not set</span>
        )}
        <ArrowRight className="text-muted-foreground size-3" />
        <span className="font-medium">{to}</span>
      </div>

      {evidence?.quote && (
        <blockquote className="text-muted-foreground border-muted-foreground/30 ml-24 flex gap-1.5 border-l-2 pl-2 text-xs leading-snug">
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
                source
                <ExternalLink className="size-2.5" />
              </a>
            )}
          </span>
        </blockquote>
      )}
    </div>
  );
}

/**
 * A collapsed list of what the profile half of the extraction proposes.
 *
 * Collapsed because the reviewer's first question is "is the deadline right?"
 * and the deep fields are the second question, not the first. Counted in the
 * summary line so the answer to "is there anything here?" costs no clicks.
 */
function Proposal({
  label,
  items,
}: {
  label: string;
  items: Array<{ key: string; text: string }>;
}) {
  if (items.length === 0) return null;

  return (
    <details className="text-sm">
      <summary className="text-muted-foreground cursor-pointer text-xs">
        {items.length} {label}
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.key} className="text-xs">
            {item.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ExtractionCard({
  extraction,
}: {
  extraction: PendingExtraction;
}) {
  const [pending, startTransition] = useTransition();
  const [resolved, setResolved] = useState<"applied" | "rejected" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const { scholarship, proposed, evidence } = extraction;

  // `proposed` is JSONB written by the extraction script; a run from before the
  // profile call existed has none of these keys at all.
  const timeline = Array.isArray(proposed.timeline) ? proposed.timeline : [];

  const coverage = Object.entries(proposed.coverage_matrix ?? {}).map(
    ([key, item]) => ({
      key,
      text: `${COVERAGE_LABELS[key as CoverageKey] ?? key}: ${
        item?.covered ? "covered" : "not covered"
      }${item?.detail ? ` — ${item.detail}` : ""}`,
    }),
  );

  const eligibility = Object.entries(proposed.eligibility_flags ?? {}).map(
    ([key, value]) => ({
      key,
      text: `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
    }),
  );

  const documents = (
    Array.isArray(proposed.document_checklist) ? proposed.document_checklist : []
  ).map((doc) => ({
    key: doc.key,
    text: `${doc.label}${doc.required ? "" : " (optional)"}${doc.notes ? ` — ${doc.notes}` : ""}`,
  }));

  function handleApply() {
    startTransition(async () => {
      const result = await applyExtraction(extraction.id);
      if (!result.success) {
        toast.error("Could not apply", { description: result.error });
        return;
      }
      setResolved("applied");
      toast.success(`${scholarship.title} updated`, {
        description:
          "Landed at ai_extracted. Confirm it against the portal in Verify to make it verified.",
      });
    });
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectExtraction(extraction.id, reason);
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
        {resolved === "applied" ? (
          <Check className="size-4" />
        ) : (
          <Ban className="size-4" />
        )}
        {scholarship.title} — {resolved}
      </article>
    );
  }

  return (
    <article className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{scholarship.country}</Badge>
            <Badge variant="outline" className="font-normal">
              {scholarship.verification_status}
            </Badge>
          </div>
          <h2 className="text-base leading-snug font-semibold tracking-tight">
            {scholarship.title}
          </h2>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {extraction.model} · {formatDate(extraction.fetched_at)}
        </span>
      </header>

      {extraction.page_subject && (
        <p className="text-muted-foreground text-xs">
          Model read the site as: <em>{extraction.page_subject}</em>
        </p>
      )}

      <div className="divide-y border-y">
        <Change
          label="Cycle"
          from={scholarship.cycle_label}
          to={proposed.cycle_label}
          evidence={evidence.cycle_label}
        />
        <Change
          label="Opens"
          from={scholarship.opens_date}
          to={proposed.opens_date}
          evidence={evidence.opens_date}
        />
        <Change
          label="Closes"
          from={scholarship.deadline_date}
          to={proposed.deadline_date}
          evidence={evidence.deadline_date}
        />
      </div>

      {timeline.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            {timeline.length} timeline stage(s)
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {timeline.map((stage) => (
              <li key={stage.key} className="flex gap-2 text-xs">
                <span className="font-medium">{stage.label}</span>
                <span className="text-muted-foreground">
                  {stage.date ?? "date not published"}
                  {stage.note ? ` · ${stage.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Proposal label="coverage line(s)" items={coverage} />
      <Proposal label="eligibility field(s)" items={eligibility} />
      <Proposal label="document(s)" items={documents} />

      {proposed.post_study_obligations && (
        <p className="text-xs">
          <span className="text-muted-foreground">After study: </span>
          {proposed.post_study_obligations}
        </p>
      )}

      {extraction.ungrounded_fields.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-3.5" />
            Discarded by the grounding check
          </p>
          <ul className="mt-1 ml-5 list-disc">
            {extraction.ungrounded_fields.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </div>
      )}

      {extraction.caveats.length > 0 && (
        <div className="rounded-md border border-sky-300 bg-sky-50 p-2.5 text-xs text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-3.5" />
            Kept, but the page qualifies it — check before applying
          </p>
          <ul className="mt-1 ml-5 list-disc">
            {extraction.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}

      {extraction.model_notes && (
        <p className="text-muted-foreground bg-muted/60 rounded-md p-2.5 text-xs leading-relaxed">
          {extraction.model_notes}
        </p>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" onClick={handleApply} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Apply
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
            <a
              href={extraction.source_url}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <ExternalLink className="size-3.5" />
          Source page
        </Button>
      </footer>
    </article>
  );
}
