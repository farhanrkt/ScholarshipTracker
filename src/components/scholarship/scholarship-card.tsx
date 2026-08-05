"use client";

import { useState } from "react";
import { BookmarkCheck, Check, CircleHelp, Minus, X } from "lucide-react";

import { ScholarshipDetailSheet } from "./scholarship-detail-sheet";
import {
  CommitmentBadges,
  VerificationBadge,
  WindowBadge,
} from "./scholarship-badges";
import { Badge } from "@/components/ui/badge";
import { displayCountry, hasProfileData, textList } from "@/lib/format";
import { COVERAGE_LABELS, type Scholarship } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** The three coverage lines students screen on first. */
const HEADLINE_COVERAGE = ["tuition", "monthly_stipend", "airfare"] as const;

interface ScholarshipCardProps {
  scholarship: Scholarship;
  tracked: boolean;
}

export function ScholarshipCard({ scholarship, tracked }: ScholarshipCardProps) {
  const [open, setOpen] = useState(false);

  // Always the same three lines, in the same order, whatever the row knows.
  // Filtering to just the covered ones made every card a different shape and,
  // worse, made "we have never read this programme's funding" look identical to
  // "this programme funds nothing".
  const coverage = HEADLINE_COVERAGE.map((key) => ({
    key,
    item: scholarship.coverage_matrix?.[key],
  }));
  const coverageKnown = coverage.some(({ item }) => item !== undefined);

  return (
    <>
      {/*
        A real <button>, not a div wearing `role="button"`.

        The old markup hand-rolled Enter and Space, and still did not announce
        itself as anything: an `<article role="button">` gives a screen reader a
        control with no accessible name beyond whatever text it happens to
        contain — which here is a country, three coverage lines and four badges,
        read out in full before you learn it opens a dialog. The button carries
        the name; the heading inside it stays a heading, so the page still has an
        outline you can navigate by.
      */}
      <article className="bg-card focus-within:ring-ring group relative flex flex-col gap-3 rounded-xl border p-4 transition-[box-shadow,transform] hover:shadow-md focus-within:ring-2 motion-safe:active:scale-[0.995]">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`${scholarship.title} — ${displayCountry(scholarship.country)}. Open details.`}
          onClick={() => setOpen(true)}
          // Stretched over the whole card, so the hit area is the card while the
          // control stays a single stop in the tab order. Nothing else here is
          // interactive — the badges are text — so covering them costs nothing.
          className="absolute inset-0 z-10 cursor-pointer rounded-xl focus:outline-none"
        />

        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{displayCountry(scholarship.country)}</Badge>
            {textList(scholarship.degree_levels).map((level) => (
              <Badge key={level} variant="outline" className="font-normal">
                {level}
              </Badge>
            ))}
          </div>

          {tracked && (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
              <BookmarkCheck className="size-3.5" />
              Tracking
            </span>
          )}
        </div>

        <h3 className="group-hover:text-primary text-base leading-snug font-semibold tracking-tight transition-colors">
          {scholarship.title}
        </h3>

        {coverageKnown ? (
          <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {coverage.map(({ key, item }) => (
              <li
                key={key}
                className={cn("flex items-center gap-1", !item && "opacity-60")}
              >
                {item?.covered ? (
                  <Check
                    className="size-3 text-emerald-600 dark:text-emerald-400"
                    strokeWidth={3}
                  />
                ) : item ? (
                  <X className="size-3 text-rose-500 dark:text-rose-400" strokeWidth={3} />
                ) : (
                  <Minus className="size-3" />
                )}
                {COVERAGE_LABELS[key]}
              </li>
            ))}
          </ul>
        ) : (
          // Two different silences. "Nobody has looked" is a gap in our data;
          // "we looked and the pages do not say" is a fact about the funder,
          // and a student deciding where to apply needs to tell them apart.
          <p className="text-muted-foreground flex items-center gap-1 text-xs italic">
            <CircleHelp className="size-3" />
            {hasProfileData(scholarship)
              ? "Funding not itemised by the programme"
              : "Funding details not read yet"}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <WindowBadge scholarship={scholarship} />
          <VerificationBadge scholarship={scholarship} />
          <CommitmentBadges scholarship={scholarship} />
        </div>
      </article>

      <ScholarshipDetailSheet
        scholarship={scholarship}
        tracked={tracked}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
