// Gate-arithmetic regression tests for goal and ralph.
//
// Every case here corresponds to a specific upstream behavior the port must
// keep. Where a case exists because the port once diverged, the comment says so:
// those are the tests that would have caught the divergence.
import { join } from 'node:path'
import { runWorkflow, review, finding, envError, check, eq, group, report } from './harness.mjs'

const ROOT = join(import.meta.dirname, '..')
const GOAL = join(ROOT, 'workflows', 'goal.js')
const RALPH = join(ROOT, 'workflows', 'ralph.js')

const receipt = (over = {}) => ({
  stage: 'implement', artifact_path: '.atomic-cc/runs/t/turn-1/orchestrator-receipt.md',
  summary: 'did the work', escalation: { needed: false, question: '' }, ...over,
})
const implResult = (over = {}) => ({
  report_path: '.atomic-cc/runs/t/iter-1/orchestrator-report.md',
  summary: 'did the work', escalation: { needed: false, question: '' }, ...over,
})

// Routes each mocked agent call by what it is: worker receipts, reviewer
// decisions (by index within the round), scribe transcriptions, everything else.
function router({ reviewsPerTurn, workerResult = receipt, implFor = null, other = 'ok' }) {
  let round = -1
  let seatInRound = 0
  return async (call) => {
    const t = call.agentType
    if (t === 'atomic:scribe') return 'written'
    if (t === 'atomic:worker') return implFor ? implFor() : workerResult()
    if (t === 'atomic:verifier') {
      if (seatInRound === 0) round += 1
      const seats = reviewsPerTurn[Math.min(round, reviewsPerTurn.length - 1)]
      const decision = seats[seatInRound]
      seatInRound = (seatInRound + 1) % seats.length
      return decision
    }
    return other
  }
}

// A router whose reviewer seats are addressed by (round, seat) without relying
// on call ordering across parallel batches.
function seatRouter(rounds, opts = {}) {
  const counts = new Map()
  return async (call) => {
    const t = call.agentType
    if (t === 'atomic:scribe') return 'written'
    if (t === 'atomic:worker') return opts.worker ? opts.worker() : receipt()
    if (t === 'atomic:verifier') {
      const m = /:(?:t|i)(\d+):/.exec(call.label ?? '')
      const idx = m ? Number(m[1]) : 0
      const seat = counts.get(idx) ?? 0
      counts.set(idx, seat + 1)
      const spec = rounds[Math.min(idx - (rounds.keyedFromOne ? 1 : 0), rounds.length - 1)] ?? rounds.at(-1)
      return spec[seat] ?? spec.at(-1)
    }
    return opts.other ?? 'ok'
  }
}

// Every mention of a gate file in a prompt must be a PROHIBITION, never an
// instruction. Splitting on lines and requiring a negation keyword on each
// mentioning line distinguishes "never write approval.json" from "write
// approval.json", which a bare substring search cannot.
function gateFileMentionsAreAllProhibitions(calls) {
  const offenders = []
  for (const call of calls) {
    for (const line of String(call.prompt).split('\n')) {
      if (!/run-state\.json|approval\.json/.test(line)) continue
      if (/run-state\.sh/.test(line)) continue                 // the sanctioned channel
      if (/\b(never|not|no|denies|denied|skip|only by|instead)\b/i.test(line)) continue
      offenders.push(`${call.label ?? '(unlabelled)'}: ${line.trim().slice(0, 120)}`)
    }
  }
  return offenders
}

const goalArgs = (over = {}) => ({
  run_id: 'g-test', objective: 'make the thing work', plugin_root: '/plugin', ...over,
})
const ralphArgs = (over = {}) => ({
  run_id: 'r-test', prompt: 'make the thing work', plugin_root: '/plugin', ...over,
})

// ---------------------------------------------------------------------------
group('goal: quorum arithmetic (upstream DEFAULT_REVIEW_QUORUM = 2 of 3)')

{
  // 3 of 3 approve -> complete on turn 1.
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  eq('unanimous approval completes', r.value.status, 'complete')
  eq('approved flag set', r.value.approved, true)
  eq('one turn used', r.value.turns_completed, 1)
}

{
  // 2 of 3 approve -> quorum met, still complete.
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(),
      review({ stop_review_loop: false, findings: [finding()] })]] }) })
  eq('2-of-3 quorum completes', r.value.status, 'complete')
}

