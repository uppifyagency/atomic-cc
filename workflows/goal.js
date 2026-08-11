export const meta = {
  name: 'goal',
  description: 'Bounded autonomous implementation loop: orchestrator turns → parallel reviewers → quorum gate on stop_review_loop → optional PR (port of Atomic goal)',
  phases: [
    { title: 'Implement', detail: 'orchestrated worker turns with ledger receipts' },
    { title: 'Verify', detail: 'parallel independent reviewers, quorum on stop_review_loop' },
    { title: 'Finalize', detail: 'seal approval, optional PR' },
  ],
}

// args: { run_id, objective, criteria = [], max_turns = 10, verifier_count = 3,
//         review_quorum = 2, base_branch = 'origin/main', create_pr = false }
// Slash-command invocation delivers everything after the command name as a
// STRING, so accept a JSON string (optionally followed by prose) too.
function atomicArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    try { return JSON.parse(s) } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch {} }
  }
  throw new Error('atomic: pass a JSON object of arguments, e.g. ' +
    '/atomic:goal {"run_id":"g-1","objective":"...","criteria":["..."]}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.objective) throw new Error('atomic: objective required')
const CRITERIA = Array.isArray(A.criteria) && A.criteria.length
  ? A.criteria
  : [`The objective is fully achieved as stated: ${A.objective}`]
const MAX_TURNS = Math.min(Math.max(A.max_turns ?? 10, 1), 30)
const N = Math.min(Math.max(A.verifier_count ?? 3, 1), 5)
const QUORUM = Math.min(Math.max(A.review_quorum ?? 2, 1), N) // Atomic DEFAULT_REVIEW_QUORUM = 2
const BLOCKER_THRESHOLD = 3                                      // Atomic DEFAULT_BLOCKER_THRESHOLD = 3

const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'requirements_traceability', 'stop_review_loop', 'reviewer_error'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'body', 'objective_alignment', 'confidence_score', 'code_location'],
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
              properties: { start: { type: 'integer' }, end: { type: 'integer' } } } } },
      }}},
    requirements_traceability: { type: 'array', items: { type: 'object',
      additionalProperties: false, required: ['requirement', 'status', 'evidence'],
      properties: { requirement: { type: 'string' },
        status: { enum: ['proven', 'contradicted', 'missing', 'unverified'] },
        evidence: { type: 'string' } }}},
    stop_review_loop: { type: 'boolean' },
    reviewer_error: { type: ['object', 'null'], additionalProperties: false,
      required: ['kind', 'message'],
      properties: { kind: { enum: ['validation_unavailable', 'dependency_unavailable',
                                   'tool_failure', 'reviewer_failure'] },
                    message: { type: 'string' }, attempted_recovery: { type: 'string' } } },
  },
}

// --- Convergence gate, ported from Atomic goal-reducer.ts + goal-review.ts ---
// The reviewer's stop_review_loop boolean is the SINGLE authoritative approval
// signal. The reducer completes on a QUORUM of approving reviewers and NEVER
// recomputes approval from findings/traceability arrays — Atomic deleted that
// recompute because it deadlocked runs whose criteria referenced the review
// process itself. A reviewer_error simply does not approve; it never aborts.
// isBlocking/normTitle build the REPAIR PAYLOAD only, not the gate decision.
function isBlocking(f) {
  const a = f.objective_alignment
  if (a === 'beyond_objective' || a === 'contradicts_objective') return false
  if (a === 'required_by_objective') return true
  if (a === 'consistent_with_objective')
    return f.priority == null ? true : f.priority <= 2
  return true
}
const normTitle = t => String(t).toLowerCase()
  .replace(/^\s*\[p[0-3]\]\s*/i, '').replace(/\s+/g, ' ').trim()
const reviewApproves = r => r?.stop_review_loop === true && r?.reviewer_error == null

function repairPayload(reviews) {
  const merged = new Map()
  for (const r of reviews) for (const f of (r?.findings ?? [])) {
    if (!f) continue
    const path = f.code_location?.absolute_file_path ?? 'unknown'
    const key = `${path}|${normTitle(f.title)}`
    const prev = merged.get(key)
    merged.set(key, { ...f, blocking: (prev?.blocking ?? false) || isBlocking(f) })
  }
  const blockers = [...merged.values()].filter(f => f.blocking)
  const unproven = reviews.flatMap(r => r?.requirements_traceability ?? [])
    .filter(Boolean).filter(t => t.status !== 'proven')
  return { blockers, unproven }
}

function reduce(reviews, expected, quorum) {
  // CC-specific safety (declared adaptation): workflow agents can resolve to
  // null on stop/unrecoverable error; fewer valid reviews than requested is
  // not convergence. Atomic's equivalent: parse failure synthesizes a
  // stop_review_loop:false decision, so it likewise cannot approve.
  const payload = repairPayload(reviews)
  if (reviews.length === 0 || reviews.length < expected)
    return { next: 'implementation', approvals: 0, ...payload,
             reason: `only ${reviews.length}/${expected} reviewers returned` }
  const approvals = reviews.filter(reviewApproves).length
  if (approvals >= quorum)
    return { next: 'finish', approvals, blockers: [], unproven: [],
             reason: `reviewer quorum met: ${approvals}/${quorum}` }
  return { next: 'implementation', approvals, ...payload,
           reason: `reviewer quorum not met: ${approvals}/${quorum}` }
}

