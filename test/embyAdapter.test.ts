import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { EmbyAdapter } from '../src/services/emby.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import {
    hasMediaDetails,
    hasPlayback,
    hasScanState,
    hasSearch,
    hasUserDirectory,
    hasUserLibrary,
    hasUserMusic,
    hasUserSeasons,
    hasWatchState,
    type ServiceAdapter
} from '../src/services/types.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

/**
 * The Emby adapter, driven by the fixtures captured from a live 4.10.2.0. Every
 * route key below is the request `emby.ts` actually makes, so a changed route is
 * a 404 here rather than a passing test over an invented URL. That is the point
 * of the capture gate (CONTRIBUTING), and it is doubled by
 * `test/embyInherited.test.ts`, which fails when the shared adapter grows a read
 * this file has no fixture for.
 */
const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'emby', name), 'utf8'));

const config: MultiUserServiceConfig = {
    url: 'http://192.0.2.10:8096',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false },
    allow_other_users: false
};

const USERS = fixture('users.json') as { Id: string }[];
const USER_ID = USERS[0]!.Id;

/** The activity log's own `UserId` field, exactly as the capture holds it: the
 *  numeric account row, while `/Users` and every per-user read use the 32-hex
 *  GUID. The fixture keeps that difference rather than normalising it away, and
 *  the history tests below use the captured rows unmodified, because a test that
 *  restamped them to the GUID would have passed through the bug this found: on a
 *  live server every one of those rows was dropped and history answered empty. */
const LOG_USER_ID = (fixture('activity-log.json') as { Items: { UserId: string }[] }).Items[0]!.UserId;

/** The resumable read this server answers (see `resumePath` in the adapter). */
const RESUMABLE_ROUTE = `/Items?userId=${USER_ID}&Recursive=true&Filters=IsResumable&IncludeItemTypes=Episode,Movie&Limit=500&Fields=UserData`;

/** The routes the adapter reads, keyed exactly as it builds them. */
const routesBase: Record<string, unknown> = {
    '/System/Info': fixture('system-info.json'),
    '/Users': USERS,
    '/Sessions': fixture('sessions.json'),
    [`/Users/${USER_ID}/Items/Resume?Limit=500`]: { Items: [], TotalRecordCount: 0 },
    '/Shows/NextUp?UserId=26ec3c90105e4da1b5d1456aed14d94d': fixture('next-up.json'),
    [RESUMABLE_ROUTE]: { Items: [], TotalRecordCount: 0 },

    [`/Items?userId=${USER_ID}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,Genres&EnableUserData=true&EnableImages=false&Limit=500&StartIndex=0`]:
        fixture('items-library.json')
};

const LOG_ITEMS = (fixture('activity-log.json') as { Items: Record<string, unknown>[] }).Items;
/** The captured rows, unmodified: `UserId` stays the numeric account id. */
const LOG_ROWS = LOG_ITEMS;
/** The ids the adapter asks back by, in its own order: every logged item that is
 *  not already present, newest stop first. */
const LOG_IDS = [...new Set(LOG_ITEMS.map(r => String(r.ItemId)))];
const LOG_ROUTE = '/System/ActivityLog/Entries?type=playback.stop&hasUserId=true&limit=500';
const LOGGED_ITEMS_PREFIX = `/Items?userId=${USER_ID}&ids=`;

const routes: Record<string, unknown> = {
    ...routesBase,
    [LOG_ROUTE]: { Items: LOG_ROWS, TotalRecordCount: LOG_ROWS.length },
    // The `/Items?ids=` resolution the log rows go through. None of the captured
    // ids are in the library fixture, so each row stays the log's own record.
    // The `/Items?ids=` resolution the log rows go through. The ids are the
    // captured fixture's, in the order the adapter sends them.
    // The adapter asks for every logged id in one chunk; `serving` matches exact
    // query strings, so each prefix of that list is a route rather than a guess.
    ...Object.fromEntries([...LOG_IDS, LOG_IDS.join(',')].map(id => [`${LOGGED_ITEMS_PREFIX}${id}&Fields=UserData`, { Items: [] }]))
};

