import { createSignal } from "solid-js";
import { studioApi } from "../api/invoke";
import type { PackageInfo } from "../types";

export type CatalogMode = "discover" | "installed" | "updates" | "errors";
export type CatalogUpdatesState =
	| { kind: "unknown" | "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; count: number };

const [catalogUpdatesState, setCatalogUpdatesState] =
	createSignal<CatalogUpdatesState>({ kind: "unknown" });
export { catalogUpdatesState, setCatalogUpdatesState };

export type CatalogErrorsState =
	| { kind: "unknown" | "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; count: number; severity: "error" | "warning" };

export function catalogErrorSeverity(
	packages: readonly PackageInfo[],
): "error" | "warning" {
	return packages.some((packageInfo) => packageInfo.kind === "Error")
		? "error"
		: "warning";
}

const [catalogErrorsState, setCatalogErrorsState] =
	createSignal<CatalogErrorsState>({ kind: "unknown" });
export { catalogErrorsState, setCatalogErrorsState };

let catalogUpdatesBootstrap: Promise<void> | undefined;
/** App-level single-flight update check. The workspace rail that renders the recommendation is
 * unmounted on compact windows and whenever the details panel is closed, so the sidebar badge
 * must not be fed from it. */
export function bootstrapCatalogUpdates(): Promise<void> {
	if (catalogUpdatesBootstrap) return catalogUpdatesBootstrap;
	if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve();
	setCatalogUpdatesState({ kind: "loading" });
	catalogUpdatesBootstrap = (async () => {
		try {
			const packages = await studioApi.catalog("updates");
			setCatalogUpdatesState({ kind: "ready", count: packages.length });
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: "OMP could not check the configured marketplaces.";
			setCatalogUpdatesState({ kind: "error", message });
		} finally {
			catalogUpdatesBootstrap = undefined;
		}
	})();
	return catalogUpdatesBootstrap;
}

let catalogErrorsBootstrap: Promise<void> | undefined;
/** App-level single-flight errors check so the sidebar badge shows at launch, before any marketplace page is visited. */
export function bootstrapCatalogErrors(): Promise<void> {
	if (catalogErrorsBootstrap) return catalogErrorsBootstrap;
	if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve();
	setCatalogErrorsState({ kind: "loading" });
	catalogErrorsBootstrap = (async () => {
		try {
			const packages = await studioApi.catalog("errors");
			setCatalogErrorsState({
				kind: "ready",
				count: packages.length,
				severity: catalogErrorSeverity(packages),
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: "OMP could not check the configured marketplaces.";
			setCatalogErrorsState({ kind: "error", message });
		} finally {
			catalogErrorsBootstrap = undefined;
		}
	})();
	return catalogErrorsBootstrap;
}

type LoadingCounts = Record<CatalogMode, number>;

const [loadingCounts, setLoadingCounts] = createSignal<LoadingCounts>({
	discover: 0,
	installed: 0,
	updates: 0,
	errors: 0,
});
const [catalogNavigationMode, setCatalogNavigationMode] =
	createSignal<CatalogMode>();
export { catalogNavigationMode };

export function catalogModeLoading(mode: CatalogMode): boolean {
	return catalogNavigationMode() === mode || loadingCounts()[mode] > 0;
}

export function catalogNavigationPending(mode: CatalogMode): boolean {
	return catalogNavigationMode() === mode;
}

export function setCatalogNavigationPending(
	mode: CatalogMode,
	pending: boolean,
): void {
	setCatalogNavigationMode((current) =>
		pending ? mode : current === mode ? undefined : current,
	);
}

export function beginCatalogLoading(mode: CatalogMode): () => void {
	setLoadingCounts((current) => ({ ...current, [mode]: current[mode] + 1 }));
	let pending = true;

	return () => {
		if (!pending) return;
		pending = false;
		setLoadingCounts((current) => ({
			...current,
			[mode]: Math.max(0, current[mode] - 1),
		}));
		setCatalogNavigationPending(mode, false);
	};
}
