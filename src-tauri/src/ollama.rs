//! Local Ollama integration.
//!
//! Everything here talks to the Ollama HTTP API on the loopback interface only.
//! Repository content never leaves the machine, and this module never starts a
//! cloud model or contacts any endpoint other than the configured local one.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Default endpoint. Kept local on purpose — an AI feature must never become an
/// exfiltration path.
const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";

/// Small default so the feature stays light. The model is configurable and any
/// installed model may be selected instead.
pub const DEFAULT_MODEL: &str = "qwen2.5:0.5b";

/// Status probes are fast; generation on CPU with a small model can still take a
/// while, especially the first call while weights load.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(180);
const START_POLL_TIMEOUT: Duration = Duration::from_secs(20);

/// Upper bounds. Prompts and replies are clipped so a huge diff or a rambling
/// model can never exhaust memory or wedge the UI.
const MAX_FACT_LINES: usize = 200;
const MAX_FILES: usize = 200;
const MAX_DIFF_CHARS: usize = 6_000;
const MAX_REPLY_CHARS: usize = 8_000;

/// Token budget per explanation. Bounded deliberately: a large model on CPU can
/// spend minutes producing hundreds of tokens, which reads to the user as a
/// hang rather than a slow answer.
const MAX_REPLY_TOKENS: u32 = 400;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
  pub name: String,
  pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
  pub installed: bool,
  pub running: bool,
  pub version: Option<String>,
  pub endpoint: String,
  pub models: Vec<OllamaModel>,
  pub selected_model: String,
  pub selected_model_available: bool,
  /// Exactly what to run to install the selected model. Never acted on
  /// automatically — models are not downloaded without an explicit request.
  pub install_hint: Option<String>,
  pub message: Option<String>,
}

/// What the user is asking the model to explain.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
  /// `branch`, `commit`, `risk`, or `tests`.
  pub kind: String,
  pub model: String,
  /// Headline, e.g. "main → feature/laboratory" or a commit subject.
  pub title: String,
  /// Verified Git facts, one per entry. These come from the real Git commands.
  pub facts: Vec<String>,
  /// Changed paths with their real line stats, e.g. "src/a.ts (+10/-2)".
  pub files: Vec<String>,
  /// Bounded diff excerpt.
  pub diff_excerpt: Option<String>,
  /// Paths changed on both sides since the merge base.
  pub overlap: Vec<String>,
  /// Human-readable merge preview result, if one was run.
  pub preview: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiExplanation {
  pub text: String,
  pub model: String,
  /// True when the reply was clipped at `MAX_REPLY_CHARS`.
  pub truncated: bool,
  pub elapsed_ms: u64,
}

fn endpoint() -> String {
  std::env::var("BRANCHMAP_OLLAMA_ENDPOINT")
    .unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string())
    .trim_end_matches('/')
    .to_string()
}

/// Cached HTTP clients.
///
/// A fresh `reqwest::Client` spins up its own connection pool and background
/// driver task, so building one per request is needless churn — and every drop
/// has to tear that pool down. These are built once and reused.
///
/// `Client::default()` is deliberately avoided: it calls `Client::new()`, which
/// **panics** if the TLS backend cannot initialise. A panic inside a command
/// handler is exactly the kind of intermittent, hard-to-diagnose failure we do
/// not want, so a build failure is cached as an `Err` and returned normally.
static STATUS_CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
  std::sync::OnceLock::new();
static GENERATE_CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
  std::sync::OnceLock::new();

