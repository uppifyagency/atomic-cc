export const meta = {
  name: 'ralph',
  description: 'Refine → codebase research → delegated implementation → fresh-context review (unanimous gate) → bounded repair → optional PR (port of Atomic ralph)',
  phases: [
    { title: 'Refine', detail: 'turn the raw prompt into a spec with acceptance criteria' },
    { title: 'Research', detail: 'parallel codebase and online research' },
    { title: 'Implement', detail: 'worker implements the refined spec' },
    { title: 'Verify', detail: 'fresh-context reviewers, unanimous stop_review_loop gate' },
    { title: 'Repair', detail: 'bounded repair loop' },
    { title: 'Finalize', detail: 'seal approval, optional PR' },
  ],
}

// args: { run_id, prompt, criteria = [], max_loops = 10, verifier_count = 3,
//         base_branch = 'origin/main', create_pr = false }
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
    '/atomic:ralph {"run_id":"r-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const MAX_LOOPS = Math.min(Math.max(A.max_loops ?? 10, 1), 20)
const N = Math.min(Math.max(A.verifier_count ?? 3, 1), 5)
const QUORUM = N // Atomic ralph is unanimous: approvalCount === REVIEWER_COUNT

const SPEC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['refined_task', 'acceptance_criteria', 'research_question'],
  properties: {
    refined_task: { type: 'string' },
    acceptance_criteria: { type: 'array', minItems: 1, items: { type: 'string' } },
    research_question: { type: 'string' },
  },
}

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

// Convergence gate ported from Atomic ralph-review-gate.ts: stop_review_loop is
// the single authoritative signal; approval never recomputed from findings/
// traceability; reviewer_error does not approve but never aborts. blockers/
// unproven are the repair payload only.
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
  const payload = repairPayload(reviews)
  if (reviews.length === 0 || reviews.length < expected)
    return { next: 'implementation', approvals: 0, ...payload,
             reason: `only ${reviews.length}/${expected} reviewers returned` }
  const approvals = reviews.filter(reviewApproves).length
  if (approvals >= quorum)
    return { next: 'finish', approvals, blockers: [], unproven: [],
             reason: `unanimous approval: ${approvals}/${quorum}` }
  return { next: 'implementation', approvals, ...payload,
           reason: `not unanimous: ${approvals}/${quorum}` }
}

phase('Refine')
const spec = await agent(
  `Refine this raw engineering prompt into a precise spec. Keep the user's intent exactly;
do not invent requirements. Raw prompt: ${A.prompt}
${Array.isArray(A.criteria) && A.criteria.length
    ? `The user already provided these acceptance criteria — keep them verbatim and only ADD
missing testable ones: ${JSON.stringify(A.criteria)}`
    : 'Derive minimal, testable acceptance criteria from the prompt.'}
Also produce the single most valuable research question about this codebase for the task.`,
  { schema: SPEC_SCHEMA, label: 'refine' })
if (!spec) throw new Error('atomic ralph: refine stage returned null')
const CRITERIA = spec.acceptance_criteria

phase('Research')
const research = (await parallel([
  () => agent(
    `Research question: ${spec.research_question}
Task context: ${spec.refined_task}
Find the relevant files, directories, tests, and configs. Return a compact list of paths with
one line each on why they matter.`,
    { agentType: 'atomic:codebase-locator', label: 'research:locator' }),
  () => agent(
    `Task: ${spec.refined_task}
Explain how the code involved currently works: trace the data flow with file:line references.
Return a compact technical brief.`,
    { agentType: 'atomic:codebase-analyzer', label: 'research:analyzer' }),
  () => agent(
    `Task: ${spec.refined_task}
Research official docs and ecosystem behavior relevant to this task. Return key facts with
source URLs. Skip anything you cannot source.`,
    { agentType: 'atomic:codebase-online-researcher', label: 'research:online' }),
])).filter(Boolean)

