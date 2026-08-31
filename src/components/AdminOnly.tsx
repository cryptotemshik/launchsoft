import type { ReactNode } from "react";
import { useMe } from "../lib/runnerClient";

/**
 * Render children only for the operator/admin.
 *
 * A wrapper rather than a per-tab check so the many operator-only panels — the
 * RPC editor, the connection box, the "server needs updating" notice — can be
 * hidden from a normal visitor by wrapping, without threading an admin flag
 * through every component. It hides while the answer is still unknown, so a
 * visitor never sees a flash of operator plumbing on a slow /me.
 */
export default function AdminOnly({ children }: { children: ReactNode }) {
  const { me } = useMe();
  if (!me?.admin) return null;
  return <>{children}</>;
}
