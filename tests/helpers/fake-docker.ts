// External Docker boundary for updater tests. No Docker daemon is contacted.
import fs from 'node:fs'
const args = process.argv.slice(2)
interface State { scenario: string; current: string; modes: Record<string, string>; events: string[]; pullFail?: boolean }
const file = process.env.OVERSEER_TEST_DOCKER_STATE!
const state = JSON.parse(fs.readFileSync(file, 'utf8')) as State
const old = 'a'.repeat(64), replacement = 'c'.repeat(64), rollback = 'd'.repeat(64)
const imageOld = `sha256:${'1'.repeat(64)}`, imageNew = `sha256:${'2'.repeat(64)}`
const output = (value: string) => console.log(value)
const fail = () => { fs.writeFileSync(file, JSON.stringify(state)); process.exit(1) }
if (args[0] === 'compose') {
  if (args.includes('ps')) output(state.current)
  else if (args.includes('config')) output('ghcr.io/example/overseer:latest')
  else if (args.includes('pull')) { if (state.scenario === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); state.events.push('pull'); if (state.pullFail) fail() }
  else if (args.includes('up')) {
    const pinned = args.find((value) => value.endsWith('pinned.yaml'))!
    const restoring = fs.readFileSync(pinned, 'utf8').includes('overseer-rollback:')
    if (state.modes[state.current] !== 'sealed') throw new Error('unsafe replacement before current service is idle and sealed')
    state.events.push(restoring ? 'rollback' : 'replace')
    state.current = restoring ? rollback : replacement
    state.modes[state.current] = 'running'
  }
} else if (args[0] === 'exec') {
  const id = args.find((value) => /^[a-f0-9]{64}$/.test(value))!
  const action = args.at(-1)!
  const label = id === old ? 'old' : id === replacement ? 'new' : 'rollback'
  state.events.push(`${label}:${action}`)
  if ((state.scenario === 'legacy' && label === 'old') || (state.scenario === 'unhealthy' && label === 'new' && action === 'await-ready') || (state.scenario === 'unreachable' && label === 'new')) fail()
  if (state.scenario === 'drain-fail' && label === 'old' && action === 'wait') fail()
  if (state.scenario === 'resume-fail' && label === 'old' && ['wait', 'resume'].includes(action)) fail()
  if (action === 'wait') state.modes[id] = 'sealed'
  if (action === 'sealed' && state.modes[id] !== 'sealed') fail()
  if (action === 'resume') state.modes[id] = 'running'
  output(`${label}-instance-123`)
} else if (args[0] === 'inspect') output(state.current === old ? imageOld : imageNew)
else if (args[0] === 'image' && args[1] === 'inspect') output(state.scenario === 'current' ? imageOld : imageNew)
else if (args[0] === 'run') state.events.push('preflight')
else if (!(args[0] === 'image' && ['tag', 'rm'].includes(args[1]!))) throw new Error(`Unexpected Docker command ${args.join(' ')}`)
fs.writeFileSync(file, JSON.stringify(state))
