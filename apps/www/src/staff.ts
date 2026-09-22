import {
	addUsernameChange,
	clearPasswordHash,
	createGift,
	getAccount,
	getPresences,
	movePlayerToDorm,
	writeAuditLog,
} from '@repo/domain'
import { intVar, logger } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

// The report table and the ban policy over it, owned (and migrated) by the `api` worker.
// Imported rather than reimplemented: the SQL belongs with the table, and `banFromReport`
// is the same write `api` would do. www owns the ENDPOINTS, not the storage — see the
// module comment below.
import { banEvasionMatch, linkedAccounts } from '../../api/src/bans-db'
import {
	banBlockDetails,
	banFromReport,
	createReport,
	getActiveBan,
	getBansInForce,
	getReportById,
	getReportsAgainst,
	getTopReported,
	searchReports,
} from '../../api/src/reports-db'
import { getWarningsAgainst } from '../../api/src/warnings-db'
// Balances, owned by `econ`. A staff token gift is the same credit econ's own faucets make.
import {
	ALL_PLATFORMS,
	creditCurrency,
	CurrencyType,
	DEFAULT_STARTING_TOKENS,
	ensureStartingBalances,
} from '../../econ/src/balance-db'
// The notification ids and the kick frame's recovered shape, owned by `notify`. Both are
// imported as values/types with no runtime dependencies.
import { NotificationType } from '../../notify/src/notification-types'

import type { Context, MiddlewareHandler } from 'hono'
import type { GiftContent } from '@repo/domain'
import type { ReportRow, ReportSearch } from '../../api/src/reports-db'
import type {
	BalanceResponsePayload,
	GiftPackagePayload,
	ModerationKickPayload,
} from '../../notify/src/notification-payloads'
import type { App, Env } from './context'

/**
 * The staff moderation surface — the endpoints behind the `/moderation` panel in the SPA.
 *
 * These live on `www` rather than on `api` (which owns the `report` table) on purpose:
 * every other worker reimplements an endpoint the Rec Room client actually calls, and a
 * staff panel has no counterpart in the real service. Keeping recflare's own additions
 * here leaves the game-facing workers a faithful surface, with nothing in them the client
 * never asked for. So the SQL stays in `api`'s reports-db/bans-db beside the table, and
 * only the HTTP lives here.
 *
 * Where a real game service already answers the question, the SPA asks IT rather than
 * having www proxy: usernames for the ids in a report come from `accounts`'
 * `POST /account/bulk`, the same lookup the game does. This module serves only what no
 * existing endpoint does.
 *
 * Every route is gated by {@link requireStaff} — a valid token carrying `moderator` or
 * `developer`, the operator-granted roles `auth` stamps from an account's
 * isModerator/isDeveloper flags (see the admin CLI's `grant-moderator` /
 * `grant-developer`). The SPA's `isAdmin()` gate only decides what to SHOW; this is the
 * one that decides anything.
 */

/**
 * Roles allowed through. The same set `api`'s warning write and `notify`'s internal
 * endpoints gate on — staff hold both roles, and moderation is not developer-only.
 */
const STAFF_ROLES = new Set(['moderator', 'developer'])

/** The notifications hub is a single global DO instance (see the `notify` worker). */
const HUB_INSTANCE = 'global'

/** Hard cap on a page of search results, whatever the query string asks for. */
const MAX_TAKE = 200

/**
 * Gates a route on a staff token: 401 for a missing or invalid one, 403 for a valid token
 * without a staff role. The acting moderator is stashed on the context so a handler reads
 * it without validating the token a second time.
 *
 * Two answers, not one, because they mean different things to the page: a 401 is a session
 * that has expired (the SPA's `call` drops the token and sends them to sign in), while a
 * 403 is a signed-in player who is not staff — and the panel says so rather than looping
 * them through a sign-in that would change nothing.
 */
export const requireStaff: MiddlewareHandler<App> = async (c, next) => {
	const secret = await c.env.JWT_SECRET.get()
	const roles = await validateAndGetRoles(c.req.raw, secret)
	if (roles === null) return c.json({ error: 'Unauthorized' }, 401)
	if (!roles.some((role) => STAFF_ROLES.has(role))) return c.json({ error: 'Forbidden' }, 403)

	const accountId = await validateAndGetAccountId(c.req.raw, secret)
	// A token that carries a staff role but no integer `sub` can't be attributed to a
	// moderator, and every action here is recorded against one.
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	c.set('staffId', accountId)
	await next()
}

