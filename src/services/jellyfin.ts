import { aliasesOf } from '../core/titleMatch.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import type { EpisodeRecord, MovieRecord } from '../core/episodeMismatch.ts';
import type { IndexInput } from '../core/resolver.ts';
import { embyToken, type AuthStrategy } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type MediaDetailCapable,
    type MediaDetails,
    type MetadataInspectCapable,
    type MetadataRepairCapable,
    type PlaybackEntry,
    type PlaybackCapable,
    type ScanState,
    type ScanStateCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable,
    type UserLibraryCapable,
    type UserSeasonsCapable,
    type WatchStateCapable,
    type WatchTarget,
    type CommandHandle
} from './types.ts';

/**
 * The identify half of a metadata repair is a *synchronous* remote provider
 * lookup (Jellyfin holds the request open while it talks to TVDB and rebuilds
 * the item) so it does not fit the per-service read timeout. A live run
 * against a 69-episode series blew the configured 10s and the repair never
 * landed, which is exactly the shape `RELEASE_SEARCH_TIMEOUT_MS` already
 * documents for the *arrs' indexer sweeps.
 *
 * Deliberately generous rather than tuned: too short reports a repair that is
 * still running as a failure, and a caller who retries that starts a second
 * full rematch.
 */
export const METADATA_REPAIR_TIMEOUT_MS = 120_000;

/**
 * Jellyfin's generated types are a megabyte of declarations and its PascalCase
 * field names are stable across releases, so these three narrow shapes are
 * declared locally. The contract test checks them against the vendored spec,
 * which is where that checking belongs.
 */
type RawSystemInfo = { Version?: string; ServerName?: string; Id?: string };
type RawUser = { Id?: string; Name?: string };
type RawTask = {
    /** Per-install GUID. Only `startLibraryScan` needs it; `getScanState`
     *  matches on `Key`, which is stable across installs. */
    Id?: string;
    Key?: string;
    Name?: string;
    State?: string;
    LastExecutionResult?: { EndTimeUtc?: string; Status?: string };
};

/**
 * The library-scan task, confirmed against a live 10.11.11.
 *
 * Keyed on `Key`, never `Name`, for two reasons: a server exposes eight
 * library-ish keys including `TraktSyncLibraryTask`, so a pattern matches the
 * wrong one, and `Name` is localised, returning "Mediabibliotheek scannen" on
 * the instance this came from.
 */
const LIBRARY_SCAN_KEY = 'RefreshLibrary';

type RawItem = {
    Id?: string;
    Name?: string;
    SeriesName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    RunTimeTicks?: number;
    /** Only the activity-log read uses it, to drop live TV and the like. */
    Type?: string;
    UserData?: { PlaybackPositionTicks?: number; LastPlayedDate?: string; Played?: boolean };
};
/** The same row, as one server's log may name the user by its internal account
 *  number rather than the id every other route uses. See `logUserMatcher`. */
export type RawActivityEntry = { Name?: string; Type?: string; ItemId?: string | null; Date?: string; UserId?: string };
type RawSession = {
    UserId?: string;
    UserName?: string;
    DeviceName?: string;
    NowPlayingItem?: RawItem;
    PlayState?: { PositionTicks?: number };
};
type RawItemsPage = { Items?: RawItem[] };

/** Jellyfin measures time in 100-nanosecond ticks. Nothing else in the stack does. */
const TICKS_PER_SECOND = 10_000_000;

/** Library reads are paged: a large library has thousands of items, and one
 *  unpaged read would be the slowest call in a library build. */
const PAGE_SIZE = 500;
/** Backstop for `#pagedItems`: 400 pages is 200,000 items. */
const MAX_PAGES = 400;
const ticksToSeconds = (ticks: number | undefined): number | undefined =>
    typeof ticks === 'number' ? Math.round(ticks / TICKS_PER_SECOND) : undefined;

/**
 * Every playback stop Jellyfin logged, newest first. `type` is a real filter:
 * confirmed against a live 12.x with an invented-parameter control, which
 * returned the unfiltered 46k entries against 10k stops. The log is
 * household-wide; `UserId` narrows it, and comes back in the same undashed
 * form as `/Users`.
 *
 * An offline client (AFinity) reports its plays here when it reconnects, often
 * as a lone stop and without the item ever getting `Played`. The log is kept
 * for `ActivityLogRetentionDays` (30 by default), so this reaches no further.
 */
const ACTIVITY_LOG_ROUTE = '/System/ActivityLog/Entries?type=VideoPlaybackStopped&hasUserId=true&limit=500';

/** The newest logged stop per item, oldest rows dropped. Shared with the Emby
 *  adapter, which reads its own event type from the same envelope. */
const newestStopPerItem = (entries: RawActivityEntry[]): RawActivityEntry[] => {
    const newest = new Map<string, RawActivityEntry>();
    for (const e of entries) {
        if (typeof e.ItemId !== 'string' || e.ItemId === '') continue;
        const kept = newest.get(e.ItemId);
        if (kept === undefined || (e.Date ?? '') > (kept.Date ?? '')) newest.set(e.ItemId, e);
    }
    return [...newest.values()];
};

/** Ids per `/Items?ids=` read, keeping the URL well short of proxy limits.
 *  Overridable because this ceiling is a property of the server being asked: Emby
 *  4.10 answers **500 Internal Server Error** for an `ids=` list longer than 46
 *  (live-confirmed 2026-11-14: 46 ok, 47 fails, repeatably, and every smaller
 *  chunk resolves fully), so at 100 its history read lost one whole request to a
 *  transport error that looks like an upstream fault rather than a page-size bug. */
const LOGGED_ITEMS_CHUNK = 100;

const HISTORY_TYPES = new Set(['Episode', 'Movie']);

type RawItemDetail = {
    Id?: string;
    Name?: string;
    /** Only with `Fields=OriginalTitle`. */
    OriginalTitle?: string | null;
    ProductionYear?: number;
    Overview?: string;
    Path?: string;
    Type?: string;
    /** `MusicBrainzArtist` is what joins an album artist to Lidarr. */
    ProviderIds?: { Tmdb?: string; Tvdb?: string; Imdb?: string; MusicBrainzArtist?: string };
    MediaSources?: { Size?: number }[];
    Genres?: string[];
    UserData?: { Played?: boolean; PlayCount?: number; LastPlayedDate?: string };
    /** Only with `Fields=RecursiveItemCount` and a user: on a series, its episodes (seasons are not counted). */
    RecursiveItemCount?: number;
    /** Both only with `Fields=Settings`. */
    LockData?: boolean;
    LockedFields?: string[];
};

