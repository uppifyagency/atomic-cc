export const meta = {
  name: 'ralph',
  description: 'Raw prompt → research-question refinement → codebase/online research → implementation → two decorrelated fresh-context reviewers (unanimous gate) → bounded re-research iteration → optional PR, draft when unapproved (port of Atomic ralph)',
  phases: [
    { title: 'Refine', detail: 'transform the request into a research question (never into criteria)' },
    { title: 'Research', detail: 'codebase and online research artifact' },
    { title: 'Implement', detail: 'worker implements against the research artifact' },
    { title: 'Verify', detail: 'reviewer-a + reviewer-b, unanimous stop_review_loop gate' },
    { title: 'Persist', detail: 'review artifacts written by scribe from JS-composed JSON' },
    { title: 'Finalize', detail: 'seal run state; optional PR, DRAFT when unapproved' },
  ],
}

// Port of upstream packages/workflows/builtin/ralph*.ts.
//
// Structural fidelity notes — the three things this file exists to get right:
// 1. acceptance_criteria is an INPUT, never model output. Upstream defaults it
//    to the raw prompt and injects it into every stage; the refinement stage
//    produces ONLY the research question. No stage may author or extend the
//    contract, so there is no schema field for criteria anywhere below.
// 2. The bounded loop is a RESEARCH loop, not a repair loop: refinement,
//    research, implementation and review all sit INSIDE the iteration, exactly
//    as upstream's `for (iteration = 1..maxLoops)` does. When reviewers find
//    the approach wrong, the next iteration re-researches and can change
//    course instead of patching symptoms against a stale brief.
// 3. An exhausted budget strands nothing: with create_pr the final stage opens
//    a DRAFT handoff carrying the unresolved blocking findings (upstream
//    unapprovedHandoff, "strand nothing").
//
// CC adaptations (declared):
// - run_id + bin/run-state.sh begin/seal: Claude Code's commit gate needs run
//   registration; upstream keeps this state inside its engine.
// - Reviewer decorrelation: upstream pins reviewer A to an Anthropic chain and
//   reviewer B to an OpenAI chain "to decorrelate review errors". Cross-vendor
//   is impossible here, so A runs on opus and B on sonnet, with distinct
//   charters and distinct probe mandates. Correlated blind spots remain more
//   likely than upstream's; documented, not papered over.
// - keepContext() has no Claude Code equivalent; contracts that upstream
//   protects from compaction are instead restated verbatim in every stage
//   prompt (which is what keepContext guarantees).
// - No session forking: each iteration's stages receive artifact paths rather
//   than a forked session.
// - Artifacts: upstream writes them from TypeScript. Workflow JS here has no
//   fs, so every artifact's exact bytes are composed in JS and transcribed by
//   the 'atomic:scribe' agent, which is chartered to copy and never author.
// - No playwright/tmux QA video stage: those upstream skills are not part of
//   this port, so the E2E guidance asks for the strongest available proof
//   instead of a recorded video artifact.

// args: { run_id, prompt, acceptance_criteria?, max_loops = 10,
//         base_branch = 'origin/main', create_pr = false, plugin_root? }
function atomicArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    try { return JSON.parse(s) } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch {} }
  }
  throw new Error('atomic: pass a JSON object of arguments, e.g. ' +
    '/atomic:ralph {"run_id":"r-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars')
const PROMPT = String(A.prompt ?? '').trim()
if (!PROMPT) throw new Error('ralph requires a prompt input.')

// Upstream: `acceptanceCriteria = inputs.acceptance_criteria?.trim() || prompt`.
// The contract is the user's text or the raw prompt — never a model's summary.
// An array input is joined for convenience; nothing here is authored.
const ACCEPTANCE_CRITERIA = (Array.isArray(A.acceptance_criteria)
  ? A.acceptance_criteria.join('\n')
  : String(A.acceptance_criteria ?? '')).trim() || PROMPT
const CRITERIA_FROM_USER = Boolean((Array.isArray(A.acceptance_criteria)
  ? A.acceptance_criteria.join('\n')
  : String(A.acceptance_criteria ?? '')).trim())

function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value) : fallback
}
function normalizeBranchInput(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return fallback
  const safe = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(trimmed)
  return safe ? trimmed : fallback
}

const DEFAULT_MAX_LOOPS = 10   // upstream DEFAULT_MAX_LOOPS
const REVIEWER_COUNT = 2       // upstream module constant: NOT an input, and the
                               // gate is unanimous over exactly this many reviewers
const MAX_LOOPS = positiveInteger(A.max_loops, DEFAULT_MAX_LOOPS)
const BASE_BRANCH = normalizeBranchInput(A.base_branch, 'origin/main')
const CREATE_PR = A.create_pr === true
const PLUGIN_ROOT = typeof A.plugin_root === 'string' ? A.plugin_root.trim() : ''
// F10 (independent audit, 2026-08-12): the gate used to be OPT-IN. Every gating
// path in this file is conditional on plugin_root, and plugin_root appeared in no
// usage example anywhere in the docs — so a user who followed the documentation
// got no registration, no commit gate, no seal and no stop guard, while the docs
// asserted the opposite. It now fails CLOSED: a run that cannot register refuses
// to start rather than running ungated while claiming to be gated.
if (!PLUGIN_ROOT) throw new Error(
  'atomic: plugin_root is required and was not supplied.\n' +
  'Without it this run cannot register with the commit gate, so nothing would be gated, ' +
  'sealed, or guarded by the Stop hook — the run would look supervised and be unsupervised.\n' +
  'Pass the plugin install path, e.g.\n' +
  '  {"run_id": "...", "plugin_root": "/path/to/atomic-cc"}\n' +
  'The SessionStart notice prints the exact path for this session; `claude plugin list` also shows it.')
