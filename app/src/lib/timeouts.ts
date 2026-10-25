/**
 * Why this file exists: every program Desk starts gets a time limit, so a stuck one can't freeze
 * the app. The limits live here so they are set in one place.
 *
 * If git waits on a credential prompt or a stalled network drive: the call fails after the limit.
 * If gh or the Anthropic API stop answering: the same happens, and the person sees an error.
 *
 * @author Patrick Finazzo
 */

/** Local git commands answer in well under a second; two minutes covers a very large repo. */
export const GIT_TIMEOUT_MS = 120_000;

/** gh talks to GitHub over the network. A pull request is opened in seconds. */
export const GH_TIMEOUT_MS = 60_000;

/** `which` and `where` only search PATH. */
export const FINDER_TIMEOUT_MS = 10_000;

/** One Anthropic API request. The SDK's own default is ten minutes per attempt. */
export const API_TIMEOUT_MS = 300_000;
