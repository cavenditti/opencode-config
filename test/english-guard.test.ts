import assert from "node:assert/strict"
import * as pluginModule from "../plugin/english-guard.ts"
import { hasSubstantialHan, isTargetModel } from "../plugin/english-guard/core.ts"

const EnglishGuard = pluginModule.default
assert.deepEqual(Object.keys(pluginModule), ["default"], "top-level plugin files must export only plugin factories")
assert.equal(hasSubstantialHan("Use the field 名称 as-is."), false)
assert.equal(hasSubstantialHan("我们需要先检查配置，然后继续修复这个问题。"), true)
assert.equal(isTargetModel("openrouter", "z-ai/glm-5.2"), true)
assert.equal(isTargetModel("openrouter", "moonshotai/kimi-k3"), true)
assert.equal(isTargetModel("openrouter", "openai/gpt-5.2"), false)

const originalFetch = globalThis.fetch
const originalKey = process.env.OPENROUTER_API_KEY
const patches: Array<Record<string, unknown>> = []
process.env.OPENROUTER_API_KEY = "test-key"

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === "openrouter.ai") {
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translation: "We should inspect the configuration and continue with the fix." }) } }] })
  }
  if (request.method === "PATCH" && url.pathname.includes("/part/")) {
    const body = await request.json() as Record<string, unknown>
    patches.push(body)
    return Response.json(body)
  }
  throw new Error(`Unexpected request: ${request.method} ${request.url}`)
}
globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect })

try {
  const hooks = await EnglishGuard({
    directory: process.cwd(),
    serverUrl: new URL("http://opencode.test"),
  } as never)

  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({
    sessionID: "ses_test",
    model: { providerID: "openrouter", id: "z-ai/glm-5.2" } as never,
  }, system)
  assert.equal(system.system.length, 1)
  assert.match(system.system[0]!, /use English exclusively/)

  const completed = { text: "我们需要先检查配置，然后继续修复这个问题。" }
  await hooks["experimental.text.complete"]?.({ sessionID: "ses_test", messageID: "msg_text", partID: "part_text" }, completed)
  assert.match(completed.text, /Translated from Chinese by English Guard/)
  assert.match(completed.text, /inspect the configuration/)

  await hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_reasoning",
          sessionID: "ses_test",
          messageID: "msg_reasoning",
          type: "reasoning",
          text: "我们需要先检查配置，然后继续修复这个问题。",
          time: { start: 1, end: 2 },
        },
      },
    },
  })
  await hooks.dispose?.()
  assert.equal(patches.length, 1)
  assert.match(String(patches[0]?.text), /Translated from Chinese by English Guard/)
  assert.deepEqual((patches[0]?.metadata as Record<string, unknown>)?.englishGuard && {
    translatedFrom: ((patches[0]?.metadata as Record<string, any>).englishGuard).translatedFrom,
  }, { translatedFrom: "zh" })

  const nonTarget = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({
    sessionID: "ses_other",
    model: { providerID: "openrouter", id: "openai/gpt-5.2" } as never,
  }, nonTarget)
  assert.equal(nonTarget.system.length, 0)

  console.log("PASS English system guard, model targeting, text translation, and reasoning-part replacement")
} finally {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = originalKey
}