type RawEpisodeItem = {
    Id?: string;
    Name?: string;
    SeriesId?: string;
    /** Jellyfin's season number. `IndexNumber` is the episode's. */
    ParentIndexNumber?: number;
    IndexNumber?: number;
    /** Only present when the read asks for it via `Fields=Path`. */
    Path?: string;
    /** Likewise `Fields=ProviderIds`. An episode carrying one is pinned to it
     *  across refreshes: see `pinnedToProvider`. */
    ProviderIds?: Record<string, string>;
    UserData?: { Played?: boolean; LastPlayedDate?: string };
    LockData?: boolean;
    LockedFields?: string[];
};

/**
 * Jellyfin's locks in the detector's terms. `LockData` makes a refresh skip
 * every provider, so it holds everything; `Name` is the only per-field lock a
 * mismatch can be about, since Jellyfin has none for the year. Checked against
 * MetadataService.cs at v12.1.
 */
const lockedFields = (item: { LockData?: boolean; LockedFields?: string[] }): string[] | undefined =>
    item.LockData === true ? ['title', 'year'] : item.LockedFields?.includes('Name') === true ? ['title'] : undefined;

const withLocks = (item: { LockData?: boolean; LockedFields?: string[] }): { lockedFields?: string[] } => {
    const locked = lockedFields(item);
    return locked === undefined ? {} : { lockedFields: locked };
};

/**
 * Jellyfin stores external ids as **strings** while Radarr and Sonarr use
 * numbers. The identity resolver joins on tmdbId and tvdbId, so a string
 * here would silently fail every join: convert at the boundary.
 */
const numericId = (value: string | undefined): number | undefined => {
    // Digits required, not just finiteness: `Number('')` is 0 and passes
    // `Number.isFinite`, so an empty provider id, which Jellyfin does emit,
    // became `tmdb: 0` and joined against every other item missing one.
    // Same trap `yearOf` documents in seerr.ts.
    if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
    return Number(value.trim());
};

/**
 * What one server's adapter is, and which of its behaviours differ from the
 * family default. Only three values exist here, and only for the two servers
 * that share this code; a third MediaBrowser-family adapter would pass its own.
 *
 * The `label` is what an error message calls the service. It is separate from
 * `id` because `id` is the audit and log identity (`emby/attic` when named) and
 * must never be interpolated into prose that names a product.
 */
type JellyfinFamilyIdentity = { id: string; type: ServiceId; label: string };

/**
 * The reads this family knows how to do, and the only way a derived adapter can
 * claim fewer of them.
 *
 * Capability here is decided by whether a method exists at all (the `has*` guards
 * in `types.ts` probe for it), so an adapter that inherits ten methods and has a
 * capture for four would silently claim ten. Each name below is replaced with
 * `undefined` on the instance rather than deleted from the class: deleting needs
 * a second base class, and this keeps one implementation while making the guard,
 * the own-property check, and every caller agree. The roster is checked against
 * the union, so a renamed method is an error here rather than an option that
 * quietly stopped unclaiming anything.
 */
type JellyfinFamilyRead =
    | 'getMediaDetails'
    | 'getScanState'
    | 'search'
    | 'startLibraryScan'
    | 'listUserMusic'
    | 'listUserSeasons'
    | 'readEpisodeMetadata'
    | 'readMovieMetadata'
    | 'readWatchTarget'
    | 'repairMetadata'
    | 'setWatched';

const ALL_FAMILY_READS: readonly JellyfinFamilyRead[] = [
    'getMediaDetails',
    'getScanState',
    'search',
    'startLibraryScan',
    'listUserMusic',
    'listUserSeasons',
    'readEpisodeMetadata',
    'readMovieMetadata',
    'readWatchTarget',
    'repairMetadata',
    'setWatched'
];

/** The seams where Emby's 4.10 differs from Jellyfin, each documented at its capture. */
export type FamilyOptions = {
    /** The activity-log read for `getWatchHistory`, event vocabulary included. */
    activityLogRoute?: string;
    /** Whether a logged item is a history row at all. Emby needs it: its log
     *  covers library events too, and an unrelated row would be reported as a
     *  play that never happened. */
    loggedItemIsKnown?: (item: RawItem) => boolean;
    /** The item-id shape guard, and the phrase describing it in a refusal. Emby ids
     *  are numeric strings, so Jellyfin's 32-hex rule would refuse every real one. */
    itemIdPattern?: { pattern: RegExp; shape: string };
    /** The resumable-items read. Only `getPlayback` asks for an extra `Fields`
     *  group, and it is a parameter this server has no fixture proving, so the
     *  base list is overridable rather than widened in place. */
    resumePath?: (userId: string) => string;
    /** The `Fields=` list of the per-user library read. */
    libraryFields?: string;
    /** The watched-items read that backs half of `getWatchHistory`. Emby has no
     *  such read: `/UserPlayedItems` is 404 and a played filter answers with the
     *  whole library, so it asks its own question instead of one that lies. */
    markedPlayedPath?: (userId: string) => string | undefined;
    /** The next-up read. Only its parameter name differs between the two. */
    nextUpPath?: (userId: string) => string;
    /** How many ids to resolve per request. See `LOGGED_ITEMS_CHUNK`. */
    loggedItemsChunk?: number;
    /** The credential strategy, which carries the 401 remedy with it. Emby accepts
     *  the same header (probes P1) but its key is made somewhere else, so an
     *  operator told to open a Jellyfin dashboard they do not run learns nothing. */
    auth?: (apiKey: string) => AuthStrategy;
    /** The reads this server has no capture for, and therefore does not offer.
     *  See `JellyfinFamilyRead`. */
    unclaimedReads?: readonly JellyfinFamilyRead[];
};

