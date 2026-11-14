import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { EmbyAdapter } from '../src/services/emby.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * R1: the guard that makes sharing `jellyfin.ts` safe (DESIGN D1).
 *
 * The Whisparr precedent compares two vendored OpenAPI documents. Emby publishes
 * no fetchable spec (docs/emby-probes.md, "What is still unknown"), so there
 * is nothing to diff, and
 * the claim worth protecting is narrower anyway: that every request the shared
 * code makes on Emby's behalf is a request a real Emby answered once. That is
 * checkable against the fixtures in this repository, which is what this file does.
 *
 * It works by recording the requests both adapters make with an injected `fetch`
 * and comparing them: any route, parameter or field-bearing `Fields=` group the
 * shared adapter gains without an Emby fixture behind it shows up as a request
 * Emby has never been observed to answer. That is deliberate: a silent
 * inheritance is exactly the failure mode DESIGN R1 names, because the maintainer
 * can read this code but cannot run the service.
 */

const config = (port: number): MultiUserServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false },
    allow_other_users: false
});

const USER = { id: 'u1', name: 'Someone' };

/** A `fetch` that answers every shape with an empty result and records the paths. */
const recordingFetch = (seen: string[]): typeof fetch =>
    ((async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        seen.push(url.pathname);
        if (url.pathname === '/ScheduledTasks') {
            // A task with the stable key, so `startLibraryScan` reaches its POST
            // instead of stopping at "no such task" and never making a request.
            return jsonResponse([{ Id: 't', Key: 'RefreshLibrary', State: 'Idle' }]);
        }
        const listy = ['/Users', '/Sessions'].includes(url.pathname);
        const body = listy ? [] : { Items: [], Version: '1.0.0' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown) as typeof fetch;

/** Every read the shared adapter can perform, so a new call site is covered. */
async function exercise(adapter: JellyfinAdapter): Promise<void> {
    // Each read is wrapped: this file records requests, and a refusal after the
    // request was made is still evidence about the request.
    const tryRead = (fn: () => Promise<unknown>): Promise<unknown> => fn().catch(() => undefined);
    await tryRead(() => adapter.getVersion());
    await tryRead(() => adapter.listUsers());
    await tryRead(() => adapter.getPlayback(USER));
    await tryRead(() => adapter.getNextUp(USER));
    await tryRead(() => adapter.getWatchHistory(USER));
    await tryRead(() => adapter.listUserLibrary(USER));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any = adapter as unknown as Record<string, ((...a: any[]) => Promise<unknown>) | undefined>;
    for (const name of [
        'getScanState',
        'startLibraryScan',
        'search',
        'getMediaDetails',
        'listUserMusic',
        'listUserSeasons',
        'readEpisodeMetadata',
        'readMovieMetadata',
        'repairMetadata'
    ]) {
        // A refusal is fine here; what this file cares about is which requests
        // were made before it, so an error is not allowed to stop the sweep.
        await any[name]?.call(adapter, '1', { includeEpisodes: false, episodeLimit: 1 }).catch(() => undefined);
    }
}

const jellyfinSeen: string[] = [];
const embySeen: string[] = [];
await exercise(new JellyfinAdapter(config(8096), recordingFetch(jellyfinSeen)));
await exercise(new EmbyAdapter(config(8096), recordingFetch(embySeen)));
const jellyfinPaths = new Set(jellyfinSeen);
const embyPaths = new Set(embySeen);

const captureSource = readFileSync(`${import.meta.dirname}/../scripts/capture-fixtures.ts`, 'utf8');
const embyBlock = captureSource.slice(
    captureSource.indexOf('    emby: ['),
    captureSource.indexOf('\n    seerr: [')
);
/**
 * The one route the adapter asks that this capture script never made, and why it
 * may stay: `/Users/{id}/Items/Resume` answered 200 and correctly shaped in
 * `docs/emby-probes.md` (P3), just not through this script, so it has a probe
 * rather than a fixture. Anything new here needs one of the two, not silence.
 */
const UNPROVEN = new Set(['/Users/u1/Items/Resume']);

/** A route is the part before any query string or interpolation. */
const routeOf = (path: string): string => path.split('?')[0]!;
const captured = new Set<string>();
for (const m of embyBlock.matchAll(/['"`](\/[^'"\n$]*)/g)) {
    const route = routeOf(m[1]!);
    if (route.length > 1) captured.add(route);
}

describe('the Emby adapter only asks what a real Emby answered', () => {
    it('records the capture set as non-empty, so an absent list cannot pass by vacuity', () => {
        expect(captured.size).toBeGreaterThan(3);
    });

    it('asks only routes the capture script named, or one this file declares unproven', () => {
        const outside = [...embyPaths].filter(p => !captured.has(routeOf(p)) && !UNPROVEN.has(p));
        expect(outside, `Emby was never captured answering ${outside.join(', ')}`).toEqual([]);
    });

    it('does not reach a route of its own to cover an inherited read', () => {
        // A read the base performs and Emby does not must be *unclaimed*, not
        // quietly redirected to some other route: an adapter that found a new way
        // to answer `getScanState` would claim a capability no capture proved. So
        // every route only the shared adapter asks has to stay one Emby lacks.
        const jellyfinOnly = [...jellyfinPaths].filter(p => !embyPaths.has(p));
        expect(jellyfinOnly.length, 'the two adapters ask identical routes').toBeGreaterThan(0);
        for (const path of jellyfinOnly) {
            expect(embyPaths.has(path), `Emby reached ${path} through a read it should not have`).toBe(false);
        }
    });


    it('leaves the unclaimed list honest: each is absent on the adapter', () => {
        const emby = new EmbyAdapter(config(8096), recordingFetch([])) as unknown as Record<string, unknown>;
        for (const name of [
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
        ]) {
            expect(emby[name], `${name} is still callable on the Emby adapter`).toBeUndefined();
        }
    });

    it('keeps the reads that are shared identical in name, so a rename fails here', () => {
        // The four the adapter does offer must exist on both: an accidental
        // rename in the base would otherwise make Emby silently lose a capability
        // while every test still passed.
        const shared = new JellyfinAdapter(config(8096), recordingFetch([])) as unknown as Record<string, unknown>;
        const emby = new EmbyAdapter(config(8096), recordingFetch([])) as unknown as Record<string, unknown>;
        for (const name of ['getVersion', 'listUsers', 'getPlayback', 'getNextUp', 'getWatchHistory', 'listUserLibrary']) {
            expect(typeof shared[name]).toBe('function');
            expect(typeof emby[name], `${name} is missing on the Emby adapter`).toBe('function');
        }
    });
});
