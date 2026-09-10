// What the latest published version is, asked the cheap way.
//
// **Over the `releases/latest` redirect rather than the API**, and the reason is
// the rate limit more than the latency: the API is 60 requests an hour *per IP*,
// so an office or a CI fleet behind one NAT shares one budget, and it answers
// with 60 kB of JSON to report a tag. The redirect costs no body and no budget —
// one request, redirects off, read `Location`, take the last segment.
//
// It is also not a new dependency on GitHub behaving this way: both install
// scripts already rest on `releases/latest/download/<asset>` resolving through
// the same redirect, so a day on which this stops working is a day the scripts
// are already broken.
//
// **One function with two callers**, deliberately: `upgrade` asks on demand and
// the in-`run` notice asks on a period, and two implementations of one question
// is how they come to disagree about what *latest* means.

import { versionFromLocation } from "./plan.ts";

/** Where releases are published. The install scripts name the same repository. */
export const RELEASE_REPO = "dguridi/mdbrain";

/** The address whose redirect carries the tag. */
export const latestUrl = (repo: string = RELEASE_REPO): string => `https://github.com/${repo}/releases/latest`;

/** Where one asset of one release is downloaded from. */
export const downloadUrl = (version: string, file: string, repo: string = RELEASE_REPO): string =>
  `https://github.com/${repo}/releases/download/v${version}/${file}`;

/**
 * The latest published version, or null when it could not be established.
 *
 * **Null covers every failure and says nothing about which**, because both
 * callers want the same thing from a failure and neither wants a reason: the
 * notice is silent about one by ruling, and `upgrade` reports *the check could
 * not be reached* rather than relaying a status code somebody would then have to
 * interpret.
 *
 * **`redirect: "manual"` is the whole of the saving and is asserted rather than
 * assumed.** A lookup that followed the redirect would still return the right
 * answer, while quietly costing the release page's body — so the flag is the
 * kind of thing that is silently removed by a tidy-up and has to be watched.
 *
 * **An abort is a failure like any other and answers null**, which is what lets
 * a caller that cannot afford to wait — the in-`run` notice, which must never be
 * the reason the process will not exit — cut the request off and get the same
 * silence it would get from an unreachable host. Without a signal the only bound
 * is `fetch`'s own, which is five minutes.
 *
 * @param fetchImpl injected so a test can drive it without a network
 * @param repo injected so a test never names the real repository
 * @param signal aborts the request; the answer is then null
 * @returns the version with no leading `v`, or null
 */
export async function latestVersion(
  fetchImpl: typeof fetch = fetch,
  repo: string = RELEASE_REPO,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchImpl(latestUrl(repo), { redirect: "manual", signal: signal ?? null });
    return versionFromLocation(response.headers.get("location"));
  } catch {
    return null;
  }
}
