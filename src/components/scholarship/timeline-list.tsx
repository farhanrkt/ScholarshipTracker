import { formatDate, recordList, safeText } from "@/lib/format";
import type { Timeline, TimelineStage } from "@/lib/types/database";

/** A stage is worth a row only if it has something to call itself. */
function isRenderable(stage: Partial<TimelineStage>): boolean {
  return safeText(stage.label) !== null;
}

/** A date only renders when it is actually an ISO date we can format. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Renders the published stages of an application cycle. A stage with a null
 * date is shown as "date not published" rather than hidden — knowing a stage
 * exists is useful even before its date is announced.
 *
 * Every field is treated as untrusted: this array is written by a model, and a
 * truncated response can leave a null element or a stage with no label in it.
 * See the guards in `@/lib/format`.
 */
export function TimelineList({
  timeline,
}: {
  timeline: Timeline | null | undefined;
}) {
  const stages = recordList<Partial<TimelineStage>>(timeline).filter(isRenderable);
  if (stages.length === 0) return null;

  return (
    <ol className="border-border relative ml-1.5 border-l pl-5">
      {stages.map((stage, index) => {
        const date = safeText(stage.date);
        const dated = date !== null && ISO_DATE.test(date);
        const note = safeText(stage.note);

        return (
          <li
            // The key may be missing or duplicated; the index disambiguates it
            // without letting two stages collapse into one row.
            key={`${safeText(stage.key) ?? "stage"}-${index}`}
            className="relative pb-4 last:pb-0"
          >
            <span
              className={
                "absolute top-1.5 -left-[1.4rem] size-2 rounded-full ring-2 ring-background " +
                (dated ? "bg-foreground" : "bg-muted-foreground/40")
              }
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{safeText(stage.label)}</span>
              <span className="text-muted-foreground text-xs">
                {dated ? formatDate(date) : "date not published"}
              </span>
            </div>
            {note && (
              <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
                {note}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
