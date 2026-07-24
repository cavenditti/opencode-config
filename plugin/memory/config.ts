/**
 * plugin/memory/config.ts — memory subsystem configuration.
 *
 * Loaded once on plugin init from the plugin options tuple (second element
 * of the plugin entry in opencode.jsonc) and the environment. All knobs are
 * optional with safe defaults; the system runs offline (local backend) with
 * zero configuration and upgrades to Supermemory when SUPERMEMORY_API_KEY is
 * present.
 */
import { homedir } from "node:os"
import { join } from "node:path"

export type { EvidenceEventType } from "./domain.ts"

export interface MemoryConfig {
  enabled: boolean
  instanceId: string
  dataDir: string
  journalPath: string
  storePath: string
  blobsDir: string
  strictMode: boolean
  retainRawDays: number
  retainBlobsDays: number
  batching: {
    maxEvents: number
    maxDelaySeconds: number
    processOnIdle: boolean
    processOnCompaction: boolean
    processOnCommit: boolean
    pollIntervalSeconds: number
  }
  extraction: {
    provider: "openrouter" | "external"
    model: string
    escalationModel?: string
    maxInputTokens: number
    temperature: number
    retryCount: number
    timeoutMs: number
    apiKeyEnv: string
    apiKey?: string
    externalUrl?: string
  }
  review: {
    autoAcceptUserRequirements: boolean
    autoAcceptRepositoryFacts: boolean
    autoAcceptObservations: boolean
    requireHumanForGlobalPreferences: boolean
    reviewerAgents: string[]
    ordinaryAgentTools: string[]
  }
  backend: {
    type: "local" | "supermemory"
    apiKeyEnv: string
    apiKey?: string
    baseUrl: string
    containerTagPrefix: string
    indexPending: boolean
    semanticThreshold: number
    searchLimit: number
  }
  retrieval: {
    defaultLimit: number
    defaultTokenBudget: number
    semanticThreshold: number
    includeChallenged: boolean
    includePending: boolean
  }
  reviewerAgentNames: string[]
}

export function defaultInstanceId(): string {
  const user = process.env.USER ?? "anonymous"
  return "opencode-" + user.slice(0, 24)
}

export function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return join(xdg, "opencode-memory")
  const home = homedir()
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "opencode-memory")
  }
  return join(home, ".local", "share", "opencode-memory")
}

