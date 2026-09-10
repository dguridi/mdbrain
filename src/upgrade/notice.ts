// The in-`run` version notice, as a decision: when to look, and what there is to
// say once the lookup has answered.
//
// Its own module rather than more of `plan.ts`, because the two answer different
// questions about the same subject. `plan.ts` is what `upgrade` does when
// somebody types it — a command with a person waiting on it. This is what a
// long-lived `run` says without being asked, and the whole of its difficulty is
// in the two things that are *not* the lookup: the period, and the silence.
//
// Pure. The clock is the caller's, and so is the network — `latestVersion` is
// handed in an answer rather than asked for one here, which is what lets a
// runner that has been up for a day be tested in a millisecond.

import { howToUpgrade, type Channel } from "./plan.ts";

/**
 * How long between version checks: six hours.
 *
 * **A period rather than a startup-only check, and a long one rather than a
 * short one.** A runner is left up for days, so a check that only ran at startup
 * would say nothing during the window a person is actually in — which is nearly
 * all of it. But the fact being reported changes at most a few times a week and
 * the notice is persistent once shown, so a shorter period buys requests rather
 * than information: the second check to find the same tag has told nobody
 * anything. Six hours is *within a working day of a release landing*, which is
 * the useful granularity for a thing whose remedy is a command somebody types
 * when it suits them.
 *
 * **There is no jitter, and that is a decision rather than an omission.** A fixed
 * period means every runner in a fleet behind one NAT wakes on its own schedule
 * and they can align. It is not acted on because there is no fleet; the trigger
 * to re-open it is a fleet existing, or the redirect ceasing to be free.
 */
export const VERSION_CHECK_PERIOD_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a version check is due.
 *
 * **A null `lastCheckedAt` is due**, which is what makes the first check happen
 * at startup without a second code path asking for one.
 *
 * @param lastCheckedAt when a check was last *started*, or null if none has been
 * @param now the moment being asked about, in epoch milliseconds
 */
export function versionCheckDue(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= VERSION_CHECK_PERIOD_MS;
}

/**
 * How long the notice's lookup is given before it is abandoned.
 *
 * **A bound is needed because `fetch`'s own is five minutes**, and this request
 * is made by a process that must be able to exit promptly: a host that accepts a
 * connection and never answers would otherwise keep a handle open long after the
 * command returned, so a person who pressed Ctrl-C would sit looking at a prompt
 * that has not come back. Ten seconds is generous for a redirect that measures at
 * about a third of one, and an abort is silent for the same reason every other
 * failure is.
 */
export const VERSION_CHECK_TIMEOUT_MS = 10_000;

/** What a version notice says, once there is something to say. */
export interface VersionNotice {
  /** The version that is published, with no leading `v`. */
  version: string;
  /** How to get it — this command, or the packager that owns the install. */
  how: string;
}

/**
 * The sentence both presenters say, composed in one place.
 *
 * Neither presenter is allowed to word this for itself: a line in a log file and
 * a line on a screen that describe the same fact differently are two accounts of
 * it, and the whole point of the shared event vocabulary is that there is one.
 */
export function versionNoticeText(notice: VersionNotice): string {
  return `mdbrain ${notice.version} is available. ${notice.how}`;
}

/**
 * What to say about a lookup's answer, or null when there is nothing to say.
 *
 * **Null is the answer in two quite different cases, and collapsing them is
 * deliberate.** A lookup that failed answers `null` and is silent by ruling: a
 * failure does not know whether a new version exists, so the honest content of
 * one is *I could not tell*, which is not actionable and would compete for room
 * on a screen whose scarcity this notice's design is entirely about. A runner
 * behind a proxy that blocks GitHub would otherwise carry a permanent complaint
 * about a check nobody asked for. **The accepted cost, written out so nobody
 * later reads it as an oversight:** a lookup broken since the first release is
 * indistinguishable from a project that has not released, and on such a machine
 * the notice silently does not exist.
 *
 * The other case is a lookup that succeeded and found this very version, which
 * has nothing to report for the ordinary reason.
 *
 * **Nothing here writes anywhere, and that includes the run log.** A log line for
 * a failed lookup was offered, argued for a second time, and declined. It is the
 * thing that looks like a free improvement to somebody who is already in this
 * file. It is not one.
 *
 * A notice is produced for **any** channel, because the fact that a new version
 * exists is true however the binary arrived; only `how` differs, and
 * `howToUpgrade` is what knows the difference. A person on a packaged install
 * still wants to be told, and is told their own packager's command.
 *
 * @param current this binary's own `VERSION`
 * @param latest what the lookup answered, or null if it could not establish one
 * @param channel how this binary arrived
 * @param isCompiled whether there is an installed binary at all
 */
export function versionNoticeFor(
  current: string,
  latest: string | null,
  channel: Channel,
  isCompiled: boolean,
): VersionNotice | null {
  if (latest === null) return null;
  if (latest === current) return null;
  return { version: latest, how: howToUpgrade(channel, isCompiled) };
}