fn status_client() -> Result<reqwest::Client, String> {
  STATUS_CLIENT
    .get_or_init(|| {
      reqwest::Client::builder()
        .timeout(STATUS_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not create an HTTP client: {e}"))
    })
    .clone()
}

fn generate_client() -> Result<reqwest::Client, String> {
  GENERATE_CLIENT
    .get_or_init(|| {
      reqwest::Client::builder()
        .timeout(GENERATE_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not create an HTTP client: {e}"))
    })
    .clone()
}

/// Strips control characters and clips to a bound, on a char boundary.
fn sanitize(text: &str, max_chars: usize) -> (String, bool) {
  let cleaned: String = text
    .chars()
    .map(|c| {
      let cc = c as u32;
      if (cc < 32 && c != '\n' && c != '\t') || cc == 127 {
        ' '
      } else {
        c
      }
    })
    .collect();

  if cleaned.chars().count() <= max_chars {
    return (cleaned.trim().to_string(), false);
  }

  let clipped: String = cleaned.chars().take(max_chars).collect();
  (format!("{}\n\n[truncated by BranchMap]", clipped.trim_end()), true)
}

fn find_ollama_exe() -> Option<String> {
  // `where` avoids assuming a fixed install location.
  let mut command = Command::new("where");
  crate::hide_console(&mut command);
  if let Ok(out) = command.arg("ollama").output() {
    if out.status.success() {
      let text = String::from_utf8_lossy(&out.stdout).to_string();
      if let Some(first) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
        return Some(first.to_string());
      }
    }
  }

  let mut candidates: Vec<String> = Vec::new();
  if let Ok(local) = std::env::var("LOCALAPPDATA") {
    candidates.push(format!("{local}\\Programs\\Ollama\\ollama.exe"));
  }
  if let Ok(program_files) = std::env::var("ProgramFiles") {
    candidates.push(format!("{program_files}\\Ollama\\ollama.exe"));
  }
  candidates.into_iter().find(|c| std::path::Path::new(c).exists())
}

async fn probe() -> (bool, Option<String>) {
  let Ok(http) = status_client() else {
    return (false, None);
  };
  let url = format!("{}/api/version", endpoint());
  match http.get(&url).send().await {
    Ok(resp) if resp.status().is_success() => {
      #[derive(Deserialize)]
      struct Version {
        version: String,
      }
      match resp.json::<Version>().await {
        Ok(v) => (true, Some(v.version)),
        // Reachable but unparseable still means the server is up.
        Err(_) => (true, None),
      }
    }
    _ => (false, None),
  }
}

async fn fetch_models() -> Vec<OllamaModel> {
  #[derive(Deserialize)]
  struct Tags {
    #[serde(default)]
    models: Vec<TagModel>,
  }
  #[derive(Deserialize)]
  struct TagModel {
    name: String,
    #[serde(default)]
    size: u64,
  }

  let url = format!("{}/api/tags", endpoint());
  let Ok(http) = status_client() else { return Vec::new() };
  match http.get(&url).send().await {
    Ok(resp) => resp
      .json::<Tags>()
      .await
      .map(|t| {
        t.models
          .into_iter()
          .map(|m| OllamaModel { name: m.name, size: m.size })
          .collect()
      })
      .unwrap_or_default(),
    Err(_) => Vec::new(),
  }
}

fn model_available(models: &[OllamaModel], selected: &str) -> bool {
  if models.iter().any(|m| m.name == selected) {
    return true;
  }
  // `qwen2.5:0.5b` may be listed as `qwen2.5:0.5b` only; also accept an implicit
  // `:latest` tag match.
  let with_latest = format!("{selected}:latest");
  models.iter().any(|m| m.name == with_latest)
}

async fn build_status(selected_model: &str) -> OllamaStatus {
  let (running, version) = probe().await;
  let installed = running || find_ollama_exe().is_some();
  let models = if running { fetch_models().await } else { Vec::new() };
  let available = model_available(&models, selected_model);

  let install_hint = if running && !available {
    Some(format!("ollama pull {selected_model}"))
  } else {
    None
  };

  let message = if !installed {
    Some("Ollama was not found on this machine.".to_string())
  } else if !running {
    Some("Ollama is installed but not running.".to_string())
  } else if !available {
    Some(format!("The model '{selected_model}' is not downloaded yet."))
  } else {
    None
  };

  OllamaStatus {
    installed,
    running,
    version,
    endpoint: endpoint(),
    models,
    selected_model: selected_model.to_string(),
    selected_model_available: available,
    install_hint,
    message,
  }
}

/// Reports Ollama availability and which models are present locally.
#[tauri::command]
pub async fn ollama_status(model: Option<String>) -> OllamaStatus {
  let selected = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
  let id = crate::diag::next_request_id();
  crate::diag::record("status", id, &selected, "begin", None, "");
  let status = build_status(&selected).await;
  crate::diag::record(
    "status",
    id,
    &selected,
    "ok",
    None,
    &format!("running={} models={}", status.running, status.models.len()),
  );
  status
}

/// Starts Ollama **only if it is not already answering**.
///
/// The probe happens first, so a running instance is never duplicated. The child
/// is spawned detached and the handle is dropped without killing it, so Ollama
/// keeps running after BranchMap exits — BranchMap never terminates it.
#[tauri::command]
pub async fn ollama_start(model: Option<String>) -> OllamaStatus {
  let selected = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());

  if probe().await.0 {
    // Already up: never launch a second server.
    return build_status(&selected).await;
  }

  let Some(exe) = find_ollama_exe() else {
    return build_status(&selected).await;
  };

  let mut command = Command::new(exe);
  // Belt and braces: never flash a console window for this either.
  crate::hide_console(&mut command);
  command
    .arg("serve")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — survives app exit and keeps
    // the server out of our console session.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(
      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
    );
  }

  if command.spawn().is_err() {
    return build_status(&selected).await;
  }

  // Wait for the API to answer, then report.
  let deadline = Instant::now() + START_POLL_TIMEOUT;
  while Instant::now() < deadline {
    if probe().await.0 {
      break;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
  }

  build_status(&selected).await
}