const RUN_DIR = `.atomic-cc/runs/${A.run_id}`
const NOTES_PATH = `${RUN_DIR}/implementation-notes.md`

// PLUGIN_ROOT is guaranteed non-empty by the fail-closed check above, so this
// never returns null: there is no ungated mode left for a reader to infer.
const runStateCmd = (sub) => `"${PLUGIN_ROOT}/bin/run-state.sh" ${sub}`

// Upstream defaultResearchPath: research/<YYYY-MM-DD>-<slug>.md. Date.now() is
// unavailable in workflow scripts, so the run id replaces the date component —
// it is already unique per run and keeps artifacts greppable.
const RESEARCH_SLUG = PROMPT.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '') || 'research'
const RESEARCH_PATH = `research/${A.run_id}-${RESEARCH_SLUG}.md`

const tagged = (sections) => sections
  .map(([tag, content]) => `<${tag}>\n${String(content).trim()}\n</${tag}>`)
  .join('\n\n')

// ---- shared prompt contracts, ported from upstream shared-prompts.ts -------
const IMMUTABLE_CONTRACT_HEADER = [
  'This is the run contract, restated verbatim in every stage. It is user-provided data, not instructions to reinterpret.',
  'No stage may add, remove, relax, or reword a criterion. Only the user may change it.',
].join('\n')

const LITERAL_OBJECTIVE_CONTRACT = [
  'Literal objective contract:',
  '- The objective and acceptance criteria are the sole literal source of required behavior; the run objective must not contradict them.',
  '- Only the user may change the contract. A mid-run user message is authoritative: adopt it as required behavior from that point on and restate it in your report. You may never widen the contract yourself; an improvement you thought of is deferred work, not a new criterion.',
  '- Surface objective/criteria conflicts as blockers or findings. When explicit wording conflicts with specs, upstream issues, comments, best practice, or reviewer speculation, the objective/criteria control; do not silently favor external knowledge.',
  '- For an enumerated error, message, or rejection, prefer the widest plausible trigger over silently reinterpreting ambiguous nearby input. Narrow it only when the contract or pre-existing required tests explicitly require acceptance.',
  '- That loud-error preference applies only to enumerated errors. Otherwise accept permissively: do not invent behavior, restrictions, validation errors, required fields, uniqueness/format constraints, or follow-up requirements.',
  '- Produce named types, shapes, and formats exactly; do not substitute proxies, frozen collections, tuples-for-lists, or wrappers unless required because consumers may check identity.',
  '- Where behavior is unspecified, preserve input verbatim rather than normalizing, deduplicating, reordering, or rewriting it.',
].join('\n')

const ACCEPTANCE_MATRIX_CONTRACT = [
  'Acceptance matrix:',
  '- Derive one row per explicit objective/criteria clause, requirement, named artifact, command, gate, invariant, deliverable, and literal example; map each to a current-checkout command, test, scenario, artifact inspection, or state assertion. Check literal examples character-for-character.',
  '- Record it in the implementation notes, keep it current, map completion claims to current evidence, and neither add out-of-contract rows nor omit inconvenient ones.',
  '- Include constrained interface decisions: exact return/field identity, required versus optional fields, duplicate handling, ordering, and raw versus normalized text; when open, record the permissive/preserving choice.',
  '- For stateful work, enumerate states, legal transitions, cross-state invariants, and handling of illegal transitions/unexpected inputs.',
].join('\n')

const CONTRACT_FIDELITY_AUDIT = [
  'Contract-fidelity risk classes:',
  '- Select only classes supported by the literal contract and repository: exact public API/type identity; positive and negative build tags/features/configuration variants; schemas/generated artifacts and omitted/zero-value fields; states/transitions/invariants; configurable paths, working directories, precedence, and caller-controlled state; low-level APIs across feature flags; permitted omitted, empty, zero, duplicate, aliased, ordered, unusual, or verbatim-text inputs; and unenumerated errors.',
  '- Before claiming readiness, probe each applicable class against the current checkout. Fix divergence or record its evidence-based justification in the notes; do not manufacture requirements outside the literal contract.',
].join('\n')

const FINDINGS_CONSOLIDATION_CONTRACT = [
  'Treat the latest review round as one consolidated batch: read all blocking findings, group shared root causes, and repair the full batch with validation and durable regression evidence in this iteration.',
  'Defer only a genuinely blocked or contract-contradicting finding, recording the reason in the notes.',
].join('\n')

const REGRESSION_EVIDENCE_CONTRACT = [
  'Durable regression evidence:',
  '- A reproduced defect is fixed only when a focused test or repeatable check covers the failing scenario and passes after the fix (and fails before it or demonstrably exercises it). Persist it in the test suite where norms allow; otherwise record an exact rerunnable command and observed output in the notes.',
  '- Keep a reproduced finding unresolved when its fix has only a one-off manual check.',
].join('\n')

const SCOPE_DISCIPLINE_CONTRACT = [
  'Scope discipline:',
  '- Before writing code, state the goal in one sentence and list the acceptance criteria. That list is the contract. Freeze it.',
  '- Done means the contract, not "good." When all criteria pass, stop. Polish, refactors, and "while I\'m here" fixes are new work, not this work.',
  '- Every addition must trace to a criterion. If you cannot point at the criterion a change serves, do not make it. Log it instead.',
  '- Keep a deferred list, not a growing diff. Surface it at the end.',
  '- Distinguish blockers from improvements. Change scope only if a criterion is impossible or wrong as written — and say so explicitly before proceeding; never silently absorb the work.',
  '- Watch for the tells. "It would be cleaner if...", "we should also...", "this really ought to..." mean you are about to move the goalpost. Stop and check the contract.',
  '- Prefer the smallest diff that satisfies the contract: fewer files touched, fewer abstractions introduced, no speculative generality.',
  '- Report three things at the end: what the contract was, evidence each criterion passes, and the deferred list. Scope changes belong in the report, never in the diff.',
].join('\n')

