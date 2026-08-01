import { A, useLocation, useNavigate } from "@solidjs/router";
import {
	AlertCircle,
	Box,
	ChevronDown,
	ChevronRight,
	Folder,
	Gauge,
	KeyRound,
	Loader2,
	MessageSquare,
	PackageCheck,
	PackageOpen,
	Pencil,
	Plus,
	Search,
	Settings,
	Sparkles,
	SquarePen,
	Trash2,
	X,
} from "lucide-solid";
import { For, Show, createEffect, createSignal } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Dialog } from "../ui";
import { studioApi } from "../../api/invoke";
import {
	activeModelLabel,
	activeSession,
	clearWorkspace,
	resumeStoredSession,
	setActiveSession,
	startConfiguredSession,
} from "../../stores/appStore";
import { catalogModeLoading, catalogNavigationPending, catalogUpdatesState, setCatalogNavigationPending, type CatalogMode } from "../../stores/catalogLoadingStore";
import type { ProjectSummary, SessionSummary } from "../../types";

type MarketplaceItem = {
	href: string;
	label: string;
	icon: typeof Search;
	mode?: CatalogMode;
};

const marketplace: readonly MarketplaceItem[] = [
	{ href: "/discover", label: "Discover", icon: Search, mode: "discover" },
	{ href: "/installed", label: "Installed", icon: Box, mode: "installed" },
	{ href: "/updates", label: "Updates", icon: PackageCheck, mode: "updates" },
	{ href: "/local", label: "Local resources", icon: PackageOpen, mode: "local" },
	{ href: "/usage", label: "Usage & limits", icon: Gauge },
];

const PROJECT_LIMIT = 4;
const SESSION_LIMIT = 4;

function compactAge(iso: string): string {
	const elapsed = Date.now() - new Date(iso).valueOf();
	if (!Number.isFinite(elapsed) || elapsed < 60_000) return "now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
	if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
	if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(new Date(iso));
}

