"use client";

import { CircleAlert, ExternalLink, FileText, Globe2 } from "lucide-react";

import { CoverageGrid } from "./coverage-grid";
import { EligibilityList } from "./eligibility-list";
import {
  CommitmentBadges,
  VerificationBadge,
  WindowBadge,
} from "./scholarship-badges";
import { SourceNote } from "./source-note";
import { TimelineList } from "./timeline-list";
import { TrackButton } from "./track-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  describeVerification,
  displayCountry,
  recordList,
  safeText,
  textList,
} from "@/lib/format";
import type {
  ChecklistDocument,
  Scholarship,
  TimelineStage,
} from "@/lib/types/database";

interface ScholarshipDetailSheetProps {
  scholarship: Scholarship;
  tracked: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2.5 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}

export function ScholarshipDetailSheet({
  scholarship,
  tracked,
  open,
  onOpenChange,
}: ScholarshipDetailSheetProps) {
  // Both JSONB columns can hold a shape the type does not promise — a row
  // promoted from discovery starts with '[]' and a hand-seeded one may hold
  // '{}'. Guard at the boundary rather than trusting the column: `recordList`
  // also drops null elements, which an interrupted model response leaves behind
  // and which would throw on the first property access below.
  const documents = recordList<Partial<ChecklistDocument>>(
    scholarship.document_checklist,
  ).filter((doc) => safeText(doc.label) !== null);
  const timeline = recordList<TimelineStage>(scholarship.timeline);
  const requiredDocs = documents.filter((doc) => doc.required !== false);
  const verification = describeVerification(scholarship);
  const checkUrl = scholarship.source_url ?? scholarship.official_portal_url;

  const duration = safeText(scholarship.award_duration);
  const awardCount = safeText(scholarship.number_of_awards);
  const studyFields = textList(scholarship.fields_of_study);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
      >
        <SheetHeader className="bg-background/95 sticky top-0 z-10 border-b backdrop-blur">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="gap-1">
              <Globe2 className="size-3" />
              {displayCountry(scholarship.country)}
            </Badge>
            {textList(scholarship.degree_levels).map((level) => (
              <Badge key={level} variant="outline">
                {level}
              </Badge>
            ))}
            {scholarship.cycle_label && (
              <Badge variant="outline">{scholarship.cycle_label}</Badge>
            )}
          </div>

          <SheetTitle className="text-xl leading-tight">
            {scholarship.title}
          </SheetTitle>

          <SheetDescription className="sr-only">
            Coverage, eligibility and document requirements for{" "}
            {scholarship.title}.
          </SheetDescription>

          <div className="flex flex-wrap items-center gap-1.5">
            <WindowBadge scholarship={scholarship} />
            <VerificationBadge scholarship={scholarship} />
            <CommitmentBadges scholarship={scholarship} />
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-4 sm:p-6">
          {/* Provenance -------------------------------------------------- */}
          {verification.state !== "verified" && (
            <p
              className={
                "flex gap-2.5 rounded-md border p-3 text-xs leading-relaxed " +
                (verification.state === "stale"
                  ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                  : verification.state === "ai_extracted"
                    ? "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100"
                    : "text-muted-foreground border-dashed")
              }
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {verification.detail}
            </p>
          )}

          {/* Timeline ---------------------------------------------------- */}
          {timeline.length > 0 && (
            <section>
              <SectionHeading>
                Application timeline
                {scholarship.cycle_label ? ` · ${scholarship.cycle_label}` : ""}
              </SectionHeading>
              <TimelineList timeline={timeline} />
              {/* Provenance for the dates, where it is read rather than
                  buried in a column. Renders nothing in the ordinary case:
                  the funder said it and nobody disagreed. */}
              <SourceNote sources={scholarship.field_sources} field="deadline_date" />
              <SourceNote sources={scholarship.field_sources} field="opens_date" />
            </section>
          )}

          {/* Scope ------------------------------------------------------- */}
          {(duration || awardCount || studyFields.length > 0) && (
            <section>
              <SectionHeading>Scope of the award</SectionHeading>
              <dl className="divide-y">
                {duration && (
                  <div className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">Funded for</dt>
                    <dd>{duration}</dd>
                  </div>
                )}
                {awardCount && (
                  <div className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">Awards offered</dt>
                    <dd>{awardCount}</dd>
                  </div>
                )}
                {studyFields.length > 0 && (
                  <div className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">Subjects</dt>
                    {/* Only ever a restriction — an empty column means open to
                        any subject, so this row simply does not appear. */}
                    <dd className="font-medium">
                      Restricted to {studyFields.join(", ")}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {/* Coverage ---------------------------------------------------- */}
          <section>
            <SectionHeading>What the award covers</SectionHeading>
            <CoverageGrid matrix={scholarship.coverage_matrix} />
          </section>

          <Separator />

          {/* Eligibility ------------------------------------------------- */}
          <section>
            <SectionHeading>Eligibility</SectionHeading>
            <EligibilityList flags={scholarship.eligibility_flags} />
          </section>

          <Separator />

          {/* Documents --------------------------------------------------- */}
          <section>
            <SectionHeading>
              Documents ({requiredDocs.length} required of {documents.length})
            </SectionHeading>
            <ul className="flex flex-col gap-1.5">
              {documents.map((doc, index) => (
                <li
                  key={`${safeText(doc.key) ?? "doc"}-${index}`}
                  className="flex items-start gap-2.5 text-sm"
                >
                  <FileText className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {safeText(doc.label)}
                    {doc.required === false && (
                      <span className="text-muted-foreground"> · optional</span>
                    )}
                    {safeText(doc.notes) && (
                      <span className="text-muted-foreground block text-xs">
                        {safeText(doc.notes)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-xs">
              {documents.length === 0
                ? "No document list has been read off the official pages yet — check the portal."
                : "Track this scholarship to turn the list into a checklist you can tick off."}
            </p>
          </section>

          {/* Obligations ------------------------------------------------- */}
          {safeText(scholarship.post_study_obligations) && (
            <>
              <Separator />
              <section>
                <SectionHeading>After you graduate</SectionHeading>
                <p className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-relaxed text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {safeText(scholarship.post_study_obligations)}
                </p>
              </section>
            </>
          )}
        </div>

        {/* Sticky action bar --------------------------------------------- */}
        <div className="bg-background/95 sticky bottom-0 mt-auto flex flex-col gap-2 border-t p-4 backdrop-blur sm:px-6">
          <TrackButton
            scholarshipId={scholarship.id}
            tracked={tracked}
            fullWidth
          />
          <Button
            variant="outline"
            className="w-full"
            nativeButton={false}
            render={
              <a href={checkUrl} target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLink className="size-4" />
            {scholarship.source_url ? "Official timeline page" : "Official portal"}
          </Button>
          <p className="text-muted-foreground text-center text-[11px]">
            {verification.state === "verified"
              ? `${verification.label} against the official page · always confirm before you apply`
              : "Dates and details are not confirmed — check the official page before you apply"}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
