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

/**
 * Why the branch you are on cannot be opened as a pull request right now, or null when it can.
 * Checked in the order a person would fix them: the remote and sign-in first, then which branch
 * this is, then whether GitHub has it.
 */
export const findBranchPullRequestBlocker = ({ isGhReady, origin, branch, base, isBranchPushed }: { isGhReady: boolean; origin: string | null; branch: string | null; base: string; isBranchPushed: boolean }): string | null => {
  const blocker = findPullRequestBlocker({ isGhReady, origin });
  if (blocker) return blocker;
  if (!branch || branch === 'HEAD') return 'Desk cannot tell which branch this is. Check out a branch, then come back.';
  if (branch === base) return `You are on ${base}, the branch a pull request goes into. Check out your feature branch, then come back.`;
  if (!isBranchPushed) return `This branch is not on GitHub yet. Run git push -u origin ${branch} in a terminal, then come back.`;
  return null;
};

const PLAIN_BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * A branch name that is safe to hand to git and gh as one argument: letters, digits and . _ / -,
 * not starting with a dash, with none of the shapes git reads as something else (.., //, a trailing
 * slash or dot, or .lock).
 */
export const isPlainBranchName = ({ name }: { name: string }): boolean =>
  PLAIN_BRANCH_NAME.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock');
