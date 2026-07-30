use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::{errors::{StudioError, StudioResult}, startup::StartupPhase};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpModel {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    pub reasoning: bool,
    pub thinking: Option<Vec<String>>,
    #[serde(default)]
    pub input: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OmpProvider { pub id: String, pub name: String }

#[derive(Deserialize)]
struct ModelCatalog { models: Vec<OmpModel> }

pub async fn available() -> StudioResult<Vec<OmpModel>> {
    let models = StartupPhase::begin("omp", "models");
    let output = match Command::new("omp").args(["--no-extensions", "models", "--json"]).output().await {
        Ok(output) => output,
        Err(error) => {
            let error = StudioError::OmpUnavailable(error.to_string());
            models.failed(&error);
            return Err(error);
        }
    };
    if !output.status.success() {
        let error = StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        models.failed(&error);
        return Err(error);
    }
    match parse(&output.stdout) {
        Ok(available) => { models.completed(); Ok(available) }
        Err(error) => { models.failed(&error); Err(error) }
    }
}

pub async fn available_providers() -> StudioResult<Vec<OmpProvider>> {
    let output = Command::new("omp").args(["auth-broker", "list", "--json"]).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
    if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
    parse_providers(&output.stdout)
}

fn parse(bytes: &[u8]) -> StudioResult<Vec<OmpModel>> {
    let mut models = serde_json::from_slice::<ModelCatalog>(bytes)?.models;
    models.retain(|model| !model.provider.trim().is_empty() && !model.id.trim().is_empty() && model.selector.contains('/'));
    models.sort_by(|left, right| left.provider.cmp(&right.provider).then_with(|| left.name.cmp(&right.name)).then_with(|| left.id.cmp(&right.id)));
    models.dedup_by(|left, right| left.selector == right.selector);
    Ok(models)
}

fn parse_providers(bytes: &[u8]) -> StudioResult<Vec<OmpProvider>> {
    let mut providers = serde_json::from_slice::<Vec<OmpProvider>>(bytes)?;
    providers.retain(|provider| !provider.id.trim().is_empty() && !provider.name.trim().is_empty());
    providers.sort_by(|left, right| left.name.cmp(&right.name).then_with(|| left.id.cmp(&right.id)));
    providers.dedup_by(|left, right| left.id == right.id);
    Ok(providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_model_contract_without_inventing_entries() {
        let models = parse(br#"{"models":[{"provider":"openai-codex","id":"gpt-test","selector":"openai-codex/gpt-test","name":"GPT Test","contextWindow":200000,"maxTokens":32000,"reasoning":true,"thinking":["low","high"],"input":["text"]}]}"#).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].selector, "openai-codex/gpt-test");
        assert!(models[0].thinking.as_deref().is_some_and(|values| values.iter().map(String::as_str).eq(["low", "high"])));
    }

    #[test]
    fn parses_every_provider_reported_by_omp() {
        let providers = parse_providers(br#"[{"id":"zai","name":"Z.AI"},{"id":"anthropic","name":"Anthropic"}]"#).unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "anthropic");
        assert_eq!(providers[1].id, "zai");
    }
}
