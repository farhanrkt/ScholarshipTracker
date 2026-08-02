"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { FilterPanel } from "./filter-panel";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface FilterProps {
  countries: string[];
  resultCount: number;
}

/** Always-visible rail. Hidden below `lg`, where `FilterSheet` takes over. */
export function FilterRail({ countries, resultCount }: FilterProps) {
  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 pb-8">
        <FilterPanel countries={countries} resultCount={resultCount} />
      </div>
    </aside>
  );
}

/** The same panel, behind a trigger, for small screens. */
export function FilterSheet({
  countries,
  resultCount,
  activeCount,
}: FilterProps & { activeCount: number }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="outline" size="sm" className="lg:hidden" />}
      >
        <SlidersHorizontal className="size-4" />
        Filters
        {activeCount > 0 && (
          <span className="bg-primary text-primary-foreground ml-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold tabular-nums">
            {activeCount}
          </span>
        )}
      </SheetTrigger>

      <SheetContent side="left" className="w-[85vw] max-w-sm overflow-y-auto">
        <SheetHeader className="pb-0">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>
            Narrow the list down to what you can actually win.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-8">
          <FilterPanel countries={countries} resultCount={resultCount} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
