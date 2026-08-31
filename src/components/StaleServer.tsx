/**
 * The one message that explains a whole class of confusing failures: the page
 * has been updated but the box it talks to has not, so requests it sends are
 * shapes the old server never learned to parse. Shown in every panel that
 * talks to the server, because the failure surfaces wherever the user happens
 * to be — most often on a delete, which changed shape to support bulk removal.
 */
import { API_VERSION, UPDATE_HINT } from "../lib/apiVersion";
import { useMe } from "../lib/runnerClient";

export default function StaleServer({ version }: { version: number | null }) {
  // "Update the server over SSH" is operator advice; a normal visitor has no
  // server to update, so this is theirs alone.
  const { me } = useMe();
  if (!me?.admin) return null;
  if (version === null || version >= API_VERSION) return null;
  return (
    <p className="warn" style={{ marginBottom: 0 }}>
      <b>Your server is running older code than this page.</b> Buttons here send
      requests it can&apos;t parse, which show up as odd errors like{" "}
      <i>&quot;address must be a 0x address&quot;</i>. Update it over SSH, then
      press refresh:
      <br />
      <code>{UPDATE_HINT}</code>
    </p>
  );
}
