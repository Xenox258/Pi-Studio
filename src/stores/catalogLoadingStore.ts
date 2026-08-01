import { createSignal } from "solid-js";

export type CatalogMode = "discover" | "installed" | "updates" | "local";
export type CatalogUpdatesState =
	| { kind: "unknown" | "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; count: number };

const [catalogUpdatesState, setCatalogUpdatesState] =
	createSignal<CatalogUpdatesState>({ kind: "unknown" });
export { catalogUpdatesState, setCatalogUpdatesState };

type LoadingCounts = Record<CatalogMode, number>;

const [loadingCounts, setLoadingCounts] = createSignal<LoadingCounts>({
	discover: 0,
	installed: 0,
	updates: 0,
	local: 0,
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