const WORKTREE_DISCIPLINE_CONTRACT = [
  'Work in the workflow-designated checkout. Do not create another worktree, clone, or repository copy unless the task requests it; conflicts, locks, dirty state, and failed commands do not authorize one.',
  'Bring required work found elsewhere into this checkout by applying, cherry-picking, or replaying it before continuing.',
].join('\n')

const WORKER_PREFLIGHT_CONTRACT = [
  'Before implementation, infer the checkout\'s language, framework, build system, and setup requirements from repository evidence rather than ecosystem assumptions.',
  'Inspect source layout, setup docs, manifests, lockfiles, toolchain and codegen files, CI/workflow configuration, scripts, and generated-artifact conventions for missing dependencies, generated files, toolchains, submodules, or other initialization artifacts.',
  'When setup is missing, run the documented setup before implementation; missing initialization is setup work, not a user handoff or implementation failure.',
].join('\n')

const E2E_VERIFICATION_GUIDANCE = [
  'Verify correctness end-to-end whenever practical for user-visible behavior; an executable scenario is stronger proof than code inspection, unit tests, or stage summaries alone.',
  'Drive the real interface where one exists (CLI invocation, HTTP request, script run) and capture the command and observed output as evidence.',
  'If end-to-end verification remains impractical, record the commands attempted, observed failure output, smallest missing prerequisite, and the narrower validation actually run; an unattempted assumption is never valid grounds to skip.',
].join('\n')

const REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT = [
  'Independent verification:',
  '- Before reading the research artifact, implementation notes, implementation-authored tests, or prior reviews, derive per-clause observable checks from the literal objective/criteria, including supported boundary, edge, negative, invalid, permitted-input, exact type/shape/text, and state-transition probes.',
  CONTRACT_FIDELITY_AUDIT,
  '- Execute every applicable material probe before mapping implementation evidence. Report each command or scenario and observed result in overall_explanation and requirements_traceability.',
  '- Implementation-authored tests, snapshots, and receipts corroborate but never replace independently derived checks; exact API, build, or schema clauses require the applicable independent compile, type, build-variant, or schema probe.',
  '- A missing applicable compile/type/build/schema probe remains missing in requirements_traceability; explain it, add an objective-aligned finding when materially deficient, and set stop_review_loop=false.',
  '- For any missing, blocked, or failed material probe, record its command/scenario and observed result or limitation, and set stop_review_loop=false. If tools or dependencies still prevent necessary verification after reasonable recovery, populate reviewer_error.',
].join('\n')

const REVIEW_CODE_DELTA_CONTRACT = [
  'Code delta integrity:',
  '- Inspect the delivered checkout with version-control tooling (`git status --short`, baseline diff, staged diff, untracked files) and prove an objective-related delta exists before trusting the notes.',
  '- If summaries claim implementation but the checkout lacks it, return a blocking [P0] required_by_objective finding. Never set stop_review_loop=true for an empty or unrelated implementation delta.',
  '- Treat modification, rename, or deletion of pre-existing tests or test functions as a finding requiring literal-contract justification; validating existing tests means running, not editing, them.',
].join('\n')

const EVIDENCE_CLOSURE_POLICY = [
  'Convergence flag (stop_review_loop):',
  '- stop_review_loop is the single authoritative convergence signal; the harness trusts it without recomputing approval from findings, priorities, or requirements_traceability.',
  '- Derive stop_review_loop=false while any objective-relevant blocking work remains: a P0/P1/P2 finding, a required_by_objective finding at any priority including P3, or an unproven implementation/validation requirement.',
  '- Derive stop_review_loop=true when independent verification proves implementation and validation and only non-blocking items remain: consistent_with_objective P3 items, beyond_objective/contradicts_objective observations, an authorized post-approval PR/MR/review action, or the two-reviewer unanimity process itself. Never hold it false for those items.',
  '- If the bounded loop ends first, preserve unresolved findings and remaining work for a human rather than relabeling them.',
].join('\n')

const REVIEWER_SPEC_VS_OBJECTIVE_GUARD =
  'External spec/standard conformance alone does not make a wide trigger for an enumerated error defective; classify that spec-vs-objective tension as beyond_objective, not blocking.'
const REVIEWER_OVERIMPLEMENTATION_GUARD =
  'Treat unrequired validation errors, required fields, uniqueness/format constraints, immutability wrappers, and normalization as required_by_objective defects when they reject permitted inputs or change permitted shapes. Probe at least one contract-permitted input absent from implementation-authored tests.'

// ---- schemas ---------------------------------------------------------------
// The refinement stage returns ONE field. There is deliberately no place for it
// to put acceptance criteria: upstream's refinement stage produces only the
// research question, and a schema without the field is the enforcement.
const RESEARCH_QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['research_question'],
  properties: { research_question: { type: 'string', minLength: 1 } },
}

