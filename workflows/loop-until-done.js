export const meta = {
  name: 'loop-until-done',
  description: 'Bounded iterate-and-evaluate loop: worker increments with ledger receipts, fresh evaluator gates on explicit evidence of completion (port of Atomic loop-until-done)',
  phases: [
    { title: 'Iterate', detail: 'worker performs the next increment, appends ledger receipt' },
    { title: 'Evaluate', detail: 'fresh evaluator checks explicit evidence of completion' },
    { title: 'Finalize', detail: 'terminal run-state and final ledger line' },
  ],
}

// args: { run_id, prompt, max_iterations = 5 }
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
    '/atomic:loop-until-done {"run_id":"l-1","prompt":"..."}')
}
const A = atomicArgs(args)
if (!A.run_id) throw new Error('atomic: run_id required')
if (!/^[A-Za-z0-9._-]{1,64}$/.test(A.run_id))
  throw new Error('atomic: run_id must match [A-Za-z0-9._-], max 64 chars (no slashes, spaces, or quotes)')
if (!A.prompt) throw new Error('atomic: prompt required')
const MAX_ITERATIONS = Math.min(Math.max(A.max_iterations ?? 5, 1), 20) // Atomic default 5

const EVAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['done', 'evidence', 'remaining_work', 'evaluator_error'],
  properties: {
    done: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'string' } },
    remaining_work: { type: 'array', items: { type: 'string' } },
    evaluator_error: { type: ['string', 'null'] },
  },
}

// Deterministic gate, ported from Atomic loop-until-done: the loop continues
// until EXPLICIT EVIDENCE proves completion. A null evaluation (dead subagent)
// or an evaluator_error never counts as done — it just burns an iteration.
const evalDone = e => e?.done === true && e?.evaluator_error == null

const LEDGER_PATH = `.atomic-cc/runs/${A.run_id}/ledger.jsonl`
let iteration = 0
let remaining = [`Start the task; nothing has been attempted yet: ${A.prompt}`]
let done = false

while (iteration < MAX_ITERATIONS) {
  phase('Iterate')
  await agent(
    `You are the loop-until-done worker, atomic run "${A.run_id}", iteration ${iteration}.
${iteration === 0 ? `First: write .atomic-cc/run-state.json with
{"active_run": "${A.run_id}", "status": "in_progress"} (create directories as needed).` : ''}
Task (the durable contract, restated verbatim every iteration): ${A.prompt}
${iteration > 0 ? `Remaining work identified by the previous evaluation — do the next increment of ONLY this,
no scope creep:
${JSON.stringify(remaining, null, 2)}` : 'This is the first iteration.'}
Validate your change narrowly (build/tests for the touched area), then APPEND one JSON line to
the ledger ${LEDGER_PATH}:
{"iteration": ${iteration}, "actions": ["<what you did>"], "evidence": ["<commands run + outcomes>"], "remaining_work": ["<what you believe is left>"]}
Do NOT git commit or push: commits are gated.
Report what you did and what you believe remains.`,
    { agentType: 'atomic:worker', label: `iterate:${iteration}` })

  phase('Evaluate')
  const evaluation = await agent(
    `Fresh evaluator for atomic run "${A.run_id}", iteration ${iteration}. You did NOT do the
work; judge it cold.
Task: ${A.prompt}
Read the ledger ${LEDGER_PATH} and VERIFY its claims against the actual repo state: open the
files it names, re-run the cheap commands it cites, cite what you observed. Completion claims
without evidence are NOT completion — set done=true ONLY when explicit evidence proves the
task is fully complete. Otherwise set done=false and list concrete remaining_work items.
If you cannot evaluate (tooling failure, unreadable ledger), set evaluator_error to a short
message and done=false.`,
    { schema: EVAL_SCHEMA, label: `evaluate:${iteration}` })

  iteration += 1
  if (evalDone(evaluation)) { done = true; remaining = []; break }
  if (evaluation?.remaining_work?.length) remaining = evaluation.remaining_work
  else remaining = [`Previous evaluation returned no usable result (${evaluation?.evaluator_error ?? 'evaluator unavailable'}); re-verify the task state and continue: ${A.prompt}`]
  log(`atomic loop-until-done: iteration ${iteration - 1} not done (${evaluation ? evaluation.evaluator_error ?? 'evidence insufficient' : 'evaluator returned null'})`)
}
// Budget exhausted without proven completion → 'failed' (Atomic's exhaustion status).
const status = done ? 'complete' : 'failed'

phase('Finalize')
await agent(
  `Atomic loop-until-done run "${A.run_id}" ended: status "${status}", iterations used=${iteration}.
1. Update .atomic-cc/run-state.json to {"active_run": "${A.run_id}", "status": "${status}"}.
2. Append final ledger line to ${LEDGER_PATH}:
   {"iteration": ${iteration - 1}, "stage": "finalize", "summary": "${status}"}.
Do NOT git commit or push.`,
  { agentType: 'atomic:worker', label: 'finalize' })

return { status, iterations_completed: iteration, max_iterations: MAX_ITERATIONS,
         ledger_path: LEDGER_PATH, remaining_work: remaining }
