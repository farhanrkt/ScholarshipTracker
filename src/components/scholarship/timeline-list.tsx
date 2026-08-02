import { formatDate } from "@/lib/format";
import type { Timeline } from "@/lib/types/database";

/**
 * Renders the published stages of an application cycle. A stage with a null
 * date is shown as "date not published" rather than hidden — knowing a stage
 * exists is useful even before its date is announced.
 */
export function TimelineList({
  timeline,
}: {
  timeline: Timeline | null | undefined;
}) {
  const stages = Array.isArray(timeline) ? timeline : [];
  if (stages.length === 0) return null;

  return (
    <ol className="border-border relative ml-1.5 border-l pl-5">
      {stages.map((stage) => (
        <li key={stage.key} className="relative pb-4 last:pb-0">
          <span
            className={
              "absolute top-1.5 -left-[1.4rem] size-2 rounded-full ring-2 ring-background " +
              (stage.date ? "bg-foreground" : "bg-muted-foreground/40")
            }
          />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{stage.label}</span>
            <span className="text-muted-foreground text-xs">
              {stage.date ? formatDate(stage.date) : "date not published"}
            </span>
          </div>
          {stage.note && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
              {stage.note}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
