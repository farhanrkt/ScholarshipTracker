"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";

/**
 * The thing that actually puts `.dark` on the document.
 *
 * `attribute="class"` because `globals.css` defines the dark palette under a
 * `.dark` selector — `@custom-variant dark (&:is(.dark *))` — so a data
 * attribute would leave every `dark:` variant in the app inert, which is the
 * state this codebase was already in before the provider existed at all.
 *
 * `disableTransitionOnChange` stops every colour transition on the page from
 * firing at once when the theme flips, which reads as a flash rather than a
 * change.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