const LENSES = ['correctness', 'security', 'does-it-reproduce', 'performance', 'completeness']
let decision = { next: 'implementation', blockers: [], unproven: [], approvals: 0 }
let turn = 0
let lastBlockerSig = null, blockerStreak = 0
let terminal = null // 'complete' | 'blocked' | 'needs_human'

while (turn < MAX_TURNS) {
  phase('Implement')
  await agent(
    `You are the goal orchestrator's worker, atomic run "${A.run_id}", turn ${turn}.
${turn === 0 ? `First: write .atomic-cc/run-state.json with
{"active_run": "${A.run_id}", "status": "in_progress"} (create directories as needed).` : ''}
Objective (the durable contract): ${A.objective}
Acceptance criteria (IMMUTABLE, restated verbatim every turn):
${JSON.stringify(CRITERIA, null, 2)}
${turn > 0 ? `Open blocking findings from the previous review — repair ONLY these, no scope creep:
${JSON.stringify(decision.blockers, null, 2)}
Unproven requirements: ${JSON.stringify(decision.unproven, null, 2)}` : 'This is the first implementation turn.'}
Base branch: ${A.base_branch ?? 'origin/main'}.
Validate your change narrowly (build/tests for the touched area), then APPEND one JSON line to
the ledger .atomic-cc/runs/${A.run_id}/ledger.jsonl:
{"turn": ${turn}, "stage": "implement", "artifact_path": "<main file touched>", "summary": "<one line>"}
Do NOT git commit or push: commits are gated until the reducer approves.`,
    { agentType: 'atomic:worker', label: `turn:${turn}` })

  phase('Verify')
  const reviews = (await parallel(Array.from({ length: N }, (_, i) => () =>
    agent(
      `Independent reviewer (lens: ${LENSES[i % LENSES.length]}), atomic run "${A.run_id}", turn ${turn}.
Derive your probe objectives from the LITERAL acceptance criteria BEFORE reading any ledger
or receipts:
${JSON.stringify(CRITERIA, null, 2)}
Objective: ${A.objective}
Inspect the actual checkout delta against ${A.base_branch ?? 'origin/main'} yourself; run the
relevant commands; cite absolute file paths and line ranges. Cross-check claims against real
command logs in .atomic-cc/evidence/*.jsonl if present.
Set stop_review_loop=true ONLY when the objective is met: no blocking P0/P1/P2 finding and no
required_by_objective finding at any priority remain. In-scope P3 nice-to-haves, out-of-scope
observations, and clauses about the review/PR process itself must NOT hold the flag at false.`,
      { agentType: 'atomic:verifier', schema: VERIFIER_SCHEMA,
        label: `verify:t${turn}:${LENSES[i % LENSES.length]}` })
  ))).filter(Boolean)

  decision = reduce(reviews, N, QUORUM)
  if (decision.next === 'finish') { terminal = 'complete'; break }

  // Anti-loop, ported from Atomic consecutiveBlockerTurns: the same blocker set
  // repeated BLOCKER_THRESHOLD consecutive turns marks the run blocked.
  const sig = decision.blockers
    .map(b => `${b.code_location?.absolute_file_path ?? 'unknown'}|${normTitle(b.title)}`)
    .sort().join('~')
  if (sig && sig === lastBlockerSig) blockerStreak += 1
  else { blockerStreak = 1; lastBlockerSig = sig }
  if (sig && blockerStreak >= BLOCKER_THRESHOLD) { terminal = 'blocked'; break }

  turn += 1
}
// Budget exhausted without quorum → needs_human (Atomic goal has no 'incomplete').
if (!terminal) terminal = 'needs_human'
const status = terminal
const approved = status === 'complete'

phase('Finalize')
await agent(
  `Atomic goal run "${A.run_id}" ended: status "${status}", approved=${approved}, turns used=${turn + 1}.
1. Update .atomic-cc/run-state.json to {"active_run": "${A.run_id}", "status": "${status}"}.
2. Append final ledger line to .atomic-cc/runs/${A.run_id}/ledger.jsonl:
   {"turn": ${turn}, "stage": "reduce", "artifact_path": "ledger", "summary": "${status}"}.
${approved
    ? `3. Write {"approved": true, "human": false, "run_id": "${A.run_id}"} to
   .atomic-cc/runs/${A.run_id}/approval.json.
${A.create_pr ? `4. The run is approved AND create_pr=true: commit the work on a feature branch and
   open a PR against ${A.base_branch ?? 'origin/main'} using gh, with the objective and the
   final decision in the body.` : '4. create_pr=false: stop after sealing approval. No commit.'}`
    : `3. Do NOT write approval.json. Write the decision to
   .atomic-cc/runs/${A.run_id}/decision.json: ${JSON.stringify(decision)}`}`,
  { agentType: 'atomic:worker', label: 'finalize' })

return { status, approved, turns_used: turn + 1, max_turns: MAX_TURNS, review_quorum: QUORUM,
         ledger_path: `.atomic-cc/runs/${A.run_id}/ledger.jsonl`, decision }
