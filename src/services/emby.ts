import type { ConfigByService } from '../config/schema.ts';
import { embyToken } from '../core/auth.ts';
import type { PlaybackEntry, ServiceUser } from './types.ts';
import { JellyfinAdapter, type JellyfinFamilyIdentity } from './jellyfin.ts';

/**
 * The Emby adapter: `JellyfinAdapter` with Emby's identity and the four places
 * its 4.10 differs, each one recorded in `docs/emby-probes.md` rather
 * than assumed. Everything else (the version read, the user directory,
 * sessions, Next Up, the library read, paging, fencing) is inherited unchanged,
 * which is what `test/embyInherited.test.ts` exists to keep honest: a route or
 * field added to the shared adapter without an Emby fixture behind it fails there.
 *
 * ## What is implemented, and why nothing else
 *
 * Only the two tiers every route of which was answered by the captured
 * 4.10.2.0 instance: the version/connection pair (`/System/Info`) and the three
 * per-user media-server reads (`/Users`, `/Items?userId=…`, `/Sessions`). That
 * is what makes it a media server to `selectMediaServers`, and what delivers
 * `get_stack_health`, `get_library`'s watch-state join, `get_playback` and the
 * playback stage of `diagnose_media`.
 *
 * Not implemented, deliberately, each for a reason a capture gave rather than a
 * guess:
 *
 * - **`setWatched`.** `/UserPlayedItems` is **404** on Emby 4.10, and no other
 *   route was proven to write the flag. `set_watched` is Jellyfin-only by
 *   design already (Plex has no write half), so this costs one honest refusal.
 * - **`getScanState` / `startLibraryScan`.** `/ScheduledTasks` answers and
 *   `Key: RefreshLibrary` exists, but no capture ran the task, so its POST form
 *   is unproven. The fixture stays in the tree as the evidence that a future
 *   version must match on `Key`: four other tasks carry Scan or Refresh in their
 *   `Name`.
 * - **`search` / `getMediaDetails`.** `/Items?searchTerm=` works, but search is
 *   tier T3 (out of the first version's scope), and `Fields=Path` and
 *   `Overview` were never captured, so a details row would be missing the two
 *   fields the question usually asks for.
 * - **`listUserSeasons`, `readEpisodeMetadata`, `repairMetadata`.** T4. Emby's
 *   synchronous re-identify is unproven, and Jellyfin needed a 120 s timeout on
 *   the equivalent call; inheriting that number for a server nobody timed out
 *   would be an invented fact.
 * - **`listUserMusic`.** `/Artists/AlbumArtists` was never probed, so a music
 *   read would claim an entire collection is unmanaged or absent, which is the
 *   one thing `musicGathered` exists to prevent.
 *
 * ## The four differences, in order of how much they cost
 *
 * 1. **Watch history has one source.** `/Users/{id}/PlayedItems` is 404 and
 *    `Filters=Played` / `Filters=IsPlayed` are **accepted and ignored**, still
 *    answering `UserData.Played: false` on every row (probes P4). A filter that
 *    returns the unfiltered set is worse than a 400, because it reads as "no one
 *    has watched anything", so this adapter never asks it. History comes from
 *    `/System/ActivityLog/Entries`, whose rows are wrapped in `{ Items,
 *    TotalRecordCount }` and named with **dotted event types**: `playback.stop`,
 *    where Jellyfin's filter is `type=VideoPlaybackStopped`.
 * 2. **Item ids are numeric strings.** `"24952"`, not 32 hex, while user and
 *    server ids *are* 32-hex GUIDs (probes, surprise 2). The inherited id guard
 *    would refuse every real Emby id, so the pattern is passed in. It matters
 *    even though no write uses it here: a refusal that tells an Emby user their
 *    own ids are wrong is worse than the bug it prevents.
 * 3. **The library read asks for two fields fewer.** `OriginalTitle` and
 *    `RecursiveItemCount` were never captured, and Emby silently ignores a
 *    parameter it does not know, so an uncaptured one cannot be claimed to work.
 *    Their absence degrades to what the base already does with them missing: no
 *    aliases, and no `empty` marker on a series.
 * 4. **The resumable read is the older route.** `/UserItems/Resume` is
 *    unproven; `/Users/{id}/Items/Resume` answered 200 and correctly shaped. It
 *    is empty on the captured instance, which `docs/tools.md` marks as
 *    unverified rather than treating as a working answer.
 */

