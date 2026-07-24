const DEFAULT_TARGETS = ["glm", "deepseek", "qwen", "kimi", "moonshot", "minimax", "yi-"]

export function hasSubstantialHan(text: string): boolean {
  const matches = text.match(/\p{Script=Han}/gu)
  const count = matches?.length ?? 0
  if (count < 4) return false
  const visible = text.match(/[\p{L}\p{N}]/gu)?.length ?? text.length
  return count >= 12 || count / Math.max(1, visible) >= 0.03
}

function targetTokens(): string[] {
  const configured = process.env.OPENCODE_ENGLISH_GUARD_MODELS
  return (configured ? configured.split(",") : DEFAULT_TARGETS)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

export function isTargetModel(providerID: string, modelID: string): boolean {
  const identity = `${providerID}/${modelID}`.toLowerCase()
  return targetTokens().some((token) => identity.includes(token))
}
