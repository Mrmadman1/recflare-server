import { useCallback, useEffect, useState } from 'react'

import { KickReportCategory } from '../../../notify/src/notification-payloads'
import { accountIdForUsername, call, isAdmin, useAction, usernamesFor } from './api'

import type { PublicAccount } from './api'

/**
 * The staff moderation panel, at `/moderation`.
 *
 * Its own file rather than another section of App.tsx: App renders this, so the shared
 * plumbing both need lives in api.ts (see the note there), and this is a whole surface
 * rather than one more form on the account dashboard.
 *
 * Everything here talks to `www`'s own `/api/staff/*` endpoints (see src/staff.ts) —
 * except the names, which come from `accounts`' bulk lookup, the same endpoint the game
 * uses. The staff reads return account IDS; a moderation table whose rows are numbers is
 * unreadable, and joining names on the server would tie those reads to a table another
 * worker owns.
 *
 * The `isAdmin()` gate below is cosmetic. It decodes the token's `role` claim without
 * verifying it, because a page holds no signing key — faking it reveals a table that
 * every endpoint behind it answers 403 to. `requireStaff` is the real gate.
 */

/** What the panel is showing. The player history is a drill-down from any of them. */
type Tab = 'queue' | 'search' | 'bans' | 'new'

const TABS: Array<{ id: Tab; label: string }> = [
	// Queue first: "who is a problem right now" is the question someone opens this page
	// with, where the search is what you use once you know who you're looking at.
	{ id: 'queue', label: 'Report queue' },
	{ id: 'search', label: 'Search reports' },
	{ id: 'bans', label: 'Standing bans' },
	{ id: 'new', label: 'File a report' },
]

/**
 * A stored report, as `www` serves the row — snake_case, because it IS the row. Not every
 * column is rendered; the ones that are not (the measured heights, the instance type) are
 * kept in the type so a row can be passed around whole.
 */
interface ReportRow {
	id: number
	reporter_player_id: number
	reported_player_id: number
	report_category: number
	details: string | null
	room_id: number | null
	room_instance_type: string | null
	created_at: string
	banned: number
	ban_expires: string | null
	event_id: number | null
	invention_id: number | null
	custom_avatar_item_id: string | null
	banned_by_player_id: number | null
	banned_at: string | null
}

/** A moderator-issued warning, as the `warning` table stores it. */
interface WarningRow {
	id: number
	moderator_player_id: number
	warned_player_id: number
	report_category: number
	display_reason: string | null
	moderator_note: string | null
	created_at: string
}

/** A row of the report queue — see `getTopReported`. */
interface ReportedPlayerTally {
	playerId: number
	reports: number
	distinctReporters: number
	lastReportAt: string
	bannedNow: boolean
}

/** An account a ban would also reach, and what links it — see `linkedAccounts`. */
interface LinkedAccount {
	accountId: number
	username: string | null
	via: 'platform' | 'ip'
	value: string
}

/**
 * What a report's category means, keyed off the client's own enum so a renumbering moves
 * these labels with it rather than leaving them quietly wrong.
 *
 * The names are the client's, made readable: `CoCSexual` is the code of conduct's sexual
 * content rule, and a moderator reading a table should not have to know that. An id with
 * no entry is shown as the bare number — the column is stored verbatim and unmapped (see
 * the report write), so a build that reports something new must not render a blank.
 */
const CATEGORY_LABEL: Record<number, string> = {
	[KickReportCategory.Moderator]: 'Moderator action',
	[KickReportCategory.Unknown]: 'Unspecified',
	[KickReportCategory.Harassment]: 'Harassment',
	[KickReportCategory.Cheating]: 'Cheating',
	[KickReportCategory.AFK]: 'Inactive (AFK)',
	[KickReportCategory.Misc]: 'Game conduct',
	[KickReportCategory.Underage]: 'Underage',
	[KickReportCategory.VoteKick]: 'Vote to kick',
	[KickReportCategory.MisleadingPurchases]: 'Misleading purchases',
	[KickReportCategory.CoCUnderage]: 'Underage (CoC)',
	[KickReportCategory.CoCSexual]: 'Sexual content',
	[KickReportCategory.CoCDiscrimination]: 'Discrimination',
	[KickReportCategory.CoCTrolling]: 'Griefing / trolling',
	[KickReportCategory.CoCNameOrProfile]: 'Name or profile',
	[KickReportCategory.InappropriateClothing]: 'Inappropriate clothing',
	[KickReportCategory.IssuingInaccurateReports]: 'Inaccurate reports',
}