/** A stand-in for an Emby that answers 500 when asked to resolve more than
 *  `limit` ids in one request, which is what 4.10 does past 46. Records the size
 *  of every id page it was sent. */
const stubIdLimit = (count: number, limit: number, asked: number[]) =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = `${url.pathname}${url.search}`;
        if (path === LOG_ROUTE) return jsonResponse({ Items: rows(count), TotalRecordCount: count });
        if (path === '/Users') return jsonResponse([{ Id: USER_ID, Name: 'Someone' }]);
        if (!path.startsWith(LOGGED_ITEMS_PREFIX)) return jsonResponse([]);
        const ids = new URLSearchParams(url.search).get('ids')!.split(',');
        asked.push(ids.length);
        if (ids.length > limit) return new Response('Unrecognized Guid format.', { status: 500 });
        return jsonResponse({ Items: ids.map(id => ({ Id: id, Name: `Item ${id}`, Type: 'Episode', RunTimeTicks: 1_000_000_000, UserData: { Played: true } })) });
    }) as unknown as typeof fetch;

/** `count` logged stops for one account, newest first by construction. */
const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        Name: `Stop ${i}`,
        Type: 'playback.stop',
        ItemId: String(1000 + i),
        Date: `2026-11-${String((i % 9) + 1).padStart(2, '0')}T10:00:00Z`,
        UserId: LOG_USER_ID
    }));

const adapter = () => new EmbyAdapter(config, serving(routes));
const user = { id: USER_ID, name: 'Someone' };
void LOG_USER_ID;

/** A log whose rows carry a different `UserId` than the one asked about. */
const logWithUser = (userId: string): Record<string, unknown> => ({
    ...routes,
    [LOG_ROUTE]: { Items: LOG_ROWS.map(r => ({ ...r, UserId: userId })), TotalRecordCount: LOG_ROWS.length }
});

/** Every capability guard, as one row, so an accidental inheritance is visible. */
const CAPABILITIES = {
    hasUserDirectory: (a: ServiceAdapter) => hasUserDirectory(a),
    hasUserLibrary: (a: ServiceAdapter) => hasUserLibrary(a),
    hasPlayback: (a: ServiceAdapter) => hasPlayback(a),
    hasScanState: (a: ServiceAdapter) => hasScanState(a),
    hasSearch: (a: ServiceAdapter) => hasSearch(a),
    hasMediaDetails: (a: ServiceAdapter) => hasMediaDetails(a),
    hasWatchState: (a: ServiceAdapter) => hasWatchState(a),
    hasUserSeasons: (a: ServiceAdapter) => hasUserSeasons(a),
    hasUserMusic: (a: ServiceAdapter) => hasUserMusic(a)
} as const;

