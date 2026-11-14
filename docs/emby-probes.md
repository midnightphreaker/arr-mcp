# Emby live probes

The record behind the [Emby adapter](configuration.md#emby): every claim about
what this server does or does not answer, and the request that decided it. Each
is also commented where the adapter handles it, and those comments point back
here, so this is where a claim can be checked rather than trusted.

Run 2026-11-14 against a live Emby Server **4.10.2.0** (`SystemUpdateLevel:
Release`, `OperatingSystem: Linux`) behind an HTTPS reverse proxy, the way most
installations are reached, with an API key created under Dashboard → Advanced →
Security. Library under test: 288 films
and series, one user.

Method: single requests with `curl` and `urllib`, both over HTTPS, then
field-name inspection of the bodies. The key is referred to only as `$K` and the
user id only as `$EU`. No host name, address, path or account name from that
install appears here. No library title is reproduced either: where a search check
is described, it says how many rows came back, never what was looked for.

## P1: which credential form works

| Variant | Result |
|---|---|
| `Authorization: MediaBrowser Token="$K"` | **200** |
| `X-Emby-Token: $K` | 200 |
| `?api_key=$K` | 200 |
| no credential (control) | 401, body `Access token is invalid or expired.` |

All three accepted forms work, so the adapter keeps the one it already sends for
Jellyfin and `src/core/auth.ts` is not touched. The control matters more than it
looks: that 401 body is `text/plain`, not JSON, which is why a refused key is
reported as an auth failure from the status rather than parsed out of a body
shape this server does not use.

## P2: base path

`/System/Info` and `/emby/System/Info` both answer 200, and `/emby/Users` and
`/emby/Sessions` behave like their unprefixed forms. A server answers at its root
and under `/emby`, so no prefix is required and none is assumed: the operator puts
the reachable base in `url`, exactly as for [Jellyfin behind a URL
base](configuration.md#services-behind-a-url-base). There is no path handling in
the adapter.

## P3: what answers, and its shape

| Route | Result | Shape note |
|---|---|---|
| `/System/Info` | 200 | `Version`, `Id`, `ServerName`, `HttpServerPortNumber`, … Same field names the Jellyfin adapter reads. |
| `/System/Info/Public` | 200 | **No `ProductName` field at all.** Keys: `Id`, `LocalAddresses`, `RemoteAddresses`, `ServerName`, `Version`. |
| `/Users` | 200 | Array of `Id` (32-hex), `Name`, `HasPassword`, `ServerId`, `Configuration`, `Policy`. Matches what the user list needs. |
| `/Items?userId=$EU&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,Genres&EnableUserData=true&EnableImages=false&Limit=20` | 200, 20 rows of 288 | `Items[]` with `Id`, `Name`, `Type`, `ProviderIds` (`Tmdb`, `Imdb`, `Tvdb`), `Genres`, `RunTimeTicks`, `UserData{Played,PlaybackPositionTicks,UnplayedItemCount}`. `TotalRecordCount` present; paging parameters honoured. |
| `/Sessions` | 200, 8 sessions | `NowPlayingItem`, `PlayState{PositionTicks…}`, `UserName`, `DeviceName`. Matches the playback read. |
| `/Shows/NextUp?UserId=$EU` | 200, empty | Route exists and is shaped `{Items,TotalRecordCount}`. Empty is a real answer for a library with no in-progress TV; it is not proof of behaviour with data. |
| `/Users/$EU/Items/Resume` | 200, empty | Same caveat. |
| `/System/ActivityLog/Entries?type=VideoPlaybackStopped&hasUserId=true&limit=50` | 200, 50 entries | Wrapped in `{Items,TotalRecordCount}`. Entry keys: `Date`, `Id`, `ItemId`, `Name`, `Severity`, `Type`, `UserId`. All 50 had a non-null `ItemId`. **The event names are dotted**: `playback.start`, `playback.stop`. Jellyfin's `VideoPlaybackStopped` is not one of this server's values; the parameter was accepted, the vocabulary differs. |
| `/Items?searchTerm=…&Recursive=true&IncludeItemTypes=Movie,Series&Limit=5&Fields=ProviderIds` | 200, correct results | Checked against known library contents (three queries returned 2, 1 and 1 rows), stable over 6 repeats. Case-insensitive, and prefix matching: a partial word found the whole title it begins. `term=` is **ignored** and silently returns the unfiltered set of 288, so a misspelled parameter fails as an answer. |
| `/ScheduledTasks` | 200, 42 tasks | `Key`, `Name`, `State`, `Category`, `Triggers`. **`Key: "RefreshLibrary"` exists**, named "Scan media library". That key is the stable identifier; matching on name would have matched four other tasks carrying Scan or Refresh. It was Running during the probe, and it was never run by the probe, so its POST form is unproven. |

## P4: watch state, which decides what history can claim

| Read | Result |
|---|---|
| `/Users/{id}/PlayedItems` (Jellyfin's watched-list route) | **404.** Not present on Emby 4.10. |
| `/Items?userId=…&Filters=Played` vs `Filters=Unplayed` | Both return the same total as unfiltered (157), and every row reports `UserData.Played: false`. **The filter is accepted and ignored**, so it cannot read watch state. |
| Per-item `UserData` across all 288 library items | `Played: true` on exactly 1 item; `PlayCount`, `LastPlayedDate` and `PlaybackPositionTicks` empty or zero everywhere. |
| `/System/ActivityLog/Entries?type=playback.stop` | Works (131 rows on the later check, 24 distinct items on the first). **Resolving those ids gives `Type: "Episode"` rows**, each carrying `SeriesName`, `ParentIndexNumber` and `IndexNumber`: a stop names the file watched, not the show it belongs to. The log is the only reliable history source here. |
| `/Shows/NextUp`, `/Users/{id}/Items/Resume` | 200 and correctly shaped, empty. Empty is plausible for this library (1 of 288 marked played), so it is not evidence either read works with data. That is why both carry an `**Unverified live**` marker in [Tools](tools.md). |

The consequence the adapter is built on: a media server needs the playback,
next-up and history reads together (`src/services/types.ts`, the capability
guards), and on Emby only the activity log gives history. So history here asks
the log with this server's own event names, and `UserData.Played` is not trusted
the way Jellyfin's is. A filter that answers 200 with the unfiltered set is worse
than a 400: it reads as "nobody has watched anything".

## Six things its API does not say out loud

1. **`/System/Info/Public` carries no product name.** Jellyfin's discovery
   predicate keys on `ProductName === 'Jellyfin Server'`, a string this server
   never sends, so copying it would find nothing. Emby is therefore not
   discoverable by response content and is listed as undiscoverable by reason
   (`src/discovery/catalog.ts`) rather than guessed from `ServerName`.
2. **Item ids are numeric strings** (`"24952"`), while user and server ids *are*
   32-hex GUIDs. The inherited id guard rejects anything that is not 32 hex
   characters, so it would refuse every real Emby id; the pattern is passed to
   the shared adapter instead of inherited (`src/services/jellyfin.ts`).
3. **A bad `userId` is a 500** with body `Unrecognized Guid format.` Not a 400,
   and not shaped like the rest of this API's errors. A hand-typed
   `default_user` mismatch would surface as an upstream failure, so users are
   always resolved first and no unvalidated id is sent.
4. **Unknown parameters are ignored, not rejected.** Both the search term and the
   played filter above prove it. Any parameter this adapter sends on Emby's
   behalf has to be one a real Emby answered, because a wrong name returns an
   answer rather than an error.
5. **The activity log names users by their internal account row.** Every one of
   the 131 logged stops carries `UserId: "1"`, while `/Users` reports that same
   account as a 32-hex GUID, and the log ignores a `userId=` set to that GUID
   (it answers the full set either way). So the two id spaces do not meet even
   inside one server. Comparing them directly was every Emby history answer being
   empty on a server with real play data; see item 5 of the "On Emby" section in
   [Tools](tools.md) for what the adapter does instead.
6. **A played stop names the episode, not the show.** The ids in that log resolve
   to `Type: "Episode"` rows carrying their series coordinates. Any history filter
   written against "what a library contains" (films and series) silently discards
   every real play, because nothing in an item list is ever asked to be an episode.
   Both this and the item above were found only by running the tool against a live
   server: each fixture held the value that made the wrong code look right.

## Accuracy note

Two earlier probe runs recorded the search check returning zero rows. Those
requests were built with a shell variable that bash refuses to assign (`UID` is
readonly), so they carried a literal `1000` as the user id; the 500 and empty
bodies were the harness, not Emby. Re-run properly, search returns correct results
every time. Recorded here because an earlier draft of this record said search was
intermittent, which was wrong.

## What is still unknown

One instance, one version. Search and one-item details were captured as working
routes but are not implemented (a later scope decision), no library scan has ever
been run through this server, and there is no write path: `/UserPlayedItems` is
404 and nothing else was proven to set the flag. Emby publishes its OpenAPI
document from the running server rather than at a fixed URL this repository could
fetch nightly, so `test/contract.test.ts` has no `spec` entry for it; these
fixtures are the contract, which means they catch arr-mcp breaking its own
adapter and only a recapture catches Emby changing. A tester on another version,
or with a library where Next Up and the resumable list are not empty, is what
would move those.
