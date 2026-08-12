export const meta = {
  name: 'adversarial-verification',
  description: 'Worker → fresh rubric verifiers (pass/fail) → LLM reducer with unanimity override → bounded repair (faithful port of Atomic adversarialVerification)',
  phases: [
    { title: 'Implement', detail: 'worker produces a candidate artifact' },
    { title: 'Verify', detail: 'N fresh-context verifiers return pass/fail + evidence' },
    { title: 'Reduce', detail: 'fresh-context reducer decides accept/reject/repair, unanimity enforced' },
    { title: 'Repair', detail: 'bounded repair of the candidate' },
  ],
}

// args: { run_id, task, verifier_count = 3, max_repairs = 2, plugin_root? }
// Faithful to Atomic adversarial-verification-runner.ts: a lean pass/fail
// verifier contract + a fresh-context LLM reducer, with a DETERMINISTIC override
// that only lets "accept" stand when ALL verifiers unanimously passed.
// Slash-command invocation delivers everything after the command name as a
// STRING, so accept a JSON string (optionally followed by prose) as well as an
// object passed programmatically.
function atomicArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    try { return JSON.parse(s) } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) } catch {} }
  }
  throw new Error('atomic: pass a JSON object of arguments, e.g. ' +
    '/atomic:adversarial-verification {"run_id":"av-1","task":"...","criteria":["..."]}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required (e.g. av-fix-login-01)')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.task) throw new Error('atomic: task required')
const N = Math.min(Math.max(A.verifier_count ?? 3, 1), 5)   // Atomic default 3
const MAX_REPAIRS = Math.min(Math.max(A.max_repairs ?? 2, 0), 5) // Atomic default 2
const RUN_DIR = `.atomic-cc/runs/${A.run_id}`
const CAND = `${RUN_DIR}/candidate.md`
// Gate-state transitions go only through the plugin CLI; direct writes to
// run-state.json / approval.json are denied by the tamper-guard hook.
const PLUGIN_ROOT = typeof A.plugin_root === 'string' ? A.plugin_root.trim() : ''
const runStateCmd = (sub) => PLUGIN_ROOT ? `"${PLUGIN_ROOT}/bin/run-state.sh" ${sub}` : null
// User-supplied criteria (CC extension over upstream, which has task-only input):
// folded verbatim into the verification rubric so they gate exactly like the
// built-in checks. Kept immutable for the whole run.
const CRITERIA = Array.isArray(A.criteria) ? A.criteria.map(String).filter(Boolean) : []
const RUBRIC = [
  'The candidate satisfies the literal task.',
  'Important claims cite observable evidence.',
  'Relevant validation is executed and reported with commands run and observed output.',
  'File findings cite file:line evidence where applicable.',
  'No blocking correctness, safety, or completeness gap remains.',
  ...CRITERIA.map(c => `Acceptance criterion (user-supplied, immutable): ${c}`),
]

const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'evidence', 'blocking_findings'],
  properties: {
    verdict: { enum: ['pass', 'fail'] },
    evidence: { type: 'array', items: { type: 'string' } },
    blocking_findings: { type: 'array', items: { type: 'string' } },
  },
}
const REDUCER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'rationale', 'remaining_work'],
  properties: {
    decision: { enum: ['accept', 'reject', 'repair'] },
    rationale: { type: 'string' },
    remaining_work: { type: 'array', items: { type: 'string' } },
  },
}

phase('Implement')
const BEGIN_CMD = runStateCmd(`begin ${A.run_id}`)
await agent(
  `You are the implementation worker for atomic run "${A.run_id}".
1. ${BEGIN_CMD
    ? `First action: register the run with the commit gate by running exactly:
   ${BEGIN_CMD}
   Never Write or Edit .atomic-cc/run-state.json or approval.json directly — a hook denies it, and the CLI is the only channel.`
    : 'plugin_root was not provided, so skip gate registration entirely (do NOT create .atomic-cc/run-state.json) and note "run-state registration skipped (no plugin_root)" in the candidate.'}
2. Implement this task, strictly in scope: ${A.task}
3. Validate your own change narrowly (run the relevant build/tests).
4. Write the CANDIDATE artifact to ${CAND}: a self-contained record of what you produced —
   what you did, the evidence (commands run + observed output), and file:line references.
Do NOT git commit or push: commits are gated until the run is approved.`,
  { agentType: 'atomic:worker', label: 'worker' })

