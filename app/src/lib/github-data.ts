/**
 * Reads a repo's pull requests and issues through the GitHub CLI, and turns what it prints into
 * the plain shapes in shared/github.ts.
 *
 * Why every field is checked: the JSON comes from GitHub, and the words in it come from strangers.
 * A title, a branch name or a label can hold anything. Each value is read as the type it should be,
 * or replaced by an empty one, so a strange pull request cannot crash the page or smuggle in markup.
 *
 * @author Patrick Finazzo
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangedFile, CheckState, CheckSummary, IssueDetail, IssueSummary, LinkedIssue, MergeState, PullRequestDetail, PullRequestSummary, ReviewLine, ReviewState } from '../shared/github.ts';
import { parseJsonOrUndefined } from '../shared/json.ts';
import { toPlainMessage } from './plain-error.ts';
import { GH_TIMEOUT_MS } from './timeouts.ts';

const runExecFile = promisify(execFile);

export type GhExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

/** The longest list Desk asks for. A team with more open than this sees the newest ones. */
export const LIST_LIMIT = 100;

const GH_BUFFER_BYTES = 32 * 1024 * 1024;

const CLAIMS_FILE = '.claimcheck/claims.yaml';

// ---- reading unknown JSON -----------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

const toRecord = ({ value }: { value: unknown }): JsonRecord => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {});

const toList = ({ value }: { value: unknown }): readonly unknown[] => (Array.isArray(value) ? (value as readonly unknown[]) : []);

const readText = ({ value }: { value: unknown }): string => (typeof value === 'string' ? value : '');

const readCount = ({ value }: { value: unknown }): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

const readLogin = ({ value }: { value: unknown }): string => readText({ value: toRecord({ value }).login });

const readLabels = ({ value }: { value: unknown }): readonly string[] => toList({ value }).map((label) => readText({ value: toRecord({ value: label }).name })).filter(Boolean);

const readLinkedIssues = ({ value }: { value: unknown }): readonly LinkedIssue[] =>
  toList({ value }).flatMap((entry) => {
    const record = toRecord({ value: entry });
    const number = readCount({ value: record.number });
    return number > 0 ? [{ number, title: readText({ value: record.title }), url: readText({ value: record.url }) }] : [];
  });

// ---- checks --------------------------------------------------------------------------------------------------------------

type CheckOutcome = 'passing' | 'failing' | 'pending' | 'skipped';

const CHECK_RUN_CONCLUSIONS = new Map<string, CheckOutcome>([
  ['SUCCESS', 'passing'],
  ['NEUTRAL', 'passing'],
  ['SKIPPED', 'skipped'],
  ['FAILURE', 'failing'],
  ['TIMED_OUT', 'failing'],
  ['CANCELLED', 'failing'],
  ['ACTION_REQUIRED', 'failing'],
  ['STARTUP_FAILURE', 'failing'],
]);

const STATUS_CONTEXT_STATES = new Map<string, CheckOutcome>([
  ['SUCCESS', 'passing'],
  ['FAILURE', 'failing'],
  ['ERROR', 'failing'],
  ['PENDING', 'pending'],
  ['EXPECTED', 'pending'],
]);

type CheckLine = { name: string; outcome: CheckOutcome; startedAtIso: string };

const toCheckLine = ({ entry }: { entry: unknown }): CheckLine => {
  const record = toRecord({ value: entry });
  const isStatusContext = readText({ value: record.__typename }) === 'StatusContext';
  const name = isStatusContext ? readText({ value: record.context }) : [readText({ value: record.workflowName }), readText({ value: record.name })].filter(Boolean).join(' / ');
  const startedAtIso = readText({ value: record.startedAt });
  if (isStatusContext) return { name, outcome: STATUS_CONTEXT_STATES.get(readText({ value: record.state })) ?? 'pending', startedAtIso };
  const isFinished = readText({ value: record.status }) === 'COMPLETED';
  return { name, outcome: isFinished ? (CHECK_RUN_CONCLUSIONS.get(readText({ value: record.conclusion })) ?? 'pending') : 'pending', startedAtIso };
};

