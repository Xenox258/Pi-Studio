use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::{StudioError, StudioResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub fetched_at: DateTime<Utc>,
    pub source: UsageSource,
    pub stale: bool,
    pub providers: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageSource { OmpRpc, OmpCli, Cache }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage { pub provider_id: String, pub provider_name: String, pub accounts: Vec<AccountUsage> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub credential_id: String,
    pub display_label: String,
    pub organization_label: Option<String>,
    pub auth_kind: UsageAuthKind,
    pub plan_type: Option<String>,
    pub active_for_session: bool,
    pub session_id: Option<String>,
    pub limits: Vec<UsageLimit>,
    pub reset_credits: Option<ResetCreditCollection>,
    pub token_activity: Option<Value>,
    pub credits: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageAuthKind { Subscription, ApiKey, Unknown }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit { pub id: String, pub label: String, pub used_percent: f64, pub resets_at: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCreditCollection { pub available: u32, pub credits: Vec<ResetCredit> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit { pub id: String, pub applicable: bool, pub expires_at: Option<String> }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeResetRequest { pub credential_id: String, pub credit_id: String, pub idempotency_key: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsumeResetOutcome { Reset, AlreadyRedeemed, NothingToReset, NoCredit }

pub fn normalize_percent(value: f64) -> f64 { value.clamp(0.0, 100.0) }

pub fn normalize_snapshot(mut snapshot: UsageSnapshot, source: UsageSource) -> StudioResult<UsageSnapshot> {
    for provider in &mut snapshot.providers {
        if provider.provider_id.trim().is_empty() || provider.provider_name.trim().is_empty() { return Err(StudioError::Protocol("usage provider identity is missing".into())); }
        for account in &mut provider.accounts {
            if account.credential_id.trim().is_empty() || account.display_label.trim().is_empty() { return Err(StudioError::Protocol("usage account identity is missing".into())); }
            for limit in &mut account.limits { limit.used_percent = normalize_percent(limit.used_percent); }
        }
    }
    snapshot.fetched_at = Utc::now(); snapshot.source = source; snapshot.stale = false; Ok(snapshot)
}

pub fn parse_snapshot(value: Value, source: UsageSource) -> StudioResult<UsageSnapshot> {
    if value.get("providers").is_some() {
        let snapshot: UsageSnapshot = serde_json::from_value(value).map_err(|error| StudioError::Protocol(format!("unsupported usage snapshot: {error}")))?;
        return normalize_snapshot(snapshot, source);
    }
    let reports = value.get("reports").and_then(Value::as_array).ok_or_else(|| StudioError::Protocol("usage JSON has neither providers nor reports".into()))?;
    let mut providers: Vec<ProviderUsage> = Vec::new();
    for report in reports {
        let provider_id = required_string(report, "provider")?;
        let metadata = report.get("metadata");
        let credential_id = first_string(metadata, &["accountId", "credentialId", "email", "projectId", "orgId"])
            .ok_or_else(|| StudioError::Protocol(format!("{provider_id} report has no account identity")))?;
        let display_label = first_string(metadata, &["email", "accountId", "projectId"]).unwrap_or_else(|| credential_id.clone());
        let organization_label = first_string(metadata, &["orgName", "orgId"]);
        let plan_type = string_field(metadata, "planType");
        let limits = report.get("limits").and_then(Value::as_array).map(|items| items.iter().map(parse_limit).collect::<StudioResult<Vec<_>>>()).transpose()?.unwrap_or_default();
        let reset_credits = report.get("resetCredits").map(parse_reset_credits).transpose()?;
        let account = AccountUsage { credential_id, display_label, organization_label, auth_kind: if plan_type.is_some() { UsageAuthKind::Subscription } else { UsageAuthKind::Unknown }, plan_type, active_for_session: false, session_id: None, limits, reset_credits, token_activity: None, credits: None };
        push_account(&mut providers, provider_id, account);
    }
    for (index, account) in value.get("accountsWithoutUsage").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let provider_id = required_string(account, "provider")?;
        let auth_type = account.get("type").and_then(Value::as_str);
        let credential_id = first_string(Some(account), &["accountId", "email", "projectId", "orgId", "enterpriseUrl"])
            .unwrap_or_else(|| format!("{provider_id}:unreported:{index}"));
        let display_label = first_string(Some(account), &["email", "accountId", "projectId", "enterpriseUrl"])
            .unwrap_or_else(|| if auth_type == Some("api_key") { "API key".into() } else { "OAuth account".into() });
        let account = AccountUsage {
            credential_id,
            display_label,
            organization_label: first_string(Some(account), &["orgName", "orgId"]),
            auth_kind: match auth_type { Some("oauth") => UsageAuthKind::Subscription, Some("api_key") => UsageAuthKind::ApiKey, _ => UsageAuthKind::Unknown },
            plan_type: None,
            active_for_session: false,
            session_id: None,
            limits: Vec::new(),
            reset_credits: None,
            token_activity: None,
            credits: None,
        };
        push_account(&mut providers, provider_id, account);
    }
    normalize_snapshot(UsageSnapshot { fetched_at: Utc::now(), source: source.clone(), stale: false, providers }, source)
}

fn push_account(providers: &mut Vec<ProviderUsage>, provider_id: String, account: AccountUsage) {
    if let Some(provider) = providers.iter_mut().find(|item| item.provider_id == provider_id) {
        provider.accounts.push(account);
    } else {
        providers.push(ProviderUsage { provider_name: provider_name(&provider_id), provider_id, accounts: vec![account] });
    }
}

fn string_field(value: Option<&Value>, key: &str) -> Option<String> {
    value.and_then(|item| item.get(key)).and_then(Value::as_str).filter(|item| !item.is_empty()).map(str::to_owned)
}

fn first_string(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| string_field(value, key))
}

fn parse_limit(value: &Value) -> StudioResult<UsageLimit> {
    let id = required_string(value, "id")?;
    let label = value.get("label").and_then(Value::as_str).unwrap_or(&id).to_owned();
    let amount = value.get("amount").ok_or_else(|| StudioError::Protocol(format!("limit {id} has no amount")))?;
    let used_percent = amount.get("usedFraction").and_then(Value::as_f64).map(|value| value * 100.0)
        .or_else(|| amount.get("remainingFraction").and_then(Value::as_f64).map(|value| (1.0 - value) * 100.0))
        .or_else(|| {
            let used = amount.get("used").and_then(Value::as_f64)?;
            let unit = amount.get("unit").and_then(Value::as_str);
            if unit == Some("percent") { Some(used) } else { amount.get("limit").and_then(Value::as_f64).filter(|limit| *limit > 0.0).map(|limit| used / limit * 100.0) }
        })
        .ok_or_else(|| StudioError::Protocol(format!("limit {id} has no usage value")))?;
    let resets_at = value.get("window").and_then(|window| window.get("resetsAt")).and_then(timestamp_string);
    Ok(UsageLimit { id, label, used_percent: normalize_percent(used_percent), resets_at })
}

fn parse_reset_credits(value: &Value) -> StudioResult<ResetCreditCollection> {
    let available = value.get("availableCount").and_then(Value::as_u64).unwrap_or(0).try_into().map_err(|_| StudioError::Protocol("reset credit count exceeds u32".into()))?;
    let credits = value.get("credits").and_then(Value::as_array).into_iter().flatten().filter_map(|credit| {
        let id = credit.get("id")?.as_str()?.to_owned();
        Some(ResetCredit { id, applicable: credit.get("status").and_then(Value::as_str) == Some("available"), expires_at: credit.get("expiresAt").and_then(Value::as_str).map(str::to_owned) })
    }).collect();
    Ok(ResetCreditCollection { available, credits })
}

fn required_string(value: &Value, key: &str) -> StudioResult<String> { value.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned).ok_or_else(|| StudioError::Protocol(format!("usage field {key} is missing"))) }
fn timestamp_string(value: &Value) -> Option<String> { if let Some(raw) = value.as_str() { Some(raw.to_owned()) } else { value.as_i64().and_then(|millis| Utc.timestamp_millis_opt(millis).single()).map(|time| time.to_rfc3339()) } }
fn provider_name(id: &str) -> String { match id { "openai-codex" => "OpenAI Codex".into(), "anthropic" => "Anthropic".into(), other => other.to_owned() } }

impl ConsumeResetRequest {
    pub fn validate(&self) -> StudioResult<()> {
        for (name, value) in [("credentialId", &self.credential_id), ("creditId", &self.credit_id), ("idempotencyKey", &self.idempotency_key)] {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) { return Err(StudioError::InvalidInput(format!("invalid {name}"))); }
        }
        UuidLike::validate(&self.idempotency_key)?; Ok(())
    }
}

struct UuidLike;
impl UuidLike { fn validate(value: &str) -> StudioResult<()> { uuid::Uuid::parse_str(value).map(|_| ()).map_err(|_| StudioError::InvalidInput("idempotencyKey must be a UUID".into())) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn clamps_percentages() { assert_eq!(normalize_percent(-3.0), 0.0); assert_eq!(normalize_percent(101.0), 100.0); }
    #[test] fn reset_requires_uuid() { let request = ConsumeResetRequest { credential_id: "c".into(), credit_id: "r".into(), idempotency_key: "bad".into() }; assert!(request.validate().is_err()); }
    #[test] fn parses_omp_reports_contract() {
        let value: Value = serde_json::from_str(include_str!("../../../tests/fixtures/usage/omp.json")).unwrap();
        let snapshot = parse_snapshot(value, UsageSource::OmpCli).unwrap();
        assert_eq!(snapshot.providers[0].accounts[0].limits[0].used_percent, 96.0);
        assert_eq!(snapshot.providers[0].accounts[0].reset_credits.as_ref().unwrap().available, 3);
        assert!(snapshot.providers[0].accounts[0].reset_credits.as_ref().unwrap().credits.is_empty());
        assert_eq!(snapshot.providers.len(), 3);
        let anthropic = snapshot.providers.iter().find(|provider| provider.provider_id == "anthropic").unwrap();
        assert_eq!(anthropic.accounts[0].limits[0].used_percent, 2.0);
        assert_eq!(anthropic.accounts[0].organization_label.as_deref(), Some("Example Organization"));
        let unreported = snapshot.providers.iter().find(|provider| provider.provider_id == "github-copilot").unwrap();
        assert!(unreported.accounts[0].limits.is_empty());
    }
}