{
  // 1 of 3 -> no quorum; with max_turns 1 the reducer must say needs_human.
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 1 }),
    agent: router({ reviewsPerTurn: [[review(),
      review({ stop_review_loop: false, findings: [finding()] }),
      review({ stop_review_loop: false, findings: [finding()] })]] }) })
  eq('1-of-3 does not complete', r.value.status, 'needs_human')
  eq('not approved', r.value.approved, false)
}

{
  // REGRESSION (port once discarded null reviewers and required
  // reviews.length === expected, so one crashed reviewer cancelled a reached
  // quorum). Upstream synthesizes a reviewer_failure decision and still counts
  // 3 records: quorum is over APPROVALS, not arrivals.
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), null]] }) })
  eq('crashed reviewer does not cancel a met quorum', r.value.status, 'complete')
}

{
  // All three reviewers dead -> needs_human, never approval.
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 1 }),
    agent: router({ reviewsPerTurn: [[null, null, null]] }) })
  eq('total reviewer failure needs a human', r.value.status, 'needs_human')
  eq('total reviewer failure is not approved', r.value.approved, false)
}

{
  // stop_review_loop=true with a reviewer_error must NOT approve (hard guard).
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 1 }),
    agent: router({ reviewsPerTurn: [[
      review({ reviewer_error: envError() }),
      review({ reviewer_error: envError() }),
      review({ reviewer_error: envError() })]] }) })
  eq('reviewer_error never approves', r.value.approved, false)
}

group('goal: approval is the boolean, never a recount of findings')

{
  // A reviewer that approves while filing a blocking P0 still approves: upstream
  // deleted the recompute-from-findings path because it deadlocked runs whose
  // criteria referenced the review process itself.
  const blocking = finding({ title: '[P0] blocking', priority: 0, objective_alignment: 'required_by_objective' })
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review({ findings: [blocking] }),
      review({ findings: [blocking] }), review()]] }) })
  eq('gate trusts stop_review_loop over findings', r.value.status, 'complete')
}

{
  // Unproven traceability likewise does not veto an approving boolean.
  const unproven = [{ requirement: 'a clause about the review process', status: 'unverified', evidence: 'no single reviewer can prove it' }]
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review({ requirements_traceability: unproven }),
      review({ requirements_traceability: unproven }), review()]] }) })
  eq('unproven traceability does not deadlock', r.value.status, 'complete')
}

group('goal: blocked comes from repeated ENVIRONMENT blockers, not code findings')

{
  // REGRESSION (port once signed the blocked anti-loop over the blocking
  // FINDING set, so a stable P1 aborted at turn 3 and burned the remaining
  // budget). Upstream: code findings always produce continue.
  const stable = [
    review({ stop_review_loop: false, findings: [finding({ title: '[P1] stable defect' })] }),
    review({ stop_review_loop: false, findings: [finding({ title: '[P1] stable defect' })] }),
    review({ stop_review_loop: false, findings: [finding({ title: '[P1] stable defect' })] }),
  ]
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 5 }),
    agent: router({ reviewsPerTurn: [stable] }) })
  eq('a stable code finding never yields blocked', r.value.status, 'needs_human')
  eq('the full turn budget is spent on it', r.value.turns_completed, 5)
}

{
  // REGRESSION (the same port bug in the other direction: three reviewers all
  // failing on a missing dependency produced an empty signature, the guard
  // never fired, and the run burned every turn). Upstream: an identical
  // environment blocker repeated BLOCKER_THRESHOLD=3 turns is blocked.
  const envRound = [
    review({ stop_review_loop: false, reviewer_error: envError('pytest is not installed') }),
    review({ stop_review_loop: false, reviewer_error: envError('pytest is not installed') }),
    review({ stop_review_loop: false, reviewer_error: envError('pytest is not installed') }),
  ]
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 10 }),
    agent: router({ reviewsPerTurn: [envRound] }) })
  eq('repeated environment blocker yields blocked', r.value.status, 'blocked')
  eq('and stops at the threshold instead of burning 10 turns', r.value.turns_completed, 3)
}

{
  // A tool_failure blocker counts the same as dependency_unavailable.
  const round = [
    review({ stop_review_loop: false, reviewer_error: { kind: 'tool_failure', message: 'sandbox denied network', attempted_recovery: 'retried' } }),
    review({ stop_review_loop: false, reviewer_error: { kind: 'tool_failure', message: 'sandbox denied network', attempted_recovery: 'retried' } }),
    review({ stop_review_loop: false, findings: [finding()] }),
  ]
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 10 }),
    agent: router({ reviewsPerTurn: [round] }) })
  eq('tool_failure also reaches blocked', r.value.status, 'blocked')
}

