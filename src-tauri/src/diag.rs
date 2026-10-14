//! Bounded, privacy-safe diagnostics for the AI subsystem.
//!
//! This exists because the intermittent AI failure could not be reproduced
//! automatically: no OS crash event was recorded, so the only way to learn what
//! happened is to let the app record it itself.
//!
//! Rules enforced here:
//! - Never store prompts, diff content, commit messages, file contents, or any
//!   repository data. Only metadata: event name, request id, model, duration,
//!   outcome, HTTP status, and a *sanitised* error category.
//! - The buffer is a fixed-size ring, so diagnostics can never grow unbounded.
//! - Free-form strings are truncated and stripped of control characters.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Oldest events are dropped once this many are retained.
const MAX_EVENTS: usize = 80;
/// Any single field is clipped to this length.
const MAX_FIELD_CHARS: usize = 120;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEvent {
  /// Milliseconds since the Unix epoch.
  pub at_ms: u64,
  /// Stable identifier shared by every event for one logical request.
  pub request_id: u64,
  /// Coarse kind: `status`, `start`, `warmup`, `explain`, `client`.
  pub event: String,
  pub model: String,
  /// `begin`, `ok`, `error`, `timeout`, `discarded`, or a short category.
  pub outcome: String,
  pub duration_ms: Option<u64>,
  /// Sanitised detail — never repository content.
  pub detail: String,
  /// True when the process was built in release mode (no console attached).
  pub packaged: bool,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn scrub(value: &str) -> String {
  value
    .chars()
    .map(|c| {
      let cc = c as u32;
      if (cc < 32 && c != ' ') || cc == 127 {
        ' '
      } else {
        c
      }
    })
    .take(MAX_FIELD_CHARS)
    .collect::<String>()
    .trim()
    .to_string()
}

/// Classifies an error into a short, stable category.
///
/// This deliberately drops the underlying message: reqwest errors embed the full
/// URL, and we only want to know *what kind* of failure occurred. The patterns
/// match the exact messages the Ollama commands actually produce.
pub fn categorize(error: &str) -> String {
  let lowered = error.to_ascii_lowercase();
  if lowered.contains("timed out") || lowered.contains("timeout") {
    // Checked first: a reqwest timeout is wrapped in "Could not reach Ollama".
    "timeout".to_string()
  } else if lowered.contains("is not running") {
    "server-unavailable".to_string()
  } else if lowered.contains("not downloaded") {
    "model-missing".to_string()
  } else if lowered.contains("could not reach ollama") {
    "send-failed".to_string()
  } else if lowered.contains("returned http") {
    "http-error".to_string()
  } else if lowered.contains("unreadable") {
    "malformed-response".to_string()
  } else if lowered.contains("empty response") {
    "empty-response".to_string()
  } else if lowered.contains("http client") {
    "client-init".to_string()
  } else {
    "other".to_string()
  }
}

static BUFFER: Mutex<VecDeque<DiagEvent>> = Mutex::new(VecDeque::new());
static NEXT_REQUEST_ID: Mutex<u64> = Mutex::new(1);

/// Allocates a request id. Ids are monotonic per process run.
pub fn next_request_id() -> u64 {
  let mut guard = match NEXT_REQUEST_ID.lock() {
    Ok(g) => g,
    // A poisoned lock must never take the app down.
    Err(poisoned) => poisoned.into_inner(),
  };
  *guard += 1;
  *guard
}

pub fn record(event: &str, request_id: u64, model: &str, outcome: &str, duration_ms: Option<u64>, detail: &str) {
  let entry = DiagEvent {
    at_ms: now_ms(),
    request_id,
    event: scrub(event),
    model: scrub(model),
    outcome: scrub(outcome),
    duration_ms,
    detail: scrub(detail),
    packaged: !cfg!(debug_assertions),
  };

  let mut buffer = match BUFFER.lock() {
    Ok(b) => b,
    Err(poisoned) => poisoned.into_inner(),
  };
  if buffer.len() >= MAX_EVENTS {
    buffer.pop_front();
  }
  buffer.push_back(entry);
}

/// Returns retained events, newest last. Bounded by [`MAX_EVENTS`].
#[tauri::command]
pub fn ai_diagnostics() -> Vec<DiagEvent> {
  let buffer = match BUFFER.lock() {
    Ok(b) => b,
    Err(poisoned) => poisoned.into_inner(),
  };
  buffer.iter().cloned().collect()
}

/// Clears retained events. Test-only helper.
#[cfg(test)]
pub fn clear() {
  if let Ok(mut buffer) = BUFFER.lock() {
    buffer.clear();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn buffer_is_bounded_and_keeps_newest() {
    clear();
    for i in 0..(MAX_EVENTS + 25) {
      record("explain", i as u64, "qwen2.5:0.5b", "ok", Some(10), "x");
    }
    let events = ai_diagnostics();
    assert_eq!(events.len(), MAX_EVENTS, "buffer must never grow past its cap");
    // Newest retained event should be the last one written.
    assert_eq!(events.last().unwrap().request_id, (MAX_EVENTS + 24) as u64);
  }

  #[test]
  fn fields_are_scrubbed_and_truncated() {
    clear();
    let noisy = format!("bad\x07value{}", "z".repeat(400));
    record("explain", 1, &noisy, "error", None, &noisy);
    let event = ai_diagnostics().pop().unwrap();

    assert!(!event.detail.contains('\x07'), "control characters must be stripped");
    assert!(event.detail.chars().count() <= MAX_FIELD_CHARS, "fields must be clipped");
    assert!(event.model.chars().count() <= MAX_FIELD_CHARS);
  }

  #[test]
  fn errors_are_reduced_to_stable_categories() {
    // These are the exact messages the Ollama commands produce.
    assert_eq!(
      categorize("Ollama is not running. Start it from the AI panel and retry."),
      "server-unavailable"
    );
    assert_eq!(
      categorize("The model 'qwen2.5:0.5b' is not downloaded. Run: ollama pull qwen2.5:0.5b"),
      "model-missing"
    );
    assert_eq!(categorize("Could not reach Ollama: error sending request"), "send-failed");
    // A timeout wrapped in the send error must still be reported as a timeout.
    assert_eq!(
      categorize("Could not reach Ollama: operation timed out"),
      "timeout"
    );
    assert_eq!(categorize("Ollama returned HTTP 500."), "http-error");
    assert_eq!(
      categorize("Ollama returned an unreadable response: eof"),
      "malformed-response"
    );
    assert_eq!(
      categorize("The model returned an empty response. Try another model."),
      "empty-response"
    );
    assert_eq!(
      categorize("Could not create an HTTP client: tls init failed"),
      "client-init"
    );
    assert_eq!(categorize("something unexpected"), "other");

    // The original message must not survive categorisation.
    assert!(!categorize("secret-token-abc123 leaked").contains("secret-token"));
  }

  #[test]
  fn request_ids_are_unique_and_monotonic() {
    let a = next_request_id();
    let b = next_request_id();
    assert!(b > a);
  }
}