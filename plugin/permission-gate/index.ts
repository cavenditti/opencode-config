import { createHash, randomBytes } from "node:crypto"

const DEFAULT_THRESHOLD = 2
const MIN_THRESHOLD = 2
const MAX_THRESHOLD = 5
const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 256

export type RetryIdentity = {
  sessionID: string
  agent: string
  epoch: string
  scope: string
  binding?: string
}

export type RetryContext = Omit<RetryIdentity, "scope">

export type RetryStatus = {
  attempts: number
  threshold: number
  requestID?: string
  spent: boolean
}

type Attempt = {
  count: number
  updatedAt: number
  sessionID: string
  requestID?: string
}

type Token = {
  key: string
  expiresAt: number
  sessionID: string
  agent: string
  epoch: string
  binding: string
}

function configuredThreshold(): number {
  const parsed = Number.parseInt(process.env.OPENCODE_PERMISSION_RETRY_THRESHOLD ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_THRESHOLD
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, parsed))
}

function identityKey(identity: RetryIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.sessionID, identity.agent, identity.epoch, identity.scope]))
    .digest("hex")
}

function bindingKey(binding: string): string {
  return createHash("sha256").update(binding).digest("hex")
}

export class PermissionRetryGate {
  private readonly attempts = new Map<string, Attempt>()
  private readonly tokens = new Map<string, Token>()
  private readonly spent = new Map<string, { expiresAt: number; sessionID: string }>()

  record(identity: RetryIdentity): RetryStatus {
    const now = Date.now()
    this.prune(now)
    const threshold = configuredThreshold()
    const key = identityKey(identity)
    if (this.spent.has(key)) return { attempts: threshold, threshold, spent: true }

    const attempt = this.attempts.get(key) ?? { count: 0, updatedAt: now, sessionID: identity.sessionID }
    attempt.count++
    attempt.updatedAt = now
    if (attempt.count >= threshold) {
      const token = attempt.requestID ? this.tokens.get(attempt.requestID) : undefined
      if (!token || token.expiresAt <= now) {
        if (attempt.requestID) this.tokens.delete(attempt.requestID)
        attempt.requestID = randomBytes(18).toString("base64url")
        this.tokens.set(attempt.requestID, {
          key,
          expiresAt: now + TOKEN_TTL_MS,
          sessionID: identity.sessionID,
          agent: identity.agent,
          epoch: identity.epoch,
          binding: bindingKey(identity.binding ?? identity.scope),
        })
      }
    }
    this.attempts.set(key, attempt)
    this.trim()
    return {
      attempts: attempt.count,
      threshold,
      requestID: attempt.requestID,
      spent: false,
    }
  }

  validate(identity: RetryIdentity, requestID: string): string | undefined {
    const now = Date.now()
    this.prune(now)
    const key = identityKey(identity)
    if (this.spent.has(key)) return "Permission escalation was already used for this operation in the current user turn."
    const token = this.tokens.get(requestID)
    if (!token || token.expiresAt <= now) return "Permission request ID is invalid or expired."
    if (token.key !== key) return "Permission request ID does not match this operation, agent, session, or user turn."
    return undefined
  }

  validateContext(context: RetryContext, requestID: string, binding?: string): string | undefined {
    const now = Date.now()
    this.prune(now)
    const token = this.tokens.get(requestID)
    if (!token || token.expiresAt <= now) return "Permission request ID is invalid or expired."
    if (token.sessionID !== context.sessionID || token.agent !== context.agent || token.epoch !== context.epoch) {
      return "Permission request ID does not belong to this agent, session, or user turn."
    }
    if (binding !== undefined && token.binding !== bindingKey(binding)) {
      return "Permission request ID does not match these tool arguments."
    }
    return undefined
  }

  consume(identity: RetryIdentity, requestID: string): string | undefined {
    const invalid = this.validate(identity, requestID)
    if (invalid) return invalid
    const key = identityKey(identity)
    this.tokens.delete(requestID)
    this.attempts.delete(key)
    this.spent.set(key, { expiresAt: Date.now() + TOKEN_TTL_MS, sessionID: identity.sessionID })
    return undefined
  }

  consumeContext(context: RetryContext, requestID: string, binding?: string): string | undefined {
    const invalid = this.validateContext(context, requestID, binding)
    if (invalid) return invalid
    const token = this.tokens.get(requestID)!
    this.tokens.delete(requestID)
    this.attempts.delete(token.key)
    this.spent.set(token.key, { expiresAt: Date.now() + TOKEN_TTL_MS, sessionID: context.sessionID })
    return undefined
  }

  resetSession(sessionID: string): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.sessionID !== sessionID) continue
      if (attempt.requestID) this.tokens.delete(attempt.requestID)
      this.attempts.delete(key)
    }
    for (const [requestID, token] of this.tokens) {
      if (token.sessionID === sessionID) this.tokens.delete(requestID)
    }
    for (const [key, entry] of this.spent) {
      if (entry.sessionID === sessionID) this.spent.delete(key)
    }
  }

  private prune(now: number): void {
    for (const [requestID, token] of this.tokens) {
      if (token.expiresAt <= now) this.tokens.delete(requestID)
    }
    for (const [key, entry] of this.spent) {
      if (entry.expiresAt <= now) this.spent.delete(key)
    }
  }

  private trim(): void {
    while (this.attempts.size > MAX_ENTRIES) {
      const oldest = [...this.attempts.entries()].reduce((a, b) => a[1].updatedAt <= b[1].updatedAt ? a : b)
      if (oldest[1].requestID) this.tokens.delete(oldest[1].requestID)
      this.attempts.delete(oldest[0])
    }
    while (this.spent.size > MAX_ENTRIES) this.spent.delete(this.spent.keys().next().value!)
  }
}

export function retryEpoch(messageID: string | undefined, timestamp: number | undefined): string {
  return messageID ?? (timestamp === undefined ? "no-user-message" : `user-${timestamp}`)
}
