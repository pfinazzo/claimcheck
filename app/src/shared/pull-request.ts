/**
 * Why this file exists: "Open pull request" must be offered only when it can work, and the page
 * and the main process must agree on when that is. Both call this one function, so a button never
 * promises something the server will then refuse.
 *
 * @author Patrick Finazzo
 */

/**
 * Why a pull request cannot be opened right now, in words for the person, or null when it can.
 * `origin` is the URL of the repo's `origin` remote, or null when the repo has none.
 */
export const findPullRequestBlocker = ({ isGhReady, origin }: { isGhReady: boolean; origin: string | null }): string | null => {
  if (!origin) return 'This repo has no GitHub remote yet. Add one with git remote add origin <url> and push, then come back.';
  if (!isGhReady) return 'The GitHub CLI is not signed in. Run gh auth login in a terminal, then come back.';
  return null;
};