/** The acting moderator, set by {@link requireStaff}. Only valid behind that middleware. */
const staffId = (c: Context<App>): number => c.get('staffId')

/** Read an integer query param, or null when absent or unparseable. */
function intQuery(c: Context<App>, name: string): number | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	const n = Number.parseInt(raw, 10)
	return Number.isNaN(n) ? null : n
}

/**
 * Read a tri-state boolean query param: `true`/`false` narrow, absent means "don't
 * filter". Distinct from a plain `=== 'true'`, which would read an absent param as an
 * explicit `false` and hide every banned row from an unfiltered search.
 */
function boolQuery(c: Context<App>, name: string): boolean | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	return raw === 'true' || raw === '1'
}

/** Read an ISO-8601 query param, or null when absent or not a date we can parse. */
function dateQuery(c: Context<App>, name: string): string | null {
	const raw = c.req.query(name)
	if (raw === undefined || raw === '') return null
	const parsed = Date.parse(raw)
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * When a ban handed down now should lift, from what the panel posted.
 *
 * Accepts a DURATION (`days` and/or `hours`) or an explicit ISO `expires`, because
 * moderators think in "7 days" and audit trails are in timestamps. `permanent` (or a
 * body with neither) means null — a ban that never lifts, which is what `ban_expires`
 * NULL records.
 *
 * Returns `undefined` for an expiry that was asked for but can't be honoured (an
 * unparseable date, or a duration that lands in the past), so the caller refuses the
 * request rather than quietly making the ban permanent — the one mistake here that
 * cannot be walked back by waiting.
 */
function banExpiry(
	body: { permanent?: unknown; expires?: unknown; days?: unknown; hours?: unknown },
	now: Date
): string | null | undefined {
	if (body.permanent === true) return null

	if (typeof body.expires === 'string' && body.expires !== '') {
		const parsed = Date.parse(body.expires)
		if (Number.isNaN(parsed) || parsed <= now.getTime()) return undefined
		return new Date(parsed).toISOString()
	}

	const days = Number(body.days ?? 0)
	const hours = Number(body.hours ?? 0)
	if (!Number.isFinite(days) || !Number.isFinite(hours)) return undefined
	const ms = days * 86_400_000 + hours * 3_600_000
	// No duration at all is a permanent ban; a negative one is a mistake, not a lift.
	if (ms === 0) return null
	if (ms < 0) return undefined
	return new Date(now.getTime() + ms).toISOString()
}

/**
 * Tell a player they have been banned from the GAME, and throw them out of wherever they are.
 *
 * Without this a ban only takes effect on the player's NEXT sign-in or matchmake: `match`
 * refuses a banned player and `moderationBlockDetails` blocks them at login, but nothing
 * revisits a session already in progress, so someone banned mid-session keeps playing.
 *
 * The frame is a `ModerationKick` (id 22) with `IsBan: true` — the frame the client's
 * moderation screen shows as a ban from the game. This is the ONE place that frame belongs: a
 * ROOM ban must never send it (`rooms` sends `IsBan: false` and is enforced by refusing the
 * room), because the client cannot tell the two apart and shows a game-wide ban screen.
 *
 * Its contents are {@link banBlockDetails} — the same `ReportCategory`, `Message` and the
 * `Duration`/`TimeoutStartedAt` pair `moderationBlockDetails` answers for this ban — so the
 * screen a player sees mid-session is the screen they see when they next sign in, not a
 * generic "banned" with no length.
 *
 * Sent to anyone ONLINE, not only to a player standing in an instance: someone in a menu is
 * as banned as someone in a room. `GameSessionId` is their instance, or 0 when they are in
 * none. EPHEMERAL, because an offline player needs no frame — they meet the same screen at
 * `moderationBlockDetails` when they next sign in — and a queued one would fire again then.
 *
 * They are moved into their own DORM rather than having their presence deleted — the same move
 * every kick makes, and the one place a banned player is still allowed to be: `match` lets them
 * matchmake there and nowhere else, which is how they reach this screen at all. Deleting the row
 * instead left the client arriving at the dorm not knowing where it was, loading it a second
 * time. The instance they were in, if any, frees a slot.
 *
 * Entirely best-effort. The ban row is already committed by the time this runs; a hub hiccup
 * or a missing presence must not fail a ban that has been handed down.
 */