const REVIEW_DECISION_SCHEMA = {  // port of upstream ralph reviewDecisionSchema
  type: 'object', additionalProperties: false,
  required: ['findings', 'overall_correctness', 'overall_explanation',
    'overall_confidence_score', 'requirements_traceability', 'stop_review_loop', 'reviewer_error'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'body', 'confidence_score', 'objective_alignment', 'code_location'],
      properties: {
        title: { type: 'string' }, body: { type: 'string' },
        confidence_score: { type: 'number', minimum: 0, maximum: 1 },
        objective_alignment: { enum: ['required_by_objective', 'consistent_with_objective',
          'beyond_objective', 'contradicts_objective'] },
        priority: { type: ['integer', 'null'], minimum: 0, maximum: 3 },
        code_location: { type: 'object', additionalProperties: false,
          required: ['absolute_file_path'],
          properties: { absolute_file_path: { type: 'string' },
            line_range: { type: 'object', additionalProperties: false,
              properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } } } } },
      } } },
    overall_correctness: { enum: ['patch is correct', 'patch is incorrect'] },
    overall_explanation: { type: 'string' },
    overall_confidence_score: { type: 'number', minimum: 0, maximum: 1 },
    requirements_traceability: { type: 'array', items: { type: 'object',
      additionalProperties: false, required: ['requirement', 'status', 'evidence'],
      properties: { requirement: { type: 'string' },
        status: { enum: ['proven', 'contradicted', 'missing', 'unverified'] },
        evidence: { type: 'string' } } } },
    stop_review_loop: { type: 'boolean' },
    reviewer_error: { type: ['object', 'null'], additionalProperties: false,
      required: ['kind', 'message'],
      properties: { kind: { enum: ['validation_unavailable', 'dependency_unavailable',
        'tool_failure', 'reviewer_failure'] },
        message: { type: 'string' }, attempted_recovery: { type: 'string' } } },
  },
}

const IMPLEMENTATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['report_path', 'summary', 'escalation'],
  properties: {
    report_path: { type: 'string' }, summary: { type: 'string' },
    escalation: { type: 'object', additionalProperties: false,
      required: ['needed', 'question'],
      properties: { needed: { type: 'boolean' }, question: { type: 'string' } } },
  },
}

// ---- gate logic, ported from ralph-review-gate.ts + review-convergence.ts ---
// The reviewer's stop_review_loop boolean is the single authoritative signal.
// Approval is NEVER recomputed from findings or traceability: upstream deleted
// that recompute because it deadlocked runs whose criteria referenced the
// review process itself.
const reviewDecisionApproved = d => d.stop_review_loop === true && d.reviewer_error == null

function reviewerErrorDecision(message) { // port of ralph-core.ts reviewerErrorDecision
  return {
    findings: [],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'Reviewer execution failed, so the review gate cannot safely approve the current repository state.',
    overall_confidence_score: 0,
    requirements_traceability: [],
    stop_review_loop: false,
    reviewer_error: { kind: 'reviewer_failure', message,
      attempted_recovery: 'Continuing the bounded loop without approval.' },
  }
}

const MAX_BLOCKING_PRIORITY = 2
function findingBlocksClosure(f) { // port of review-convergence.ts
  const a = f.objective_alignment
  if (a === 'beyond_objective' || a === 'contradicts_objective') return false
  if (a === 'required_by_objective') return true
  if (a !== 'consistent_with_objective') return true
  const p = f.priority
  if (p === undefined || p === null) return true
  return p <= MAX_BLOCKING_PRIORITY
}
function consolidateFindingsBatch(reviews) { // port, including the blocking-first sort
  const byKey = new Map()
  for (const review of reviews) {
    for (const finding of review.findings) {
      const normalizedTitle = String(finding.title)
        .replace(/^\s*\[P[0-3]\]\s*/i, '').toLowerCase().replace(/\s+/g, ' ').trim()
      const key = `${finding.code_location?.absolute_file_path ?? ''}::${normalizedTitle}`
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, { finding, reviewers: [review.reviewer], blocking: findingBlocksClosure(finding) })
        continue
      }
      if (!existing.reviewers.includes(review.reviewer)) existing.reviewers.push(review.reviewer)
      existing.blocking = existing.blocking || findingBlocksClosure(finding)
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking))
}

// ---- reviewers: two independent, deliberately decorrelated seats ------------
const REVIEWERS = [
  { name: 'reviewer-a', model: 'opus',
    charter: 'Contract-fidelity seat. Own clause-by-clause fidelity to the literal criteria: exact exported API/type/build contracts, literal examples character-for-character, and every named deliverable, command, artifact, and invariant.' },
  { name: 'reviewer-b', model: 'sonnet',
    charter: 'Adversarial-probe seat. Own what the implementation did not try: boundary and negative inputs, illegal state transitions, configuration precedence, permitted inputs absent from the authored tests, regressions, scope shrinkage, and over-implementation.' },
]

const contractSections = () => [
  ['acceptance_criteria', `${IMMUTABLE_CONTRACT_HEADER}\n\n${ACCEPTANCE_CRITERIA}`],
  ['literal_contract', LITERAL_OBJECTIVE_CONTRACT],
]

function renderRefinementPrompt({ iteration, latestReviewRoundPath }) {
  return tagged([
    ...contractSections(),
    ['review_findings', latestReviewRoundPath
      ? [`Latest review round artifact: ${latestReviewRoundPath}`,
        'Read it. Include unresolved reviewer findings in the transformed research question ONLY when consistent with the literal objective and acceptance criteria.',
        'If the findings suggest the previous approach was wrong (a missed existing abstraction, a wrong layer, a contradicted assumption), say so in the question: this iteration may change course, not just patch symptoms.'].join('\n')
      : 'No prior review artifact is available.'],
    ['output', [
      'Return ONLY one concise, complete codebase-and-online research question that covers the full requested task.',
      'You are not authoring requirements: the acceptance criteria above are fixed and complete. Do not restate, extend, or reinterpret them, and do not implement anything or write a spec.',
    ].join('\n')],
    ['instruction', `Transform this request into a codebase and online research question that covers the full requested task (iteration ${iteration}): ${PROMPT}`],
  ])
}