/** Emby's own activity-log filter. The dotted type is what this server accepts;
 *  Jellyfin's `VideoPlaybackStopped` is not one of its values. */
const ACTIVITY_LOG_ROUTE = '/System/ActivityLog/Entries?type=playback.stop&hasUserId=true&limit=500';

/** The library read's `Fields=` list: exactly what the capture asked for, since
 *  an uncaptured field name is a claim nobody can check (see the header). */
const LIBRARY_FIELDS = 'ProviderIds,Genres';

/** Only films and series can be a history row here. Emby's log carries library
 *  events as well as plays, so a logged id that resolves to anything else is
 *  dropped rather than reported as watched; the base filter on `Type` runs
 *  first, this narrows it to what the capture actually covers. */
const isKnownLibraryItem = (item: { Type?: string }): boolean => item.Type === 'Movie' || item.Type === 'Series';

export class EmbyAdapter extends JellyfinAdapter {
    constructor(config: ConfigByService['emby'], fetchImpl: typeof fetch = fetch) {
        const identity: JellyfinFamilyIdentity = { id: 'emby', type: 'emby', label: 'Emby' };
        super(
            config,
            fetchImpl,
            identity,
            {
                activityLogRoute: ACTIVITY_LOG_ROUTE,
                // Emby item ids are plain integers as strings (probes, surprise 2).
                itemIdPattern: { pattern: /^\d+$/, shape: 'digits' },
                libraryFields: LIBRARY_FIELDS,
                // Jellyfin's marked-played read does not exist here: Emby has no
                // `/UserPlayedItems`, and `Filters=IsPlayed` is accepted and
                // ignored while reporting `Played: false` on every row (probes
                // P4), so asking it would merge the whole library into the log
                // rows as items nobody watched. `undefined` means there is no such
                // read, which the base reports as a missing half rather than an
                // empty answer; history here comes from the activity log alone.
                markedPlayedPath: () => undefined,
                // Emby spells this parameter `UserId`. The point is not the
                // capital: a name it does not know is ignored rather than rejected
                // (probes P3), so Jellyfin's spelling would return one user's list
                // for every user asked about.
                nextUpPath: userId => `/Shows/NextUp?UserId=${encodeURIComponent(userId)}`,
                loggedItemIsKnown: isKnownLibraryItem,
                // The older per-user resume route: `/UserItems/Resume` is the
                // documented modern one and was never captured here.
                resumePath: userId => `/Users/${encodeURIComponent(userId)}/Items/Resume?Limit=500`,

                // Same header Emby accepts (probes P1), different remedy text: a
                // 401 that sends an Emby user to a Jellyfin dashboard tells them
                // nothing, so this names where an Emby key is actually made.
                auth: key => ({
                    ...embyToken(key),
                    remedy: 'The API key is wrong. Create one under Emby Dashboard → Advanced → Security.'
                }),
                // Everything the header lists as not implemented. Capability in
                // this codebase is a method's existence, so inheriting the base
                // would claim all of it; naming each one here is what keeps
                // "no fixture, no capability" true for an adapter that reuses
                // the code rather than writing its own.
                unclaimedReads: [
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
                ]
            }
        );
    }

    /**
     * The activity log, and nothing else.
     *
     * The base reads marked-played items first and merges the log into them.
     * Neither half of that works here: Emby has no `/UserPlayedItems`, and a
     * played filter answers with the whole library while reporting every row
     * `Played: false` (probes P4), which merged into the log would claim that
     * nothing anyone has watched was watched. So this asks only its own log route
     * and maps those rows through the base's rules about partial plays and removed
     * items, rather than restating them where they could drift.
     */
    override async getWatchHistory(user: ServiceUser): Promise<PlaybackEntry[]> {
        return this.loggedPlays(user, await this.activityLogStops(user));
    }
}