let repairs = 0
let decision = { decision: 'reject', rationale: 'No valid reducer decision was produced.',
                 remaining_work: ['Reducer did not return a valid structured decision.'] }
for (;;) {
  phase('Verify')
  const reports = (await parallel(Array.from({ length: N }, (_, i) => () =>
    agent(
      `You are an independent verifier (${i + 1}/${N}), repair round ${repairs}, atomic run "${A.run_id}".
Verify the candidate at ${CAND} against this rubric — derive your checks from it FIRST, before
trusting anything the candidate claims:
${RUBRIC.map(r => `- ${r}`).join('\n')}
Task the candidate must satisfy: ${A.task}
Read the candidate, inspect the actual working tree, and RUN the relevant validation yourself
(cross-check against .atomic-cc/evidence/*.jsonl if present). Return verdict "pass" only when the
candidate fully satisfies the task with observable evidence; otherwise "fail" and list concrete
blocking_findings.`,
      { agentType: 'atomic:verifier', schema: VERIFIER_SCHEMA, label: `verify:r${repairs}:${i + 1}` })
  ))).filter(Boolean)

  // Deterministic unanimity override (Atomic: allVerifiersPassed requires the
  // full count AND every verdict === "pass"). A dropped/errored verifier -> not unanimous.
  const allPassed = reports.length === N && reports.every(r => r?.verdict === 'pass')

  phase('Reduce')
  const reduced = await agent(
    `You are the fresh-context reducer for atomic run "${A.run_id}", repair round ${repairs} of ${MAX_REPAIRS}.
Read the candidate at ${CAND}. Here are the ${reports.length} independent verifier reports:
${JSON.stringify(reports, null, 2)}
Decide: "accept" if the candidate satisfies the task with no blocking gap; "repair" if a bounded
fix could close the blocking findings and repairs remain; "reject" if it cannot be salvaged.
Base your rationale on the verifier evidence, not on the candidate's self-claims.`,
    { schema: REDUCER_SCHEMA, label: `reduce:r${repairs}` })
  decision = reduced ?? decision

  // Accept only stands under unanimous pass; otherwise force repair (if budget) or reject.
  if (decision.decision === 'accept' && !allPassed) {
    const remaining = reports.flatMap(r => r?.blocking_findings ?? [])
    decision = repairs < MAX_REPAIRS
      ? { decision: 'repair', rationale: 'Independent verification did not unanimously pass.', remaining_work: remaining }
      : { decision: 'reject', rationale: 'Independent verification did not pass before the repair bound was exhausted.', remaining_work: remaining }
  }
  if (decision.decision === 'repair' && repairs >= MAX_REPAIRS)
    decision = { ...decision, decision: 'reject', rationale: `${decision.rationale} Repair bound exhausted.` }
  if (decision.decision !== 'repair') break

  repairs += 1
  phase('Repair')
  await agent(
    `Atomic run "${A.run_id}", repair round ${repairs}. Repair ONLY the blocking findings below —
do not expand scope. Then rewrite the candidate at ${CAND} to reflect the repaired state.
Remaining work: ${JSON.stringify(decision.remaining_work, null, 2)}
Task (unchanged): ${A.task}
Do NOT git commit or push.`,
    { agentType: 'atomic:worker', label: `repair:r${repairs}` })
}

const approved = decision.decision === 'accept'
const status = approved ? 'complete' : 'rejected'

// Seal deterministically: the decision JSON is composed HERE and transcribed
// verbatim by the scribe, and the state transition is the CLI's job. No agent
// authors the gate token.
const SEAL_CMD = runStateCmd(`seal ${A.run_id} ${status} ${approved}`)
const decisionJson = JSON.stringify({
  run_id: A.run_id, status, approved,
  repairs_completed: repairs, max_repairs: MAX_REPAIRS,
  candidate_path: CAND, rubric: RUBRIC, decision,
}, null, 2)
await agent(
  `Transcribe the following artifact exactly as given (byte-for-byte, create directories as needed)${SEAL_CMD ? ' and then run the command exactly as written' : ''}. Do not author, reformat, or annotate content.

--- WRITE FILE: ${RUN_DIR}/decision.json ---
${decisionJson}
--- END FILE ---${SEAL_CMD ? `

--- RUN COMMAND (verbatim) ---
${SEAL_CMD}` : ''}`,
  { agentType: 'atomic:scribe', label: 'seal' })

return { status, approved, repairs_completed: repairs, candidate_path: CAND,
         remaining_work: approved ? [] : decision.remaining_work, decision }