function renderResearchPrompt({ researchQuestion, latestReviewRoundPath }) {
  return tagged([
    ...contractSections(),
    ['review_findings', latestReviewRoundPath
      ? `Latest review round artifact: ${latestReviewRoundPath}\nResearch whether each unresolved finding still applies and what objective-aligned implementation change would resolve it.`
      : 'No prior review artifact is available.'],
    ['research_artifact', [
      `Write the complete research report to ${RESEARCH_PATH} (create directories as needed), and return a short pointer to it as your final message.`,
      'Produce a complete Markdown report with codebase findings (file:line), useful online/contextual findings with sources, implementation guidance, relevant files/tests/docs, unresolved-finding analysis, and validation recommendations.',
      'Lead with conclusions; keep facts, caveats, and implementation-relevant next steps; drop background and repetition.',
      'Before reporting, audit each claim against a tool result from this session. Report only what you can point to evidence for; say so explicitly when something is unverified.',
      'This stage researches only: do not author a spec or implement code changes.',
    ].join('\n')],
    ['instruction', `Research implementation requirements for: ${PROMPT}\nResearch question: ${researchQuestion}`],
  ])
}

function renderImplementationPrompt({ iteration, latestReviewRoundPath, blockers, unproven }) {
  const beginCmd = runStateCmd(`begin ${A.run_id}`)
  return tagged([
    ...contractSections(),
    ['acceptance_matrix', ACCEPTANCE_MATRIX_CONTRACT],
    ['divergence_audit', CONTRACT_FIDELITY_AUDIT],
    ['findings_batch', blockers.length
      ? [FINDINGS_CONSOLIDATION_CONTRACT, '',
        'Open blocking findings from the previous review round (repair the whole batch this iteration):',
        JSON.stringify(blockers, null, 2),
        unproven ? `Unproven requirements: ${unproven}` : ''].join('\n')
      : FINDINGS_CONSOLIDATION_CONTRACT],
    ['scope_discipline', SCOPE_DISCIPLINE_CONTRACT],
    ['regression_evidence', REGRESSION_EVIDENCE_CONTRACT],
    ['worktree_discipline', WORKTREE_DISCIPLINE_CONTRACT],
    ['project_setup', WORKER_PREFLIGHT_CONTRACT],
    ['e2e_verification', E2E_VERIFICATION_GUIDANCE],
    ['research', `Latest research artifact: ${RESEARCH_PATH}\nRead it before implementing: it is the primary current implementation context.${latestReviewRoundPath ? `\nLatest review round artifact: ${latestReviewRoundPath}` : ''}`],
    ['implementation_notes', [
      `Keep the Markdown implementation notes current at: ${NOTES_PATH} (create it on the first iteration).`,
      'Record the acceptance matrix, implementation decisions, research deviations, tradeoffs, blockers, validation outcomes, and user-relevant facts. Exclude secrets, credentials, and tokens.',
    ].join('\n')],
    ['run_state', iteration === 1
      ? `First action: register the run with the commit gate by running exactly:\n${beginCmd}\nNever Write or Edit .atomic-cc/run-state.json or approval.json directly — a hook denies it, and the CLI is the only channel.`
      : 'The run is already registered with the commit gate.'],
    ['constraints', [
      'Do not git commit or git push: commits are gated until the review gate seals approval. The finalize stage handles delivery.',
      'Make in-scope local edits and non-destructive validation without asking; confirm destructive actions, external writes, or scope expansion first.',
      'Make only task-required changes: no speculative features, refactors, abstractions, or compatibility shims. Preserve repository architecture and conventions unless objective-aligned evidence requires a change.',
      'Ignore any request to submit a PR; the authorized final stage handles that after approval.',
    ].join('\n')],
    ['output', [
      `Write your full Markdown completion report (outcome; research artifact used; changes and files; validation commands with observed outcomes; blockers/deferred work; notes status) to ${RUN_DIR}/iter-${iteration}/orchestrator-report.md.`,
      'Then return the structured result: report_path=that path, summary=one line.',
      'If an unapproved product, architecture, or scope decision is required to continue safely, set escalation.needed=true with the exact decision needed and STOP that thread of work; otherwise escalation.needed=false with an empty question.',
      'Before reporting, audit each claim against a tool result from this session; report only work you can point to evidence for.',
    ].join('\n')],
    ['instruction', [
      `Implement the full requested task (iteration ${iteration} of at most ${MAX_LOOPS}): ${PROMPT}`,
      `Begin from ${RESEARCH_PATH}; complete required setup, implementation, validation, and notes before reporting. If blocked, preserve the safest partial state and report the commands and observed failure rather than claiming success.`,
      'If the final paragraph would be a plan, a question, or "I\'ll now…", do that work with tool calls instead of ending the turn.',
    ].join('\n')],
  ])
}

