/**
 * What Desk shows about a repo's pull requests and issues, in the shape the page uses.
 * GitHub's own JSON is read once, in lib/github-data.ts, and turned into these types. Everything
 * below the page works with plain values: no raw gh output, and no markup from a pull request.
 *
 * @author Patrick Finazzo
 */

export type CheckState = 'none' | 'pending' | 'passing' | 'failing';

/** The checks on a pull request's latest commit, counted. Skipped checks are left out. */
export type CheckSummary = {
  state: CheckState;
  passing: number;
  failing: number;
  pending: number;
  failingNames: readonly string[];
};

export type ReviewState = 'approved' | 'changes-requested' | 'review-required' | 'none';

export type MergeState = 'clean' | 'conflicting' | 'unknown';

export type LinkedIssue = { number: number; title: string; url: string };

export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  author: string;
  isBot: boolean;
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** The branch comes from a fork, so Desk would fetch it from the pull request itself. */
  isFromFork: boolean;
  createdAtIso: string;
  updatedAtIso: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: readonly string[];
  review: ReviewState;
  checks: CheckSummary;
  merge: MergeState;
  linkedIssues: readonly LinkedIssue[];
  /** The signed-in person wrote it. */
  isMine: boolean;
  /** GitHub is waiting on the signed-in person, by name, for a review. */
  isReviewRequested: boolean;
};

export type ChangedFile = { path: string; additions: number; deletions: number };

export type ReviewLine = { author: string; state: string };

export type PullRequestDetail = PullRequestSummary & {
  /** Written by the author: shown as plain text and never as markup. */
  body: string;
  files: readonly ChangedFile[];
  reviews: readonly ReviewLine[];
  commitCount: number;
  commentCount: number;
  /** The branch ships its own claims file, so claimcheck can grade it as written. */
  carriesClaims: boolean;
};

export type IssueSummary = {
  number: number;
  title: string;
  url: string;
  author: string;
  isOpen: boolean;
  labels: readonly string[];
  assignees: readonly string[];
  commentCount: number;
  createdAtIso: string;
  updatedAtIso: string;
  /** The signed-in person wrote it or is assigned to it. */
  isMine: boolean;
};

export type IssueDetail = IssueSummary & {
  /** Written by the author: shown as plain text and never as markup. */
  body: string;
};

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** The longest goal the spec wizard keeps. */
const GOAL_LIMIT = 8000;

/**
 * What an issue becomes in the spec wizard's goal box: its title, then its description with the
 * template comments taken out. The person reads and edits it before anything is sent to Claude.
 */
export const buildSpecGoal = ({ issue }: { issue: { number: number; title: string; body: string } }): string => {
  const body = issue.body.replace(HTML_COMMENT, '').trim();
  return `${issue.title.trim()} (issue #${issue.number})${body ? `\n\n${body}` : ''}`.slice(0, GOAL_LIMIT);
};

/** What the page knows about one GitHub list: not asked for, on its way, here, or failed with a sentence to show. */
export type GithubLoad<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; items: readonly T[]; viewer: string }
  | { state: 'failed'; message: string };

/** Which side's .claimcheck/config.toml a pull request check uses. */
export type PullRequestConfigSource = 'base' | 'pull-request';

/** A pull request being graded in a folder of its own, as the page needs to describe it. */
export type PullRequestCheck = {
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** What the diff is measured against, as git names it: origin/main. */
  baseRef: string;
  /** The repo the person opened, which Back returns to. */
  originPath: string;
  configSource: PullRequestConfigSource;
};

/** What is about to be posted on a pull request: shown first, and posted only when the person says so. */
export type PullRequestSummaryPreview = { number: number; url: string; body: string };