export class JellyfinAdapter
    implements
        ServiceAdapter,
        ScanStateCapable,
        UserDirectoryCapable,
        MediaDetailCapable,
        SearchCapable,
        UserLibraryCapable,
        UserSeasonsCapable,
        WatchStateCapable,
        MetadataInspectCapable,
        MetadataRepairCapable,
        PlaybackCapable
{
    readonly type: ServiceId;
    readonly id: string;
    /** What an error message calls this service: `Jellyfin`, or `Emby`. */
    readonly #label: string;
    readonly #http: ServiceHttp;
    readonly #activityLogRoute: string;
    readonly #loggedItemIsKnown: ((item: RawItem) => boolean) | undefined;
    readonly #itemIdPattern: { pattern: RegExp; shape: string };
    readonly #resumePath: (userId: string) => string;
    readonly #libraryFields: string;
    readonly #markedPlayedPath: (userId: string) => string | undefined;
    readonly #nextUpPath: (userId: string) => string;
    readonly #loggedItemsChunk: number;

    constructor(
        // The two media servers of this family share the same block shape
        // (`MultiUserServiceSchema`); their configs differ only by the phantom
        // `__service`, which names the service rather than constraining a field.
        config: ConfigByService['jellyfin'] | ConfigByService['emby'],
        fetchImpl: typeof fetch = fetch,
        identity: JellyfinFamilyIdentity = { id: 'jellyfin', type: 'jellyfin', label: 'Jellyfin' },
        opts: FamilyOptions = {}
    ) {
        this.id = identity.id;
        this.type = identity.type;
        this.#label = identity.label;
        this.#activityLogRoute = opts.activityLogRoute ?? ACTIVITY_LOG_ROUTE;
        this.#loggedItemIsKnown = opts.loggedItemIsKnown;
        this.#itemIdPattern = opts.itemIdPattern ?? { pattern: /^[0-9a-f]{32}$/, shape: '32 hex characters' };
        this.#resumePath =
            opts.resumePath ?? (userId => `/UserItems/Resume?userId=${encodeURIComponent(userId)}&Limit=500`);
        this.#libraryFields = opts.libraryFields ?? 'ProviderIds,Genres,OriginalTitle,RecursiveItemCount';
        this.#markedPlayedPath =
            opts.markedPlayedPath === undefined
                ? (userId =>
                `/Items?userId=${encodeURIComponent(userId)}&SortBy=DatePlayed&SortOrder=Descending` +
                    '&Filters=IsPlayed&IncludeItemTypes=Episode,Movie&Recursive=true&Limit=500&Fields=UserData')
                : opts.markedPlayedPath;
        this.#nextUpPath = opts.nextUpPath ?? (userId => `/Shows/NextUp?userId=${encodeURIComponent(userId)}`);
        this.#loggedItemsChunk = Math.max(1, opts.loggedItemsChunk ?? LOGGED_ITEMS_CHUNK);
        const unclaimed = opts.unclaimedReads ?? [];
        const auth = opts.auth ?? (key => embyToken(key));
        this.#http = new ServiceHttp(identity.id, config, auth(config.api_key), fetchImpl);

        for (const read of unclaimed) {
            if (!ALL_FAMILY_READS.includes(read)) {
                throw new Error(`${identity.id}: "${read}" is not a read of this family, so it cannot be unclaimed`);
            }
            Object.defineProperty(this, read, { value: undefined, writable: true, configurable: true });
        }
    }

    async getVersion(): Promise<string> {
        const info = await this.#http.get<RawSystemInfo>('/System/Info');
        if (!info.Version) {
            throw new ServiceError('UpstreamError', this.id, 'System/Info returned no version field');
        }
        return info.Version;
    }

    /**
     * Jellyfin identifies users by GUID while config names them by username, so
     * every per-user call resolves through this list, and the resolver reports
     * the available names on a miss, because a hand-typed username is a
     * guaranteed source of silent mismatches.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const users = await this.#http.getArray<RawUser>('/Users');
        return users
            .filter((u): u is { Id: string; Name: string } => typeof u.Id === 'string' && typeof u.Name === 'string')
            .map(u => ({ id: u.Id, name: u.Name }));
    }

    /**
     * Start the library scan: this adapter's only write.
     *
     * The task id is looked up rather than hard-coded, by the same
     * `Key === LIBRARY_SCAN_KEY` match `getScanState` uses: Jellyfin's ids are
     * per-install GUIDs, and the localised task *name* is no good either (a
     * Dutch install returns "Mediabibliotheek scannen"). Matching on the key
     * once, in one place, is what stops the two disagreeing about which task
     * this is.
     *
     * Jellyfin answers this with 204 and no body, so there is no command id to
     * report back, unlike the *arrs, which return one. The handle says so
     * rather than inventing a number that would look like something you could
     * poll.
     */
    async startLibraryScan(): Promise<CommandHandle> {
        const tasks = await this.#http.getArray<RawTask>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);

        if (scan?.Id === undefined) {
            throw new ServiceError('NotFound', this.id, 'Jellyfin did not report a library scan task', {
                remedy: 'The task is called RefreshLibrary. If this Jellyfin has it disabled, start the scan from its dashboard instead.'
            });
        }

        await this.#http.post(`/ScheduledTasks/Running/${encodeURIComponent(scan.Id)}`, undefined, true);

        return { service: this.id, name: LIBRARY_SCAN_KEY, status: 'started' };
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.getArray<RawTask>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);
        const lastCompleted = scan?.LastExecutionResult?.EndTimeUtc;
        return {
            service: this.id,
            running: scan?.State === 'Running',
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    /**
     * Sessions are global (an admin key sees the whole household), so they are
     * filtered to the resolved user here. The identity gate has already decided
     * that this user may be queried; this is the mechanical narrowing, not the
     * authorization decision.
     */
    #fence(field: string, value: string): string {
        return fenceText(value, { service: this.id, field });
    }

    #commonPlayback(user: ServiceUser, item: RawItem) {
        return {
            service: this.id,
            itemId: item.Id ?? '',
            title: this.#fence('Name', item.Name ?? ''),
            ...(item.SeriesName === undefined ? {} : { seriesTitle: this.#fence('SeriesName', item.SeriesName) }),
            ...(item.ParentIndexNumber === undefined ? {} : { season: item.ParentIndexNumber }),
            ...(item.IndexNumber === undefined ? {} : { episode: item.IndexNumber }),
            user: user.name
        };
    }

    #progress(position: number | undefined, runtime: number | undefined) {
        return {
            ...(position === undefined ? {} : { positionSeconds: position }),
            ...(runtime === undefined ? {} : { runtimeSeconds: runtime }),
            // Guarded against a zero runtime, which would divide to Infinity.
            ...(position !== undefined && runtime !== undefined && runtime > 0
                ? { percentComplete: Math.round((position / runtime) * 100) }
                : {})
        };
    }

    async getPlayback(user: ServiceUser): Promise<PlaybackEntry[]> {
        const [sessions, resume] = await Promise.all([
            this.#http.getArray<RawSession>('/Sessions'),
            /**
             * `/UserItems/Resume` is the documented way to ask for the resumable
             * set. `/Items?IsResumable=true` looks like the right query but is
             * silently ignored: it returns the entire library, not just
             * resumable items.
             *
             * The older `/Users/{id}/Items/Resume` still answers in Jellyfin 12,
             * but only as `[Obsolete]`, and it is absent from the OpenAPI
             * document, so nothing here would catch its removal.
             *
             * `Limit=500` ensures truncation is decided by `applyLimit` in the
             * contract layer, which reports it, rather than by an undocumented
             * server default page size, which does not.
             */
            this.#http.get<RawItemsPage>(this.#resumePath(user.id))
        ]);

        const nowPlaying: PlaybackEntry[] = sessions
            .filter(s => s.UserId === user.id && s.NowPlayingItem !== undefined)
            .map(s => {
                const item = s.NowPlayingItem as RawItem;
                return {
                    ...this.#commonPlayback(user, item),
                    kind: 'now_playing' as const,
                    ...this.#progress(ticksToSeconds(s.PlayState?.PositionTicks), ticksToSeconds(item.RunTimeTicks)),
                    ...(s.DeviceName === undefined ? {} : { device: s.DeviceName })
                };
            });

        const resuming: PlaybackEntry[] = (resume.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'resume' as const,
            ...this.#progress(ticksToSeconds(item.UserData?.PlaybackPositionTicks), ticksToSeconds(item.RunTimeTicks)),
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        return [...nowPlaying, ...resuming];
    }

    /**
     * `/Shows/NextUp` is Jellyfin's own per-user answer to "what next": one
     * row per series with an unwatched episode after the last one this user
     * finished. Confirmed against a live 10.11.11: 19 rows for a household
     * with several in-progress shows.
     */
    async getNextUp(user: ServiceUser): Promise<PlaybackEntry[]> {
        const page = await this.#http.get<RawItemsPage>(this.#nextUpPath(user.id));
        return (page.Items ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'next_up' as const
        }));
    }

    /**
     * Recently watched movies and episodes, newest first. `Filters=IsPlayed`
     * plus the DatePlayed sort are both real: confirmed against a live
     * 10.11.11 with an invented-parameter control, since Jellyfin silently
     * ignores a query param it does not recognise. `Limit=500` matches
     * `getPlayback`'s resumable read: truncation is decided by `applyLimit`,
     * not an undocumented server page size.
     */
    async getWatchHistory(user: ServiceUser): Promise<PlaybackEntry[]> {
        const [markedPage, logged] = await Promise.all([
            this.#markedPlayedItems(user),
            this.activityLogStops(user)
        ]);

        const marked: PlaybackEntry[] = (markedPage ?? []).map(item => ({
            ...this.#commonPlayback(user, item),
            kind: 'watched' as const,
            source: 'marked_played' as const,
            ...(item.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: item.UserData.LastPlayedDate })
        }));

        const seen = new Set(marked.map(e => e.itemId));
        const unmarked = logged.filter(e => !seen.has(e.ItemId as string));
        const fromLog = await this.loggedPlays(user, unmarked);

        // ISO-8601 UTC strings sort lexically; an entry with no date goes last.
        return [...marked, ...fromLog].sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''));
    }

    /**
     * The marked-played read, or `undefined` when this server has no such read at
     * all (Emby: no `/UserPlayedItems`, and a played filter that ignores the
     * filter). Absent rows are then genuinely "no source for this half", not the
     * empty answer a filter would return while claiming to have filtered.
     */
    async #markedPlayedItems(user: ServiceUser): Promise<RawItem[] | undefined> {
        const path = this.#markedPlayedPath?.(user.id);
        // No such read on this server (Emby): not an empty answer, and not a
        // failure to report either. `undefined` here means the half was never
        // asked, which is what the caller's `marked === undefined` branch says.
        if (path === undefined) return undefined;
        const page = await this.#http.get<RawItemsPage>(path);
        return page.Items ?? [];
    }

    /** How one server's activity log names the user a stop belongs to. The two
     *  disagree, and neither says so: Jellyfin echoes back the undashed GUID it
     *  uses everywhere else, while Emby 4.10 answers `"1"`, its internal row
     *  number (live-confirmed 2026-11-14: all 131 logged stops carried
     *  `UserId: "1"` against the GUID `/Users` reports for that same account).
     *  Comparing raw ids therefore drops every Emby row, and it does so quietly,
     *  because an empty history is a plausible answer. */
    protected activityLogUserMatches(entry: RawActivityEntry, user: ServiceUser): boolean {
        return entry.UserId === user.id;
    }

    /** This user's newest stop per item. A failed read degrades to none rather
     *  than failing the history: the marked-played half is still a correct answer
     *  to most questions, and losing it over a supplementary read would not be.
     *
     *  The user list is read only when a server cannot name its own log rows; see
     *  `logUserMatcher`. */
    protected async activityLogStops(user: ServiceUser): Promise<RawActivityEntry[]> {
        let entries: RawActivityEntry[];
        try {
            entries = (await this.#http.get<{ Items?: RawActivityEntry[] }>(this.#activityLogRoute)).Items ?? [];
        } catch (err) {
            logger.warn({ service: this.id, err }, 'activity log read failed; history covers marked-played items only');
            return [];
        }

        const matches = await this.logUserMatcher(entries, user);
        return newestStopPerItem(entries.filter(matches));
    }

    /** A predicate over the log rows for one user, given the rows themselves.
     *  The default needs nothing beyond the id it was handed; a server whose log
     *  uses another vocabulary (Emby) resolves it against the account list here,
     *  and only when a row actually carries that other form. */
    protected async logUserMatcher(
        _entries: RawActivityEntry[],
        user: ServiceUser
    ): Promise<(entry: RawActivityEntry) => boolean> {
        return entry => this.activityLogUserMatches(entry, user);
    }

    /**
     * Logged stops as history rows. Completion is the item's own `UserData`: a
     * resume position partway through means they stopped, so the row is
     * `partially_watched`; no position counts as watched, because an offline
     * client only syncs a stop once the file has been played and the server clears
     * the position at both ends. An item gone from the library keeps its row,
     * titled with the log's own (localised) sentence, since that is all that is
     * left of it.
     *
     * `loggedItemIsKnown` narrows this further where a server's log covers more
     * than plays; see the Emby adapter.
     */
    protected async loggedPlays(user: ServiceUser, stops: RawActivityEntry[]): Promise<PlaybackEntry[]> {
        if (stops.length === 0) return [];

        const ids = stops.map(e => e.ItemId as string);
        // One page's failure costs that page and nothing else. The rows it held are
        // then treated as removed from the library, which is a conservative reading
        // (their own log entry is all they keep), and better than the whole read
        // failing because one chunk of ids did not resolve.
        const pages = await Promise.all(
            Array.from({ length: Math.ceil(ids.length / this.#loggedItemsChunk) }, (_, i) =>
                this.#http
                    .get<RawItemsPage>(
                        `/Items?userId=${encodeURIComponent(user.id)}` +
                            `&ids=${ids.slice(i * this.#loggedItemsChunk, (i + 1) * this.#loggedItemsChunk).join(',')}&Fields=UserData`
                    )
                    .catch(() => ({ Items: [] }))
            )
        );
        const byId = new Map(pages.flatMap(p => p.Items ?? []).map(item => [item.Id, item]));

        return stops.flatMap((stop): PlaybackEntry[] => {
            const item = byId.get(stop.ItemId as string);
            if (item === undefined) {
                return [
                    {
                        service: this.id,
                        kind: 'watched',
                        source: 'activity_log',
                        removedFromLibrary: true,
                        itemId: stop.ItemId as string,
                        title: this.#fence('Name', stop.Name ?? ''),
                        user: user.name,
                        ...(stop.Date === undefined ? {} : { lastPlayed: stop.Date })
                    }
                ];
            }
            if (!HISTORY_TYPES.has(item.Type ?? '')) return [];
            if (this.#loggedItemIsKnown !== undefined && !this.#loggedItemIsKnown(item)) return [];

            const position = item.UserData?.PlaybackPositionTicks ?? 0;
            const partial = item.UserData?.Played !== true && position > 0;
            const dates = [item.UserData?.LastPlayedDate, stop.Date].filter((d): d is string => d !== undefined);
            const lastPlayed = dates.sort().at(-1);
            return [
                {
                    ...this.#commonPlayback(user, item),
                    kind: partial ? 'partially_watched' : 'watched',
                    source: 'activity_log',
                    ...(partial ? this.#progress(ticksToSeconds(position), ticksToSeconds(item.RunTimeTicks)) : {}),
                    ...(lastPlayed === undefined ? {} : { lastPlayed })
                }
            ];
        });
    }

    /**
     * `/Items?ids=…`, not `/Items/{id}`. A bare `/Items/{id}` answered
     * **400 Error processing request** on a live 10.11.11; the cause was not
     * established. `readWatchTarget` reads `/Items/{id}?userId=`, a form
     * captured on Jellyfin 12.4.0. This read has no business needing an
     * identity, so it stays on `ids`.
     *
     * `Fields` is required for anything beyond the summary: without it there
     * are no provider ids, no path and no media sources.
     */
    async getMediaDetails(id: string): Promise<MediaDetails> {
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?ids=${encodeURIComponent(id)}&Fields=ProviderIds,Path,MediaSources,Overview`
        );
        const item = page.Items?.[0];
        if (item === undefined) {
            throw new ServiceError('NotFound', this.id, `no item with id ${id}`, {
                remedy: 'Check the id came from a Jellyfin search rather than another service.'
            });
        }

        const tmdb = numericId(item.ProviderIds?.Tmdb);
        const tvdb = numericId(item.ProviderIds?.Tvdb);

        return {
            service: this.id,
            kind: 'item',
            id,
            title: fenceText(item.Name ?? '', { service: this.id, field: 'Name' }),
            ...(item.ProductionYear === undefined ? {} : { year: item.ProductionYear }),
            ...(item.Overview === undefined
                ? {}
                : { overview: fenceText(item.Overview, { service: this.id, field: 'Overview' }) }),
            ...(item.MediaSources?.[0]?.Size === undefined ? {} : { sizeBytes: item.MediaSources[0].Size }),
            ...(item.Path === undefined ? {} : { path: fenceText(item.Path, { service: this.id, field: 'Path' }) }),
            ids: {
                ...(tmdb === undefined ? {} : { tmdb }),
                ...(tvdb === undefined ? {} : { tvdb }),
                ...(item.ProviderIds?.Imdb === undefined ? {} : { imdb: item.ProviderIds.Imdb })
            }
        };
    }

    /** Jellyfin is the only service that knows what has actually been watched. */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];

        // `Fields=ProviderIds` is not optional decoration: Jellyfin omits
        // ProviderIds from search results entirely without it, confirmed
        // against a live 10.11.11. Every hit came back with no external ids at
        // all, which is precisely what the resolver joins on.
        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?searchTerm=${encodeURIComponent(query)}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds`
        );

        return (page.Items ?? [])
            .filter((i): i is RawItemDetail & { Id: string } => typeof i.Id === 'string')
            .map(i => {
                const tmdb = numericId(i.ProviderIds?.Tmdb);
                const tvdb = numericId(i.ProviderIds?.Tvdb);
                return {
                    service: this.id,
                    source: 'library' as const,
                    kind: i.Type === 'Series' ? ('series' as const) : ('item' as const),
                    id: i.Id,
                    title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                    ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                    ids: {
                        ...(tmdb === undefined ? {} : { tmdb }),
                        ...(tvdb === undefined ? {} : { tvdb }),
                        ...(i.ProviderIds?.Imdb === undefined ? {} : { imdb: i.ProviderIds.Imdb })
                    }
                };
            });
    }

    /**
     * Per-user by construction. `EnableUserData` is what makes `Played`
     * come back at all, and `Fields=ProviderIds` is what makes the join
     * possible: the same parameter whose absence once made every search hit
     * arrive with no external ids.
     */
    async listUserLibrary(user: ServiceUser): Promise<IndexInput[]> {
        const items = await this.#pagedItems<RawItemDetail>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Movie,Series` +
                `&Fields=${this.#libraryFields}&EnableUserData=true&EnableImages=false`
        );

        return items.map(i => {
            const tmdb = numericId(i.ProviderIds?.Tmdb);
            const tvdb = numericId(i.ProviderIds?.Tvdb);

            return {
                kind: i.Type === 'Series' ? ('series' as const) : ('movie' as const),
                title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ...((aliases => (aliases.length === 0 ? {} : { aliases }))(aliasesOf(i.Name, [i.OriginalTitle]))),
                ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                ...(i.Genres === undefined
                    ? {}
                    : { genres: i.Genres.map(g => fenceText(g, { service: this.id, field: 'Genres' })) }),
                ids: {
                    ...(tmdb === undefined ? {} : { tmdb }),
                    ...(tvdb === undefined ? {} : { tvdb }),
                    ...(i.ProviderIds?.Imdb === undefined ? {} : { imdb: i.ProviderIds.Imdb })
                },
                playback: {
                    user: user.name,
                    ...(i.Id === undefined ? {} : { itemId: i.Id }),
                    watched: i.UserData?.Played ?? false,
                    ...(i.UserData?.PlayCount === undefined ? {} : { playCount: i.UserData.PlayCount }),
                    ...(i.UserData?.LastPlayedDate === undefined ? {} : { lastPlayed: i.UserData.LastPlayedDate }),
                    ...(i.Type === 'Series' && i.RecursiveItemCount === 0 ? { empty: true as const } : {})
                }
            };
        });
    }

    /**
     * The user's album artists, one row each, joined to Lidarr on the
     * MusicBrainz artist id.
     *
     * Its own read, and its own source in a library build, so a Jellyfin whose
     * music half fails does not take films and series down with it, and so
     * `musicGathered` can say which half was missing rather than claiming
     * every artist is `arr_only`.
     *
     * `/Artists/AlbumArtists` rather than `/Items?IncludeItemTypes=...`,
     * because an album artist is not a library item type: it is the set
     * Jellyfin derives from the albums it holds, and it is the only read that
     * exposes `ProviderIds.MusicBrainzArtist` for one. `playback` carries the
     * server's own id and no watch state: music watch state is not read here,
     * and a `watched: false` invented from that silence would be a claim
     * nobody made.
     */
    async listUserMusic(user: ServiceUser): Promise<IndexInput[]> {
        const items = await this.#pagedItems<RawItemDetail>(
            `/Artists/AlbumArtists?userId=${encodeURIComponent(user.id)}&Recursive=true&Fields=ProviderIds`
        );
        return items.map(i => {
            const mbid = i.ProviderIds?.MusicBrainzArtist;
            return {
                kind: 'artist' as const,
                title: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ids: mbid === undefined || mbid === '' ? {} : { mbid },
                playback: {
                    user: user.name,
                    ...(i.Id === undefined ? {} : { itemId: i.Id })
                }
            };
        });
    }

    /** Reads every page of an items-shaped endpoint, `PAGE_SIZE` at a time,
     *  stopping on the first short page. `path` must already carry a query.
     *  A page identical to the one before it means the server ignored
     *  `StartIndex`; that, or running past `MAX_PAGES`, is thrown rather than
     *  looped on. */
    async #pagedItems<T>(path: string): Promise<T[]> {
        const out: T[] = [];
        let previous: string | undefined;
        for (let start = 0; ; start += PAGE_SIZE) {
            if (start / PAGE_SIZE >= MAX_PAGES) {
                throw new ServiceError('UpstreamError', this.id, `${path.split('?')[0]} did not finish paging after ${MAX_PAGES} pages`, {
                    remedy: 'This is a backstop, not an expected outcome. Check that nothing in front of Jellyfin rewrites Limit or StartIndex.'
                });
            }
            const page = await this.#http.get<{ Items?: T[] }>(`${path}&Limit=${PAGE_SIZE}&StartIndex=${start}`);
            const items = page.Items ?? [];
            const fingerprint = JSON.stringify(items);
            if (start > 0 && items.length > 0 && fingerprint === previous) {
                throw new ServiceError('UpstreamError', this.id, `${path.split('?')[0]} did not advance past StartIndex=0, the whole page repeated`, {
                    remedy: `${this.#label}, or a proxy in front of it, appears to be ignoring the StartIndex query parameter.`
                });
            }
            previous = fingerprint;
            out.push(...items);
            if (items.length < PAGE_SIZE) return out;
        }
    }

    /**
     * Per-season watch state for every series this user has episodes of.
     *
     * Two calls, and the series call is deliberately **not** shared with
     * `listUserLibrary`: sharing it would couple the two sources, and
     * independent failure is the entire reason they are separate. It is cheap:
     * ids only, no genres and no user data.
     *
     * Episodes are collapsed here rather than returned, so a 10,000-episode
     * library costs one object per season in the snapshot instead of 10,000.
     * Jellyfin's internal `Id` never leaves this method; the resolver keeps
     * joining on external ids alone.
     */
    /**
     * Item ids are checked against this server's own shape before any network
     * call, because the ids a caller is most likely to reach for by mistake (a
     * Radarr movie id, a Sonarr series id) are small integers, and sending one
     * on produces a 404 that names nothing useful.
     *
     * The pattern is a constructor argument rather than a literal: Emby's item
     * ids are numeric strings while its user and server ids are 32-hex, so
     * Jellyfin's rule would refuse every real Emby id (docs/emby-probes.md,
     * item 2 of "Seven things its API does not say out loud"). The message names
     * the product from `#label`, not from this file's name, because an Emby user
     * must not be told to look in Jellyfin.
     */
    #itemId(id: string): string {
        const clean = id.trim().toLowerCase();
        if (!this.#itemIdPattern.pattern.test(clean)) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a ${this.#label} item id`, {
                remedy:
                    `${this.#label} item ids are ${this.#itemIdPattern.shape}, and are not Radarr or Sonarr ids. Take one from the \`itemId\` get_playback reports, or from a ${this.type} hit in search_media.`
            });
        }
        return clean;
    }

    async readWatchTarget(user: ServiceUser, itemId: string): Promise<WatchTarget> {
        const id = this.#itemId(itemId);
        const item = await this.#http.get<
            RawItemDetail & { Type?: string; IsFolder?: boolean; IndexNumber?: number; SeriesId?: string; UserData?: { Played?: boolean } }
        >(`/Items/${id}?userId=${encodeURIComponent(user.id)}`);

        const KINDS: Record<string, WatchTarget['kind']> = { Movie: 'movie', Series: 'series', Episode: 'episode' };
        // Marking a folder marks every child, so it is told apart from a leaf.
        // Seen live: Season and CollectionFolder both carry IsFolder.
        const folder = item.IsFolder === true || item.Type === 'Season' || item.Type === 'BoxSet';
        const seasonOf = item.Type === 'Season' && typeof item.SeriesId === 'string' && /^[0-9a-f]{32}$/i.test(item.SeriesId);
        return {
            id,
            title: fenceText(item.Name ?? '', { service: this.id, field: 'Name' }),
            kind: KINDS[item.Type ?? ''] ?? (folder ? 'folder' : 'item'),
            watched: item.UserData?.Played === true,
            ...(seasonOf ? { seriesId: item.SeriesId, ...(typeof item.IndexNumber === 'number' ? { season: item.IndexNumber } : {}) } : {})
        };
    }

    /**
     * `season` is Jellyfin's own parameter name, confirmed by sending an
     * invented one and getting the unfiltered count back: Jellyfin ignores
     * query parameters it does not recognise, so a wrong spelling looks
     * exactly like a working filter.
     */
    async listEpisodeItems(user: ServiceUser, seriesItemId: string, season?: number): Promise<WatchTarget[]> {
        const id = this.#itemId(seriesItemId);
        const page = await this.#http.get<{ Items?: RawEpisodeItem[] }>(
            `/Shows/${id}/Episodes?userId=${encodeURIComponent(user.id)}&EnableUserData=true` +
                (season === undefined ? '' : `&season=${season}`)
        );

        return (page.Items ?? [])
            .filter((e): e is RawEpisodeItem & { Id: string } => typeof e.Id === 'string')
            .map(e => ({
                id: e.Id,
                title: fenceText(e.Name ?? '', { service: this.id, field: 'Name' }),
                kind: 'episode' as const,
                watched: e.UserData?.Played === true,
                ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
                ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber })
            }));
    }

    /**
     * POST marks played, DELETE unmarks. Both answer with the item's user
     * data, which nothing here reads: the tool re-reads state through
     * `readWatchTarget` when it needs it.
     *
     * `userId` is a query parameter, and Jellyfin ignores parameters it does
     * not recognise: a misspelling here would silently mark the item for
     * whoever the API key belongs to instead. Proved correct by sending an
     * invented parameter alongside and confirming the response was unchanged.
     */
    async setWatched(user: ServiceUser, itemId: string, watched: boolean): Promise<void> {
        const path = `/UserPlayedItems/${this.#itemId(itemId)}?userId=${encodeURIComponent(user.id)}`;
        if (watched) {
            await this.#http.post(path, undefined, true);
        } else {
            await this.#http.delete(path);
        }
    }

    /**
     * The same endpoint `listEpisodeItems` reads, asked a different question.
     * `Fields=Path` is the entire reason this is a separate method: Jellyfin
     * omits `Path` unless a read asks for it, and `set_watched` has no use for
     * a file path: widening its read to carry one would change a verified
     * request for nothing.
     */
    async readEpisodeMetadata(user: ServiceUser, seriesItemId: string): Promise<EpisodeRecord[]> {
        const id = this.#itemId(seriesItemId);
        // `ProviderIds` alongside `Path` because the two together decide
        // whether a mismatch is repairable at all: an episode pinned to its own
        // provider id is re-fetched from that id by a refresh, so refreshing it
        // rewrites exactly the metadata it already had.
        const page = await this.#http.get<{ Items?: RawEpisodeItem[] }>(
            `/Shows/${id}/Episodes?userId=${encodeURIComponent(user.id)}&Fields=Path,ProviderIds,Settings&EnableImages=false`
        );

        return (page.Items ?? [])
            .filter((e): e is RawEpisodeItem & { Id: string } => typeof e.Id === 'string')
            .map(e => ({
                id: e.Id,
                name: fenceText(e.Name ?? '', { service: this.id, field: 'Name' }),
                ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
                ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber }),
                // Fenced like every other server-supplied string. The mismatch
                // parser unfences before it reads the path, so the fence costs
                // the comparison nothing and the value stays safe to print.
                ...(e.Path === undefined ? {} : { path: fenceText(e.Path, { service: this.id, field: 'Path' }) }),
                // Not fenced: these are read as structure (whether an id
                // exists at all) and never printed as prose.
                ...(e.ProviderIds === undefined ? {} : { providerIds: e.ProviderIds }),
                ...withLocks(e)
            }));
    }

    /**
     * Every film, in one call rather than one call per title.
     *
     * The asymmetry with the episode read is the library's, not a design
     * choice: episodes have to be asked for per series, films do not, so a
     * sweep of a large library costs one request here and one per series
     * there.
     */
    async readMovieMetadata(user: ServiceUser, itemId?: string): Promise<MovieRecord[]> {
        // One film by id when the caller wants one. `fix_metadata` reads a film
        // four times across a preview and a confirm, and pulling the whole film
        // library each time is a multi-megabyte response under a read timeout
        // meant for a small one, which `get` then retries once before failing.
        const scope =
            itemId === undefined
                ? '&Recursive=true&IncludeItemTypes=Movie'
                : `&ids=${encodeURIComponent(this.#itemId(itemId))}`;

        const page = await this.#http.get<{ Items?: RawItemDetail[] }>(
            `/Items?userId=${encodeURIComponent(user.id)}${scope}` +
                '&Fields=Path,ProviderIds,Settings&EnableImages=false'
        );

        return (page.Items ?? [])
            .filter((i): i is RawItemDetail & { Id: string } => typeof i.Id === 'string')
            .map(i => ({
                id: i.Id,
                name: fenceText(i.Name ?? '', { service: this.id, field: 'Name' }),
                ...(i.ProductionYear === undefined ? {} : { year: i.ProductionYear }),
                ...(i.Path === undefined ? {} : { path: fenceText(i.Path, { service: this.id, field: 'Path' }) }),
                ...(i.ProviderIds === undefined ? {} : { providerIds: i.ProviderIds }),
                ...withLocks(i)
            }));
    }

    /**
     * One call, not two, and which one depends on whether an identity can be
     * pinned.
     *
     * `ApplySearchCriteria` is not just a pin. Checked against the server
     * source rather than assumed: it sets the item's `ProviderIds` and then
     * **awaits `RefreshFullItem` itself**, with `MetadataRefreshMode.FullRefresh`,
     * `ReplaceAllMetadata = true` and `RemoveOldMetadata = true`, before
     * answering 204. So a following `/Refresh` is a second full provider fetch
     * of the same item for no gain, and the comment that used to sit here
     * claiming "two calls, and both are needed" was wrong.
     *
     * The difference matters beyond the wasted work: Apply is **synchronous**,
     * so when it returns the metadata is settled and a caller comparing before
     * and after is reading a final answer. The standalone refresh is queued, so
     * a caller reading straight after it is reading a snapshot mid-flight.
     * `settled` says which of the two happened rather than making the caller
     * guess.
     *
     * The refresh query names are camelCase because that is what the vendored
     * spec says (`RefreshItem`), not the capitalised spelling issue #199 quoted.
     * Jellyfin ignores parameters it does not recognise, so a wrong spelling
     * here would return 204 and change nothing: the failure this whole tool
     * exists to stop being reported as success.
     */
    async repairMetadata(itemId: string, opts: { tvdbId?: number; tmdbId?: number }): Promise<{ settled: boolean }> {
        const id = this.#itemId(itemId);
        const slow = { timeoutMs: METADATA_REPAIR_TIMEOUT_MS };

        const providerIds: Record<string, string> = {
            ...(opts.tvdbId === undefined ? {} : { Tvdb: String(opts.tvdbId) }),
            ...(opts.tmdbId === undefined ? {} : { Tmdb: String(opts.tmdbId) })
        };

        // Applying an empty match would unpin whatever identity the item
        // already had, so with no id to pin this falls back to the plain
        // refresh, which cannot fix a wrong match, only a missing one.
        if (Object.keys(providerIds).length > 0) {
            await this.#http.post(
                `/Items/RemoteSearch/Apply/${id}?replaceAllImages=false`,
                { ProviderIds: providerIds },
                true,
                slow
            );
            return { settled: true };
        }

        await this.#http.post(
            `/Items/${id}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh` +
                '&replaceAllMetadata=true&replaceAllImages=false',
            undefined,
            true,
            slow
        );
        return { settled: false };
    }

    async listUserSeasons(user: ServiceUser): Promise<IndexInput[]> {
        const series = await this.#pagedItems<RawItemDetail>(
            '/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds&EnableImages=false'
        );
        const episodes = await this.#pagedItems<RawEpisodeItem>(
            `/Items?userId=${encodeURIComponent(user.id)}&Recursive=true&IncludeItemTypes=Episode` +
                '&EnableUserData=true&EnableImages=false'
        );

        const bySeries = new Map<string, Map<number, { watched: number; lastPlayed?: string }>>();
        for (const episode of episodes) {
            const seriesId = episode.SeriesId;
            const season = episode.ParentIndexNumber;
            if (seriesId === undefined || season === undefined) continue;

            const seasons = bySeries.get(seriesId) ?? new Map<number, { watched: number; lastPlayed?: string }>();
            bySeries.set(seriesId, seasons);

            const row = seasons.get(season) ?? { watched: 0 };
            if (episode.UserData?.Played === true) row.watched += 1;
            const played = episode.UserData?.LastPlayedDate;
            // Compared as strings: ISO 8601 sorts lexicographically in the order
            // it sorts chronologically, and `new Date()` on a malformed value
            // yields NaN, which compares false against everything.
            if (played !== undefined && (row.lastPlayed === undefined || played > row.lastPlayed)) {
                row.lastPlayed = played;
            }
            seasons.set(season, row);
        }

        return series
            .filter((s): s is RawItemDetail & { Id: string } => typeof s.Id === 'string' && bySeries.has(s.Id))
            .map(s => {
                const tmdb = numericId(s.ProviderIds?.Tmdb);
                const tvdb = numericId(s.ProviderIds?.Tvdb);
                return {
                    kind: 'series' as const,
                    title: fenceText(s.Name ?? '', { service: this.id, field: 'Name' }),
                    ids: {
                        ...(tmdb === undefined ? {} : { tmdb }),
                        ...(tvdb === undefined ? {} : { tvdb }),
                        ...(s.ProviderIds?.Imdb === undefined ? {} : { imdb: s.ProviderIds.Imdb })
                    },
                    seasons: [...(bySeries.get(s.Id) ?? new Map<number, { watched: number; lastPlayed?: string }>()).entries()]
                        .map(([season, row]) => ({
                            season,
                            watched: row.watched,
                            ...(row.lastPlayed === undefined ? {} : { lastPlayed: row.lastPlayed })
                        }))
                        .sort((a, b) => a.season - b.season)
                };
            })
            // A row with no external id can never join. `LibraryIndex.build`
            // keys on tmdb/tvdb/imdb, so a seasons-only row carrying none of
            // them matches nothing and becomes a **new** library item: the
            // same id-less series `listUserLibrary` already returned, appearing
            // a second time with no playback, no acquisition and
            // `presence: 'unknown'`, inflating `get_library`'s `total` and
            // duplicating the title. Dropped rather than emitted: seasons with
            // nothing to attach them to answer no question anyone can ask.
            .filter(row => Object.keys(row.ids).length > 0);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
