import assert from "node:assert/strict"
import { PermissionRetryGate } from "../plugin/permission-gate/index.ts"

const originalThreshold = process.env.OPENCODE_PERMISSION_RETRY_THRESHOLD
process.env.OPENCODE_PERMISSION_RETRY_THRESHOLD = "2"

try {
  const gate = new PermissionRetryGate()
  const identity = { sessionID: "session", agent: "agent", epoch: "message", scope: "operation-a", binding: "arguments-a" }
  const first = gate.record(identity)
  assert.equal(first.attempts, 1)
  assert.equal(first.requestID, undefined)

  const second = gate.record(identity)
  assert.equal(second.attempts, 2)
  assert.ok(second.requestID)
  assert.equal(gate.validate(identity, second.requestID), undefined)
  assert.match(gate.validate({ ...identity, scope: "operation-b" }, second.requestID) ?? "", /does not match/)
  assert.match(gate.validateContext({ ...identity, epoch: "new-message" }, second.requestID) ?? "", /does not belong/)
  assert.match(gate.validateContext(identity, second.requestID, "arguments-b") ?? "", /does not match these tool arguments/)

  assert.equal(gate.consume(identity, second.requestID), undefined)
  assert.match(gate.validate(identity, second.requestID) ?? "", /already used/)
  assert.equal(gate.record(identity).spent, true)

  gate.resetSession(identity.sessionID)
  const nextIdentity = { ...identity, epoch: "new-message" }
  assert.equal(gate.record(nextIdentity).attempts, 1)
  const nextToken = gate.record(nextIdentity).requestID
  assert.ok(nextToken)
  assert.equal(gate.consumeContext(nextIdentity, nextToken, nextIdentity.binding), undefined)
  assert.match(gate.validateContext(nextIdentity, nextToken) ?? "", /invalid or expired/)
  console.log("PASS permission retry threshold, token binding, one-shot consumption, and session reset")
} finally {
  if (originalThreshold === undefined) delete process.env.OPENCODE_PERMISSION_RETRY_THRESHOLD
  else process.env.OPENCODE_PERMISSION_RETRY_THRESHOLD = originalThreshold
}