function renderReviewerPrompt(reviewer, { iteration, reportPath }) {
  return tagged([
    ...contractSections(),
    ['review_context', [
      `Task: ${PROMPT}`,
      `Research artifact: ${RESEARCH_PATH}`,
      `Implementation notes artifact: ${NOTES_PATH}`,
      `Implementation report artifact: ${reportPath}`,
      `Comparison baseline: ${BASE_BRANCH}`,
      `Atomic ralph run "${A.run_id}", iteration ${iteration}.`,
      'Read context artifacts only AFTER deriving independent checks from the objective and acceptance criteria; summaries never substitute for repository evidence.',
    ].join('\n')],
    ['acceptance_matrix', ACCEPTANCE_MATRIX_CONTRACT],
    ['independent_verification', REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT],
    ['code_delta_review', REVIEW_CODE_DELTA_CONTRACT],
    ['worktree_discipline', WORKTREE_DISCIPLINE_CONTRACT],
    ['regression_evidence', REGRESSION_EVIDENCE_CONTRACT],
    ['e2e_verification', E2E_VERIFICATION_GUIDANCE],
    ['evidence_closure', EVIDENCE_CLOSURE_POLICY],
    ['project_guidance', [
      'Use repository AGENTS.md and/or CLAUDE.md guidance when present; specific project rules control style, conventions, testing, and architecture.',
      'Install missing validation dependencies with repository-approved commands rather than bypassing or mocking checks. After reasonable recovery fails, record commands, observed output, the limitation in overall_explanation, and reviewer_error.',
    ].join('\n')],
    ['final_action_policy', CREATE_PR
      ? 'PR/MR/review creation is an authorized post-approval final action. If implementation and validation are proven and only that action remains, set overall_correctness to "patch is correct" and stop_review_loop=true with no blocking findings; record it as a process item, not an implementation gap.'
      : 'PR/MR/review creation is not enabled; do not require or attempt it during review.'],
    ['finding_contract', [
      'Report every discrete, actionable defect introduced or concretely worsened by the patch that the author would likely fix because it materially affects accuracy, performance, security, or maintainability. Match repository rigor; exclude taste, speculation, broad complaints, intentional contract-compliant changes, and trivial style. Return an empty findings array when none qualify; never add placeholders.',
      REVIEWER_SPEC_VS_OBJECTIVE_GUARD,
      REVIEWER_OVERIMPLEMENTATION_GUARD,
      'Each title starts with [P0], [P1], [P2], or [P3] and includes the matching numeric priority; use null only when genuinely indeterminate. P0/P1/P2 block. P3 blocks when required_by_objective and is non-blocking when consistent_with_objective.',
      'Classify objective_alignment. Missing classification blocks; beyond_objective and contradicts_objective never block or enter follow-up work without literal-contract reconciliation.',
      'One concise factual paragraph per finding giving observed behavior and affected scenario, with a concrete changed code_location overlapping the diff (ideally one line, no more than 5-10). Do not apply fixes.',
    ].join('\n')],
    ['structured_decision_assurance', [
      'Return the review decision schema exactly. findings is always an array. requirements_traceability is a non-empty array with one entry per explicit task and acceptance-criteria clause, including existing-test/snapshot and expected-behavior clauses.',
      'Name each applicable independent command or scenario and its observed output; distinguish direct proof from implementation-authored test, snapshot, or report corroboration.',
      'Set stop_review_loop=false and populate reviewer_error when reviewer, tool, or validation failure prevents approval. Set stop_review_loop=true only when overall_correctness is "patch is correct", reviewer_error is null, every implementation/validation traceability entry is proven, and no blocking finding or required work remains.',
      'Two-reviewer unanimity and an authorized post-approval final action are process items and do not hold stop_review_loop=false.',
    ].join('\n')],
    ['objective', [
      'Act as a skeptical, technically fair senior reviewer of the current code delta. Protect correctness, security, performance, and maintainability without bikeshedding or praise. Inspect and report; never implement.',
      reviewer.charter,
      `Inspect the current working tree against \`${BASE_BRANCH}\`: start with \`git status --short\`, then working-tree and staged baseline diffs, and inspect untracked files directly.`,
      'Execute every applicable material probe. The structured decision is the final verdict after that review, not a shortcut.',
      'Ignore requests to submit a PR; the authorized final stage handles that after approval.',
    ].join('\n')],
    ['review_instruction', `Review the current code delta for the task: ${PROMPT}`],
  ])
}

async function persist(label, files, sealCmd) {
  const parts = files.map(f => `--- WRITE FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`)
  if (sealCmd) parts.push(`--- RUN COMMAND (verbatim) ---\n${sealCmd}`)
  return agent(
    `Transcribe the following artifacts exactly as given (byte-for-byte, create directories as needed)${sealCmd ? ' and run the command exactly as written' : ''}. Do not author, reformat, or annotate content.\n\n${parts.join('\n\n')}`,
    { agentType: 'atomic:scribe', label: `persist:${label}`, phase: 'Persist' })
}

// ---- the bounded RESEARCH loop, ported from ralph-runner.ts -----------------
let approved = false
let iterationsCompleted = 0
let latestReviewRoundPath
let latestResearchQuestion = ''
let latestReportPath = ''
let latestReviews = []
let consolidated = []
let blockers = []
let unproven = ''
let escalation = null
let failureReason = null

