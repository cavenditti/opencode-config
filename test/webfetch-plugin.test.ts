import assert from "node:assert/strict"
import WebfetchPlugin from "../plugin/webfetch.ts"

const asks: Array<{ permission: string; patterns: string[] }> = []
let fetchCount = 0
const controller = new AbortController()
const originalFetch = globalThis.fetch
const mockFetch = async (input: RequestInfo | URL) => {
  fetchCount++
  const url = String(input)
  if (url === "http://127.0.0.1/redirect") {
    return new Response(null, { status: 302, headers: { location: "/page" } })
  }
  if (url === "http://127.0.0.1/page") {
    return new Response("<h1>Hello</h1><script>secret()</script><p>World</p>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }
  throw new Error(`Unexpected fetch: ${url}`)
}
globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect })

try {
  const hooks = await WebfetchPlugin({} as never, {})
  const definition = hooks.tool?.webfetch
  const permissionDefinition = hooks.tool?.webfetch_request_permission
  assert.ok(definition)
  assert.ok(permissionDefinition)
  const context = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: controller.signal,
    metadata() {},
    async ask(input: { permission: string; patterns: string[] }) {
      asks.push(input)
    },
  }

  const args = {
    url: "http://127.0.0.1/redirect",
    format: "markdown",
    timeout: 5,
    description: "Exercise redirect checks and HTML conversion",
  } as const

  const first = await definition.execute(args, context as never)
  assert.notEqual(typeof first, "string")
  if (typeof first !== "string") assert.match(first.output, /Attempts: 1\/2/)
  assert.equal(fetchCount, 0)
  assert.equal(asks.length, 0)

  const second = await definition.execute(args, context as never)
  assert.notEqual(typeof second, "string")
  const denialOutput = typeof second === "string" ? second : second.output
  const requestID = denialOutput.match(/request_id "([^"]+)"/)?.[1]
  assert.ok(requestID)
  assert.match(denialOutput, /Attempts: 2\/2/)
  assert.equal(fetchCount, 0)
  assert.equal(asks.length, 0)

  await assert.rejects(
    permissionDefinition.execute({ ...args, request_id: "invalid" }, context as never),
    /invalid or expired/,
  )
  await assert.rejects(
    permissionDefinition.execute({ ...args, url: "http://127.0.0.1/different", request_id: requestID }, context as never),
    /does not match these tool arguments/,
  )
  const result = await permissionDefinition.execute({ ...args, request_id: requestID }, context as never)
  assert.notEqual(typeof result, "string")
  if (typeof result !== "string") {
    assert.match(result.output, /^# Hello/m)
    assert.match(result.output, /World/)
    assert.doesNotMatch(result.output, /secret\(\)/)
    assert.equal(result.metadata?.redirects, 1)
  }
  assert.equal(fetchCount, 2, "the explicitly authorized fetch must follow and recheck its redirect")
  assert.equal(asks.length, 1, "same-origin redirects in the approved safety scope share one prompt")
  assert.ok(asks.every((ask) => ask.permission === "webfetch"))

  await assert.rejects(
    definition.execute({ url: "file:///etc/passwd", format: "text", timeout: 5 }, context as never),
    /Blocked by webfetch safety policy/,
  )
  await assert.rejects(
    definition.execute({ url: "http://169.254.169.254/latest/meta-data/", format: "text", timeout: 5 }, context as never),
    /Cloud metadata endpoint blocked/,
  )

  console.log("PASS webfetch non-interactive denial, gated permission, redirect, rendering, and hard deny")
} finally {
  controller.abort()
  globalThis.fetch = originalFetch
}