/** A check that ran again under the same name is counted once, as its newest run. */
const keepNewestPerName = ({ lines }: { lines: readonly CheckLine[] }): readonly CheckLine[] => [
  ...lines
    .reduce((newest, line) => {
      const earlier = newest.get(line.name);
      return earlier && earlier.startedAtIso > line.startedAtIso ? newest : new Map(newest).set(line.name, line);
    }, new Map<string, CheckLine>())
    .values(),
];

const toCheckState = ({ failing, pending, passing }: { failing: number; pending: number; passing: number }): CheckState => {
  if (failing > 0) return 'failing';
  if (pending > 0) return 'pending';
  return passing > 0 ? 'passing' : 'none';
};

/** The checks on a pull request, counted. `rollup` is gh's statusCheckRollup. */
export const summarizeChecks = ({ rollup }: { rollup: unknown }): CheckSummary => {
  const lines = keepNewestPerName({ lines: toList({ value: rollup }).map((entry) => toCheckLine({ entry })) });
  const count = ({ outcome }: { outcome: CheckOutcome }): number => lines.filter((line) => line.outcome === outcome).length;
  const failing = count({ outcome: 'failing' });
  const pending = count({ outcome: 'pending' });
  const passing = count({ outcome: 'passing' });
  return {
    state: toCheckState({ failing, pending, passing }),
    passing,
    failing,
    pending,
    failingNames: lines.filter((line) => line.outcome === 'failing').map((line) => line.name),
  };
};

// ---- pull requests ------------------------------------------------------------------------------------------------------

const REVIEW_STATES = new Map<string, ReviewState>([
  ['APPROVED', 'approved'],
  ['CHANGES_REQUESTED', 'changes-requested'],
  ['REVIEW_REQUIRED', 'review-required'],
]);

const MERGE_STATES = new Map<string, MergeState>([
  ['MERGEABLE', 'clean'],
  ['CONFLICTING', 'conflicting'],
]);

const isRequestedOf = ({ requests, viewer }: { requests: unknown; viewer: string }): boolean =>
  viewer !== '' && toList({ value: requests }).some((request) => readLogin({ value: request }).toLowerCase() === viewer.toLowerCase());

const parsePullRequestSummary = ({ raw, viewer }: { raw: unknown; viewer: string }): PullRequestSummary | null => {
  const record = toRecord({ value: raw });
  const number = readCount({ value: record.number });
  if (number === 0) return null;
  const author = readLogin({ value: record.author });
  return {
    number,
    title: readText({ value: record.title }),
    url: readText({ value: record.url }),
    author,
    isBot: toRecord({ value: record.author }).is_bot === true,
    isDraft: record.isDraft === true,
    headBranch: readText({ value: record.headRefName }),
    baseBranch: readText({ value: record.baseRefName }),
    headSha: readText({ value: record.headRefOid }),
    isFromFork: record.isCrossRepository === true,
    createdAtIso: readText({ value: record.createdAt }),
    updatedAtIso: readText({ value: record.updatedAt }),
    additions: readCount({ value: record.additions }),
    deletions: readCount({ value: record.deletions }),
    changedFiles: readCount({ value: record.changedFiles }),
    labels: readLabels({ value: record.labels }),
    review: REVIEW_STATES.get(readText({ value: record.reviewDecision })) ?? 'none',
    checks: summarizeChecks({ rollup: record.statusCheckRollup }),
    merge: MERGE_STATES.get(readText({ value: record.mergeable })) ?? 'unknown',
    linkedIssues: readLinkedIssues({ value: record.closingIssuesReferences }),
    isMine: viewer !== '' && author.toLowerCase() === viewer.toLowerCase(),
    isReviewRequested: isRequestedOf({ requests: record.reviewRequests, viewer }),
  };
};

const toUnreadable = ({ what }: { what: string }): Error => new Error(`GitHub sent ${what} that Desk could not read. Try again in a moment.`);

const parseArrayOf = <T>({ text, what, parseOne }: { text: string; what: string; parseOne: (raw: unknown) => T | null }): readonly T[] => {
  const parsed = parseJsonOrUndefined({ text });
  if (!Array.isArray(parsed)) throw toUnreadable({ what });
  return (parsed as readonly unknown[]).flatMap((raw) => {
    const one = parseOne(raw);
    return one === null ? [] : [one];
  });
};