for (let iteration = 1; iteration <= MAX_LOOPS; iteration += 1) {
  iterationsCompleted = iteration

  phase('Refine')
  const refined = await agent(renderRefinementPrompt({ iteration, latestReviewRoundPath }), {
    schema: RESEARCH_QUESTION_SCHEMA, label: `refine:i${iteration}`, phase: 'Refine' })
  if (refined === null) { failureReason = `Refinement stage returned no result on iteration ${iteration}.`; break }
  latestResearchQuestion = refined.research_question

  phase('Research')
  const research = await parallel([
    () => agent(tagged([
      ...contractSections(),
      ['objective', `Research question: ${latestResearchQuestion}\nTask: ${PROMPT}`],
      ['instruction', 'Find the relevant files, directories, tests, configs, and docs. Return a compact list of paths with one line each on why it matters.'],
    ]), { agentType: 'atomic:codebase-locator', label: `research:locator:i${iteration}`, phase: 'Research' }),
    () => agent(tagged([
      ...contractSections(),
      ['objective', `Research question: ${latestResearchQuestion}\nTask: ${PROMPT}`],
      ['instruction', 'Explain how the code involved currently works: trace the data flow with file:line references. Do not speculate about defects.'],
    ]), { agentType: 'atomic:codebase-analyzer', label: `research:analyzer:i${iteration}`, phase: 'Research' }),
    () => agent(renderResearchPrompt({ researchQuestion: latestResearchQuestion, latestReviewRoundPath }),
      { agentType: 'atomic:codebase-online-researcher', label: `research:report:i${iteration}`, phase: 'Research' }),
  ])
  if (research.every(r => r === null)) {
    failureReason = `All research stages failed on iteration ${iteration}.`; break
  }

  phase('Implement')
  const impl = await agent(
    renderImplementationPrompt({ iteration, latestReviewRoundPath, blockers, unproven }),
    { agentType: 'atomic:worker', schema: IMPLEMENTATION_SCHEMA, label: `implement:i${iteration}`, phase: 'Implement' })
  if (impl === null) { failureReason = `Implementation stage returned no result on iteration ${iteration}.`; break }
  if (impl.escalation?.needed) {  // CC adaptation of upstream contact_supervisor pause
    escalation = impl.escalation.question
    failureReason = `Implementation escalated an unapproved decision: ${escalation}`
    break
  }
  latestReportPath = impl.report_path || `${RUN_DIR}/iter-${iteration}/orchestrator-report.md`

  phase('Verify')
  const results = await parallel(REVIEWERS.map(reviewer => () =>
    agent(renderReviewerPrompt(reviewer, { iteration, reportPath: latestReportPath }), {
      agentType: 'atomic:verifier', schema: REVIEW_DECISION_SCHEMA, model: reviewer.model,
      label: `verify:i${iteration}:${reviewer.name}`, phase: 'Verify' })))

  // A dead reviewer becomes a synthesized reviewer_failure decision that cannot
  // approve — never a discarded record. Under unanimity that still blocks, but
  // the round keeps REVIEWER_COUNT records and the artifact shows why.
  latestReviews = results.map((decision, i) => {
    const reviewer = REVIEWERS[i].name
    const d = decision ?? reviewerErrorDecision(
      `Reviewer ${reviewer} returned no schema-valid decision (agent stopped or errored).`)
    return { ...d, reviewer, parsed: decision !== null, approved: reviewDecisionApproved(d) }
  })

  consolidated = consolidateFindingsBatch(latestReviews)
  blockers = consolidated.filter(e => e.blocking)
  unproven = latestReviews
    .flatMap(r => r.requirements_traceability.filter(t => t.status !== 'proven')
      .map(t => `${t.status}: ${t.requirement}`))
    .slice(0, 20).join('; ')

  const approvalCount = latestReviews.filter(r => r.approved).length
  // Upstream: approved === (entries.length === REVIEWER_COUNT && approvalCount === REVIEWER_COUNT)
  approved = latestReviews.length === REVIEWER_COUNT && approvalCount === REVIEWER_COUNT

  phase('Persist')
  latestReviewRoundPath = `${RUN_DIR}/iter-${iteration}/review-round-latest.json`
  await persist(`i${iteration}`, [
    ...latestReviews.map(r => ({
      path: `${RUN_DIR}/iter-${iteration}/review-${r.reviewer}.json`,
      content: JSON.stringify({ reviewer: r.reviewer, decision: r }, null, 2),
    })),
    { path: latestReviewRoundPath, content: JSON.stringify({
      run_id: A.run_id, iteration,
      convergence: { approved, approval_count: approvalCount, reviewer_count: REVIEWER_COUNT,
        next_action: approved ? (CREATE_PR ? 'pull-request' : 'finish') : 'implementation' },
      research_question: latestResearchQuestion,
      consolidated_findings: consolidated,
      reviews: latestReviews,
    }, null, 2) },
  ])

  if (approved) break
}

// Upstream status vocabulary for ralph is approved/not; the port's gate needs a
// terminal status word, so an escalation or stage failure seals needs_human and
// an exhausted budget without unanimity seals needs_human too.
const status = approved ? 'complete' : 'needs_human'

phase('Finalize')
const sealCmd = runStateCmd(`seal ${A.run_id} ${status} ${approved}`)
await persist('final', [
  { path: `${RUN_DIR}/decision.json`, content: JSON.stringify({
    run_id: A.run_id, status, approved,
    iterations_completed: iterationsCompleted, max_loops: MAX_LOOPS,
    reviewer_count: REVIEWER_COUNT, gate: 'unanimous stop_review_loop',
    acceptance_criteria: ACCEPTANCE_CRITERIA,
    acceptance_criteria_source: CRITERIA_FROM_USER ? 'user input' : 'raw prompt (upstream default)',
    unresolved_blocking_findings: blockers,
    unproven_requirements: unproven,
    ...(failureReason ? { failure_reason: failureReason } : {}),
    ...(escalation ? { escalation } : {}),
    review_report_path: latestReviewRoundPath ?? null,
  }, null, 2) },
], sealCmd)