{
  // reviewer_failure / validation_unavailable are NOT environment impasses:
  // they must not produce blocked (upstream blockerFromReviewDecision).
  const round = [
    review({ stop_review_loop: false, reviewer_error: { kind: 'reviewer_failure', message: 'model stopped', attempted_recovery: 'n/a' } }),
    review({ stop_review_loop: false, reviewer_error: { kind: 'reviewer_failure', message: 'model stopped', attempted_recovery: 'n/a' } }),
    review({ stop_review_loop: false, reviewer_error: { kind: 'reviewer_failure', message: 'model stopped', attempted_recovery: 'n/a' } }),
  ]
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 3 }),
    agent: router({ reviewsPerTurn: [round] }) })
  eq('reviewer_failure is not a blocked-eligible blocker', r.value.status, 'needs_human')
}

{
  // A blocker that CHANGES each turn never reaches the threshold.
  const mk = (msg) => [
    review({ stop_review_loop: false, reviewer_error: envError(msg) }),
    review({ stop_review_loop: false, reviewer_error: envError(msg) }),
    review({ stop_review_loop: false, reviewer_error: envError(msg) }),
  ]
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 3 }),
    agent: router({ reviewsPerTurn: [mk('missing pytest'), mk('missing docker'), mk('missing node')] }) })
  eq('a changing blocker does not trip the anti-loop', r.value.status, 'needs_human')
}

group('goal: run lifecycle and escalation')

{
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  const scribe = r.calls.filter(c => c.opts.agentType === 'atomic:scribe')
  const begin = r.calls.find(c => c.prompt.includes('run-state.sh" begin g-test'))
  const seal = scribe.find(c => c.prompt.includes('run-state.sh" seal g-test complete true'))
  check('the first worker turn is told to register the run via the CLI', Boolean(begin))
  check('the run is sealed complete/true via the CLI', Boolean(seal))
  const offenders = gateFileMentionsAreAllProhibitions(r.calls)
  check('every mention of a gate file is a prohibition, never an instruction',
    offenders.length === 0, offenders.join(' | '))
  check('per-reviewer artifacts are persisted',
    scribe.some(c => c.prompt.includes('review-completion-reviewer.json')))
  check('the consolidated review round is persisted',
    scribe.some(c => c.prompt.includes('review-round-latest.json')))
  check('the ledger is persisted', scribe.some(c => c.prompt.includes('goal-ledger.json')))
}

{
  // An unapproved run must seal a terminal status too, or the gate would hold
  // commits forever (the port's worst functional defect before this).
  const r = await runWorkflow(GOAL, { args: goalArgs({ max_turns: 1 }),
    agent: router({ reviewsPerTurn: [[review({ stop_review_loop: false }),
      review({ stop_review_loop: false }), review({ stop_review_loop: false })]] }) })
  const seal = r.calls.find(c => c.prompt.includes('run-state.sh" seal g-test needs_human false'))
  check('an unapproved run still seals a terminal status', Boolean(seal))
}

{
  // A worker escalation routes the run to a human instead of letting reviewers
  // grade deliberately incomplete work.
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]],
      workerResult: () => receipt({ escalation: { needed: true, question: 'which auth model?' } }) }) })
  eq('escalation routes to needs_human', r.value.status, 'needs_human')
  eq('the question is surfaced', r.value.escalation, 'which auth model?')
  check('no reviewer runs after an escalation',
    !r.calls.some(c => c.opts.agentType === 'atomic:verifier'))
}