/// Optional warm-up. Loads the model into memory with a one-token generation.
///
/// Off by default: it consumes RAM and CPU, so the caller must ask for it
/// explicitly rather than doing it silently at startup.
#[tauri::command]
pub async fn ollama_warmup(model: Option<String>) -> Result<bool, String> {
  let selected = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
  let started = Instant::now();
  let id = crate::diag::next_request_id();
  crate::diag::record("warmup", id, &selected, "begin", None, "");

  let fail = |reason: &str, err: String| {
    crate::diag::record(
      "warmup",
      id,
      &selected,
      "error",
      Some(started.elapsed().as_millis() as u64),
      reason,
    );
    Err(err)
  };

  if !probe().await.0 {
    return fail("server-unavailable", "Ollama is not running.".into());
  }
  if !model_available(&fetch_models().await, &selected) {
    return fail(
      "model-missing",
      format!("The model '{selected}' is not downloaded yet."),
    );
  }

  #[derive(Serialize)]
  struct Generate<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
    options: Options,
  }
  #[derive(Serialize)]
  struct Options {
    num_predict: u32,
  }

  let url = format!("{}/api/generate", endpoint());
  let http = generate_client()?;
  let body = Generate {
    model: &selected,
    prompt: "",
    stream: false,
    options: Options { num_predict: 1 },
  };

  match http.post(&url).json(&body).send().await {
    Ok(resp) if resp.status().is_success() => {
      crate::diag::record(
        "warmup",
        id,
        &selected,
        "ok",
        Some(started.elapsed().as_millis() as u64),
        "loaded",
      );
      Ok(true)
    }
    Ok(resp) => fail(
      "http-error",
      format!("Ollama returned HTTP {}.", resp.status()),
    ),
    Err(e) => fail("send-failed", format!("Could not reach Ollama: {e}")),
  }
}

