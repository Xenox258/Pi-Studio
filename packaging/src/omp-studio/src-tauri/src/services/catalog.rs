use std::{collections::HashMap, time::{Duration, Instant}};

use serde::Serialize;
use serde_json::Value;
use tokio::{process::Command, sync::RwLock};

use crate::errors::{StudioError, StudioResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage { pub id: String, pub name: String, pub author: String, pub description: String, pub kind: String, pub version: String, pub installed: bool, pub update_available: bool, pub compatibility: String, pub permissions: Vec<String>, pub resources: Vec<CatalogResource> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResource { pub r#type: String, pub count: u32 }

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMarketplace { pub name: String, pub source: String }

#[derive(Default)]
pub struct CatalogService { cache: RwLock<HashMap<String, (Instant, Vec<CatalogPackage>)>> }

impl CatalogService {
    pub async fn list(&self, mode: &str) -> StudioResult<Vec<CatalogPackage>> {
        if !matches!(mode, "discover" | "installed" | "updates" | "local") { return Err(StudioError::InvalidInput("invalid catalog mode".into())); }
        if let Some((at, value)) = self.cache.read().await.get(mode) { if at.elapsed() < Duration::from_secs(1800) { return Ok(value.clone()); } }
        let mut packages = if mode == "discover" {
            self.discover().await?
        } else {
            let mut arguments = vec!["plugin", "list", "--json"];
            if mode == "local" { arguments.push("--local"); }
            let output = omp_output(&arguments).await?;
            if output.trim().is_empty() { Vec::new() } else { packages_from(serde_json::from_str(&output)?, mode) }
        };
        if mode == "updates" { packages.retain(|package| package.update_available); }
        self.cache.write().await.insert(mode.to_owned(), (Instant::now(), packages.clone()));
        Ok(packages)
    }

    pub async fn marketplaces(&self) -> StudioResult<Vec<CatalogMarketplace>> {
        Ok(marketplaces_from(&omp_output(&["plugin", "marketplace", "list"]).await?))
    }

    pub async fn add_marketplace(&self, source: &str) -> StudioResult<()> {
        let source = source.trim();
        if source.is_empty() || source.len() > 512 || source.chars().any(char::is_control) { return Err(StudioError::InvalidInput("invalid marketplace source".into())); }
        omp_output(&["plugin", "marketplace", "add", source]).await?;
        self.invalidate().await;
        Ok(())
    }

    async fn discover(&self) -> StudioResult<Vec<CatalogPackage>> {
        let mut discovered = Vec::new();
        for marketplace in self.marketplaces().await? {
            let output = omp_output(&["plugin", "discover", &marketplace.name]).await?;
            discovered.extend(discovered_from(&output, &marketplace));
        }
        Ok(discovered)
    }

    pub async fn invalidate(&self) { self.cache.write().await.clear(); }
}

async fn omp_output(arguments: &[&str]) -> StudioResult<String> {
    let output = Command::new("omp").args(arguments).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
    if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn marketplaces_from(output: &str) -> Vec<CatalogMarketplace> {
    output.lines().filter_map(|line| {
        if !line.starts_with("  ") || line.starts_with("    ") { return None; }
        let mut fields = line.split_whitespace();
        let name = fields.next()?.to_owned();
        let source = fields.collect::<Vec<_>>().join(" ");
        (!source.is_empty()).then_some(CatalogMarketplace { name, source })
    }).collect()
}

fn discovered_from(output: &str, marketplace: &CatalogMarketplace) -> Vec<CatalogPackage> {
    let mut entries: Vec<(String, String, String)> = Vec::new();
    for line in output.lines() {
        if line.starts_with("  ") && !line.starts_with("    ") {
            let token = line.trim();
            let (name, version) = token.rsplit_once('@').filter(|(base, suffix)| !base.is_empty() && suffix.chars().next().is_some_and(|character| character.is_ascii_digit())).map_or((token, "Not reported"), |(base, suffix)| (base, suffix));
            entries.push((name.to_owned(), version.to_owned(), String::new()));
        } else if line.starts_with("    ") {
            if let Some(entry) = entries.last_mut() { entry.2 = line.trim().to_owned(); }
        }
    }
    entries.into_iter().map(|(name, version, description)| CatalogPackage {
        id: format!("{name}@{}", marketplace.name), name, author: marketplace.name.clone(), description, kind: "Package".into(), version, installed: false, update_available: false, compatibility: "OMP marketplace".into(), permissions: Vec::new(), resources: vec![CatalogResource { r#type: "Plugin".into(), count: 1 }],
    }).collect()
}

fn packages_from(value: Value, mode: &str) -> Vec<CatalogPackage> {
    let mut objects = Vec::new(); collect_objects(&value, &mut objects);
    objects.into_iter().filter_map(|object| {
        let id = text(object, &["id", "package", "name"])?; let name = text(object, &["name", "id"]).unwrap_or_else(|| id.clone());
        Some(CatalogPackage { id, name, author: text(object, &["author"]).unwrap_or_default(), description: text(object, &["description"]).unwrap_or_default(), kind: text(object, &["kind", "type"]).unwrap_or_else(|| "Package".into()), version: text(object, &["version"]).unwrap_or_else(|| "Not reported".into()), installed: mode != "discover", update_available: object.get("updateAvailable").and_then(Value::as_bool).unwrap_or(false), compatibility: text(object, &["compatibility"]).unwrap_or_else(|| "Not reported".into()), permissions: object.get("permissions").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(), resources: Vec::new() })
    }).collect()
}

fn collect_objects<'a>(value: &'a Value, output: &mut Vec<&'a serde_json::Map<String, Value>>) { match value { Value::Array(values) => values.iter().for_each(|value| collect_objects(value, output)), Value::Object(object) => { if object.contains_key("id") || object.contains_key("name") || object.contains_key("package") { output.push(object); } else { object.values().for_each(|value| collect_objects(value, output)); } }, _ => {} } }
fn text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> { keys.iter().find_map(|key| object.get(*key).and_then(Value::as_str).map(str::to_owned)) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_marketplaces_and_discovery_output() {
        let marketplaces = marketplaces_from("Configured Marketplaces:\n\n  official  https://example.test/plugins");
        assert_eq!(marketplaces, vec![CatalogMarketplace { name: "official".into(), source: "https://example.test/plugins".into() }]);
        let packages = discovered_from("Available Plugins (official):\n\n  code-review@1.2.3\n    Reviews code", &marketplaces[0]);
        assert_eq!(packages[0].id, "code-review@official");
        assert_eq!(packages[0].version, "1.2.3");
        assert_eq!(packages[0].description, "Reviews code");
    }

    #[test]
    fn preserves_reported_package_metadata() {
        let value = serde_json::json!({ "npm": [{ "id": "pkg", "name": "Package", "version": "1.2.3", "permissions": ["read"] }] });
        let packages = packages_from(value, "installed");
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].version, "1.2.3");
        assert_eq!(packages[0].permissions, vec!["read"]);
        assert!(packages[0].installed);
    }
}