export function loadConfig(raw?: Record<string, unknown>): MemoryConfig {
  const opts = raw ?? {}
  const dataDir = typeof opts.dataDir === "string" ? opts.dataDir : defaultDataDir()
  const enabled = opts.enabled !== false && process.env.OPENCODE_MEMORY_DISABLED !== "1"
  const instanceId = typeof opts.instanceId === "string" ? opts.instanceId : defaultInstanceId()

  const extractionOpts = (opts.extraction ?? {}) as Record<string, unknown>
  const reviewOpts = (opts.review ?? {}) as Record<string, unknown>
  const backendOpts = (opts.backend ?? {}) as Record<string, unknown>
  const retrievalOpts = (opts.retrieval ?? {}) as Record<string, unknown>
  const batchingOpts = (opts.batching ?? {}) as Record<string, unknown>

  const hasSupermemoryKey = !!(
    process.env.SUPERMEMORY_API_KEY ||
    (typeof backendOpts.apiKey === "string" && backendOpts.apiKey)
  )
  const backendType: "local" | "supermemory" =
    backendOpts.type === "supermemory" || (backendOpts.type !== "local" && hasSupermemoryKey)
      ? "supermemory"
      : "local"

  return {
    enabled,
    instanceId,
    dataDir,
    journalPath: typeof opts.journalPath === "string" ? opts.journalPath : join(dataDir, "events.db"),
    storePath: typeof opts.storePath === "string" ? opts.storePath : join(dataDir, "memories.db"),
    blobsDir: typeof opts.blobsDir === "string" ? opts.blobsDir : join(dataDir, "blobs"),
    strictMode: opts.strictMode === true,
    retainRawDays: typeof opts.retainRawDays === "number" ? opts.retainRawDays : 30,
    retainBlobsDays: typeof opts.retainBlobsDays === "number" ? opts.retainBlobsDays : 14,
    batching: {
      maxEvents: typeof batchingOpts.maxEvents === "number" ? batchingOpts.maxEvents : 30,
      maxDelaySeconds: typeof batchingOpts.maxDelaySeconds === "number" ? batchingOpts.maxDelaySeconds : 300,
      processOnIdle: batchingOpts.processOnIdle !== false,
      processOnCompaction: batchingOpts.processOnCompaction !== false,
      processOnCommit: batchingOpts.processOnCommit !== false,
      pollIntervalSeconds: typeof batchingOpts.pollIntervalSeconds === "number" ? batchingOpts.pollIntervalSeconds : 30,
    },
    extraction: {
      provider: extractionOpts.provider === "external" ? "external" : "openrouter",
      model: typeof extractionOpts.model === "string" ? extractionOpts.model : "deepseek/deepseek-v4-flash",
      escalationModel: typeof extractionOpts.escalationModel === "string" ? extractionOpts.escalationModel : undefined,
      maxInputTokens: typeof extractionOpts.maxInputTokens === "number" ? extractionOpts.maxInputTokens : 24000,
      temperature: typeof extractionOpts.temperature === "number" ? extractionOpts.temperature : 0,
      retryCount: typeof extractionOpts.retryCount === "number" ? extractionOpts.retryCount : 1,
      timeoutMs: typeof extractionOpts.timeoutMs === "number" ? extractionOpts.timeoutMs : 30000,
      apiKeyEnv: typeof extractionOpts.apiKeyEnv === "string" ? extractionOpts.apiKeyEnv : "OPENROUTER_API_KEY",
      apiKey: typeof extractionOpts.apiKey === "string" ? extractionOpts.apiKey : undefined,
      externalUrl: typeof extractionOpts.externalUrl === "string" ? extractionOpts.externalUrl : process.env.OPENCODE_MEMORY_EXTRACT_URL,
    },
    review: {
      autoAcceptUserRequirements: reviewOpts.autoAcceptUserRequirements !== false,
      autoAcceptRepositoryFacts: reviewOpts.autoAcceptRepositoryFacts === true,
      autoAcceptObservations: reviewOpts.autoAcceptObservations !== false,
      requireHumanForGlobalPreferences: reviewOpts.requireHumanForGlobalPreferences !== false,
      reviewerAgents: Array.isArray(reviewOpts.reviewerAgents)
        ? (reviewOpts.reviewerAgents as string[])
        : ["memory-reviewer", "reviewer"],
      ordinaryAgentTools: Array.isArray(reviewOpts.ordinaryAgentTools)
        ? (reviewOpts.ordinaryAgentTools as string[])
        : ["memory_context", "memory_search", "memory_get", "memory_propose", "memory_relate", "memory_challenge", "memory_checkpoint"],
    },
    backend: {
      type: backendType,
      apiKeyEnv: typeof backendOpts.apiKeyEnv === "string" ? backendOpts.apiKeyEnv : "SUPERMEMORY_API_KEY",
      apiKey: typeof backendOpts.apiKey === "string" ? backendOpts.apiKey : process.env.SUPERMEMORY_API_KEY,
      baseUrl: typeof backendOpts.baseUrl === "string" ? backendOpts.baseUrl : "https://api.supermemory.ai",
      containerTagPrefix: typeof backendOpts.containerTagPrefix === "string" ? backendOpts.containerTagPrefix : "opencode",
      indexPending: backendOpts.indexPending === true,
      semanticThreshold: typeof backendOpts.semanticThreshold === "number" ? backendOpts.semanticThreshold : 0.6,
      searchLimit: typeof backendOpts.searchLimit === "number" ? backendOpts.searchLimit : 24,
    },
    retrieval: {
      defaultLimit: typeof retrievalOpts.defaultLimit === "number" ? retrievalOpts.defaultLimit : 12,
      defaultTokenBudget: typeof retrievalOpts.defaultTokenBudget === "number" ? retrievalOpts.defaultTokenBudget : 3000,
      semanticThreshold: typeof retrievalOpts.semanticThreshold === "number" ? retrievalOpts.semanticThreshold : 0.6,
      includeChallenged: retrievalOpts.includeChallenged !== false,
      includePending: retrievalOpts.includePending === true,
    },
    reviewerAgentNames: Array.isArray(opts.reviewerAgentNames)
      ? (opts.reviewerAgentNames as string[])
      : ["memory-reviewer", "reviewer"],
  }
}