/// Builds the explanation prompt. The rules below are the guardrails that keep
/// model output from overstating what Git actually proved.
fn build_prompt(request: &AiRequest) -> String {
  let facts: Vec<String> = request
    .facts
    .iter()
    .take(MAX_FACT_LINES)
    .map(|f| format!("- {}", sanitize(f, 400).0))
    .collect();

  let files: Vec<String> = request
    .files
    .iter()
    .take(MAX_FILES)
    .map(|f| format!("- {}", sanitize(f, 300).0))
    .collect();

  let overlap: Vec<String> = request
    .overlap
    .iter()
    .take(MAX_FILES)
    .map(|f| format!("- {}", sanitize(f, 300).0))
    .collect();

  let mut context = String::new();
  context.push_str(&format!("SUBJECT: {}\n\n", sanitize(&request.title, 200).0));

  if !facts.is_empty() {
    context.push_str("VERIFIED GIT FACTS:\n");
    context.push_str(&facts.join("\n"));
    context.push_str("\n\n");
  }
  if !files.is_empty() {
    context.push_str("CHANGED FILES (path with insertion/deletion counts):\n");
    context.push_str(&files.join("\n"));
    context.push_str("\n\n");
  }
  if !overlap.is_empty() {
    context.push_str(
      "PATHS CHANGED ON BOTH SIDES SINCE THE MERGE BASE (overlap only, NOT a confirmed conflict):\n",
    );
    context.push_str(&overlap.join("\n"));
    context.push_str("\n\n");
  }
  if let Some(preview) = &request.preview {
    context.push_str(&format!(
      "MERGE PREVIEW RESULT (an estimate, never a guarantee):\n{}\n\n",
      sanitize(preview, 600).0
    ));
  }
  if let Some(diff) = &request.diff_excerpt {
    if !diff.trim().is_empty() {
      let (excerpt, _) = sanitize(diff, MAX_DIFF_CHARS);
      context.push_str("DIFF EXCERPT (may be truncated):\n```diff\n");
      context.push_str(&excerpt);
      context.push_str("\n```\n\n");
    }
  }

  let focus = match request.kind.as_str() {
    "branch" => "Summarise what this branch appears to change relative to its merge base.",
    "commit" => "Explain what this commit changed and its likely intent.",
    "risk" => "Describe change-risk observations based only on the evidence above.",
    "tests" => "Suggest verification steps appropriate to these changes.",
    _ => "Explain the changes shown above.",
  };

  format!(
    "You are a careful Git assistant inside BranchMap, explaining facts that a local Git CLI \
already computed.\n\n{focus}\n\nHARD RULES:\n\
1. Use ONLY the data below. Never invent commits, files, numbers, authors, or outcomes.\n\
2. Separate VERIFIED FACT (stated in the data) from INFERENCE (your interpretation) using those \
labels explicitly.\n\
3. Never claim a change caused a bug, and never claim a change is safe. You have no runtime, \
test, or production evidence.\n\
4. Never claim a merge will succeed. Overlapping paths are only a risk signal; Git may still \
merge them cleanly.\n\
5. If the data is insufficient, say so plainly instead of speculating.\n\
6. Be concise and plain. No preamble.\n\nDATA:\n{context}"
  )
}

#[derive(Deserialize)]
struct GenerateResponse {
  #[serde(default)]
  response: String,
}

