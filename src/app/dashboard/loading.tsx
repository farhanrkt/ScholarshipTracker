import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <Skeleton className="mb-6 h-9 w-72" />

      <div className="flex gap-8">
        <div className="hidden w-64 shrink-0 flex-col gap-3 lg:flex">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>

        <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-52 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
