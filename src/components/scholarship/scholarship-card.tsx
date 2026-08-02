"use client";

import { useState } from "react";
import { BookmarkCheck, Check } from "lucide-react";

import { ScholarshipDetailSheet } from "./scholarship-detail-sheet";
import {
  CommitmentBadges,
  VerificationBadge,
  WindowBadge,
} from "./scholarship-badges";
import { Badge } from "@/components/ui/badge";
import { COVERAGE_LABELS, type Scholarship } from "@/lib/types/database";

/** The three coverage lines students screen on first. */
const HEADLINE_COVERAGE = ["tuition", "monthly_stipend", "airfare"] as const;

interface ScholarshipCardProps {
  scholarship: Scholarship;
  tracked: boolean;
}

export function ScholarshipCard({ scholarship, tracked }: ScholarshipCardProps) {
  const [open, setOpen] = useState(false);

  const covered = HEADLINE_COVERAGE.filter(
    (key) => scholarship.coverage_matrix?.[key]?.covered,
  );

  return (
    <>
      <article
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="bg-card focus-visible:ring-ring group flex cursor-pointer flex-col gap-3 rounded-xl border p-4 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{scholarship.country}</Badge>
            {scholarship.degree_levels.map((level) => (
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

        <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {covered.map((key) => (
            <li key={key} className="flex items-center gap-1">
              <Check className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
              {COVERAGE_LABELS[key]}
            </li>
          ))}
        </ul>

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