/// Explains real Git data using a local model. Never contacts a remote service.
#[tauri::command]
pub async fn ai_explain(request: AiRequest) -> Result<AiExplanation, String> {
  let started = Instant::now();
  let id = crate::diag::next_request_id();
  let model = request.model.clone();
  let kind = request.kind.clone();
  crate::diag::record("explain", id, &model, "begin", None, &format!("kind={kind}"));

  if !probe().await.0 {
    crate::diag::record(
      "explain",
      id,
      &model,
      "error",
      Some(started.elapsed().as_millis() as u64),
      "server-unavailable",
    );
    return Err("Ollama is not running. Start it from the AI panel and retry.".into());
  }
  if !model_available(&fetch_models().await, &request.model) {
    crate::diag::record(
      "explain",
      id,
      &model,
      "error",
      Some(started.elapsed().as_millis() as u64),
      "model-missing",
    );
    return Err(format!(
      "The model '{}' is not downloaded. Run: ollama pull {}",
      request.model, request.model
    ));
  }

  #[derive(Serialize)]
  struct GenerateBody<'a> {
    model: &'a str,
    prompt: String,
    stream: bool,
    options: GenerateOptions,
  }
  #[derive(Serialize)]
  struct GenerateOptions {
    temperature: f32,
    num_predict: u32,
  }

  let url = format!("{}/api/generate", endpoint());
  let http = generate_client()?;
  let body = GenerateBody {
    model: &request.model,
    prompt: build_prompt(&request),
    stream: false,
    options: GenerateOptions { temperature: 0.2, num_predict: MAX_REPLY_TOKENS },
  };

  let response = match http.post(&url).json(&body).send().await {
    Ok(r) => r,
    Err(e) => {
      let category = crate::diag::categorize(&e.to_string());
      crate::diag::record(
        "explain",
        id,
        &model,
        "error",
        Some(started.elapsed().as_millis() as u64),
        &format!("send-failed:{category}"),
      );
      return Err(format!("Could not reach Ollama: {e}"));
    }
  };

  let status_code = response.status().as_u16();
  if !response.status().is_success() {
    crate::diag::record(
      "explain",
      id,
      &model,
      "error",
      Some(started.elapsed().as_millis() as u64),
      &format!("http-{status_code}"),
    );
    return Err(format!("Ollama returned HTTP {status_code}."));
  }

  let parsed: GenerateResponse = match response.json().await {
    Ok(p) => p,
    Err(e) => {
      crate::diag::record(
        "explain",
        id,
        &model,
        "error",
        Some(started.elapsed().as_millis() as u64),
        "malformed-response",
      );
      return Err(format!("Ollama returned an unreadable response: {e}"));
    }
  };

  let raw = parsed.response.trim();
  if raw.is_empty() {
    crate::diag::record(
      "explain",
      id,
      &model,
      "error",
      Some(started.elapsed().as_millis() as u64),
      "empty-response",
    );
    return Err("The model returned an empty response. Try a different model or retry.".into());
  }

  let (text, truncated) = sanitize(raw, MAX_REPLY_CHARS);
  let elapsed = started.elapsed().as_millis() as u64;
  crate::diag::record(
    "explain",
    id,
    &model,
    "ok",
    Some(elapsed),
    &format!("chars={} truncated={truncated}", text.len()),
  );

  Ok(AiExplanation { text, model: request.model, truncated, elapsed_ms: elapsed })
}