/** The open pull requests from `gh pr list --json`, newest activity first. */
export const parsePullRequests = ({ text, viewer }: { text: string; viewer: string }): readonly PullRequestSummary[] =>
  parseArrayOf({ text, what: 'a list of pull requests', parseOne: (raw) => parsePullRequestSummary({ raw, viewer }) }).toSorted((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso));

const readChangedFiles = ({ value }: { value: unknown }): readonly ChangedFile[] =>
  toList({ value }).flatMap((entry) => {
    const record = toRecord({ value: entry });
    const path = readText({ value: record.path });
    return path ? [{ path, additions: readCount({ value: record.additions }), deletions: readCount({ value: record.deletions }) }] : [];
  });

const readReviews = ({ value }: { value: unknown }): readonly ReviewLine[] =>
  toList({ value }).flatMap((entry) => {
    const record = toRecord({ value: entry });
    const author = readLogin({ value: record.author });
    return author ? [{ author, state: readText({ value: record.state }).toLowerCase().replaceAll('_', ' ') }] : [];
  });

/** One pull request in full, from `gh pr view --json`. */
export const parsePullRequestDetail = ({ text, viewer }: { text: string; viewer: string }): PullRequestDetail => {
  const parsed = parseJsonOrUndefined({ text });
  const summary = parsePullRequestSummary({ raw: parsed, viewer });
  if (summary === null) throw toUnreadable({ what: 'a pull request' });
  const record = toRecord({ value: parsed });
  const files = readChangedFiles({ value: record.files });
  return {
    ...summary,
    body: readText({ value: record.body }),
    files,
    reviews: readReviews({ value: record.latestReviews }),
    commitCount: toList({ value: record.commits }).length,
    commentCount: toList({ value: record.comments }).length,
    carriesClaims: files.some((file) => file.path === CLAIMS_FILE),
  };
};

// ---- issues -------------------------------------------------------------------------------------------------------------

const parseIssueSummary = ({ raw, viewer }: { raw: unknown; viewer: string }): IssueSummary | null => {
  const record = toRecord({ value: raw });
  const number = readCount({ value: record.number });
  if (number === 0) return null;
  const author = readLogin({ value: record.author });
  const assignees = toList({ value: record.assignees }).map((assignee) => readLogin({ value: assignee })).filter(Boolean);
  const isViewer = ({ login }: { login: string }): boolean => viewer !== '' && login.toLowerCase() === viewer.toLowerCase();
  return {
    number,
    title: readText({ value: record.title }),
    url: readText({ value: record.url }),
    author,
    isOpen: readText({ value: record.state }).toUpperCase() === 'OPEN',
    labels: readLabels({ value: record.labels }),
    assignees,
    commentCount: toList({ value: record.comments }).length,
    createdAtIso: readText({ value: record.createdAt }),
    updatedAtIso: readText({ value: record.updatedAt }),
    isMine: isViewer({ login: author }) || assignees.some((login) => isViewer({ login })),
  };
};

export const parseIssues = ({ text, viewer }: { text: string; viewer: string }): readonly IssueSummary[] =>
  parseArrayOf({ text, what: 'a list of issues', parseOne: (raw) => parseIssueSummary({ raw, viewer }) }).toSorted((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso));

export const parseIssueDetail = ({ text, viewer }: { text: string; viewer: string }): IssueDetail => {
  const parsed = parseJsonOrUndefined({ text });
  const summary = parseIssueSummary({ raw: parsed, viewer });
  if (summary === null) throw toUnreadable({ what: 'an issue' });
  return { ...summary, body: readText({ value: toRecord({ value: parsed }).body }) };
};

// ---- asking gh ----------------------------------------------------------------------------------------------------------

const PR_LIST_FIELDS = 'number,title,url,author,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,reviewDecision,reviewRequests,statusCheckRollup,closingIssuesReferences,labels,additions,deletions,changedFiles,createdAt,updatedAt,mergeable';
const PR_DETAIL_FIELDS = `${PR_LIST_FIELDS},body,files,latestReviews,commits,comments`;
const ISSUE_LIST_FIELDS = 'number,title,url,author,state,labels,assignees,comments,createdAt,updatedAt';
const ISSUE_DETAIL_FIELDS = `${ISSUE_LIST_FIELDS},body`;

