/**
 * Thin wrapper over the browser Notifications API.
 *
 * Honest limits: a static site can only raise a notification while this tab is
 * open and the API is permitted. There is no closed-tab / background push here
 * — that needs a server and Web Push (a Service Worker with a VAPID key and a
 * subscription store), which this keyless app deliberately doesn't run.
 */

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function notifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notifyPermission(): NotifyPermission {
  if (!notifySupported()) return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return notifyPermission();
  }
}

/** Fire one notification if permitted; a no-op otherwise. */
export function notify(title: string, body: string, tag?: string): void {
  if (!notifySupported() || Notification.permission !== "granted") return;
  try {
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag, icon: "/favicon.svg" });
  } catch {
    // Some browsers throw if constructed outside a user gesture — ignore.
  }
}
