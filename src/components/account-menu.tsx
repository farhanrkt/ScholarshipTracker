import Link from "next/link";
import { LogIn } from "lucide-react";

import { signOut } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { currentAccount } from "@/lib/supabase/account";

/**
 * Ghost accounts get a sign-in link (for people returning on a new device);
 * linked accounts get their address and a way out.
 *
 * Sign-out is deliberately not offered to anonymous users — their tracker is
 * only reachable through that session, so signing out would destroy it with no
 * way back.
 */
export async function AccountMenu() {
  const { email, signedIn } = await currentAccount();

  if (!signedIn || !email) {
    return (
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={<Link href="/auth/sign-in" />}
        className="ml-auto"
      >
        <LogIn className="size-3.5" />
        Sign in
      </Button>
    );
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-muted-foreground hidden max-w-40 truncate text-xs sm:inline">
        {email}
      </span>
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm">
          Sign out
        </Button>
      </form>
    </div>
  );
}
