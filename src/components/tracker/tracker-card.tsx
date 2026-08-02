"use client";

import { useOptimistic, useTransition } from "react";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { toggleChecklistItem, untrackScholarship, updateTargetStatus } from "@/app/actions/targets";
import {
  CommitmentBadges,
  VerificationBadge,
  WindowBadge,
} from "@/components/scholarship/scholarship-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { summariseChecklist } from "@/lib/format";
import {
  TARGET_STATUSES,
  TARGET_STATUS_LABELS,
  type ChecklistProgress,
  type TargetStatus,
  type UserTargetWithScholarship,
} from "@/lib/types/database";
import { cn } from "@/lib/utils";

interface OptimisticState {
  progress: ChecklistProgress;
  status: TargetStatus;
}

type OptimisticAction =
  | { type: "toggle"; key: string; checked: boolean }
  | { type: "status"; status: TargetStatus };

function reduce(state: OptimisticState, action: OptimisticAction): OptimisticState {
  switch (action.type) {
    case "toggle":
      return {
        ...state,
        progress: { ...state.progress, [action.key]: action.checked },
      };
    case "status":
      return { ...state, status: action.status };
  }
}

export function TrackerCard({ target }: { target: UserTargetWithScholarship }) {
  const { scholarship } = target;
  const [pending, startTransition] = useTransition();

  const [optimistic, dispatch] = useOptimistic<OptimisticState, OptimisticAction>(
    { progress: target.checklist_progress ?? {}, status: target.status },
    reduce,
  );

  // A row promoted from discovery has an empty checklist until an extraction
  // fills one in, and a hand-seeded row can hold '{}' — neither may crash the
  // page the user keeps their own progress on.
  const documents = Array.isArray(scholarship.document_checklist)
    ? scholarship.document_checklist
    : [];
  const stats = summariseChecklist(documents, optimistic.progress);

  function handleToggle(key: string, checked: boolean) {
    startTransition(async () => {
      dispatch({ type: "toggle", key, checked });

      const result = await toggleChecklistItem(target.id, key, checked);
      if (!result.success) {
        toast.error("Could not save that tick", { description: result.error });
      }
    });
  }

  function handleStatus(status: TargetStatus | null) {
    if (!status) return;

    startTransition(async () => {
      dispatch({ type: "status", status });

      const result = await updateTargetStatus(target.id, status);
      if (!result.success) {
        toast.error("Could not update the status", { description: result.error });
      }
    });
  }

  function handleUntrack() {
    startTransition(async () => {
      const result = await untrackScholarship(scholarship.id);
      if (!result.success) {
        toast.error("Could not remove it", { description: result.error });
        return;
      }
      toast.success("Removed from your tracker");
    });
  }

  return (
    <article className="bg-card flex flex-col gap-4 rounded-xl border p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{scholarship.country}</Badge>
            {scholarship.degree_levels.map((level) => (
              <Badge key={level} variant="outline" className="font-normal">
                {level}
              </Badge>
            ))}
          </div>
          <h2 className="text-base leading-snug font-semibold tracking-tight">
            {scholarship.title}
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {pending && (
            <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
          )}
          <Select value={optimistic.status} onValueChange={handleStatus}>
            <SelectTrigger size="sm" className="w-36">
              <SelectValue>
                {(value: TargetStatus | null) =>
                  value ? TARGET_STATUS_LABELS[value] : "Status"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TARGET_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {TARGET_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <WindowBadge scholarship={scholarship} />
        <VerificationBadge scholarship={scholarship} />
        <CommitmentBadges scholarship={scholarship} />
      </div>

      {/* Progress ------------------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            {stats.requiredCompleted} of {stats.requiredTotal} required documents
            ready
          </span>
          <span className="font-medium tabular-nums">{stats.percent}%</span>
        </div>
        <Progress value={stats.percent} className="h-1.5" />
      </div>

      {/* Interactive checklist ------------------------------------------ */}
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {documents.map((doc) => {
          const checked = Boolean(optimistic.progress[doc.key]);
          const id = `${target.id}-${doc.key}`;

          return (
            <li key={doc.key} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(value) => handleToggle(doc.key, value === true)}
                className="mt-0.5"
              />
              <Label
                htmlFor={id}
                className={cn(
                  "text-sm leading-snug font-normal",
                  checked && "text-muted-foreground line-through",
                )}
              >
                {doc.label}
                {!doc.required && (
                  <span className="text-muted-foreground text-xs"> · optional</span>
                )}
              </Label>
            </li>
          );
        })}
      </ul>

      <footer className="flex items-center gap-2 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
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
          Official portal
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive ml-auto"
          onClick={handleUntrack}
          disabled={pending}
        >
          <Trash2 className="size-3.5" />
          Remove
        </Button>
      </footer>
    </article>
  );
}