/** The categories the file-a-report form offers, in the order it lists them. */
const FILEABLE_CATEGORIES = [
	KickReportCategory.CoCDiscrimination,
	KickReportCategory.CoCSexual,
	KickReportCategory.CoCTrolling,
	KickReportCategory.Harassment,
	KickReportCategory.CoCNameOrProfile,
	KickReportCategory.CoCUnderage,
	KickReportCategory.Cheating,
	KickReportCategory.InappropriateClothing,
	KickReportCategory.IssuingInaccurateReports,
	KickReportCategory.Misc,
]

const categoryLabel = (id: number): string => CATEGORY_LABEL[id] ?? `Category ${id}`

/** How many reports one page of search results holds. */
const PAGE_SIZE = 25

/** A date as a moderator reads it — local time, to the minute, no seconds. */
function when(iso: string | null): string {
	if (iso === null) return '—'
	const parsed = Date.parse(iso)
	if (Number.isNaN(parsed)) return iso
	return new Date(parsed).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	})
}

/**
 * What a ban's expiry says on screen. A null expiry is permanent, not missing — the two
 * read identically as an empty cell, and confusing them is the difference between a
 * week's ban and a life one.
 */
const expiryLabel = (report: ReportRow): string =>
	report.banned !== 1 ? '—' : report.ban_expires === null ? 'Permanent' : when(report.ban_expires)

/**
 * What kind of thing a report is against. The three id columns are mutually exclusive and
 * a row with none of them is an ordinary player report (see reports-db) — which is the
 * only way to tell the kinds apart, so it is worth a column of its own.
 */
function reportKind(report: ReportRow): string {
	if (report.event_id !== null) return 'Event'
	if (report.invention_id !== null) return 'Invention'
	if (report.custom_avatar_item_id !== null) return 'Avatar item'
	return 'Player'
}

/** A player as a name plus id — the id always shown, since ids are what the rows carry. */
function PlayerName({ id, names }: { id: number; names: Map<number, PublicAccount> }) {
	const account = names.get(id)
	return (
		<span className="mod-player">
			{account?.username ? `@${account.username}` : 'unknown'}
			<span className="muted"> #{id}</span>
		</span>
	)
}

/**
 * The read of a staff endpoint, with the loading and failure states the panel renders.
 * `data === null` with no error means still in flight.
 *
 * A `null` path means "nothing to read yet" and holds whatever was last loaded — the
 * search uses it so the table doesn't clear itself between submissions. Re-reads when the
 * path changes (it carries the query string, so that covers every filter change) or when
 * a caller's dep does: the panel passes a revision counter it bumps after any write, so
 * banning someone refreshes whichever tables are on screen.
 */
function useStaffData<T>(path: string | null, deps: unknown[] = []) {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		if (path === null) return
		// Guards against the response of a superseded read landing after a newer one — two
		// filter changes in quick succession would otherwise render whichever finished last.
		let live = true
		setError('')
		call<T>(path, { authed: true })
			.then((result) => live && setData(result))
			.catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
		return () => {
			live = false
		}
		// The caller's deps are spread in deliberately — the lint rule can't see through a
		// variable-length array, and `path` plus those deps is the whole trigger set.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [path, ...deps])

	return { data, error }
}

/**
 * Names for every id a page of rows mentions, in one bulk lookup.
 *
 * Re-runs when the rows change, and holds the previous names while the next lookup is in
 * flight, so a table doesn't flash back to bare ids between pages.
 */
function useNames(ids: number[]) {
	const [names, setNames] = useState<Map<number, PublicAccount>>(new Map())
	const key = ids.join(',')

	useEffect(() => {
		if (key === '') return
		let live = true
		void usernamesFor(key.split(',').map(Number)).then((found) => {
			// Merged rather than replaced: the panel holds several tables, and a lookup for
			// one must not blank the names in another.
			if (live) setNames((prev) => new Map([...prev, ...found]))
		})
		return () => {
			live = false
		}
	}, [key])

	return names
}

