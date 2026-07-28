use std::{collections::{HashMap, HashSet}, future::Future, time::{Duration, Instant}};

use serde::Serialize;
use serde_json::Value;
use tokio::{process::Command, sync::{Mutex, RwLock}};

use crate::errors::{StudioError, StudioResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage { pub id: String, pub name: String, pub author: String, pub description: String, pub kind: String, pub version: String, pub downloads: Option<String>, pub installed: bool, pub update_available: bool, pub compatibility: String, pub permissions: Vec<String>, pub resources: Vec<CatalogResource> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResource { pub r#type: String, pub count: u32 }

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMarketplace { pub name: String, pub source: String }

const CATALOG_CACHE_TTL: Duration = Duration::from_secs(1800);

#[derive(Default)]
pub struct CatalogService {
    cache: RwLock<HashMap<String, (Instant, Vec<CatalogPackage>)>>,
    installed_snapshot_guard: Mutex<()>,
    discover_snapshot_guard: Mutex<()>,
}

impl CatalogService {
    pub async fn list(&self, mode: &str) -> StudioResult<Vec<CatalogPackage>> {
        if !matches!(mode, "discover" | "installed" | "updates" | "local") { return Err(StudioError::InvalidInput("invalid catalog mode".into())); }
        if mode == "installed" || mode == "updates" { return self.installed_view(mode == "updates").await; }
        if mode == "discover" { return self.discover_view_with(|| self.discover()).await; }
        if let Some(value) = self.cached(mode).await { return Ok(value); }

        let mut arguments = vec!["plugin", "list", "--json"];
        if mode == "local" { arguments.push("--local"); }
        let output = omp_output(&arguments).await?;
        let packages = if output.trim().is_empty() { Vec::new() } else { packages_from(serde_json::from_str(&output)?, mode) };
        self.cache.write().await.insert(mode.to_owned(), (Instant::now(), packages.clone()));
        Ok(packages)
    }

    async fn cached(&self, mode: &str) -> Option<Vec<CatalogPackage>> {
        let cache = self.cache.read().await;
        cache.get(mode).filter(|(at, _)| at.elapsed() < CATALOG_CACHE_TTL).map(|(_, value)| value.clone())
    }

    async fn discover_view_with<Load, LoadFuture>(&self, load: Load) -> StudioResult<Vec<CatalogPackage>>
    where
        Load: FnOnce() -> LoadFuture,
        LoadFuture: Future<Output = StudioResult<Vec<CatalogPackage>>>,
    {
        if let Some(value) = self.cached("discover").await { return Ok(value); }
        let _snapshot_guard = self.discover_snapshot_guard.lock().await;
        if let Some(value) = self.cached("discover").await { return Ok(value); }
        let packages = load().await?;
        if packages.is_empty() {
            eprintln!("CatalogService: discover returned 0 packages — npm API may be unreachable or rate-limited");
        } else {
            self.cache.write().await.insert("discover".into(), (Instant::now(), packages.clone()));
        }
        Ok(packages)
    }

    pub async fn marketplaces(&self) -> StudioResult<Vec<CatalogMarketplace>> {
        Ok(marketplaces_from(&omp_output(&["plugin", "marketplace", "list"]).await?))
    }

    pub async fn readme(&self, package: &str) -> StudioResult<String> {
        if package.is_empty() || package.len() > 214 || !package.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '@')) {
            return Err(StudioError::InvalidInput("invalid package name".into()));
        }
        fetch_readme(package).await
    }

    pub async fn add_marketplace(&self, source: &str) -> StudioResult<()> {
        let source = source.trim();
        if source.is_empty() || source.len() > 512 || source.chars().any(char::is_control) { return Err(StudioError::InvalidInput("invalid marketplace source".into())); }
        omp_output(&["plugin", "marketplace", "add", source]).await?;
        self.invalidate().await;
        Ok(())
    }

    async fn discover(&self) -> StudioResult<Vec<CatalogPackage>> {
        // The Pi package gallery (pi.dev/packages) is the npm registry filtered to the `pi-package`
        // keyword; mirror it as the default Discover content. Custom OMP marketplaces, when configured,
        // are appended so nothing a user added is lost.
        let marketplace_discoveries = async {
            match self.marketplaces().await {
                Ok(marketplaces) => discover_marketplace_batches(marketplaces).await,
                Err(_) => Vec::new(),
            }
        };
        let (pi_catalog, installed, marketplace_batches) = tokio::join!(
            fetch_pi_catalog(),
            self.installed_identifiers(),
            marketplace_discoveries,
        );
        let mut packages = match pi_catalog {
            Ok(packages) => packages,
            Err(error) => {
                eprintln!("Pi catalog fetch failed, falling back to marketplaces only: {error}");
                Vec::new()
            }
        };
        append_marketplace_batches_in_order(&mut packages, marketplace_batches);
        // Cross-reference the locally installed set so npm and custom marketplace entries show as installed.
        if let Ok(installed) = installed {
            for package in &mut packages {
                if installed.contains(&package.id) || installed.contains(&package.name) { package.installed = true; }
            }
        }
        Ok(packages)
    }

    pub async fn invalidate(&self) {
        let _discover_snapshot_guard = self.discover_snapshot_guard.lock().await;
        let _installed_snapshot_guard = self.installed_snapshot_guard.lock().await;
        self.cache.write().await.clear();
    }

    async fn installed_view(&self, updates_only: bool) -> StudioResult<Vec<CatalogPackage>> {
        let mode = if updates_only { "updates" } else { "installed" };
        if let Some(value) = self.cached(mode).await { return Ok(value); }

        let _snapshot_guard = self.installed_snapshot_guard.lock().await;
        if let Some(value) = self.cached(mode).await { return Ok(value); }

        let output = omp_output(&["plugin", "list", "--json"]).await?;
        let installed = if output.trim().is_empty() { Vec::new() } else { packages_from(serde_json::from_str(&output)?, "installed") };
        let (installed, updates) = installed_views(installed);
        let result = if updates_only { updates.clone() } else { installed.clone() };
        let at = Instant::now();
        let mut cache = self.cache.write().await;
        cache.insert("installed".into(), (at, installed));
        cache.insert("updates".into(), (at, updates));
        Ok(result)
    }

    async fn installed_identifiers(&self) -> StudioResult<HashSet<String>> {
        let installed = self.installed_view(false).await?;
        Ok(installed.into_iter().flat_map(|package| [package.id, package.name]).collect())
    }
}

fn installed_views(installed: Vec<CatalogPackage>) -> (Vec<CatalogPackage>, Vec<CatalogPackage>) {
    let updates = installed.iter().filter(|package| package.update_available).cloned().collect();
    (installed, updates)
}

async fn omp_output(arguments: &[&str]) -> StudioResult<String> {
    let output = Command::new("omp").args(arguments).output().await.map_err(|error| StudioError::OmpUnavailable(error.to_string()))?;
    if !output.status.success() { return Err(StudioError::Omp(String::from_utf8_lossy(&output.stderr).trim().to_owned())); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn discover_marketplace_batches(marketplaces: Vec<CatalogMarketplace>) -> Vec<(usize, Vec<CatalogPackage>)> {
    let mut requests = tokio::task::JoinSet::new();
    for (index, marketplace) in marketplaces.into_iter().enumerate() {
        requests.spawn(async move {
            match omp_output(&["plugin", "discover", marketplace.name.as_str()]).await {
                Ok(output) => Some((index, discovered_from(&output, &marketplace))),
                Err(_) => None,
            }
        });
    }

    let mut batches = Vec::with_capacity(requests.len());
    while let Some(result) = requests.join_next().await {
        if let Ok(Some(batch)) = result { batches.push(batch); }
    }
    batches
}

fn append_marketplace_batches_in_order(packages: &mut Vec<CatalogPackage>, mut batches: Vec<(usize, Vec<CatalogPackage>)>) {
    batches.sort_unstable_by_key(|(index, _)| *index);
    packages.reserve(batches.iter().map(|(_, batch)| batch.len()).sum());
    for (_, batch) in batches { packages.extend(batch); }
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
    entries.into_iter().map(|(name, version, description)| {
        let kind = marketplace_kind(&name).into();
        CatalogPackage {
            id: format!("{name}@{}", marketplace.name), name, author: marketplace.name.clone(), description, kind, version, downloads: None, installed: false, update_available: false, compatibility: "OMP marketplace".into(), permissions: Vec::new(), resources: vec![CatalogResource { r#type: "Plugin".into(), count: 1 }],
        }
    }).collect()
}

fn marketplace_kind(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    if name.contains("skill") { "Skill" }
    else if name.contains("prompt") { "Prompt" }
    else if name.contains("theme") { "Theme" }
    else if name.contains("extension") { "Extension" }
    else { "Package" }
}

const PI_PAGE_SIZE: usize = 250;
const PI_PAGE_CONCURRENCY: usize = 6;

async fn fetch_pi_catalog() -> StudioResult<Vec<CatalogPackage>> {
    // Fetch the first page eagerly to learn the total, then load the rest concurrently.
    let first = fetch_pi_page(0).await?;
    let first_count = first.get("objects").and_then(Value::as_array).map_or(0, Vec::len);
    if first_count == 0 { return Ok(Vec::new()); }
    let total = first.get("total").and_then(Value::as_u64).unwrap_or(first_count as u64) as usize;
    let mut pages = Vec::with_capacity(total.div_ceil(PI_PAGE_SIZE));
    pages.push((0, pi_packages_from(&first)));

    let mut next_offset = first_count;
    let mut requests = tokio::task::JoinSet::new();
    let mut pagination_failed = false;
    while (!pagination_failed && next_offset < total) || !requests.is_empty() {
        while !pagination_failed && next_offset < total && requests.len() < PI_PAGE_CONCURRENCY {
            let offset = next_offset;
            requests.spawn(async move { (offset, fetch_pi_page(offset).await) });
            next_offset += PI_PAGE_SIZE;
        }
        if let Some(result) = requests.join_next().await {
            match result {
                Ok((offset, Ok(value))) => pages.push((offset, pi_packages_from(&value))),
                Ok((offset, Err(error))) => {
                    if !pagination_failed {
                        let loaded = pages.iter().map(|(_, page)| page.len()).sum::<usize>();
                        let reason = if error.to_string().contains("429") { "npm rate limit" } else { "page fetch failure" };
                        eprintln!("Pi catalog pagination stopped at offset {offset} ({reason}); using {loaded} packages already loaded");
                        pagination_failed = true;
                        requests.abort_all();
                    }
                },
                Err(error) if error.is_cancelled() => {},
                Err(error) => {
                    if !pagination_failed {
                        eprintln!("Pi catalog pagination task failed; using successfully loaded pages: {error}");
                        pagination_failed = true;
                        requests.abort_all();
                    }
                },
            }
        }
    }

    pages.sort_unstable_by_key(|(offset, _)| *offset);
    let mut packages = Vec::with_capacity(total);
    for (_, page) in pages { packages.extend(page); }
    Ok(packages)
}

async fn fetch_pi_page(from: usize) -> StudioResult<Value> {
    let url = format!("https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size={PI_PAGE_SIZE}&from={from}");
    let output = Command::new("curl")
        .args(["-sSL", "--fail", "--max-time", "25", "-H", "accept: application/json", &url])
        .output()
        .await
        .map_err(|error| StudioError::OmpUnavailable(format!("curl is required to load the Pi catalog: {error}")))?;
    if !output.status.success() {
        return Err(StudioError::Omp(format!("npm registry request failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn pi_packages_from(value: &Value) -> Vec<CatalogPackage> {
    value.get("objects").and_then(Value::as_array).into_iter().flatten().filter_map(|entry| {
        let package = entry.get("package")?;
        let name = package.get("name").and_then(Value::as_str).filter(|name| !name.is_empty())?.to_owned();
        let keywords: Vec<String> = package.get("keywords").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_lowercase).collect()).unwrap_or_default();
        Some(CatalogPackage {
            id: name.clone(),
            name,
            author: package.get("publisher").and_then(|publisher| publisher.get("username")).and_then(Value::as_str).unwrap_or_default().to_owned(),
            description: package.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
            kind: pi_kind(&keywords),
            version: package.get("version").and_then(Value::as_str).unwrap_or("Not reported").to_owned(),
            downloads: format_downloads(entry),
            installed: false,
            update_available: false,
            compatibility: "Pi package".into(),
            permissions: Vec::new(),
            resources: Vec::new(),
        })
    }).collect()
}

fn pi_kind(keywords: &[String]) -> String {
    let exact = |needle: &str| keywords.iter().any(|keyword| keyword == needle);
    let fuzzy = |needle: &str| keywords.iter().any(|keyword| keyword.contains(needle));
    if fuzzy("pi-extension") || exact("extension") { "Extension".into() }
    else if fuzzy("pi-skill") || exact("skill") { "Skill".into() }
    else if fuzzy("pi-theme") || exact("theme") { "Theme".into() }
    else if fuzzy("pi-prompt") || exact("prompt") { "Prompt".into() }
    else { "Package".into() }
}

fn format_downloads(entry: &Value) -> Option<String> {
    let monthly = entry.get("downloads").and_then(|downloads| downloads.get("monthly")).and_then(Value::as_f64)?;
    Some(format!("{}/mo", compact_number(monthly)))
}

fn compact_number(value: f64) -> String {
    if value >= 1_000_000.0 { format!("{:.1}M", value / 1_000_000.0) }
    else if value >= 1_000.0 { format!("{:.1}K", value / 1_000.0) }
    else { format!("{}", value.max(0.0) as u64) }
}

async fn fetch_readme(package: &str) -> StudioResult<String> {
    let url = format!("https://registry.npmjs.org/{}", package.replace('/', "%2F"));
    let output = Command::new("curl")
        .args(["-sSL", "--fail", "--max-time", "20", "-H", "accept: application/json", &url])
        .output()
        .await
        .map_err(|error| StudioError::OmpUnavailable(format!("curl is required to load package details: {error}")))?;
    if !output.status.success() {
        return Err(StudioError::Omp(format!("npm registry request failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    Ok(readme_from(&serde_json::from_slice(&output.stdout)?))
}

fn readme_from(value: &Value) -> String {
    if let Some(readme) = value.get("readme").and_then(Value::as_str) {
        if !readme.trim().is_empty() && !readme.contains("No README data") { return readme.to_owned(); }
    }
    let latest = value.get("dist-tags").and_then(|tags| tags.get("latest")).and_then(Value::as_str);
    if let Some(latest) = latest {
        if let Some(readme) = value.get("versions").and_then(|versions| versions.get(latest)).and_then(|version| version.get("readme")).and_then(Value::as_str) {
            if !readme.trim().is_empty() { return readme.to_owned(); }
        }
    }
    String::new()
}

fn packages_from(value: Value, mode: &str) -> Vec<CatalogPackage> {
    let mut objects = Vec::new(); collect_objects(&value, &mut objects);
    objects.into_iter().filter_map(|object| {
        let id = text(object, &["id", "package", "name"])?; let name = text(object, &["name", "id"]).unwrap_or_else(|| id.clone());
        Some(CatalogPackage { id, name, author: text(object, &["author"]).unwrap_or_default(), description: text(object, &["description"]).unwrap_or_default(), kind: text(object, &["kind", "type"]).unwrap_or_else(|| "Package".into()), version: text(object, &["version"]).unwrap_or_else(|| "Not reported".into()), downloads: None, installed: mode != "discover", update_available: object.get("updateAvailable").and_then(Value::as_bool).unwrap_or(false), compatibility: text(object, &["compatibility"]).unwrap_or_else(|| "Not reported".into()), permissions: object.get("permissions").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(), resources: resources_from(object) })
    }).collect()
}

fn resources_from(object: &serde_json::Map<String, Value>) -> Vec<CatalogResource> {
    let Some(manifest) = object.get("manifest").and_then(Value::as_object) else { return Vec::new(); };
    [("extensions", "Extension"), ("skills", "Skill"), ("prompts", "Prompt"), ("themes", "Theme")].into_iter().filter_map(|(key, kind)| {
        let count = manifest.get(key).and_then(Value::as_array).map_or(0, Vec::len);
        (count > 0).then(|| CatalogResource { r#type: kind.into(), count: count.min(u32::MAX as usize) as u32 })
    }).collect()
}

fn collect_objects<'a>(value: &'a Value, output: &mut Vec<&'a serde_json::Map<String, Value>>) { match value { Value::Array(values) => values.iter().for_each(|value| collect_objects(value, output)), Value::Object(object) => { if object.contains_key("id") || object.contains_key("name") || object.contains_key("package") { output.push(object); } object.values().for_each(|value| collect_objects(value, output)); }, _ => {} } }
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
    fn classifies_marketplace_packages_by_name() {
        let marketplace = CatalogMarketplace { name: "official".into(), source: "https://example.test/plugins".into() };
        let packages = discovered_from("Available Plugins (official):\n\n  skill-lint@1.0.0\n  prompt-review@1.0.0\n  ui-theme@1.0.0\n  code-extension@1.0.0\n  utility@1.0.0", &marketplace);
        assert_eq!(packages.iter().map(|package| package.kind.as_str()).collect::<Vec<_>>(), vec!["Skill", "Prompt", "Theme", "Extension", "Package"]);
    }


    #[test]
    fn appends_marketplace_batches_in_configured_order_after_pi_catalog() {
        let mut packages = pi_packages_from(&serde_json::json!({ "objects": [
            { "package": { "name": "npm-package", "version": "1.0.0" } }
        ] }));
        let first = CatalogMarketplace { name: "first".into(), source: "https://first.test".into() };
        let third = CatalogMarketplace { name: "third".into(), source: "https://third.test".into() };

        append_marketplace_batches_in_order(&mut packages, vec![
            (2, discovered_from("Available Plugins (third):\n\n  third-a@1.0.0\n  third-b@1.0.0", &third)),
            (0, discovered_from("Available Plugins (first):\n\n  first-a@1.0.0", &first)),
        ]);

        assert_eq!(packages.iter().map(|package| package.name.as_str()).collect::<Vec<_>>(), vec!["npm-package", "first-a", "third-a", "third-b"]);
    }

    #[tokio::test]
    async fn deduplicates_concurrent_discover_cache_fill() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        async fn load(calls: &AtomicUsize) -> StudioResult<Vec<CatalogPackage>> {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(pi_packages_from(&serde_json::json!({ "objects": [
                { "package": { "name": "cached-package", "version": "1.0.0" } }
            ] })))
        }

        let service = CatalogService::default();
        let calls = AtomicUsize::new(0);
        let (first, second) = tokio::join!(
            service.discover_view_with(|| load(&calls)),
            service.discover_view_with(|| load(&calls)),
        );

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.unwrap()[0].name, "cached-package");
        assert_eq!(second.unwrap()[0].name, "cached-package");
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

    #[test]
    fn preserves_installed_manifest_resource_kinds() {
        let value = serde_json::json!({ "npm": [{
            "name": "bundle",
            "version": "1.0.0",
            "manifest": { "extensions": ["./extension.js"], "skills": ["./skills"], "prompts": ["./prompt-a", "./prompt-b"] }
        }] });
        let packages = packages_from(value, "installed");
        let resources = packages[0].resources.iter().map(|resource| (resource.r#type.as_str(), resource.count)).collect::<Vec<_>>();
        assert_eq!(resources, vec![("Extension", 1), ("Skill", 1), ("Prompt", 2)]);
    }

    #[test]
    fn collects_all_nested_packages() {
        let value = serde_json::json!({
            "plugins": [
                {"name": "skill-a", "kind": "Skill", "version": "1.0"},
                {"name": "skill-b", "kind": "Skill", "version": "2.0"},
                {"name": "prompt-x", "kind": "Prompt", "version": "1.5"},
            ]
        });
        let packages = packages_from(value, "installed");
        assert_eq!(packages.len(), 3);
        assert_eq!(packages[0].kind, "Skill");
        assert_eq!(packages[2].kind, "Prompt");
    }


    #[test]
    fn derives_updates_from_installed_snapshot() {
        let installed = packages_from(serde_json::json!({ "plugins": [
            { "name": "current", "version": "1.0.0", "updateAvailable": false },
            { "name": "outdated", "version": "1.0.0", "updateAvailable": true },
            { "name": "also-current", "version": "2.0.0" }
        ] }), "installed");
        let (installed, updates) = installed_views(installed);

        assert_eq!(installed.iter().map(|package| package.name.as_str()).collect::<Vec<_>>(), vec!["current", "outdated", "also-current"]);
        assert_eq!(updates.iter().map(|package| package.name.as_str()).collect::<Vec<_>>(), vec!["outdated"]);
        assert!(updates.iter().all(|package| package.update_available));
    }

    #[test]
    fn maps_pi_gallery_search_results() {
        let value = serde_json::json!({ "objects": [
            { "package": { "name": "pi-lens", "version": "3.8.71", "description": "Real-time code feedback", "keywords": ["pi-package", "pi-extension"], "publisher": { "username": "apmantza" } } },
            { "package": { "name": "bigpowers", "version": "2.81.0", "keywords": ["pi-package", "skill"], "publisher": { "username": "danielvm" } } },
            { "package": { "name": "plain", "version": "1.0.0", "keywords": ["pi-package"] } }
        ] });
        let packages = pi_packages_from(&value);
        assert_eq!(packages.len(), 3);
        assert_eq!(packages[0].id, "pi-lens");
        assert_eq!(packages[0].kind, "Extension");
        assert_eq!(packages[0].author, "apmantza");
        assert_eq!(packages[1].kind, "Skill");
        assert_eq!(packages[2].kind, "Package");
    }

    #[test]
    fn recognizes_fuzzy_pi_keywords_without_broad_false_positives() {
        assert_eq!(pi_kind(&[" pi-extension-v2 ".into()]), "Extension");
        assert_eq!(pi_kind(&["pi-skill-bundle".into()]), "Skill");
        assert_eq!(pi_kind(&["pi-theme-dark".into()]), "Theme");
        assert_eq!(pi_kind(&["pi-prompt-library".into()]), "Prompt");
        assert_eq!(pi_kind(&["skillful".into(), "prompting".into()]), "Package");
    }
}