/// Default model name, exposed so the frontend can show it before first use.
#[tauri::command]
pub fn ai_default_model() -> String {
  DEFAULT_MODEL.to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request(kind: &str) -> AiRequest {
    AiRequest {
      kind: kind.to_string(),
      model: DEFAULT_MODEL.to_string(),
      title: "main -> feature".to_string(),
      facts: vec!["Merge base is abc1234".to_string()],
      files: vec!["src/a.ts (+10/-2)".to_string()],
      diff_excerpt: None,
      overlap: vec!["src/a.ts".to_string()],
      preview: None,
    }
  }

  #[test]
  fn default_model_is_a_small_local_model() {
    assert_eq!(DEFAULT_MODEL, "qwen2.5:0.5b");
  }

  #[test]
  fn endpoint_is_loopback_only() {
    // An AI feature must never become an exfiltration path.
    assert!(DEFAULT_ENDPOINT.starts_with("http://127.0.0.1"));
    assert!(!DEFAULT_ENDPOINT.contains("https://"));
  }

  #[test]
  fn prompt_forbids_causal_and_safety_claims() {
    let prompt = build_prompt(&request("risk"));

    assert!(prompt.contains("Never claim a change caused a bug"));
    assert!(prompt.contains("Never claim a merge will succeed"));
    assert!(prompt.contains("Use ONLY the data below"));
    assert!(prompt.contains("If the data is insufficient"));

    // Overlap must be labelled as a signal, not a conflict.
    assert!(prompt.contains("NOT a confirmed conflict"));
  }

  #[test]
  fn prompt_includes_real_git_context() {
    let mut req = request("branch");
    req.diff_excerpt = Some("+added line\n-removed line".to_string());
    req.preview = Some("No conflicts reported".to_string());
    let prompt = build_prompt(&req);

    assert!(prompt.contains("main -> feature"));
    assert!(prompt.contains("Merge base is abc1234"));
    assert!(prompt.contains("src/a.ts (+10/-2)"));
    assert!(prompt.contains("+added line"));
    assert!(prompt.contains("No conflicts reported"));
    assert!(prompt.contains("an estimate, never a guarantee"));
  }

  #[test]
  fn prompt_clamps_enormous_diff_excerpts() {
    let mut req = request("commit");
    req.diff_excerpt = Some("x".repeat(MAX_DIFF_CHARS * 3));
    let prompt = build_prompt(&req);
    assert!(
      prompt.len() < MAX_DIFF_CHARS * 2,
      "diff excerpt must be bounded, got {} chars",
      prompt.len()
    );
  }

  #[test]
  fn sanitize_strips_control_characters_and_clips() {
    let dirty = format!("before{}-after", 0x07 as char);
    let (cleaned, truncated) = sanitize(&dirty, 100);
    assert!(!cleaned.contains(&0x07.to_string()));
    assert!(cleaned.contains("before"));
    assert!(!truncated);

    let (clipped, was_truncated) = sanitize(&"y".repeat(500), 100);
    assert!(was_truncated);
    assert!(clipped.contains("truncated by BranchMap"));
    // Count the retained payload, not the marker text (which itself contains a 'y').
    let payload = clipped.split("\n\n[truncated").next().unwrap_or("");
    assert_eq!(payload.chars().count(), 100, "retained text should be clipped to the bound");
  }

  #[test]
  fn sanitize_keeps_newlines_and_tabs_readable() {
    let (cleaned, _) = sanitize("line1\n\tindented", 100);
    assert!(cleaned.contains('\n'));
    assert!(cleaned.contains('\t'));
  }

  #[test]
  fn model_availability_matches_explicit_and_implicit_tags() {
    let models = vec![OllamaModel { name: "qwen2.5:0.5b".to_string(), size: 1 }];
    assert!(model_available(&models, "qwen2.5:0.5b"));
    assert!(!model_available(&models, "qwen2.5:3b"));

    // `model` without an explicit tag should match a `:latest` entry.
    let latest = vec![OllamaModel { name: "llama3:latest".to_string(), size: 1 }];
    assert!(model_available(&latest, "llama3"));
  }

  /// Exercises the real inference path repeatedly against a local Ollama.
  /// Ignored by default because it needs Ollama running with a model present.
  #[test]
  #[ignore = "requires a running local Ollama"]
  fn stress_ai_explain_repeatedly() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
      for i in 0..12 {
        let req = AiRequest {
          kind: "commit".to_string(),
          model: DEFAULT_MODEL.to_string(),
          title: "stress".to_string(),
          facts: vec!["Files changed: 3".to_string()],
          files: vec!["src/a.ts (+10/-2)".to_string()],
          diff_excerpt: Some("+added\n-removed".to_string()),
          overlap: vec![],
          preview: None,
        };
        match ai_explain(req).await {
          Ok(r) => println!("iter {i}: ok, {} chars, {}ms", r.text.len(), r.elapsed_ms),
          Err(e) => println!("iter {i}: ERR {e}"),
        }
      }
    });
  }
}