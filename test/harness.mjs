// Test harness: runs a real atomic-cc workflow script with the Claude Code
// workflow globals mocked, so the reducer, the gate arithmetic, and the run
// lifecycle are exercised end to end instead of being re-implemented in a test.
//
// The workflow files are plain scripts with a leading `export const meta`; the
// harness strips the `export ` keyword and evaluates the body as an async
// function with agent/parallel/pipeline/phase/log/args injected — the same
// contract the real runtime provides.
import { readFile } from 'node:fs/promises'

export async function runWorkflow(path, { args, agent }) {
  const source = await readFile(path, 'utf8')
  const body = source.replace(/^export const meta =/m, 'const meta =')

  const calls = []
  const phases = []
  const logs = []

  const trackedAgent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, agentType: opts.agentType, model: opts.model }
    calls.push(call)
    const result = await agent(call, calls.length - 1)
    call.result = result
    return result
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async t => {
    try { return await t() } catch { return null }
  }))
  const pipeline = async (items, ...stages) => {
    const out = []
    for (const [i, item] of items.entries()) {
      let value = item
      try {
        for (const stage of stages) value = await stage(value, item, i)
        out.push(value)
      } catch { out.push(null) }
    }
    return out
  }

  const fn = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget',
    `return (async () => { ${body} })()`)
  const value = await fn(args, trackedAgent, parallel, pipeline,
    t => phases.push(t), m => logs.push(m), { total: null, spent: () => 0, remaining: () => Infinity })

  return { value, calls, phases, logs }
}

// A schema-valid reviewer decision. Overrides let a test flip exactly one field
// so it is obvious which property is under test.
export function review(overrides = {}) {
  return {
    findings: [],
    overall_correctness: 'patch is correct',
    overall_explanation: 'Verified independently.',
    overall_confidence_score: 0.9,
    goal_oracle_satisfied: true,
    requirements_traceability: [{ requirement: 'the criterion', status: 'proven', evidence: 'ran the check' }],
    receipt_assessment: 'receipt maps to the outcome',
    verification_remaining: 'none',
    stop_review_loop: true,
    reviewer_error: null,
    ...overrides,
  }
}

export function finding(overrides = {}) {
  return {
    title: '[P1] something is wrong',
    body: 'observed behavior',
    confidence_score: 0.8,
    objective_alignment: 'consistent_with_objective',
    priority: 1,
    code_location: { absolute_file_path: '/repo/src/a.ts', line_range: { start: 10, end: 12 } },
    ...overrides,
  }
}

export function envError(message = 'pytest is not installed') {
  return { kind: 'dependency_unavailable', message, attempted_recovery: 'tried pip install' }
}

// --- tiny assertion kit -----------------------------------------------------
let passed = 0
const failures = []

export function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

export function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

export function group(name) { console.log(`\n${name}`) }

export function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`)
    process.exit(1)
  }
}