export function ModerationPage({
	account,
	navigate,
}: {
	account: { accountId: number; username: string } | null | undefined
	navigate: (to: string) => void
}) {
	const [tab, setTab] = useState<Tab>('queue')
	// The player whose history is open, or null for the tab's own view. Local state rather
	// than a route: it's a drill-down inside the panel, and a moderator walks in and out of
	// several in a sitting without wanting each one in their back button.
	const [openPlayer, setOpenPlayer] = useState<number | null>(null)
	// The report a ban is being composed against. Held here so the dialog can be opened
	// from any of the tables.
	const [banning, setBanning] = useState<ReportRow | null>(null)
	// Bumped after any write, to re-read whichever tables are on screen.
	const [revision, setRevision] = useState(0)
	const changed = useCallback(() => setRevision((n) => n + 1), [])

	if (account === undefined) {
		return (
			<main className="shell wide">
				<section className="card">
					<p className="muted">Checking your session…</p>
				</section>
			</main>
		)
	}

	if (account === null) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Moderation</h1>
					<p className="muted">You need to be signed in to use the moderation tools.</p>
					<button onClick={() => navigate('/login')}>Sign in</button>
				</section>
			</main>
		)
	}

	// A signed-in player who isn't staff. Told plainly rather than shown a sign-in form:
	// signing in again would change nothing, and a 404 would just make them wonder.
	if (!isAdmin()) {
		return (
			<main className="shell">
				<section className="card">
					<h1>Moderation</h1>
					<p className="muted">
						This area is for moderators. Your account doesn&apos;t have the moderator or developer
						role.
					</p>
					<button onClick={() => navigate('/')}>Back to the homepage</button>
				</section>
			</main>
		)
	}

	return (
		<main className="shell mod">
			<section className="card identity">
				<div className="muted">Moderating as</div>
				<div className="big">@{account.username}</div>
				<div className="handle">
					#{account.accountId} · actions you take here are recorded against this account
				</div>
			</section>

			{openPlayer !== null ? (
				<PlayerHistory
					playerId={openPlayer}
					revision={revision}
					onBan={setBanning}
					onClose={() => setOpenPlayer(null)}
				/>
			) : (
				<div className="workspace">
					<nav className="vtabs">
						{TABS.map((t) => (
							<button
								key={t.id}
								className={t.id === tab ? 'active' : ''}
								onClick={() => setTab(t.id)}
							>
								{t.label}
							</button>
						))}
					</nav>
					<div className="panel">
						{tab === 'queue' ? (
							<ReportQueue revision={revision} onOpenPlayer={setOpenPlayer} />
						) : tab === 'search' ? (
							<ReportSearch
								revision={revision}
								onOpenPlayer={setOpenPlayer}
								onBan={setBanning}
								onChanged={changed}
							/>
						) : tab === 'bans' ? (
							<StandingBans revision={revision} onOpenPlayer={setOpenPlayer} onChanged={changed} />
						) : (
							<FileReport
								onFiled={(report) => {
									changed()
									setBanning(report)
								}}
							/>
						)}
					</div>
				</div>
			)}

			{banning !== null && (
				<BanDialog
					report={banning}
					onClose={() => setBanning(null)}
					onDone={() => {
						setBanning(null)
						changed()
					}}
				/>
			)}
		</main>
	)
}

/**
 * The report queue: who has collected the most reports lately.
 *
 * Ranked by DISTINCT reporters ahead of raw count (see `getTopReported`), because one
 * player filing twenty reports against someone they're feuding with is a different thing
 * from twenty players each filing one. The window defaults to 30 days so the list is who
 * is a problem now rather than whoever has ever accumulated the most.
 */