export default function Sidebar() {
	const location = useLocation();
	const navigate = useNavigate();
	const [status, setStatus] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [searchOpen, setSearchOpen] = createSignal(false);
	const [expandedProjectIds, setExpandedProjectIds] = createSignal<string[]>(
		[],
	);
	const [showAllSessionsFor, setShowAllSessionsFor] = createSignal<string[]>(
		[],
	);
	const [showAllProjects, setShowAllProjects] = createSignal(false);
	const [pendingDelete, setPendingDelete] = createSignal<SessionSummary | null>(
		null,
	);
	const [projects, setProjects] = createSignal<ProjectSummary[]>([]);
	const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
	const [pendingSessionId, setPendingSessionId] = createSignal<string | null>(
		null,
	);
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [editingValue, setEditingValue] = createSignal("");
	let groupsInitialized = false;

	async function refresh() {
		if (!("__TAURI_INTERNALS__" in window)) return;
		const [nextProjects, nextSessions] = await Promise.all([
			studioApi.recentProjects(),
			studioApi.recentSessions(),
		]);
		setProjects(nextProjects);
		setSessions(nextSessions);
	}
	void refresh();

	createEffect(() => {
		const list = projects();
		if (groupsInitialized || !list.length) return;
		setExpandedProjectIds([activeSession()?.projectId ?? list[0].id]);
		groupsInitialized = true;
	});

	const active = (href: string) => location.pathname === href;
	const knownUpdateCount = () => {
		const state = catalogUpdatesState();
		return state.kind === "ready" && state.count > 0 ? state.count : undefined;
	};
	const displayTitle = (session: SessionSummary) =>
		activeSession()?.id === session.id ? activeSession()!.title : session.title;
	const isExpanded = (projectId: string) =>
		expandedProjectIds().includes(projectId);
	const normalizedQuery = () => query().trim().toLocaleLowerCase();

	const sessionsFor = (projectId: string) => {
		const q = normalizedQuery();
		return sessions().filter(
			(session) =>
				session.projectId === projectId &&
				(!q || displayTitle(session).toLocaleLowerCase().includes(q)),
		);
	};
	const filteredProjects = () => {
		const q = normalizedQuery();
		return projects().filter(
			(project) =>
				!q ||
				project.name.toLocaleLowerCase().includes(q) ||
				sessionsFor(project.id).length > 0,
		);
	};
	const visibleProjects = () => {
		const list = filteredProjects();
		return showAllProjects() || normalizedQuery()
			? list
			: list.slice(0, PROJECT_LIMIT);
	};
	const hasMoreProjects = () =>
		!normalizedQuery() &&
		!showAllProjects() &&
		filteredProjects().length > PROJECT_LIMIT;
	const displayedSessions = (projectId: string) => {
		const all = sessionsFor(projectId);
		return normalizedQuery() || showAllSessionsFor().includes(projectId)
			? all
			: all.slice(0, SESSION_LIMIT);
	};
	const hasMoreSessions = (projectId: string) =>
		!normalizedQuery() &&
		!showAllSessionsFor().includes(projectId) &&
		sessionsFor(projectId).length > SESSION_LIMIT;

	function toggleProject(projectId: string) {
		setExpandedProjectIds((current) =>
			current.includes(projectId)
				? current.filter((id) => id !== projectId)
				: [...current, projectId],
		);
	}

	async function createSession(project: ProjectSummary) {
		try {
			setStatus("");
			const opened = await startConfiguredSession(project.path);
			setExpandedProjectIds((current) =>
				current.includes(opened.id) ? current : [...current, opened.id],
			);
			await refresh();
			navigate("/");
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Unable to start session",
			);
		}
	}

	async function chooseProject() {
		const path = await open({
			directory: true,
			multiple: false,
			title: "Choose a folder for this session",
		});
		if (typeof path !== "string") return;
		await createSession({ id: "", name: "", path });
	}

	async function activateSession(session: SessionSummary) {
		if (pendingSessionId()) return;
		setStatus("");
		setPendingSessionId(session.id);
		setExpandedProjectIds((current) =>
			current.includes(session.projectId)
				? current
				: [...current, session.projectId],
		);
		navigate("/");
		try {
			await resumeStoredSession(session);
			await refresh();
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Unable to resume session",
			);
		} finally {
			setPendingSessionId(null);
		}
	}

	async function confirmDelete() {
		const session = pendingDelete();
		if (!session) return;
		setPendingDelete(null);
		try {
			setStatus("");
			await studioApi.deleteSession(session.id);
			if (activeSession()?.id === session.id) clearWorkspace();
			await refresh();
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Unable to delete session",
			);
		}
	}

	async function commitRename() {
		const id = editingId();
		const value = editingValue().trim();
		setEditingId(null);
		if (!id || !value) return;
		try {
			setStatus("");
			await studioApi.setSessionTitle(id, value);
			if (activeSession()?.id === id)
				setActiveSession((current) =>
					current ? { ...current, title: value } : current,
				);
			await refresh();
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Unable to rename session",
			);
		}
	}

	return (
		<aside class="sidebar">
			<A href="/" class="brand" aria-label="OMP Studio" title="OMP Studio">
				<span class="brand-mark">
					<Box size={22} />
				</span>
				<strong>OMP Studio</strong>
			</A>
			<nav aria-label="Main navigation">
				<div class="sidebar-primary-actions">
					<button
						class="nav-item new-session-action"
						aria-label="New session"
						title="New session"
						onClick={() => void chooseProject()}
					>
						<SquarePen size={17} />
						<span>New session</span>
					</button>
					<button
						class="nav-item"
						aria-label="Open Project"
						title="Open Project"
						onClick={() => void chooseProject()}
					>
						<Plus size={18} />
						<span>Open Project</span>
					</button>
				</div>
				<section class="session-browser" aria-label="Projects and sessions">
					<div class="nav-section-heading">
						<span>Projects &amp; Sessions</span>
						<button
							aria-label="Search sessions"
							title="Search sessions"
							class={searchOpen() ? "is-active" : ""}
							onClick={() => {
								setSearchOpen((value) => !value);
								if (searchOpen()) setQuery("");
							}}
						>
							<Search size={14} />
						</button>
					</div>
					<Show when={searchOpen()}>
						<input
							class="session-search"
							aria-label="Filter projects and sessions"
							placeholder="Filter projects and sessions…"
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
					</Show>
					<div
						class={`sidebar-sessions ${visibleProjects().length === 0 ? "is-empty" : ""}`}
					>
						<Show
							when={visibleProjects().length}
							fallback={
								<p class="session-browser__empty">
									No projects yet. Start a new session to begin.
								</p>
							}
						>
							<For each={visibleProjects()}>
								{(project) => {
									const expanded = () =>
										isExpanded(project.id) || Boolean(normalizedQuery());
									return (
										<div class="project-group">
											<button
												class="project-group-row"
												aria-expanded={expanded()}
												title={project.path}
												onClick={() => toggleProject(project.id)}
											>
												<Folder size={15} />
												<strong>{project.name}</strong>
												<small>{sessionsFor(project.id).length || ""}</small>
												{expanded() ? (
													<ChevronDown size={13} />
												) : (
													<ChevronRight size={13} />
												)}
											</button>
											<Show when={expanded()}>
												<For each={displayedSessions(project.id)}>
													{(session) => (
														<div
															class={`session-row ${activeSession()?.id === session.id ? "is-active" : ""} ${pendingSessionId() === session.id ? "is-loading" : ""}`}
														>
															<Show
																when={editingId() === session.id}
																fallback={
																	<button
																		class="session-row__open"
																		disabled={Boolean(pendingSessionId())}
																		aria-label={displayTitle(session)}
																		title={`${displayTitle(session)} · ${new Date(session.updatedAt).toLocaleString()}`}
																		onDblClick={() => {
																			setEditingId(session.id);
																			setEditingValue(displayTitle(session));
																		}}
																		onClick={() =>
																			void activateSession(session)
																		}
																	>
																		{pendingSessionId() === session.id ? (
																			<Loader2 size={14} class="spin" />
																		) : (
																			<MessageSquare size={14} />
																		)}
																		<span>{displayTitle(session)}</span>
																	</button>
																}
															>
																<input
																	class="session-row__rename"
																	value={editingValue()}
																	ref={(el) =>
																		setTimeout(() => {
																			el.focus();
																			el.select();
																		})
																	}
																	onInput={(event) =>
																		setEditingValue(event.currentTarget.value)
																	}
																	onKeyDown={(event) => {
																		if (event.key === "Enter") {
																			event.preventDefault();
																			void commitRename();
																		} else if (event.key === "Escape")
																			setEditingId(null);
																	}}
																	onBlur={() => void commitRename()}
																/>
															</Show>
															<Show when={editingId() !== session.id}>
																<time>{compactAge(session.updatedAt)}</time>
																<button
																	class="session-row__action"
																	aria-label={`Rename session ${displayTitle(session)}`}
																	title="Rename session"
																	onClick={() => {
																		setEditingId(session.id);
																		setEditingValue(displayTitle(session));
																	}}
																>
																	<Pencil size={13} />
																</button>
																<button
																	class="session-row__delete"
																	aria-label={`Delete session ${displayTitle(session)}`}
																	title="Delete session"
																	onClick={() => setPendingDelete(session)}
																>
																	<Trash2 size={13} />
																</button>
															</Show>
														</div>
													)}
												</For>
												<Show when={!displayedSessions(project.id).length}>
													<p class="session-browser__empty session-browser__empty--nested">
														No sessions yet.
													</p>
												</Show>
												<Show when={hasMoreSessions(project.id)}>
													<button
														class="see-all-row"
														onClick={() =>
															setShowAllSessionsFor((ids) => [
																...ids,
																project.id,
															])
														}
													>
														See all sessions for this project
													</button>
												</Show>
												<Show
													when={
														!normalizedQuery() &&
														showAllSessionsFor().includes(project.id) &&
														sessionsFor(project.id).length > SESSION_LIMIT
													}
												>
													<button
														class="see-all-row"
														onClick={() =>
															setShowAllSessionsFor((ids) =>
																ids.filter((id) => id !== project.id),
															)
														}
													>
														Show fewer sessions
													</button>
												</Show>
											</Show>
										</div>
									);
								}}
							</For>
							<Show when={hasMoreProjects()}>
								<button
									class="see-all-row see-all-row--projects"
									onClick={() => setShowAllProjects(true)}
								>
									See all projects
								</button>
							</Show>
							<Show
								when={
									!normalizedQuery() &&
									showAllProjects() &&
									filteredProjects().length > PROJECT_LIMIT
								}
							>
								<button
									class="see-all-row see-all-row--projects"
									onClick={() => setShowAllProjects(false)}
								>
									Show fewer projects
								</button>
							</Show>
						</Show>
					</div>
				</section>
				<div class="sidebar-secondary">
					<p class="nav-label">Marketplace</p>
					<For each={marketplace}>
						{(item) => {
							const loading = () => item.mode ? catalogModeLoading(item.mode) : false;
							return (
								<A
									href={item.href}
									class={`nav-item ${active(item.href) ? "is-active" : ""}`}
									aria-label={item.mode === "updates" && knownUpdateCount() ? `${item.label}, ${knownUpdateCount()} ${knownUpdateCount() === 1 ? "update" : "updates"} available` : item.label}
									aria-busy={loading()}
									title={item.label}
								onClick={(event) => {
									if (!item.mode) return;
									if (active(item.href) || catalogNavigationPending(item.mode)) {
										event.preventDefault();
										return;
									}
									setCatalogNavigationPending(item.mode, true);
								}}
								>
									<Show when={loading()} fallback={<item.icon size={17} />}>
										<Loader2 size={17} class="spin" aria-hidden="true" />
									</Show>
									<span>{item.label}</span>
									<Show when={item.mode === "updates" ? knownUpdateCount() : undefined}>{count => <span class="nav-item__count" aria-hidden="true">{count()}</span>}</Show>
								</A>
							);
						}}
					</For>
					<p class="nav-label">Models</p>
					<A
						href="/models"
						class={`nav-item ${active("/models") ? "is-active" : ""}`}
						aria-label={`Models · ${activeModelLabel()}`}
						title={`Models · ${activeModelLabel()}`}
					>
						<Sparkles size={17} />
						<span>{activeModelLabel()}</span>
					</A>
					<A
						href="/providers"
						class={`nav-item ${active("/providers") ? "is-active" : ""}`}
						aria-label="Providers"
						title="Providers"
					>
						<KeyRound size={17} />
						<span>Providers</span>
					</A>
				</div>
			</nav>
			<Show when={status()}>
				<div class="sidebar-alert" role="alert">
					<AlertCircle size={15} />
					<p>{status()}</p>
					<button
						type="button"
						aria-label="Dismiss error"
						onClick={() => setStatus("")}
					>
						<X size={13} />
					</button>
				</div>
			</Show>
			<div class="sidebar-footer">
				<A
					href="/settings"
					class={`nav-item ${active("/settings") ? "is-active" : ""}`}
					aria-label="Settings"
					title="Settings"
				>
					<Settings size={18} />
					<span>Settings</span>
				</A>
			</div>
			<Dialog
				open={Boolean(pendingDelete())}
				title="Delete session"
				onClose={() => setPendingDelete(null)}
				actions={
					<>
						<Button onClick={() => setPendingDelete(null)}>Cancel</Button>
						<Button
							tone="danger"
							variant="solid"
							onClick={() => void confirmDelete()}
						>
							Delete
						</Button>
					</>
				}
			>
				<p>
					Delete “{pendingDelete() ? displayTitle(pendingDelete()!) : ""}”? This
					removes it from your session history.
				</p>
			</Dialog>
		</aside>
	);
}
