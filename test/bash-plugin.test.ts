import assert from "node:assert/strict"
import BashPlugin from "../plugin/bash.ts"

const originalBun = globalThis.Bun
const asks: Array<{ permission: string; patterns: string[]; always: string[] }> = []
let spawnCount = 0
globalThis.Bun = {
  ...originalBun,
  spawn() {
    spawnCount++
    return {
      stdout: "mock stdout",
      stderr: "",
      exited: Promise.resolve(0),
      kill() {},
    }
  },
} as unknown as typeof Bun

try {
  const hooks = await BashPlugin()
  const standard = hooks.tool?.bash
  const permission = hooks.tool?.bash_request_permission
  assert.ok(standard)
  assert.ok(permission)

  const context = {
    sessionID: "bash-session",
    messageID: "assistant-message",
    agent: "test-agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask(input: { permission: string; patterns: string[]; always: string[] }) {
      asks.push(input)
    },
  }
  const args = { command: "git push --force", description: "Test permission gating" }

  const first = await standard.execute(args, context as never)
  assert.notEqual(typeof first, "string")
  if (typeof first !== "string") assert.match(first.output, /Attempts: 1\/2/)
  assert.equal(spawnCount, 0)
  assert.equal(asks.length, 0)

  const second = await standard.execute(args, context as never)
  assert.notEqual(typeof second, "string")
  const output = typeof second === "string" ? second : second.output
  const requestID = output.match(/request_id "([^"]+)"/)?.[1]
  assert.ok(requestID)
  assert.match(output, /Attempts: 2\/2/)
  assert.equal(asks.length, 0)

  await assert.rejects(
    permission.execute({ ...args, request_id: "invalid" }, context as never),
    /invalid or expired/,
  )
  const result = await permission.execute({ ...args, request_id: requestID }, context as never)
  assert.notEqual(typeof result, "string")
  if (typeof result !== "string") assert.match(result.output, /mock stdout/)
  assert.equal(spawnCount, 1)
  assert.equal(asks.length, 1)
  assert.equal(asks[0]?.permission, "bash")
  assert.deepEqual(asks[0]?.always, [])

  const spent = await standard.execute(args, context as never)
  assert.notEqual(typeof spent, "string")
  if (typeof spent !== "string") assert.match(spent.output, /already used/)

  await assert.rejects(
    standard.execute({ command: "rm -rf /" }, context as never),
    /Blocked by safety policy/,
  )
  console.log("PASS bash non-interactive denial, gated permission request, execution, and hard deny")
} finally {
  globalThis.Bun = originalBun
}