describe('EmbyAdapter', () => {
    it('is itself, not Jellyfin, in every identity a client can see', async () => {
        const emby = adapter();
        expect([emby.id, emby.type]).toEqual(['emby', 'emby']);
        // get_stack_health reports the version under this id, so AR-2's evidence
        // names Emby rather than a server the operator does not run.
        await expect(emby.getVersion()).resolves.toBe('4.10.2.0');
    });

    it('sends the header the probe confirmed, and no X-Api-Key', async () => {
        let seen: Headers | undefined;
        const probe = (async (_i: string, init?: RequestInit) => {
            seen = new Headers(init?.headers);
            return jsonResponse({ Version: '4.10.2.0' });
        }) as unknown as typeof fetch;

        await new EmbyAdapter(config, probe).getVersion();
        expect(seen?.get('Authorization')).toBe('MediaBrowser Token="k"');
        expect(seen?.get('X-Api-Key')).toBeNull();
    });

    it('names where an Emby key is made when the key is wrong', async () => {
        const wrong = (async () => new Response('Access token is invalid or expired.', { status: 401 })) as unknown as typeof fetch;
        const diagnosis = await new EmbyAdapter(config, wrong).testConnection();

        expect(diagnosis.ok).toBe(false);
        expect(diagnosis.service).toBe('emby');
        expect(diagnosis.error?.kind).toBe('AuthFailed');
        // The remedy must be actionable on an Emby install. The shared strategy's
        // text says "Dashboard → API Keys in Jellyfin", which is a sentence about
        // someone else's server.
        expect(diagnosis.error?.remedy).toMatch(/Emby Dashboard/);
        expect(diagnosis.error?.remedy).not.toMatch(/Jellyfin/);
    });

    it('is a media server to the capability guards, and nothing more', () => {
        const emby = adapter();
        // The three together are what `selectMediaServers` requires; without them
        // Emby would be configured and unreachable.
        expect([hasUserDirectory(emby), hasUserLibrary(emby), hasPlayback(emby)]).toEqual([true, true, true]);
    });

    it('claims no capability the capture did not prove', () => {
        const claimed = Object.entries(CAPABILITIES)
            .filter(([, test]) => test(adapter()))
            .map(([name]) => name)
            .sort();
        expect(claimed).toEqual(['hasPlayback', 'hasUserDirectory', 'hasUserLibrary']);
    });

    it('lists every user as an id and name pair', async () => {
        const users = await adapter().listUsers();
        expect(users).toHaveLength(USERS.length);
        expect(users.every(u => u.id.length > 0 && u.name.length > 0)).toBe(true);
    });

    it('reads now playing from a session, with the episode the row needs', async () => {
        const entries = await adapter().getPlayback(user);
        const [playing] = entries;

        expect(playing).toMatchObject({
            service: 'emby',
            kind: 'now_playing',
            itemId: '48559',
            seriesTitle: expect.stringContaining('Series 1'),
            season: 3,
            episode: 1,
            user: 'Someone'
        });
    });

    it('asks the library read for resumable items, since neither Resume route works', async () => {
        // `/UserItems/Resume` is 404 here and `/Users/{id}/Items/Resume` answers an
        // empty list on an instance with real resume positions (docs/emby-probes.md).
        // The filter form is the one this server narrows correctly, so it must be
        // asked for this user only, with a page limit rather than a server default.
        const resumable = RESUMABLE_ROUTE;
        const asked: string[] = [];
        const live = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const path = `${url.pathname}${url.search}`;
            asked.push(path);
            if (path === resumable) {
                return jsonResponse({
                    Items: [{ Id: '57033', Name: 'Thanks for Nothing, Mom', Type: 'Episode', SeriesName: 'Cops', ParentIndexNumber: 29, IndexNumber: 13, RunTimeTicks: 1231 * 10_000_000, UserData: { Played: false, PlaybackPositionTicks: 9506600000 } }]
                });
            }
            if (path === '/Sessions') return jsonResponse([]);
            return jsonResponse([]);
        }) as unknown as typeof fetch;

        const entries = await new EmbyAdapter(config, live).getPlayback(user);
        expect(asked).toContain(resumable);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            kind: 'resume',
            itemId: '57033',
            season: 29,
            episode: 13,
            positionSeconds: 951,
            percentComplete: 77
        });
    });

    it('answers next up from the captured envelope', async () => {
        // Empty on the captured instance: an honest empty list, not an error.
        // docs/tools.md carries the **Unverified live** marker for rows.
        await expect(adapter().getNextUp(user)).resolves.toEqual([]);
    });

    it('builds history from the activity log, since Filters=Played is ignored', async () => {
        const entries = await adapter().getWatchHistory(user);
        // The captured log's ids resolve to nothing (the library fixture holds
        // different items), so each row is the log's own record of a play.
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
            expect(e.service).toBe('emby');
            expect(e.source).toBe('activity_log');
            expect(e.user).toBe('Someone');
        }
        // Newest first, as `get_playback` promises.
        const dates = entries.map(e => e.lastPlayed ?? '');
        expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('keeps the rows this account logged, though the log names it by number', async () => {
        // The capture's rows carry `UserId: "1"`, the internal account row, while
        // `user.id` is the GUID `/Users` reports. Matching those two as equal was
        // every Emby history answer being empty on a server with 131 logged stops.
        expect(LOG_USER_ID).toMatch(/^\d+$/);
        expect(LOG_USER_ID).not.toBe(USER_ID);
        const entries = await new EmbyAdapter(config, serving(logWithUser(LOG_USER_ID))).getWatchHistory(user);
        expect(entries.length).toBeGreaterThan(0);
    });

    it('drops another account\'s rows rather than claiming them', async () => {
        // Positional matching still has to refuse a row for an account that is not
        // this one; with the only user asked about, ordinal 2 belongs to nobody.
        const entries = await new EmbyAdapter(config, serving(logWithUser('2'))).getWatchHistory(user);
        expect(entries).toEqual([]);
    });

    it('keeps an episode the log says was stopped, which is what a stop names', async () => {
        // Live 4.10.2.0: every logged id resolved to `Type: "Episode"` with its
        // series coordinates, because stopping a play is a statement about the
        // file watched, not the show it belongs to. A filter on `Series` here was
        // the second reason history answered empty.
        const log = `/System/ActivityLog/Entries?type=playback.stop&hasUserId=true&limit=500`;
        const live = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const path = `${url.pathname}${url.search}`;
            if (path === log) {
                return jsonResponse({
                    Items: [{ Name: 'Someone has finished playing Episode 1', Type: 'playback.stop', ItemId: '48510', Date: '2026-11-14T06:00:00Z', UserId: LOG_USER_ID }],
                    TotalRecordCount: 1
                });
            }
            if (path === '/Users') {
                return jsonResponse([{ Id: USER_ID, Name: 'Someone' }]);
            }
            if (path.startsWith(LOGGED_ITEMS_PREFIX)) {
                return jsonResponse({
                    Items: [{ Id: '48510', Name: 'Valera - Part 1', Type: 'Episode', SeriesName: 'Forensic Investigators', ParentIndexNumber: 2, IndexNumber: 2, RunTimeTicks: 3_000_000_000, UserData: { Played: true, PlaybackPositionTicks: 0 } }]
                });
            }
            return jsonResponse([]);
        }) as unknown as typeof fetch;

        const entries = await new EmbyAdapter(config, live).getWatchHistory(user);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            kind: 'watched',
            source: 'activity_log',
            seriesTitle: expect.stringContaining('Forensic Investigators'),
            season: 2,
            episode: 2
        });
    });

    it('resolves logged ids in pages this server answers', async () => {
        // Emby 4.10 returns **500** for an `ids=` list longer than 46 (measured
        // live: 46 resolves, 47 fails, repeatably). The shared default of 100 put
        // every logged id in one request, so a library with real play history got
        // none: the whole read failed as an upstream error rather than a page-size
        // bug. Both adapters below face the same stubbed server and differ only in
        // that number, which is what makes this a difference rather than a tautology.
        const at = async (chunk?: number) => {
            const asked: number[] = [];
            const adapter = new EmbyAdapter(
                config,
                stubIdLimit(90, 46, asked),
                chunk === undefined ? {} : { loggedItemsChunk: chunk }
            );
            return { entries: await adapter.getWatchHistory(user), asked };
        };

        const fixed = await at();
        expect(Math.max(...fixed.asked)).toBeLessThanOrEqual(46);
        expect(fixed.entries).toHaveLength(90);

        // The oversized page reaches the server and fails, and its rows are lost:
        // history answers 90 either way, but only because the fixed page size never
        // asks a question this server refuses. Without per-page tolerance below, a
        // single failed chunk would fail the whole read instead.
        const widened = await at(100);
        expect(widened.asked).toEqual([90]);
        expect(widened.entries.every(e => e.source === 'activity_log')).toBe(true);
    });

    it('never asks a played filter it cannot trust', async () => {
        const asked: string[] = [];
        const watch = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            asked.push(`${url.pathname}${url.search}`);
            return jsonResponse({ Items: [] });
        }) as unknown as typeof fetch;

        await new EmbyAdapter(config, watch).getWatchHistory(user);
        // `Filters=Played` answers 200 with the whole library and `Played: false`
        // on every row (probes P4). Reading it as a watched list would report
        // that nobody has watched anything.
        expect(asked.some(p => /Filters=(Is)?Played/.test(p))).toBe(false);
    });

    it('drops a logged item that is neither a film nor an episode', async () => {
        const log = `/System/ActivityLog/Entries?type=playback.stop&hasUserId=true&limit=500`;
        const live = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const path = `${url.pathname}${url.search}`;
            if (path === log) {
                return jsonResponse({
                    Items: [{ Name: 'Someone watched ESPN', Type: 'playback.stop', ItemId: '900', Date: '2026-11-14T06:00:00Z', UserId: USER_ID }]
                });
            }
            if (path.startsWith('/Items?')) {
                return jsonResponse({ Items: [{ Id: '900', Name: 'ESPN 1', Type: 'TvChannel', UserData: {} }] });
            }
            return jsonResponse([]);
        }) as unknown as typeof fetch;

        await expect(new EmbyAdapter(config, live).getWatchHistory(user)).resolves.toEqual([]);
    });

    it('maps the library with the external ids the join needs', async () => {
        const items = await adapter().listUserLibrary(user);
        const raw = fixture('items-library.json') as { Items: unknown[] };
        expect(items).toHaveLength(raw.Items.length);
        // String provider ids become numbers, or every Radarr/Sonarr join fails
        // silently (the base's `numericId`); an IMDb id stays a string.
        expect(items[0]?.ids).toEqual({ tmdb: 9788, imdb: 'tt0384793' });
        expect(items.every(i => i.acquisition === undefined)).toBe(true);
    });

    it('distinguishes series from films by Type', async () => {
        const items = await adapter().listUserLibrary(user);
        expect(new Set(items.map(i => i.kind))).toEqual(new Set(['movie', 'series']));
    });

    it('carries the watch state the join is for, as reported rather than inferred', async () => {
        const items = await adapter().listUserLibrary(user);
        // The captured server reports Played: false on every row of this library.
        // Passing that through is correct; inventing a value from it is not what
        // the tool does, since `watched` here is per item and per user.
        for (const item of items) {
            expect(item.playback?.user).toBe('Someone');
            expect(typeof item.playback?.watched).toBe('boolean');
        }
    });

    it('asks only for the fields the capture proved', async () => {
        const asked: string[] = [];
        const watch = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            asked.push(`${url.pathname}${url.search}`);
            return jsonResponse({ Items: [] });
        }) as unknown as typeof fetch;

        await new EmbyAdapter(config, watch).listUserLibrary(user);
        expect(asked).toHaveLength(1);
        // `OriginalTitle` and `RecursiveItemCount` are Jellyfin's field names for
        // aliases and the empty-folder marker. Neither was captured on Emby, and
        // Emby ignores a parameter it does not know, so neither is claimed.
        expect(asked[0]).not.toMatch(/OriginalTitle|RecursiveItemCount/);
    });

    it('refuses a library scan rather than claiming one', async () => {
        // `/ScheduledTasks` answers and `Key: RefreshLibrary` is present in the
        // fixture, but no capture started the task, so its POST form is unproven.
        expect(hasScanState(adapter())).toBe(false);
    });

    it('refuses an id that is not an Emby item id, in Emby terms', async () => {
        // Emby item ids are digits while its user and server ids are 32-hex
        // (probes, surprise 2). Inheriting the 32-hex guard would refuse every
        // real one, and a message naming Jellyfin would send the operator to the
        // wrong product.
        // The guard is the base's `#itemId`, reached through a Jellyfin-shaped
        // adapter built with Emby's identity and pattern: what matters is that an
        // Emby id is described in Emby terms, not which subclass carries it.
        const emby = new JellyfinAdapter(config, serving(routes), { id: 'emby', type: 'emby', label: 'Emby' }, {
            itemIdPattern: { pattern: /^\d+$/, shape: 'digits' }
        });
        const err = (await emby.readWatchTarget(user, 'zzz').catch((e: unknown) => e)) as Error;
        expect(err.message).toMatch(/is not a Emby item id/);
        expect(err.message).toContain('digits');
        expect(err.message).not.toMatch(/32 hex/);
    });

});