phase('Implement')
await agent(
  `You are the implementation worker for atomic ralph run "${A.run_id}".
1. First: write .atomic-cc/run-state.json with {"active_run": "${A.run_id}", "status": "in_progress"}.
2. Implement this refined task, strictly in scope: ${spec.refined_task}
Acceptance criteria (IMMUTABLE):
${JSON.stringify(CRITERIA, null, 2)}
Research briefs from independent researchers:
${research.map((r, i) => `--- brief ${i} ---\n${String(r).slice(0, 4000)}`).join('\n')}
3. Validate narrowly, then write a receipt to .atomic-cc/runs/${A.run_id}/receipt-0.json
   ({turn, stage, artifact_path, summary}).
Do NOT git commit or push.`,
  { agentType: 'atomic:worker', label: 'implement' })

const LENSES = ['correctness', 'security', 'does-it-reproduce', 'performance', 'completeness']
let decision = { next: 'implementation', blockers: [], unproven: [], approvals: 0 }
let loop = 0
let terminal = null // 'complete' | 'needs_human'
while (loop < MAX_LOOPS) {
  phase('Verify')
  const reviews = (await parallel(Array.from({ length: N }, (_, i) => () =>
    agent(
      `Independent fresh-context reviewer (lens: ${LENSES[i % LENSES.length]}),
atomic ralph run "${A.run_id}", loop ${loop}.
Acceptance criteria — derive checks LITERALLY from these first:
${JSON.stringify(CRITERIA, null, 2)}
Refined task: ${spec.refined_task}
Inspect the working tree yourself; run the checks; cite absolute paths and line ranges.
Cross-check claims against .atomic-cc/evidence/*.jsonl if present.
Set stop_review_loop=true ONLY when no blocking P0/P1/P2 finding and no required_by_objective
finding at any priority remain. P3 nice-to-haves and out-of-scope observations must NOT hold
the flag at false.`,
      { agentType: 'atomic:verifier', schema: VERIFIER_SCHEMA,
        label: `verify:l${loop}:${LENSES[i % LENSES.length]}` })
  ))).filter(Boolean)

  decision = reduce(reviews, N, QUORUM)
  if (decision.next === 'finish') { terminal = 'complete'; break }

  phase('Repair')
  await agent(
    `Atomic ralph run "${A.run_id}", repair loop ${loop}. Repair ONLY these blocking findings:
${JSON.stringify(decision.blockers, null, 2)}
Unproven requirements: ${JSON.stringify(decision.unproven, null, 2)}
Acceptance criteria (IMMUTABLE): ${JSON.stringify(CRITERIA)}
Update receipt at .atomic-cc/runs/${A.run_id}/receipt-${loop + 1}.json. No commits.`,
    { agentType: 'atomic:worker', label: `repair:l${loop}` })
  loop += 1
}
if (!terminal) terminal = 'needs_human'
const status = terminal
const approved = status === 'complete'

phase('Finalize')
await agent(
  `Atomic ralph run "${A.run_id}" ended with status "${status}", approved=${approved}.
1. Update .atomic-cc/run-state.json to {"active_run": "${A.run_id}", "status": "${status}"}.
${approved
    ? `2. Write {"approved": true, "human": false, "run_id": "${A.run_id}"} to
   .atomic-cc/runs/${A.run_id}/approval.json.
${A.create_pr ? `3. The run is approved AND create_pr=true: commit the work on a feature branch and
   open a PR against ${A.base_branch ?? 'origin/main'} using gh, with the refined task and
   acceptance criteria in the body.` : '3. create_pr=false: stop after sealing approval. No commit.'}`
    : `2. No approval.json. Write the decision to .atomic-cc/runs/${A.run_id}/decision.json:
   ${JSON.stringify(decision)}`}`,
  { agentType: 'atomic:worker', label: 'finalize' })

return { status, approved, loops_used: loop, refined_task: spec.refined_task,
         acceptance_criteria: CRITERIA, decision }
