import { invoke } from '@tauri-apps/api/core'
import type { AiExplanation, AiRequest, OllamaStatus } from '../types'

/**
 * Typed wrappers around the local Ollama commands.
 *
 * All traffic goes to the loopback endpoint chosen by the Rust backend, so no
 * repository content can reach an external service.
 */

export async function getOllamaStatus(model?: string): Promise<OllamaStatus> {
  return invoke<OllamaStatus>('ollama_status', { model: model ?? null })
}

/**
 * Starts Ollama only when it is not already answering, so an existing server is
 * never duplicated and is never terminated by BranchMap.
 */
export async function startOllama(model?: string): Promise<OllamaStatus> {
  return invoke<OllamaStatus>('ollama_start', { model: model ?? null })
}

/** Optional: loads the model into memory. Consumes RAM/CPU, so it is opt-in. */
export async function warmUpModel(model?: string): Promise<boolean> {
  return invoke<boolean>('ollama_warmup', { model: model ?? null })
}

export async function explainWithModel(request: AiRequest): Promise<AiExplanation> {
  return invoke<AiExplanation>('ai_explain', { request })
}

export async function getDefaultModel(): Promise<string> {
  return invoke<string>('ai_default_model')
}