async function kickBannedPlayer(c: Context<App>, report: ReportRow, moderatorId: number) {
	const playerId = report.reported_player_id
	try {
		const presence = (await getPresences<{ roomInstanceId?: number }>(c.env.DB, [playerId])).get(
			playerId
		)
		// Offline: nothing to eject and nobody to tell. The sign-in check has them.
		if (!presence) return

		// Read before the move, so the frame names the session they were thrown out of rather
		// than the dorm they landed in. `movePlayerToDorm` recomputes that instance's fullness.
		const gameSessionId = presence.roomInstance?.roomInstanceId
		await movePlayerToDorm(c.env.DB, playerId)

		const block = banBlockDetails(report)
		const frame: ModerationKickPayload = {
			ReportCategory: block.ReportCategory,
			Duration: block.Duration,
			GameSessionId: gameSessionId ?? 0,
			IsHostKick: false,
			Message: block.Message,
			PlayerIdReporter: null,
			IsBan: true,
			IsVoiceModAutoban: false,
			IsWarning: false,
			VoteKickReason: '',
			TimeoutStartedAt: block.TimeoutStartedAt,
		}
		await c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE).notifyPlayersEphemeral(
			[playerId],
			NotificationType.ModerationKick,
			{ ...frame }
		)
	} catch (err) {
		logger.error('failed to tell a banned player they are banned', {
			playerId,
			moderatorId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Record a ban or a lift on the `audit_log` table, against the moderator who made it.
 *
 * The report row only ever holds the ban's CURRENT state: a lift clears `banned_by` and
 * `banned_at`, and a re-ban overwrites them, so without this row nothing says who lifted a
 * ban, or that one was ever handed down on a report that is clean today. `ban` and `unban`
 * are separate actions because they are the two questions asked of this log ("who banned
 * X", "who let X back in"); the target and the report go in `data`, per the table's rule
 * that `player_id` is the actor. `previous` is the row's ban state before this call, which
 * is the only place a lifted ban's original moderator and expiry survive.
 *
 * Written after the row is committed and never throws — the ban has already happened, and a
 * failed audit insert must not turn it into a 500 the panel would read as refused.
 */
async function recordBanAudit(
	c: Context<App>,
	moderatorId: number,
	before: ReportRow,
	after: ReportRow
) {
	const action = after.banned ? 'ban' : 'unban'
	try {
		await writeAuditLog(c.env.DB, {
			playerId: moderatorId,
			action,
			data: {
				reportId: after.id,
				playerId: after.reported_player_id,
				reportCategory: after.report_category,
				banExpires: after.ban_expires,
				previous: {
					banned: before.banned === 1,
					banExpires: before.ban_expires,
					bannedBy: before.banned_by_player_id,
					bannedAt: before.banned_at,
				},
			},
		})
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId,
			reportId: after.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/** The evasion arms in force, read from the same knob `api` and `match` read. */
const armsFor = (env: Env) => banEvasionMatch(env.BAN_EVASION_MATCH)

// ---- Handlers ---------------------------------------------------------------

/**
 * A page of reports matching the panel's filters, newest first.
 *
 * Returns ids only — no usernames. The page resolves those itself through `accounts`'
 * bulk lookup, the same endpoint the game uses, so this stays one query against one table.
 */
export async function searchReportsHandler(c: Context<App>) {
	const filters: ReportSearch = {
		reportedPlayerId: intQuery(c, 'reportedPlayerId'),
		reporterPlayerId: intQuery(c, 'reporterPlayerId'),
		reportCategory: intQuery(c, 'reportCategory'),
		banned: boolQuery(c, 'banned'),
		from: dateQuery(c, 'from'),
		to: dateQuery(c, 'to'),
	}
	const page = await searchReports(c.env.DB, filters, {
		skip: intQuery(c, 'skip') ?? 0,
		take: Math.min(intQuery(c, 'take') ?? 50, MAX_TAKE),
	})
	return c.json(page)
}

/** One report by id — the detail behind a search row. */
export async function getReportHandler(c: Context<App>) {
	const id = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(id)) return c.json({ error: 'A numeric report id is required' }, 400)
	const report = await getReportById(c.env.DB, id)
	if (report === null) return c.json({ error: 'No such report' }, 404)
	return c.json(report)
}

/**
 * File a minimal report as the acting moderator — the row a ban needs something to hang
 * on when there is no player report to act on.
 *
 * A ban lives ON a report (see reports-db), so moderating something nobody happened to
 * report — found in a log, seen first-hand, escalated from elsewhere — needs a row first.
 * The reporter is the moderator, from the token, never the body: that IS the record of who
 * raised it, and it is why nothing marks these rows as staff-created.
 *
 * WHO, WHAT KIND and WHY, and nothing else. Everything else on a report describes a
 * client-side moment that did not happen here: the heights the game measured, the instance
 * type, the event/invention/item ids — and `room_id`, which a player's report gets from
 * the client that filed it. A moderator does not know a room's numeric id and would have
 * to go and look it up, so the room goes in `details` along with the rest of the account
 * of what happened. A `roomId` in the body is therefore not read; player reports still
 * carry the column, and it is theirs alone.
 */
export async function createReportHandler(c: Context<App>) {
	const moderatorId = staffId(c)
	const body = (await c.req.json().catch(() => null)) as {
		reportedPlayerId?: unknown
		reportCategory?: unknown
		details?: unknown
	} | null
	if (body === null) return c.json({ error: 'Invalid request body' }, 400)

	const reportedPlayerId = Number(body.reportedPlayerId)
	if (!Number.isInteger(reportedPlayerId) || reportedPlayerId <= 0) {
		return c.json({ error: 'reportedPlayerId is required' }, 400)
	}
	// A moderator filing a report against themselves is a mistake every time, and the ban
	// it would justify locks the panel's own operator out of the game.
	if (reportedPlayerId === moderatorId) {
		return c.json({ error: 'You cannot file a report against yourself' }, 400)
	}

	const report = await createReport(c.env.DB, {
		reporterPlayerId: moderatorId,
		reportedPlayerId,
		reportCategory: Number.isInteger(Number(body.reportCategory)) ? Number(body.reportCategory) : 0,
		details: typeof body.details === 'string' && body.details !== '' ? body.details : null,
	})
	logger.info('a moderator filed a report by hand', {
		reportId: report.id,
		moderatorId,
		reportedPlayerId,
	})
	return c.json(report)
}

/**
 * Apply or lift a ban on the report with this id.
 *
 * `banned: false` lifts it, clearing the expiry and the audit columns and leaving the
 * report itself intact — the panel needs to be able to undo a ban, and a lifted ban has to
 * be distinguishable from an expired one (`banned = 0` versus a past `ban_expires`).
 *
 * Applying one also EJECTS the player from any instance they are in (see
 * {@link kickBannedPlayer}), best-effort and after the row is committed. The response
 * reports whether the frame went out, so the panel can say "banned, but they were offline"
 * rather than implying a kick that never happened.
 */
export async function banReportHandler(c: Context<App>) {
	const moderatorId = staffId(c)
	const id = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(id)) return c.json({ error: 'A numeric report id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as {
		banned?: unknown
		permanent?: unknown
		expires?: unknown
		days?: unknown
		hours?: unknown
	}
	// Absent means ban: the endpoint's purpose is to hand one down, and a lift is the
	// explicit case.
	const banned = body.banned !== false

	const now = new Date()
	const expires = banned ? banExpiry(body, now) : null
	if (expires === undefined) {
		return c.json({ error: 'That ban duration is not a time in the future' }, 400)
	}

	// Read first so a ban on a report that doesn't exist is a 404 rather than a silent
	// no-op, and so the response can name who it reached.
	const existing = await getReportById(c.env.DB, id)
	if (existing === null) return c.json({ error: 'No such report' }, 404)

	const report = await banFromReport(c.env.DB, id, {
		banned,
		banExpires: expires,
		bannedBy: moderatorId,
	})
	if (report === null) return c.json({ error: 'No such report' }, 404)

	logger.info(banned ? 'a moderator banned a player' : 'a moderator lifted a ban', {
		reportId: id,
		moderatorId,
		bannedPlayerId: report.reported_player_id,
		banExpires: report.ban_expires,
	})

	await recordBanAudit(c, moderatorId, existing, report)

	if (banned) await kickBannedPlayer(c, report, moderatorId)
	return c.json(report)
}

/**
 * The players with the most reports against them — the panel's triage list.
 *
 * Windowed to the last 30 days by default, so the list is who is a problem NOW rather
 * than whoever has ever accumulated the most reports. `sinceDays=0` reads as all time.
 */
export async function topReportedHandler(c: Context<App>) {
	const sinceDays = intQuery(c, 'sinceDays')
	const players = await getTopReported(c.env.DB, {
		// 0 is the panel's "all time", which the query expresses as null.
		sinceDays: sinceDays === 0 ? null : (sinceDays ?? 30),
		minReports: intQuery(c, 'minReports') ?? 3,
		take: Math.min(intQuery(c, 'take') ?? 50, MAX_TAKE),
	})
	return c.json(players)
}

/** Every ban in force right now — the standing-bans list. */
export async function bansInForceHandler(c: Context<App>) {
	return c.json(await getBansInForce(c.env.DB))
}

/**
 * Everything on file about one player: every report against them, every warning handed
 * down, and the ban in force if there is one.
 *
 * One call because it is one screen — a moderator deciding what to do about an account
 * reads all three together, and three round trips would let the page render a decision
 * out of a partially-loaded history.
 */
export async function playerHistoryHandler(c: Context<App>) {
	const playerId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(playerId)) return c.json({ error: 'A numeric player id is required' }, 400)

	const [reports, warnings, activeBan] = await Promise.all([
		getReportsAgainst(c.env.DB, playerId),
		getWarningsAgainst(c.env.DB, playerId),
		getActiveBan(c.env.DB, playerId),
	])
	return c.json({ playerId, reports, warnings, activeBan })
}

/**
 * Which other accounts a ban on this player would ALSO block — shown before a moderator
 * confirms one.
 *
 * The IP arm is coarse by design (see bans-db): households, NAT and campus networks put
 * unrelated players behind one address, so a ban can reach people who did nothing. That is
 * the operator's trade to make, but it should be made with the list in front of them rather
 * than discovered from a support ticket, which is the whole reason this endpoint exists.
 *
 * `arms` echoes the operator's `BAN_EVASION_MATCH` so the page can say which arms are live
 * — an empty list under `off` means the ban reaches exactly the one account.
 */
export async function linkedAccountsHandler(c: Context<App>) {
	const playerId = Number.parseInt(c.req.param('id') ?? '', 10)
	if (Number.isNaN(playerId)) return c.json({ error: 'A numeric player id is required' }, 400)

	const arms = armsFor(c.env)
	return c.json({ playerId, arms, linked: await linkedAccounts(c.env.DB, playerId, arms) })
}

// ---- Player actions ---------------------------------------------------------
//
// The staff card on a player's profile page. None of these has a game endpoint to call —
// the client can't grant tokens, hand back a username change or wipe a password — so, like
// the moderation panel, they live here. Each one is recorded on `audit_log` against the
// acting staffer, with the target in `data` (the table's `player_id` is the actor).

/** The system "Coach" account — who a box the server hands over is from. */
const COACH_ACCOUNT_ID = 1

/**
 * The most one gift can carry when the operator's `MAX_TOKEN_GIFT` is unset. Not a policy —
 * staff can send as many gifts as they like — but a guard against a stray keypress turning
 * 1,000 into 10,000,000, which nothing can take back: there is no debit endpoint to undo a
 * credit with.
 */
export const DEFAULT_MAX_TOKEN_GIFT = 10_000

/** The message on a staff token gift's box. */
const TOKEN_GIFT_MESSAGE = 'A gift from the staff!'

/** A path's `:id` as a player id, or null when it isn't a positive integer. */
function playerIdParam(c: Context<App>): number | null {
	const id = Number(c.req.param('id'))
	return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Record a player action on `audit_log`. Written after the change has committed and never
 * throws, for the reason {@link recordBanAudit} gives: the change has already happened.
 */
async function recordPlayerAudit(
	c: Context<App>,
	action: string,
	data: Record<string, unknown>
): Promise<void> {
	try {
		await writeAuditLog(c.env.DB, { playerId: staffId(c), action, data })
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId: staffId(c),
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * Send a player RecCenterTokens in a gift box.
 *
 * The same shape as econ's own server-handed currency (a game reward's Laser Tag tickets):
 * the balance is CREDITED here — opening a box only deletes it, it grants nothing — then a
 * `StorefrontBalanceUpdate` carrying the resulting total sets the client's bucket, and the box
 * is stored and announced with `GiftPackageReceivedImmediate` so the player sees what arrived.
 * The box is from the Coach, as every box the server hands over on nobody's behalf is; who
 * really sent it is on the audit row.
 *
 * Both frames are best-effort: the tokens are banked by the time they go out, and an offline
 * player meets the box in `GET /api/avatar/v2/gifts` and the balance on their next read.
 */
export async function giftTokensHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const body = (await c.req.json().catch(() => ({}))) as { amount?: unknown }
	const amount = Number(body.amount)
	if (!Number.isInteger(amount) || amount <= 0) {
		return c.json({ error: 'Enter a whole number of tokens greater than 0' }, 400)
	}
	const maxGift = intVar(c.env.MAX_TOKEN_GIFT, DEFAULT_MAX_TOKEN_GIFT)
	if (amount > maxGift) {
		return c.json({ error: `A gift can carry at most ${maxGift.toLocaleString()} tokens` }, 400)
	}
	if ((await getAccount(c.env.DB, playerId)) === null) {
		return c.json({ error: 'No such player' }, 404)
	}

	// Seed the signup grant first, as econ does before every credit: `creditCurrency` upserts,
	// and a never-touched balance would otherwise start from this gift instead of the grant.
	const startingTokens = intVar(c.env.STARTING_TOKENS, DEFAULT_STARTING_TOKENS)
	await ensureStartingBalances(c.env.DB, playerId, startingTokens)
	const balance = await creditCurrency(
		c.env.DB,
		playerId,
		CurrencyType.RecCenterTokens,
		amount,
		startingTokens
	)

	const content: GiftContent = {
		FromPlayerId: COACH_ACCOUNT_ID,
		GiftContext: 0,
		ConsumableItemDesc: '',
		ConsumableCount: 0,
		AvatarItemDesc: '',
		AvatarItemType: 0,
		CurrencyType: CurrencyType.RecCenterTokens,
		Currency: amount,
		Xp: 0,
		PackageType: 0,
		Message: TOKEN_GIFT_MESSAGE,
		EquipmentPrefabName: '',
		EquipmentModificationGuid: '',
		GiftRarity: 0,
		Platform: -1,
		PlatformsToSpawnOn: -1,
		BalanceType: null,
	}
	const gift = await createGift(c.env.DB, playerId, content)

	await recordPlayerAudit(c, 'gift_tokens', { playerId, amount, balance, giftId: gift.id })
	logger.info('staff gifted tokens', { moderatorId: staffId(c), playerId, amount })

	const hub = c.env.RECFLARE_NOTIFICATIONS_HUB.getByName(HUB_INSTANCE)
	try {
		await hub.notifyPlayer(playerId, NotificationType.StorefrontBalanceUpdate, {
			Balance: balance,
			CurrencyType: CurrencyType.RecCenterTokens,
			Platform: ALL_PLATFORMS,
		} satisfies BalanceResponsePayload)
		await hub.notifyPlayer(playerId, NotificationType.GiftPackageReceivedImmediate, {
			Id: gift.id,
			FromPlayerId: content.FromPlayerId ?? COACH_ACCOUNT_ID,
			ConsumableItemDesc: content.ConsumableItemDesc,
			AvatarItemType: content.AvatarItemType,
			AvatarItemDesc: content.AvatarItemDesc,
			EquipmentPrefabName: content.EquipmentPrefabName,
			EquipmentModificationGuid: content.EquipmentModificationGuid,
			CurrencyType: content.CurrencyType,
			Currency: content.Currency,
			Xp: content.Xp,
			GiftContext: content.GiftContext ?? 0,
			GiftRarity: content.GiftRarity,
			Message: content.Message,
			Platform: -1,
			PlatformsToSpawnOn: -1,
			BalanceType: ALL_PLATFORMS,
		} satisfies GiftPackagePayload)
	} catch (err) {
		logger.error('failed to announce a staff token gift', {
			playerId,
			giftId: gift.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	return c.json({ playerId, amount, balance, giftId: gift.id })
}

/**
 * Give a player one more username change. The client reads the count off `/account/me`,
 * so it shows the next time the player opens the name screen.
 */
export async function addUsernameChangeHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const remaining = await addUsernameChange(c.env.DB, playerId)
	if (remaining === null) return c.json({ error: 'No such player' }, 404)

	await recordPlayerAudit(c, 'add_username_change', {
		playerId,
		availableUsernameChanges: remaining,
	})
	return c.json({ playerId, availableUsernameChanges: remaining })
}

/**
 * Remove a player's password so they can set a new one in game — the recovery for someone
 * who has forgotten it, since nothing here can send a reset email. `hadPassword` says whether
 * there was one to remove; clearing an already-clear password succeeds, and is still logged.
 */
export async function clearPasswordHandler(c: Context<App>) {
	const playerId = playerIdParam(c)
	if (playerId === null) return c.json({ error: 'A numeric player id is required' }, 400)

	const hadPassword = await clearPasswordHash(c.env.DB, playerId)
	if (hadPassword === null) return c.json({ error: 'No such player' }, 404)

	await recordPlayerAudit(c, 'clear_password', { playerId, hadPassword })
	logger.info('staff cleared a password', { moderatorId: staffId(c), playerId, hadPassword })
	return c.json({ playerId, hadPassword })
}