function ReportQueue({
	revision,
	onOpenPlayer,
}: {
	revision: number
	onOpenPlayer: (id: number) => void
}) {
	const [sinceDays, setSinceDays] = useState('30')
	const [minReports, setMinReports] = useState('3')
	const { data, error } = useStaffData<ReportedPlayerTally[]>(
		`/api/staff/reports/top-reported?sinceDays=${encodeURIComponent(sinceDays)}&minReports=${encodeURIComponent(minReports)}`,
		[revision]
	)
	const names = useNames((data ?? []).map((row) => row.playerId))

	return (
		<section className="card">
			<h2>Report queue</h2>
			<p className="muted">
				Players with the most reports against them, ranked by how many different people reported
				them. Already-banned players are marked but still listed — a ban that is about to expire is
				worth seeing.
			</p>
			<div className="mod-filters">
				<label>
					Window
					<select value={sinceDays} onChange={(e) => setSinceDays(e.target.value)}>
						<option value="7">Last 7 days</option>
						<option value="30">Last 30 days</option>
						<option value="90">Last 90 days</option>
						{/* The server reads 0 as "no window" — see the handler. */}
						<option value="0">All time</option>
					</select>
				</label>
				<label>
					Minimum reports
					<input
						type="number"
						min="1"
						value={minReports}
						onChange={(e) => setMinReports(e.target.value)}
					/>
				</label>
			</div>

			{error && <p className="error">{error}</p>}
			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : data.length === 0 ? (
				<p className="muted">Nobody has been reported that many times in this window.</p>
			) : (
				<div className="mod-scroll">
					<table className="mod-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Reports</th>
								<th>Reporters</th>
								<th>Last reported</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{data.map((row) => (
								<tr key={row.playerId}>
									<td>
										<PlayerName id={row.playerId} names={names} />
										{row.bannedNow && <span className="badge mod-banned">Banned</span>}
									</td>
									<td>{row.reports}</td>
									<td>{row.distinctReporters}</td>
									<td>{when(row.lastReportAt)}</td>
									<td>
										<button className="linkish" onClick={() => onOpenPlayer(row.playerId)}>
											History
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	)
}

/** The search form's state — mirrors the query params `searchReportsHandler` reads. */
interface SearchFilters {
	reported: string
	reporter: string
	category: string
	banned: string
	from: string
	to: string
}

const EMPTY_FILTERS: SearchFilters = {
	reported: '',
	reporter: '',
	category: '',
	banned: '',
	from: '',
	to: '',
}

/**
 * Search the report log.
 *
 * The two player boxes take either an id or an `@username`, resolved through `accounts`'
 * search before the query goes out — a moderator following up a Discord report has a name,
 * not a number, and making them look it up elsewhere first is the kind of friction that
 * ends in nobody using the panel.
 */
function ReportSearch({
	revision,
	onOpenPlayer,
	onBan,
	onChanged,
}: {
	revision: number
	onOpenPlayer: (id: number) => void
	onBan: (report: ReportRow) => void
	onChanged: () => void
}) {
	const [form, setForm] = useState<SearchFilters>(EMPTY_FILTERS)
	// The query actually in flight, separate from what's typed: a search runs when it is
	// submitted, not on every keystroke, and the ids in it are resolved by then.
	const [query, setQuery] = useState<string | null>('?take=' + PAGE_SIZE)
	const [skip, setSkip] = useState(0)
	const { pending, error: formError, run } = useAction()

	const path = query === null ? null : `/api/staff/reports${query}&skip=${skip}`
	const { data, error } = useStaffData<{ reports: ReportRow[]; total: number }>(path, [revision])
	const reports = data?.reports ?? []
	const names = useNames(reports.flatMap((r) => [r.reported_player_id, r.reporter_player_id]))

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		void run(async () => {
			const params = new URLSearchParams({ take: String(PAGE_SIZE) })
			// Either box may hold a name; resolve before searching so the query is by id, as
			// the report rows are.
			if (form.reported.trim() !== '') {
				params.set('reportedPlayerId', String(await playerIdFrom(form.reported)))
			}
			if (form.reporter.trim() !== '') {
				params.set('reporterPlayerId', String(await playerIdFrom(form.reporter)))
			}
			if (form.category !== '') params.set('reportCategory', form.category)
			if (form.banned !== '') params.set('banned', form.banned)
			// A date input gives a bare `YYYY-MM-DD`; `to` is exclusive on the server, so a
			// day entered there includes that whole day only if it is pushed to the next
			// midnight. Both are sent as local midnights, which is what the moderator meant.
			if (form.from !== '') params.set('from', new Date(form.from).toISOString())
			if (form.to !== '') {
				const to = new Date(form.to)
				to.setDate(to.getDate() + 1)
				params.set('to', to.toISOString())
			}
			setSkip(0)
			setQuery(`?${params.toString()}`)
			return ''
		})
	}

	const total = data?.total ?? 0

	return (
		<section className="card">
			<h2>Search reports</h2>
			<p className="muted">
				Every report ever filed, newest first. The player boxes take an id or an @username.
			</p>
			<form className="mod-filters" onSubmit={submit}>
				<label>
					Reported player
					<input
						value={form.reported}
						placeholder="@name or id"
						onChange={(e) => setForm({ ...form, reported: e.target.value })}
					/>
				</label>
				<label>
					Reported by
					<input
						value={form.reporter}
						placeholder="@name or id"
						onChange={(e) => setForm({ ...form, reporter: e.target.value })}
					/>
				</label>
				<label>
					Category
					<select
						value={form.category}
						onChange={(e) => setForm({ ...form, category: e.target.value })}
					>
						<option value="">Any</option>
						{Object.entries(CATEGORY_LABEL).map(([id, label]) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label>
					Ban state
					<select
						value={form.banned}
						onChange={(e) => setForm({ ...form, banned: e.target.value })}
					>
						<option value="">Any</option>
						<option value="true">Actioned (banned)</option>
						<option value="false">Not actioned</option>
					</select>
				</label>
				<label>
					From
					<input
						type="date"
						value={form.from}
						onChange={(e) => setForm({ ...form, from: e.target.value })}
					/>
				</label>
				<label>
					To
					<input
						type="date"
						value={form.to}
						onChange={(e) => setForm({ ...form, to: e.target.value })}
					/>
				</label>
				<div className="mod-filter-actions">
					<button type="submit" disabled={pending}>
						{pending ? 'Searching…' : 'Search'}
					</button>
					<button
						type="button"
						className="linkish"
						onClick={() => {
							setForm(EMPTY_FILTERS)
							setSkip(0)
							setQuery(`?take=${PAGE_SIZE}`)
						}}
					>
						Clear
					</button>
				</div>
			</form>

			{formError && <p className="error">{formError}</p>}
			{error && <p className="error">{error}</p>}

			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : reports.length === 0 ? (
				<p className="muted">No reports match those filters.</p>
			) : (
				<>
					<ReportTable
						reports={reports}
						names={names}
						onOpenPlayer={onOpenPlayer}
						onBan={onBan}
						onChanged={onChanged}
					/>
					<div className="mod-pager">
						<button disabled={skip === 0} onClick={() => setSkip(Math.max(skip - PAGE_SIZE, 0))}>
							Previous
						</button>
						<span className="muted">
							{skip + 1}–{Math.min(skip + PAGE_SIZE, total)} of {total}
						</span>
						<button disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip(skip + PAGE_SIZE)}>
							Next
						</button>
					</div>
				</>
			)}
		</section>
	)
}

/** An id typed as a number, or an `@username` resolved through `accounts`. */
async function playerIdFrom(input: string): Promise<number> {
	const trimmed = input.trim()
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
	return accountIdForUsername(trimmed)
}

/** The report rows themselves — shared by the search and the player history. */
function ReportTable({
	reports,
	names,
	onOpenPlayer,
	onBan,
	onChanged,
}: {
	reports: ReportRow[]
	names: Map<number, PublicAccount>
	onOpenPlayer?: (id: number) => void
	onBan: (report: ReportRow) => void
	onChanged: () => void
}) {
	return (
		<div className="mod-scroll">
			<table className="mod-table">
				<thead>
					<tr>
						<th>#</th>
						<th>Filed</th>
						<th>Against</th>
						<th>By</th>
						<th>Kind</th>
						<th>Category</th>
						<th>Details</th>
						<th>Ban</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{reports.map((report) => (
						<tr key={report.id}>
							<td>{report.id}</td>
							<td>{when(report.created_at)}</td>
							<td>
								{onOpenPlayer ? (
									<button
										className="linkish"
										onClick={() => onOpenPlayer(report.reported_player_id)}
									>
										<PlayerName id={report.reported_player_id} names={names} />
									</button>
								) : (
									<PlayerName id={report.reported_player_id} names={names} />
								)}
							</td>
							<td>
								<PlayerName id={report.reporter_player_id} names={names} />
							</td>
							<td>{reportKind(report)}</td>
							<td>{categoryLabel(report.report_category)}</td>
							{/* The reporter's own words, untruncated in the title so a long
							    description is readable without leaving the table. */}
							<td className="mod-details" title={report.details ?? ''}>
								{report.details ?? <span className="muted">none given</span>}
							</td>
							<td>
								{report.banned === 1 ? (
									<span className="badge mod-banned">{expiryLabel(report)}</span>
								) : (
									<span className="muted">—</span>
								)}
							</td>
							<td>
								{report.banned === 1 ? (
									<LiftBanButton report={report} onDone={onChanged} />
								) : (
									<button className="linkish" onClick={() => onBan(report)}>
										Ban…
									</button>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

/**
 * Lift the ban on a report. Confirmed first — it is one click next to a row of them, and
 * the mistake puts a banned player straight back in the game.
 */
function LiftBanButton({ report, onDone }: { report: ReportRow; onDone: () => void }) {
	const { pending, error, run } = useAction()
	return (
		<>
			<button
				className="linkish"
				disabled={pending}
				onClick={() =>
					void run(async () => {
						if (!confirm(`Lift the ban on player #${report.reported_player_id}?`)) return ''
						await call(`/api/staff/reports/${report.id}/ban`, {
							authed: true,
							json: { banned: false },
						})
						onDone()
						return ''
					})
				}
			>
				{pending ? 'Lifting…' : 'Lift ban'}
			</button>
			{error && <p className="error">{error}</p>}
		</>
	)
}

/** Every ban in force right now. */
function StandingBans({
	revision,
	onOpenPlayer,
	onChanged,
}: {
	revision: number
	onOpenPlayer: (id: number) => void
	onChanged: () => void
}) {
	const { data, error } = useStaffData<ReportRow[]>('/api/staff/bans', [revision])
	const bans = data ?? []
	const names = useNames(bans.flatMap((b) => [b.reported_player_id, b.banned_by_player_id ?? 0]))

	return (
		<section className="card">
			<h2>Standing bans</h2>
			<p className="muted">
				Bans in force right now, longest-lasting first. An expired ban isn&apos;t here — it has
				served its time, and the report stays as the record that it happened.
			</p>
			{error && <p className="error">{error}</p>}
			{data === null ? (
				!error && <p className="muted">Loading…</p>
			) : bans.length === 0 ? (
				<p className="muted">Nobody is banned.</p>
			) : (
				<div className="mod-scroll">
					<table className="mod-table">
						<thead>
							<tr>
								<th>Player</th>
								<th>Report</th>
								<th>Reason</th>
								<th>Banned</th>
								<th>By</th>
								<th>Lifts</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{bans.map((ban) => (
								<tr key={ban.id}>
									<td>
										<button
											className="linkish"
											onClick={() => onOpenPlayer(ban.reported_player_id)}
										>
											<PlayerName id={ban.reported_player_id} names={names} />
										</button>
									</td>
									<td>#{ban.id}</td>
									<td>{categoryLabel(ban.report_category)}</td>
									{/* `banned_at` where there is one; a ban handed down before that
									    column existed has only the report's own date to show. */}
									<td>
										{ban.banned_at === null ? (
											<span className="muted" title="Recorded before ban timestamps were kept">
												{when(ban.created_at)}?
											</span>
										) : (
											when(ban.banned_at)
										)}
									</td>
									<td>
										{ban.banned_by_player_id === null ? (
											<span className="muted">unknown</span>
										) : (
											<PlayerName id={ban.banned_by_player_id} names={names} />
										)}
									</td>
									<td>{ban.ban_expires === null ? 'Never' : when(ban.ban_expires)}</td>
									<td>
										<LiftBanButton report={ban} onDone={onChanged} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	)
}

/**
 * Everything on file about one player: the reports against them, the warnings handed
 * down, the ban in force, and who else a ban would reach.
 *
 * One screen because it is one decision. A moderator about to ban someone wants the
 * history and the blast radius in front of them, not in three places.
 */
function PlayerHistory({
	playerId,
	revision,
	onBan,
	onClose,
}: {
	playerId: number
	revision: number
	onBan: (report: ReportRow) => void
	onClose: () => void
}) {
	const { data, error } = useStaffData<{
		playerId: number
		reports: ReportRow[]
		warnings: WarningRow[]
		activeBan: ReportRow | null
	}>(`/api/staff/players/${playerId}`, [revision])
	const reports = data?.reports ?? []
	const warnings = data?.warnings ?? []
	const names = useNames([
		playerId,
		...reports.map((r) => r.reporter_player_id),
		...warnings.map((w) => w.moderator_player_id),
	])

	return (
		<>
			<section className="card">
				<button className="linkish" onClick={onClose}>
					← Back to the tables
				</button>
				<h2>
					<PlayerName id={playerId} names={names} />
				</h2>
				{error && <p className="error">{error}</p>}
				{data === null ? (
					!error && <p className="muted">Loading…</p>
				) : data.activeBan === null ? (
					<p className="muted">
						Not banned. {reports.length} report{reports.length === 1 ? '' : 's'} on file,{' '}
						{warnings.length} warning{warnings.length === 1 ? '' : 's'} handed down.
					</p>
				) : (
					<p className="ok">
						Banned on report #{data.activeBan.id} for{' '}
						{categoryLabel(data.activeBan.report_category)} —{' '}
						{data.activeBan.ban_expires === null
							? 'permanently'
							: `until ${when(data.activeBan.ban_expires)}`}
						.
					</p>
				)}
			</section>

			<LinkedAccountsPanel playerId={playerId} />

			<section className="card">
				<h2>Reports</h2>
				{reports.length === 0 ? (
					<p className="muted">Nobody has reported this player.</p>
				) : (
					<ReportTable reports={reports} names={names} onBan={onBan} onChanged={onClose} />
				)}
			</section>

			<section className="card">
				<h2>Warnings</h2>
				<p className="muted">
					Warnings a moderator handed down, from the game&apos;s own warning endpoint. Nothing here
					dispatches them; the rows are the record.
				</p>
				{warnings.length === 0 ? (
					<p className="muted">No warnings on file.</p>
				) : (
					<div className="mod-scroll">
						<table className="mod-table">
							<thead>
								<tr>
									<th>When</th>
									<th>By</th>
									<th>Category</th>
									<th>Shown to the player</th>
									<th>Internal note</th>
								</tr>
							</thead>
							<tbody>
								{warnings.map((warning) => (
									<tr key={warning.id}>
										<td>{when(warning.created_at)}</td>
										<td>
											<PlayerName id={warning.moderator_player_id} names={names} />
										</td>
										<td>{categoryLabel(warning.report_category)}</td>
										<td>{warning.display_reason ?? <span className="muted">—</span>}</td>
										<td>{warning.moderator_note ?? <span className="muted">—</span>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	)
}

/**
 * Who ELSE a ban on this player would block.
 *
 * The IP arm is coarse by design — households, NAT, campus and carrier networks put
 * unrelated players behind one address — so a ban can reach people who did nothing. That
 * trade is the operator's to make, but it should be made with this list in front of them
 * rather than discovered from a support ticket.
 */
function LinkedAccountsPanel({ playerId }: { playerId: number }) {
	const { data, error } = useStaffData<{
		arms: { ip: boolean; platform: boolean }
		linked: LinkedAccount[]
	}>(`/api/staff/players/${playerId}/linked`)

	if (error !== '')
		return (
			<section className="card">
				<p className="error">{error}</p>
			</section>
		)
	if (data === null) return null

	const arms = [data.arms.platform && 'shared platform identity', data.arms.ip && 'shared IP']
		.filter(Boolean)
		.join(' and ')

	return (
		<section className="card">
			<h2>Who a ban would also reach</h2>
			{arms === '' ? (
				<p className="muted">
					Ban-evasion matching is switched off on this server, so a ban reaches exactly the one
					account.
				</p>
			) : data.linked.length === 0 ? (
				<p className="muted">
					No other account shares a {arms} with this one — a ban reaches only them.
				</p>
			) : (
				<>
					<p className="muted">
						Evasion matching is on for {arms}. These accounts would be blocked too:
					</p>
					<ul className="mod-linked">
						{data.linked.map((linked) => (
							<li key={`${linked.via}-${linked.accountId}-${linked.value}`}>
								<span className={`badge ${linked.via === 'platform' ? 'live' : ''}`}>
									{linked.via === 'platform' ? 'Same platform login' : 'Same IP'}
								</span>{' '}
								{linked.username ? `@${linked.username}` : 'unknown'}
								<span className="muted">
									{' '}
									#{linked.accountId} · {linked.value}
								</span>
							</li>
						))}
					</ul>
					{data.arms.ip && (
						<p className="muted">
							An IP match is not proof of the same person. Households and shared networks look
							identical to it.
						</p>
					)}
				</>
			)}
		</section>
	)
}

/**
 * File a report by hand.
 *
 * A ban lives ON a report (see reports-db), so acting on something nobody happened to
 * report — found in a log, seen first-hand, escalated from Discord — needs a row to hang
 * it off. The reporter is the acting moderator, taken from the token; that is the record
 * of who raised it, which is why nothing marks these rows as staff-created.
 *
 * Hands the new report straight to the ban dialog, since filing one is almost always the
 * first half of banning somebody.
 */
function FileReport({ onFiled }: { onFiled: (report: ReportRow) => void }) {
	const [player, setPlayer] = useState('')
	const [category, setCategory] = useState(String(KickReportCategory.Misc))
	const [details, setDetails] = useState('')
	const [roomId, setRoomId] = useState('')
	const { pending, error, done, run } = useAction()

	return (
		<section className="card">
			<h2>File a report</h2>
			<p className="muted">
				For something no player reported. It is filed under your account, and opens the ban dialog
				once saved — you don&apos;t have to ban, and the row stands on its own either way.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const report = await call<ReportRow>('/api/staff/reports', {
							authed: true,
							json: {
								reportedPlayerId: await playerIdFrom(player),
								reportCategory: Number(category),
								details: details.trim(),
								roomId: roomId.trim() === '' ? 0 : Number(roomId),
							},
						})
						setPlayer('')
						setDetails('')
						setRoomId('')
						onFiled(report)
						return `Filed report #${report.id}.`
					})
				}}
			>
				<label>
					Player
					<input
						value={player}
						placeholder="@name or id"
						required
						onChange={(e) => setPlayer(e.target.value)}
					/>
				</label>
				<label>
					Category
					<select value={category} onChange={(e) => setCategory(e.target.value)}>
						{FILEABLE_CATEGORIES.map((id) => (
							<option key={id} value={id}>
								{categoryLabel(id)}
							</option>
						))}
					</select>
				</label>
				<label>
					What happened
					<textarea
						value={details}
						rows={4}
						placeholder="What you saw, and where you saw it. Kept internally."
						onChange={(e) => setDetails(e.target.value)}
					/>
				</label>
				<label>
					Room id (optional)
					<input
						value={roomId}
						inputMode="numeric"
						placeholder="If it happened in a particular room"
						onChange={(e) => setRoomId(e.target.value)}
					/>
				</label>
				{error && <p className="error">{error}</p>}
				{done && <p className="ok">{done}</p>}
				<button type="submit" disabled={pending}>
					{pending ? 'Filing…' : 'File report'}
				</button>
			</form>
		</section>
	)
}

/** The ban lengths offered, in the order the dialog lists them. `null` is permanent. */
const BAN_LENGTHS: Array<{ label: string; days: number | null }> = [
	{ label: '1 day', days: 1 },
	{ label: '3 days', days: 3 },
	{ label: '7 days', days: 7 },
	{ label: '30 days', days: 30 },
	{ label: '90 days', days: 90 },
	{ label: 'Permanent', days: null },
]

/**
 * Hand down a ban on one report.
 *
 * Takes a LENGTH rather than a date: a moderator decides "7 days", and the server turns
 * that into the expiry it stores, so nobody is doing calendar arithmetic over a ban. The
 * evasion preview is shown here too — this is the moment the blast radius matters.
 *
 * Says out loud what applying it does beyond the row: the player is thrown out of the
 * instance they are standing in, which is the part that is not obvious from "ban".
 */
function BanDialog({
	report,
	onClose,
	onDone,
}: {
	report: ReportRow
	onClose: () => void
	onDone: () => void
}) {
	const [choice, setChoice] = useState('7')
	const { pending, error, run } = useAction()
	const names = useNames([report.reported_player_id])

	return (
		<section className="card mod-dialog">
			<h2>
				Ban <PlayerName id={report.reported_player_id} names={names} />
			</h2>
			<p className="muted">
				On report #{report.id} — {categoryLabel(report.report_category)}
				{report.details ? `: “${report.details}”` : ''}
			</p>

			<LinkedAccountsPanel playerId={report.reported_player_id} />

			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						const length = BAN_LENGTHS.find((l) => String(l.days) === choice)
						await call(`/api/staff/reports/${report.id}/ban`, {
							authed: true,
							// `permanent` rather than an absent duration: the server reads "no
							// duration" as permanent too, but saying it explicitly means a bug in
							// this form can't quietly hand out a life ban.
							json:
								length?.days === null || length === undefined
									? { banned: true, permanent: true }
									: { banned: true, days: length.days },
						})
						onDone()
						return ''
					})
				}}
			>
				<label>
					Length
					<select value={choice} onChange={(e) => setChoice(e.target.value)}>
						{BAN_LENGTHS.map((length) => (
							<option key={length.label} value={String(length.days)}>
								{length.label}
							</option>
						))}
					</select>
				</label>
				<p className="muted">
					They are thrown out of the room they&apos;re in right now, and refused at matchmaking
					until the ban lifts. The report stays as the record either way, and a ban can be lifted
					from the tables.
				</p>
				{error && <p className="error">{error}</p>}
				<div className="mod-filter-actions">
					<button type="submit" disabled={pending}>
						{pending ? 'Banning…' : 'Apply ban'}
					</button>
					<button type="button" className="linkish" onClick={onClose}>
						Cancel
					</button>
				</div>
			</form>
		</section>
	)
}
