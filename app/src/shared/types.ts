/**
 * Types shared by the main process, the preload bridge and the renderer: the board model, the
 * fix-flow state and the claimcheck CLI protocol. Everything read from disk or from a child process
 * is untrusted and arrives as `unknown`; only the shapes below come out of the validators.
 *
 * @author Patrick Finazzo
 */

export type ClaimStatus = 'open' | 'fixing' | 'resolved' | 'accepted';
export type CheckVerdict = 'SUPPORTED' | 'REFUTED' | 'UNVERIFIABLE';
export type Flag = 'low-confidence' | 'refuted' | 'unverified' | 'weak-tests' | 'no-mutants';

export interface Criterion {
  id: number;
  text: string;
}

export interface VerdictInfo {
  id: string;
  /** Kept as text: a record written by something else may hold any word. */
  verdict: string;
  reason: string;
  evidence: string[];
  provider: string;
  model: string | null;
  ts: string;
  runId: string;
}

export interface Mutant {
  file: string;
  line_no: number | null;
  cls: string;
  original: string;
  mutated: string;
  outcome: string;
}

export interface MutationInfo {
  total: number;
  killed: number;
  survived: number;
  timeout: number;
  catchRate: number | null;
  mutants: Mutant[];
  ts: string;
  runId: string;
}

export interface AppSettings {
  flagConfidence: number;
  flagCatchRate: number;
  python: string | null;
}

export interface BoardConfig {
  base: string;
  test_cmd: string;
  ignore: string[];
  checker: { provider: string; model: string };
  app: AppSettings;
}

export interface FixState {
  runId?: string;
  branch?: string;
  worktree?: string;
  prUrl?: string | null;
  [key: string]: unknown;
}

export interface LedgerRecord {
  type?: unknown;
  claim_id?: unknown;
  ts?: unknown;
  outcome?: unknown;
  outcome_source?: unknown;
  [key: string]: unknown;
}

export interface Claim {
  id: string;
  claim: string;
  confidence: number | null;
  criteria: Criterion[];
  files: string[];
  killCondition: string;
  verifiedBy: string[];
  verdict: VerdictInfo | null;
  mutation: MutationInfo | null;
  status: ClaimStatus;
  reopened: boolean;
  note: string;
  fix: FixState | null;
  history: LedgerRecord[];
  risk: number;
  flags: string[];
  /** The exact text Copy prompt would copy; attached by the main process. */
  promptText?: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  origin: string | null;
  branch: string | null;
  head: string | null;
  hasClaimcheck: boolean;
  lockOk: boolean;
  specState: 'none' | 'draft' | 'frozen' | 'drifted';
  lastRunTs: string | null;
}

export interface CheckRun {
  file: string;
  run_id: string;
  ts: string;
  provider: string;
  model: string | null;
  verdicts: { id: string; verdict: string; reason: string; evidence: string[] }[];
}

export interface MutateRun {
  file: string;
  run_id: string;
  ts: string;
  mutants: Mutant[];
  per_claim: Record<string, unknown>;
}

export interface Board {
  repo: RepoInfo;
  config: BoardConfig;
  criteria: Criterion[];
  claims: Claim[];
  queue: string[];
  runs: { check: CheckRun | null; mutate: MutateRun | null; fixes?: unknown[] };
  ledgerCount: number;
  /** Attached by the main process after the board is read. */
  connection?: ConnectionSummary;
  trust?: TrustInfo;
}

export interface SpecLock {
  spec_sha256?: unknown;
  criteria?: unknown;
  [key: string]: unknown;
}

export interface AppStateClaim {
  status?: string;
  note?: string;
  fix?: FixState;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface AppState {
  claims: Record<string, AppStateClaim>;
  [key: string]: unknown;
}

export interface OutcomeRecord {
  v: 1;
  type: 'outcome';
  ts: string;
  run_id: string;
  claim_id: string;
  outcome: 'held' | 'broken';
  outcome_source: 'test_failure' | 'revert' | 'fix_commit' | 'human';
  evidence: string;
}

export interface Proposal {
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  effort: 'small' | 'medium' | 'large';
  touches: string[];
}

/** What the prompts need to know about one claim in one repo. */
export interface PromptContext {
  repo: Pick<RepoInfo, 'origin' | 'path' | 'branch' | 'head'>;
  config: Pick<BoardConfig, 'test_cmd'> & Partial<BoardConfig>;
  claim: Claim;
}

// ---- the claimcheck CLI protocol (machine commands) ----------------------------

export type Stack = 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle';

export interface CcStatus {
  initialized: boolean;
  spec: 'none' | 'draft' | 'frozen';
  criteria: number;
  hook: boolean;
  base: string;
  branch: string;
  provider: string;
}

export interface CcSecrets {
  created: boolean;
  added: string[];
  tracked: string[];
}

export interface CcInit {
  repo: string;
  config: 'created' | 'exists';
  stack: { name: Stack | null; test_cmd: string; others: string[] };
  hook: { status: 'installed' | 'present'; path: string };
  secrets: CcSecrets;
  gitignore_added: string[];
  agent_docs: { path: string; action: 'added' | 'updated' | 'unchanged' | 'created' }[];
  ci: { path: string; action: 'created' | 'exists' } | null;
  next: string;
}

export interface DraftQuestion {
  id: string;
  text: string;
  why: string;
}

export interface DraftCriterion {
  text: string;
  check: string;
}

export interface LintNote {
  level: 'warning' | 'error' | 'info';
  message: string;
}

export interface CcStep {
  questions: DraftQuestion[];
  criteria: DraftCriterion[];
  out_of_scope: string[];
  concerns: string[];
  ready: boolean;
  lint: Record<string, LintNote[]>;
}

export interface CcFinish {
  spec_path: string;
  criteria: number;
  frozen: boolean;
  lock_sha256: string | null;
  branch: string | null;
  commit: string | null;
}

export interface DraftRound {
  questions: DraftQuestion[];
  answers: string[];
}

export interface DraftInput {
  goal: string;
  rounds: DraftRound[];
  criteria: DraftCriterion[];
  out_of_scope: string[];
}

// ---- app state the main process sends to the renderer ---------------------------

export type ConnectionMode = 'cli' | 'api';

export interface ConnectionSummary {
  mode: ConnectionMode;
  model: string;
  cliPath: string | null;
  cliOk: boolean | null;
  apiSaved: boolean;
  apiLast4: string | null;
  apiOk: boolean | null;
  claimcheckBin: string | null;
  useAuto: boolean;
}

export interface TrustInfo {
  trusted: boolean;
  commands: { label: string; command: string }[];
}

export type ViewName = 'empty' | 'board' | 'wizard';