/** What gh says when it cannot read GitHub, matched to a sentence that says what to do. The first match wins. */
const GH_READ_REFUSALS: readonly { when: RegExp; say: string }[] = [
  { when: /ENOENT|not recognized|command not found/i, say: 'The GitHub CLI (gh) is not installed. Install it from cli.github.com, then press Connect GitHub.' },
  { when: /no git remotes found|none of the git remotes/i, say: 'This repo has no GitHub remote yet. Add one with git remote add origin <url> and push, then come back.' },
  { when: /gh auth login|not logged in|authentication|bad credentials|HTTP 401/i, say: 'The GitHub CLI is not signed in. Press Connect GitHub.' },
  { when: /rate limit/i, say: 'GitHub says Desk has asked too often. Wait a minute and press Refresh.' },
  { when: /could not resolve to a repository|repository not found|HTTP 404/i, say: 'GitHub cannot find this repository, or the signed-in account cannot see it. Check the origin remote and who gh is signed in as.' },
  { when: /HTTP 403|forbidden|resource not accessible/i, say: 'GitHub refused this account. It may need access to the repository or the organisation.' },
  { when: /timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i, say: 'Desk could not reach GitHub. Check the connection and press Refresh.' },
];

const toGithubReadFailure = ({ error }: { error: unknown }): Error => {
  const reason = toPlainMessage({ error });
  const refusal = GH_READ_REFUSALS.find((candidate) => candidate.when.test(reason));
  return new Error(refusal?.say || `GitHub did not answer: ${reason}`, { cause: error });
};

const runGh = async ({ argList, cwd, execFn }: { argList: readonly string[]; cwd: string; execFn: GhExecFn }): Promise<string> => {
  try {
    const { stdout } = await execFn('gh', [...argList], { cwd, windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: GH_BUFFER_BYTES });
    return String(stdout);
  } catch (error) {
    throw toGithubReadFailure({ error });
  }
};

/** The login of the signed-in account, or an empty string when gh cannot say. Only used to mark which items are yours. */
export const fetchViewerLogin = async ({ cwd, execFn = runExecFile }: { cwd: string; execFn?: GhExecFn }): Promise<string> => {
  try {
    return (await runGh({ argList: ['api', 'user', '--jq', '.login'], cwd, execFn })).trim();
  } catch {
    return '';
  }
};

export const fetchPullRequests = async ({ cwd, execFn = runExecFile }: { cwd: string; execFn?: GhExecFn }): Promise<{ viewer: string; pullRequests: readonly PullRequestSummary[] }> => {
  const [viewer, text] = await Promise.all([fetchViewerLogin({ cwd, execFn }), runGh({ argList: ['pr', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', PR_LIST_FIELDS], cwd, execFn })]);
  return { viewer, pullRequests: parsePullRequests({ text, viewer }) };
};

export const fetchPullRequest = async ({ cwd, number, execFn = runExecFile }: { cwd: string; number: number; execFn?: GhExecFn }): Promise<PullRequestDetail> => {
  const [viewer, text] = await Promise.all([fetchViewerLogin({ cwd, execFn }), runGh({ argList: ['pr', 'view', String(number), '--json', PR_DETAIL_FIELDS], cwd, execFn })]);
  return parsePullRequestDetail({ text, viewer });
};

export const fetchIssues = async ({ cwd, execFn = runExecFile }: { cwd: string; execFn?: GhExecFn }): Promise<{ viewer: string; issues: readonly IssueSummary[] }> => {
  const [viewer, text] = await Promise.all([fetchViewerLogin({ cwd, execFn }), runGh({ argList: ['issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', ISSUE_LIST_FIELDS], cwd, execFn })]);
  return { viewer, issues: parseIssues({ text, viewer }) };
};

export const fetchIssue = async ({ cwd, number, execFn = runExecFile }: { cwd: string; number: number; execFn?: GhExecFn }): Promise<IssueDetail> => {
  const [viewer, text] = await Promise.all([fetchViewerLogin({ cwd, execFn }), runGh({ argList: ['issue', 'view', String(number), '--json', ISSUE_DETAIL_FIELDS], cwd, execFn })]);
  return parseIssueDetail({ text, viewer });
};