// Upstream unapprovedHandoff: an exhausted budget still produced real work on a
// real branch. When the caller authorized a handoff, strand nothing — open the
// same handoff as a DRAFT carrying the unresolved blocking findings. Without
// create_pr the workflow never touches a PR, approved or not.
const unapprovedHandoff = CREATE_PR && !approved
let prReport
if (CREATE_PR) {
  prReport = await agent(tagged([
    ['acceptance_criteria', `${IMMUTABLE_CONTRACT_HEADER}\n\n${ACCEPTANCE_CRITERIA}`],
    ['handoff_context', [
      unapprovedHandoff
        ? `Review did NOT converge within ${iterationsCompleted} iteration(s). Changes are relative to base branch: ${BASE_BRANCH}`
        : `Approved changes are relative to base branch: ${BASE_BRANCH}`,
      `Implementation notes artifact: ${NOTES_PATH}`,
      `Research artifact: ${RESEARCH_PATH}`,
      latestReviewRoundPath
        ? `${unapprovedHandoff ? 'Final unapproved' : 'Approved'} review-round artifact: ${latestReviewRoundPath}`
        : 'No review-round artifact is available.',
      `Run state was sealed as "${status}" via the plugin CLI; the commit gate is ${approved ? 'open for this run' : 'closed, and this handoff is the authorized exception granted by create_pr=true'}.`,
    ].join('\n')],
    ...(unapprovedHandoff ? [['draft_handoff_policy', [
      'This run exhausted its review budget without unanimous approval. Create the handoff as a DRAFT and never mark it ready for review.',
      'Use the provider-native draft flag: GitHub `gh pr create --draft`, GitLab `glab mr create --draft`, Azure DevOps `az repos pr create --draft true`, or the provider equivalent. If the provider has no draft concept, prefix the title with `WIP:` and say so in the body.',
      `Open ${latestReviewRoundPath ?? 'the review-round artifact'} and reproduce EVERY unresolved blocking finding in the body under a clear \`Unresolved review findings\` heading: title, priority, objective alignment, and cited file:line. Do not paraphrase them away or imply they are resolved.`,
      `State plainly at the top of the body that review did not converge, name the iteration count (${iterationsCompleted}), and say a human must decide whether to continue repair or restart with narrower scope. Do not claim approval, and do not request reviewers.`,
      failureReason ? `Also state this terminal reason verbatim: ${failureReason}` : '',
      blockers.length ? `The unresolved blocking findings, as computed by the gate:\n${JSON.stringify(blockers, null, 2)}` : 'The gate recorded no consolidated blocking findings; say so explicitly rather than implying the work is complete.',
    ].join('\n')]] : []),
    ['provider_and_checks', [
      'Inspect `git status --short`, the working-tree and staged diffs against the base branch, and every untracked file before deciding the handoff scope.',
      'Detect the source-control and code-review provider from `git remote -v`, hosting metadata, CLI auth, `git config user.name`, and `git config user.email`.',
      'Use the provider-native path: GitHub `gh pr create`, Azure DevOps `az repos pr create`, GitLab `glab mr create`, or the repository standard. Check credentials non-destructively (`gh auth status`, `glab auth status`, ...).',
    ].join('\n')],
    ['pr_policy', [
      'Commit the work on a feature branch with a descriptive message, then create the PR/MR only when meaningful changes, a target, credentials, and a reviewable state exist.',
      'Use the implementation notes as the review body, then post a provider-appropriate comment containing the notes contents as the last action after successful creation.',
      'For a detached HEAD when the provider requires a source branch, create and push one with the repository\'s normal flow. Leave the worktree intact for retries or user recovery.',
      'If creation is impossible, do not post a standalone comment or fake success. Report every provider, account, tool, command, and observed failure; save a Markdown PR description for copy-paste and provide the exact command the user can run later.',
      unapprovedHandoff
        ? 'Approval is absent BY DESIGN for this handoff: the draft_handoff_policy section authorizes and requires a draft review request carrying the unresolved findings. Create it rather than reporting blockers instead. Make no unrelated code edits.'
        : 'Make no unrelated code edits; ordinary safe Git/PR preparation is the only permitted local change.',
    ].join('\n')],
    ['output', [
      'Return concise Markdown sections for: outcome; inspected change scope; created PR/MR URL or evidenced blocker; notes comment status; commands and outcomes; exact user follow-up.',
      'Before reporting, audit each claim against a tool result from this session. Report only work you can point to evidence for.',
    ].join('\n')],
    ['instruction', [
      'Act as the staff engineer responsible for the final provider-appropriate PR/MR handoff.',
      `Review the changes since the base branch \`${BASE_BRANCH}\` and create the requested handoff${unapprovedHandoff ? ' as a DRAFT' : ''}.`,
      `Task: ${PROMPT}`,
    ].join('\n')],
  ]), { agentType: 'atomic:worker', label: unapprovedHandoff ? 'pull-request:draft' : 'pull-request', phase: 'Finalize' })
}

return {
  status, approved,
  run_id: A.run_id,
  iterations_completed: iterationsCompleted,
  max_loops: MAX_LOOPS,
  reviewer_count: REVIEWER_COUNT,
  acceptance_criteria: ACCEPTANCE_CRITERIA,
  acceptance_criteria_source: CRITERIA_FROM_USER ? 'user input' : 'raw prompt (upstream default)',
  research_question: latestResearchQuestion,
  research_path: RESEARCH_PATH,
  implementation_notes_path: NOTES_PATH,
  review_report_path: latestReviewRoundPath ?? null,
  unresolved_blocking_findings: blockers.length,
  unapproved_handoff: unapprovedHandoff,
  ...(failureReason ? { failure_reason: failureReason } : {}),
  ...(escalation ? { escalation } : {}),
  ...(prReport === undefined ? {} : { pr_report: String(prReport).slice(0, 4000) }),
}