{
  // No plugin_root: the run must not pretend to register state.
  const r = await runWorkflow(GOAL, { args: goalArgs({ plugin_root: undefined }),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  check('without plugin_root the worker is told to skip registration',
    r.calls.some(c => c.prompt.includes('plugin_root was not provided')))
  check('without plugin_root no run-state command is issued',
    !r.calls.some(c => c.prompt.includes('run-state.sh')))
}

group('goal: reviewer decorrelation and personas')

{
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  const verifiers = r.calls.filter(c => c.opts.agentType === 'atomic:verifier')
  eq('three reviewer seats', verifiers.length, 3)
  const models = verifiers.map(c => c.opts.model)
  check('reviewers are not all the same model', new Set(models).size >= 2, JSON.stringify(models))
  check('completion reviewer owns contract fidelity',
    verifiers.some(c => c.prompt.includes('Completion Reviewer')))
  check('evidence reviewer owns evidence validity',
    verifiers.some(c => c.prompt.includes('Evidence Reviewer')))
  check('risk reviewer owns adversarial boundaries',
    verifiers.some(c => c.prompt.includes('Risk Reviewer')))
  check('reviewers are told the quorum is a process item, not a gap',
    verifiers.every(c => c.prompt.includes('never hold it false') || c.prompt.includes('Never hold it false')))
}

group('goal: the contract is never authored by a model')

{
  const r = await runWorkflow(GOAL, { args: goalArgs({ acceptance_criteria: 'EXACT USER CONTRACT' }),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  eq('user criteria survive verbatim', r.value.acceptance_criteria, 'EXACT USER CONTRACT')
  const verifiers = r.calls.filter(c => c.opts.agentType === 'atomic:verifier')
  check('every reviewer sees the criteria verbatim',
    verifiers.every(c => c.prompt.includes('EXACT USER CONTRACT')))
  check('the worker sees the criteria verbatim',
    r.calls.some(c => c.opts.agentType === 'atomic:worker' && c.prompt.includes('EXACT USER CONTRACT')))
}

{
  const r = await runWorkflow(GOAL, { args: goalArgs(),
    agent: router({ reviewsPerTurn: [[review(), review(), review()]] }) })
  eq('with no criteria input the objective is the contract',
    r.value.acceptance_criteria, 'make the thing work')
}

// ---------------------------------------------------------------------------
group('ralph: unanimity over exactly two reviewers')

{
  const r = await runWorkflow(RALPH, { args: ralphArgs(),
    agent: seatRouter([[review(), review()]], { worker: () => implResult() }) })
  eq('both reviewers approving completes', r.value.status, 'complete')
  eq('approved flag set', r.value.approved, true)
  eq('reviewer count is the upstream constant', r.value.reviewer_count, 2)
}

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 1 }),
    agent: seatRouter([[review(), review({ stop_review_loop: false, findings: [finding()] })]],
      { worker: () => implResult() }) })
  eq('one dissenting reviewer blocks approval', r.value.approved, false)
  eq('and the run needs a human', r.value.status, 'needs_human')
}

{
  // A dead reviewer cannot be silently dropped into a 1-of-1 unanimity.
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 1 }),
    agent: seatRouter([[review(), null]], { worker: () => implResult() }) })
  eq('a crashed reviewer cannot produce unanimity', r.value.approved, false)
}

{
  // verifier_count is NOT an input for ralph: passing it must not shrink the
  // gate to a single reviewer (the port's "unanimity 1/1" hole).
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 1, verifier_count: 1 }),
    agent: seatRouter([[review(), review({ stop_review_loop: false })]],
      { worker: () => implResult() }) })
  eq('verifier_count cannot weaken the gate', r.value.reviewer_count, 2)
  eq('so a single approval still does not approve', r.value.approved, false)
}

group('ralph: the loop re-researches instead of only repairing')

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 3 }),
    agent: seatRouter([[review({ stop_review_loop: false, findings: [finding()] }),
      review({ stop_review_loop: false, findings: [finding()] })]],
      { worker: () => implResult() }) })
  const refines = r.calls.filter(c => (c.label ?? '').startsWith('refine:'))
  const research = r.calls.filter(c => (c.label ?? '').startsWith('research:report:'))
  const locators = r.calls.filter(c => c.opts.agentType === 'atomic:codebase-locator')
  eq('refinement runs once per iteration', refines.length, 3)
  eq('research runs once per iteration', research.length, 3)
  eq('codebase research runs once per iteration', locators.length, 3)
  check('later iterations are given the prior review round',
    refines.slice(1).every(c => c.prompt.includes('review-round-latest.json')))
  check('later refinements may change course, not just patch',
    refines.slice(1).every(c => c.prompt.includes('may change course')))
}

group('ralph: the refinement stage cannot author criteria')

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ acceptance_criteria: 'USER CLAUSE ONLY' }),
    agent: seatRouter([[review(), review()]], { worker: () => implResult() }) })
  eq('user criteria survive verbatim', r.value.acceptance_criteria, 'USER CLAUSE ONLY')
  eq('and are labelled as user input', r.value.acceptance_criteria_source, 'user input')
  const refine = r.calls.find(c => (c.label ?? '').startsWith('refine:'))
  const props = refine.opts.schema.properties
  check('the refinement schema has exactly one field', Object.keys(props).length === 1,
    JSON.stringify(Object.keys(props)))
  check('and it is the research question', 'research_question' in props)
  check('the refinement schema has no criteria field',
    !('acceptance_criteria' in props) && !('criteria' in props))
  check('the refinement stage is told the criteria are fixed',
    refine.prompt.includes('do not restate, extend, or reinterpret them')
      || refine.prompt.includes('Do not restate, extend, or reinterpret them'))
}

