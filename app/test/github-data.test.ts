/**
 * Reading a repo's pull requests and issues from the GitHub CLI: what the checks add up to, who a
 * pull request is waiting on, strange input from strangers, and the sentences shown when gh fails.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchIssues, fetchPullRequest, fetchPullRequests, parseIssueDetail, parseIssues, parsePullRequestDetail, parsePullRequests, summarizeChecks, type GhExecFn } from '../src/lib/github-data.ts';
import { formatAge } from '../src/renderer/format.ts';
import { buildSpecGoal } from '../src/shared/github.ts';
import { createRecorder } from './helpers.ts';
import { expectDefined } from './helpers.ts';

const checkRun = ({ name, status = 'COMPLETED', conclusion = 'SUCCESS', startedAt = '2026-10-27T04:00:00Z', workflowName = 'CI' }: { name: string; status?: string; conclusion?: string; startedAt?: string; workflowName?: string }) => ({
  __typename: 'CheckRun', name, status, conclusion, startedAt, workflowName,
});

test('checks are counted once per name, newest run wins, skipped ones are left out', () => {
  const rollup = [
    checkRun({ name: 'Python 3.12', conclusion: 'FAILURE', startedAt: '2026-10-27T04:00:00Z' }),
    checkRun({ name: 'Python 3.12', conclusion: 'SUCCESS', startedAt: '2026-10-27T04:10:00Z' }),
    checkRun({ name: 'Desk' }),
    checkRun({ name: 'Docs', conclusion: 'SKIPPED' }),
  ];
  assert.deepEqual(summarizeChecks({ rollup }), { state: 'passing', passing: 2, failing: 0, pending: 0, failingNames: [] });
});

test('a failing check wins over a running one, and the failing names are kept', () => {
  const summary = summarizeChecks({ rollup: [checkRun({ name: 'Lint', conclusion: 'FAILURE' }), checkRun({ name: 'Build', status: 'IN_PROGRESS', conclusion: '' }), checkRun({ name: 'Tests' })] });
  assert.equal(summary.state, 'failing');
  assert.deepEqual([summary.failing, summary.pending, summary.passing], [1, 1, 1]);
  assert.deepEqual(summary.failingNames, ['CI / Lint']);
});

test('older status checks count too, and no checks at all reads as none', () => {
  const summary = summarizeChecks({ rollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', startedAt: '' }] });
  assert.equal(summary.state, 'pending');
  assert.equal(summarizeChecks({ rollup: [] }).state, 'none');
  assert.equal(summarizeChecks({ rollup: null }).state, 'none');
  assert.equal(summarizeChecks({ rollup: 'junk' }).state, 'none');
});

const buildPullJson = ({ number, author = 'dana', updatedAt = '2026-10-26T10:00:00Z', over = {} }: { number: number; author?: string; updatedAt?: string; over?: Record<string, unknown> }) => ({
  number, title: `Change ${number}`, url: `https://github.com/a/b/pull/${number}`, author: { login: author, is_bot: false }, isDraft: false,
  headRefName: `feature/${number}`, baseRefName: 'main', headRefOid: 'abc', isCrossRepository: false, reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: [], statusCheckRollup: [], closingIssuesReferences: [{ number: 7, title: 'Slow checkout', url: 'https://github.com/a/b/issues/7' }],
  labels: [{ name: 'bug' }], additions: 10, deletions: 2, changedFiles: 3, createdAt: '2026-10-25T10:00:00Z', updatedAt, mergeable: 'MERGEABLE', ...over,
});

test('pull requests keep what the page needs, mark yours and the ones waiting on you, and sort by latest activity', () => {
  const text = JSON.stringify([
    buildPullJson({ number: 1, updatedAt: '2026-10-20T00:00:00Z' }),
    buildPullJson({ number: 2, author: 'Patrick', updatedAt: '2026-10-26T00:00:00Z' }),
    buildPullJson({ number: 3, updatedAt: '2026-10-24T00:00:00Z', over: { reviewRequests: [{ __typename: 'User', login: 'PATRICK' }, { __typename: 'Team', slug: 'core' }], isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' } }),
  ]);
  const pulls = parsePullRequests({ text, viewer: 'patrick' });
  assert.deepEqual(pulls.map((pull) => pull.number), [2, 3, 1]);
  const mine = expectDefined({ value: pulls[0], what: 'your pull request' });
  const requested = expectDefined({ value: pulls[1], what: 'the one waiting on you' });
  const other = expectDefined({ value: pulls[2], what: 'the oldest pull request' });
  assert.equal(mine.isMine, true);
  assert.equal(requested.isReviewRequested, true);
  assert.equal(requested.isDraft, true);
  assert.equal(requested.merge, 'conflicting');
  assert.equal(requested.review, 'approved');
  assert.equal(other.isMine, false);
  assert.equal(other.isReviewRequested, false);
  assert.deepEqual(other.linkedIssues, [{ number: 7, title: 'Slow checkout', url: 'https://github.com/a/b/issues/7' }]);
  assert.deepEqual(other.labels, ['bug']);
});

test('strange input becomes empty values, never a crash, and markup stays text', () => {
  const hostile = '<img src=x onerror=alert(1)> **bold** \u0000';
  const text = JSON.stringify([
    buildPullJson({ number: 4, over: { title: hostile, headRefName: '"><script>', labels: [{ name: 7 }, null, { name: hostile }], additions: -5, changedFiles: 'many', author: null } }),
    { number: 'five' },
    null,
    'text',
    { title: 'no number' },
  ]);
  const pulls = parsePullRequests({ text, viewer: '' });
  assert.equal(pulls.length, 1);
  const pull = expectDefined({ value: pulls[0], what: 'the one readable pull request' });
  assert.equal(pull.title, hostile, 'kept as the text it is, for the page to show as text');
  assert.equal(pull.author, '');
  assert.equal(pull.additions, 0);
  assert.equal(pull.changedFiles, 0);
  assert.deepEqual(pull.labels, [hostile]);
  assert.equal(pull.isMine, false, 'with no signed-in name nothing is yours');
});

test('text that is not a list is refused in words a person can read', () => {
  assert.throws(() => parsePullRequests({ text: 'not json', viewer: '' }), /could not read/);
  assert.throws(() => parsePullRequests({ text: '{"a":1}', viewer: '' }), /list of pull requests/);
  assert.throws(() => parseIssues({ text: '', viewer: '' }), /list of issues/);
  assert.throws(() => parsePullRequestDetail({ text: '[]', viewer: '' }), /a pull request/);
  assert.throws(() => parseIssueDetail({ text: '{}', viewer: '' }), /an issue/);
});

test('a pull request in full says whether the branch carries its own claims', () => {
  const withClaims = parsePullRequestDetail({ text: JSON.stringify({ ...buildPullJson({ number: 9 }), body: 'Fixes the thing', files: [{ path: 'src/a.py', additions: 3, deletions: 1 }, { path: '.claimcheck/claims.yaml', additions: 9, deletions: 0 }], latestReviews: [{ author: { login: 'lee' }, state: 'CHANGES_REQUESTED' }], commits: [{}, {}], comments: [{}] }), viewer: '' });
  assert.equal(withClaims.carriesClaims, true);
  assert.deepEqual(withClaims.reviews, [{ author: 'lee', state: 'changes requested' }]);
  assert.deepEqual([withClaims.commitCount, withClaims.commentCount, withClaims.files.length], [2, 1, 2]);
  const without = parsePullRequestDetail({ text: JSON.stringify({ ...buildPullJson({ number: 10 }), files: [{ path: 'src/a.py' }] }), viewer: '' });
  assert.equal(without.carriesClaims, false);
  assert.equal(without.body, '');
});

test('issues mark the ones you wrote or are assigned, and closed ones are not open', () => {
  const issue = ({ number, author, assignees = [], state = 'OPEN' }: { number: number; author: string; assignees?: readonly string[]; state?: string }) => ({
    number, title: `Issue ${number}`, url: `https://github.com/a/b/issues/${number}`, author: { login: author }, state, labels: [{ name: 'bug' }], assignees: assignees.map((login) => ({ login })), comments: [{}, {}], createdAt: '2026-10-01T00:00:00Z', updatedAt: `2026-10-0${number}T00:00:00Z`,
  });
  const issues = parseIssues({ text: JSON.stringify([issue({ number: 1, author: 'someone' }), issue({ number: 2, author: 'me', state: 'CLOSED' }), issue({ number: 3, author: 'other', assignees: ['Me'] })]), viewer: 'me' });
  assert.deepEqual(issues.map((entry) => [entry.number, entry.isMine, entry.isOpen]), [[3, true, true], [2, true, false], [1, false, true]]);
  assert.equal(issues[0]?.commentCount, 2);
});

// ---- asking gh --------------------------------------------------------------------------------------------------------------------

type Call = { file: string; argList: readonly string[]; cwd: unknown };

const makeFakeGh = ({ calls, answers }: { calls: ReturnType<typeof createRecorder<Call>>; answers: Record<string, string | Error> }): GhExecFn => (file, argList, options) => {
  calls.record({ file, argList, cwd: options?.cwd });
  const key = argList.slice(0, 2).join(' ');
  const answer = answers[key] ?? '';
  return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer });
};

test('listing pull requests asks gh for the open ones in the repo folder, and marks yours by the signed-in name', async () => {
  const calls = createRecorder<Call>();
  const execFn = makeFakeGh({ calls, answers: { 'api user': 'dana\n', 'pr list': JSON.stringify([buildPullJson({ number: 5 })]) } });
  const { viewer, pullRequests } = await fetchPullRequests({ cwd: '/repo', execFn });
  assert.equal(viewer, 'dana');
  assert.equal(pullRequests[0]?.isMine, true);
  const list = expectDefined({ value: calls.list().find((call) => call.argList[0] === 'pr'), what: 'the pr list call' });
  assert.deepEqual(list.argList.slice(0, 6), ['pr', 'list', '--state', 'open', '--limit', '100']);
  assert.equal(list.cwd, '/repo');
  assert.ok(calls.list().every((call) => call.file === 'gh'));
});

test('a pull request and an issue are asked for by number', async () => {
  const calls = createRecorder<Call>();
  const issueText = JSON.stringify({ number: 8, title: 'T', url: 'u', author: { login: 'x' }, state: 'OPEN', labels: [], assignees: [], comments: [], createdAt: '', updatedAt: '', body: 'Steps to reproduce' });
  const execFn = makeFakeGh({ calls, answers: { 'api user': 'dana', 'pr view': JSON.stringify({ ...buildPullJson({ number: 12 }), body: 'b', files: [] }), 'issue view': issueText } });
  assert.equal((await fetchPullRequest({ cwd: '/r', number: 12, execFn })).number, 12);
  assert.equal((await fetchIssues({ cwd: '/r', execFn: makeFakeGh({ calls, answers: { 'issue list': '[]' } }) })).issues.length, 0);
  assert.equal(parseIssueDetail({ text: issueText, viewer: '' }).body, 'Steps to reproduce');
  assert.ok(calls.list().some((call) => call.argList.join(' ').startsWith('pr view 12 --json')));
});

test('when gh fails, the person reads a sentence about what to do, not gh\'s own output', async () => {
  const cases: readonly { stderr: string; says: RegExp }[] = [
    { stderr: 'spawn gh ENOENT', says: /not installed/ },
    { stderr: 'no git remotes found', says: /no GitHub remote/ },
    { stderr: 'To get started with GitHub CLI, please run: gh auth login', says: /not signed in/ },
    { stderr: 'API rate limit exceeded for user', says: /too often/ },
    { stderr: 'GraphQL: Could not resolve to a Repository with the name a/b', says: /cannot find this repository/ },
    { stderr: 'HTTP 403: Resource not accessible by integration', says: /refused this account/ },
    { stderr: 'getaddrinfo ENOTFOUND api.github.com', says: /could not reach GitHub/ },
  ];
  await Promise.all(
    cases.map(({ stderr, says }) => {
      const execFn = makeFakeGh({ calls: createRecorder<Call>(), answers: { 'api user': 'dana', 'pr list': new Error(`Command failed: gh pr list --json number,title\n${stderr}`) } });
      return assert.rejects(() => fetchPullRequests({ cwd: '/r', execFn }), (error: Error) => says.test(error.message) && !error.message.includes('Command failed'), stderr);
    }),
  );
});

test('how long ago reads as the shortest plain words', () => {
  const nowMs = Date.parse('2026-10-27T12:00:00Z');
  const readAge = ({ iso }: { iso: string }): string => formatAge({ iso, nowMs });
  assert.equal(readAge({ iso: '2026-10-27T11:59:40Z' }), 'just now');
  assert.equal(readAge({ iso: '2026-10-27T11:55:00Z' }), '5m ago');
  assert.equal(readAge({ iso: '2026-10-27T09:00:00Z' }), '3h ago');
  assert.equal(readAge({ iso: '2026-10-24T12:00:00Z' }), '3d ago');
  assert.equal(readAge({ iso: '2026-10-06T12:00:00Z' }), '3w ago');
  assert.equal(readAge({ iso: '2026-05-27T12:00:00Z' }), '5mo ago');
  assert.equal(readAge({ iso: '2024-10-27T12:00:00Z' }), '2y ago');
  assert.equal(readAge({ iso: '2026-10-28T12:00:00Z' }), 'just now', 'a time in the future is not negative');
  assert.equal(readAge({ iso: 'not a time' }), '');
});

test('an issue becomes the spec goal: its title and number, then its description without template comments', () => {
  const goal = buildSpecGoal({ issue: { number: 12, title: '  Shipping is too expensive ', body: '<!-- describe the bug -->\nOrders of $50 or more should ship free.\n<!-- thanks -->' } });
  assert.equal(goal, 'Shipping is too expensive (issue #12)\n\nOrders of $50 or more should ship free.');
  assert.equal(buildSpecGoal({ issue: { number: 3, title: 'Only a title', body: '' } }), 'Only a title (issue #3)');
  assert.ok(buildSpecGoal({ issue: { number: 3, title: 'Long', body: 'x'.repeat(20000) } }).length <= 8000, 'cut to what the wizard keeps');
});