{
  const r = await runWorkflow(RALPH, { args: ralphArgs(),
    agent: seatRouter([[review(), review()]], { worker: () => implResult() }) })
  eq('with no criteria the raw prompt is the contract',
    r.value.acceptance_criteria, 'make the thing work')
  eq('and the source is labelled', r.value.acceptance_criteria_source, 'raw prompt (upstream default)')
}

group('ralph: unapproved work is handed off, not stranded')

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 1, create_pr: true }),
    agent: seatRouter([[review({ stop_review_loop: false, findings: [finding({ title: '[P0] unresolved thing', priority: 0 })] }),
      review({ stop_review_loop: false })]], { worker: () => implResult() }) })
  eq('an unapproved run with create_pr hands off', r.value.unapproved_handoff, true)
  const pr = r.calls.find(c => c.label === 'pull-request:draft')
  check('a DRAFT handoff stage runs', Boolean(pr))
  check('the draft policy forbids ready-for-review', pr.prompt.includes('never mark it ready for review'))
  check('unresolved findings must appear in the PR body',
    pr.prompt.includes('Unresolved review findings'))
  check('the actual finding travels with the handoff',
    pr.prompt.includes('unresolved thing'))
  check('it must not claim approval', pr.prompt.includes('Do not claim approval'))
}

{
  // Without create_pr the workflow never touches a PR, approved or not.
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 1 }),
    agent: seatRouter([[review({ stop_review_loop: false }), review({ stop_review_loop: false })]],
      { worker: () => implResult() }) })
  check('no PR stage without create_pr',
    !r.calls.some(c => (c.label ?? '').startsWith('pull-request')))
  eq('and no handoff is claimed', r.value.unapproved_handoff, false)
}

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ create_pr: true }),
    agent: seatRouter([[review(), review()]], { worker: () => implResult() }) })
  const pr = r.calls.find(c => c.label === 'pull-request')
  check('an approved run opens a normal PR', Boolean(pr))
  check('and it is not a draft', !pr.prompt.includes('never mark it ready for review'))
}

group('ralph: lifecycle and escalation')

{
  const r = await runWorkflow(RALPH, { args: ralphArgs(),
    agent: seatRouter([[review(), review()]], { worker: () => implResult() }) })
  check('the worker registers the run via the CLI',
    r.calls.some(c => c.prompt.includes('run-state.sh" begin r-test')))
  check('the run is sealed via the CLI',
    r.calls.some(c => c.prompt.includes('run-state.sh" seal r-test complete true')))
  const offenders = gateFileMentionsAreAllProhibitions(r.calls)
  check('every mention of a gate file is a prohibition, never an instruction',
    offenders.length === 0, offenders.join(' | '))
}

{
  const r = await runWorkflow(RALPH, { args: ralphArgs({ max_loops: 3 }),
    agent: seatRouter([[review(), review()]],
      { worker: () => implResult({ escalation: { needed: true, question: 'which storage backend?' } }) }) })
  eq('escalation stops the loop', r.value.status, 'needs_human')
  eq('and surfaces the question', r.value.escalation, 'which storage backend?')
  check('no reviewer grades escalated work',
    !r.calls.some(c => c.opts.agentType === 'atomic:verifier'))
  check('the run is still sealed',
    r.calls.some(c => c.prompt.includes('run-state.sh" seal r-test needs_human false')))
}

group('both: reviewers are read-only seats')

{
  for (const [name, path, a, ag] of [
    ['goal', GOAL, goalArgs(), router({ reviewsPerTurn: [[review(), review(), review()]] })],
    ['ralph', RALPH, ralphArgs(), seatRouter([[review(), review()]], { worker: () => implResult() })],
  ]) {
    const r = await runWorkflow(path, { args: a, agent: ag })
    const verifiers = r.calls.filter(c => c.opts.agentType === 'atomic:verifier')
    check(`${name}: reviewers run as atomic:verifier, never as worker`, verifiers.length > 0)
    check(`${name}: no reviewer is asked to fix anything`,
      verifiers.every(c => !/apply the fix|repair only|implement the/i.test(c.prompt)))
    check(`${name}: reviewers are told to inspect, not implement`,
      verifiers.every(c => /do not implement|never implement|Inspect and report/i.test(c.prompt)))
  }
}

report()
