# Changelog

## v2.4.0

### Added

- **Failover auto-match** - Automatically build failover groups by selecting sources and categories to match from. A minimum match percentage threshold can be configured. Access via the `Failover Group` button in the EPG and select `Smart Auto-Group`.
- **Channel stream probe** - Scan playlists (configurable per source or category) to populate metadata badges, identify dead or geo-blocked channels, quickly disable all dead channels, and view a breakdown of stream resolutions. To access, click the new Probe button in the EPG.
- **Sports enhancements:**
  - **Live sidebar widget** - When enabled, a live games sidebar with live games count appears when hovering over the Live Now button, showing a compact view of all currently live games with scores and a play button for each linked channel, allowing quick game switching without leaving the player.
  - **Team channel linking and auto-linking** - Link channels to teams for quick access during live games. Configure under `Sports → Live Now → Manage Team Channels`. Channels can be linked manually or automatically, with an option to auto-swap to a backup channel if the playing stream is dead.
  - **Search source configuration** - Configure which sources and categories are used when searching for match streams, either globally or per league for a more scoped match.
  - **Automatic stream search when games go live** - Stream searches now run in the background as games kick off, so that clicking `List Streams Here` returns results instantly and for the Search button in the Live Games sidebar.
  - **Linked channels in media bar** - When multiple channels are linked to a team, a team logo icon appears in the media bar. Clicking it shows all linked channels for quick switching.
- **Local Library for Movies and Series** - Add local folders to VOD Movies and Series via the new Local tab. Titles are automatically matched with TMDB metadata (requires a TMDB key), and integrate with Trakt/Simkl scrobbling and subtitle fetching.
- **Reworked search results** - Search results are now organized into three tabs: `Channels`, `Live Now EPG`, and `Upcoming EPG`. EPG matches display time remaining, start/end times, and a progress bar. Upcoming EPG entries show start and end times. Channel matches are now displayed in the same style as the Live TV view.
- **Automated backups** - Export files are now backed up automatically. Enabled by default, can be disabled under `Settings → Export / Import`. The backup interval, save location, and maximum number of backups to retain are configurable.
- **Per-source favorites** - Favorites can now be organized into each source, globally, or both. Configure under `Settings → Live TV → Favorites`.
- **VOD metadata editing** - Manually correct the TMDb ID for VOD titles where the source-provided ID is incorrect.
- **VOD drag-to-reorder** - VOD categories and sources can be reordered by holding `Ctrl` (configurable under `Settings → Shortcuts`).
- **Automatically Hide disabled source VOD playlist items** - Disabled sources in VOD playlists are now automatically hidden with a quick way to delete.
- **Separate download subfolders** - Movies and Series are now saved into separate `Movies` and `Series` subfolders within the download location. Enabled by default; can be turned off under `DVR → Settings`.
- **VOD Series - download all seasons** - A new button allows all seasons of a series to be downloaded at once. A new prompt also lets you choose between saving seasons into organized `Name/Season #` folders or a single series folder.
- **Nuvio Cloud support** - Cloud Library sync has been added for Nuvio.
- **Hungarian (Magyar) localisation** - Hungarian language support has been added.
- **New optimization options** - Two new options are available under the Optimization settings: `Reduce Visual Effects While Scrolling` and `Flat Chrome`, aimed at improving performance on lower-end hardware.
- **OLED black for dark and custom themes** - An OLED black option is now available for dark and custom themes under `Settings → Themes`. Enables true black surfaces and backgrounds while retaining the theme's accent colours.
- **Show/hide disabled sources** - Disabled sources can now be toggled visible or hidden in the Sources tab in Settings.
- **Startup loading screen** - A loading screen is now displayed during startup with an improved error boundary for catching and recovering from startup errors.
- **Scrollbar colour adaptation** - Scrollbars now automatically adjust their colour to match the active theme, including a fallback when the default colour is unreadable.
- **Clear EPG cache only** - A new option allows EPG data to be cleared independently, without wiping channels, VOD content, or settings.

### Fixed

- **Vulkan runtime bundled** - The Vulkan runtime is now bundled with the app to prevent `vulkan-1.dll` errors introduced by the updated MPV build.
- **Settings not persisting** - Resolved a bug where certain settings would revert after being changed.
- **Custom Group Manager missing scrollbar** - A scrollbar is now correctly displayed in the Custom Group Manager.
- **Global EPG falling back when URL is unavailable** - The app now falls back to the last cached EPG when the remote EPG source cannot be reached.
- **Window state not restoring after closing in fullscreen** - The window now restores to the correct state when reopened after being closed while in fullscreen.
- **Light Theme contrast and readability** - Additional contrast and readability fixes have been applied across the Light Theme.
- **Episode skipping when paused near end** - Pausing near the 90% mark no longer incorrectly triggers a skip to the next episode.
- **New VOD episodes not appearing after sync** - New episodes now appear correctly following a sync.
- **Playlist Editor crashing when Show Hidden is selected** - Fixed a crash that occurred when toggling `Show Hidden` in the Playlist Editor.
- **Custom shortcut keys not reapplying on restart** - Custom shortcut key bindings are now correctly restored after a restart.
- **Global EPG sort order** - Fixed an issue with Global EPG entries not sorting correctly.

## v2.3.3

### Added

- **Full localisation (i18n)** - Multi-language support has been added for Albanian, Arabic, Bosnian, Brazilian Portuguese, Croatian, Dutch, French, German, Greek, Hindi, Italian, Persian/Farsi, Polish, Russian, Serbian, Simplified Chinese, Spanish, Traditional Chinese, Turkish, Urdu, and Vietnamese. Translations were AI-generated and may contain errors - community corrections are welcome via pull request.
- **Channel filter in EPG** - A channel filter has been added to the EPG view, allowing quick search through channels within the current category.
- **VOD playlists and queue** - Create playlists and queue VOD content from the new Playlist tab.
- **Improved drag-and-drop ordering** - Drag-and-drop reordering has been improved across sources and categories. Hold `Ctrl` (configurable in Shortcuts) to drag and reorder sources and categories in the Live TV sidebar.
- **Alphabetical sorting for channels and categories** - Channels and categories can be sorted alphabetically in their respective manager.
- **Jump to Letter in EPG** - Hover over the A-Z button in the EPG for a full alphabetical display, select any letter to jump to that letter in the EPG. Works best when channels are sorted alphabetically.
- **Sports Favourites page updates** - The Favourites page now displays the next scheduled game and any currently live games for each favourite team.
- **Subtitle diagnostics tool** - A new diagnostics modal, accessible while a subtitle issue is occurring, captures the app's subtitle selection state alongside an MPV debug log to assist with investigating support issues.
- **Additional VOD sort options** - VOD content can now be sorted by Year, Rating, and Last Watched.
- **Mouse side button support** - Mouse Back and Forward buttons can now be bound to shortcuts.
- **Minimise to system tray on close** - An option to minimise the app to the system tray instead of closing has been added under `Settings → UI`.
- **EPG date headers** - Dates can now be displayed directly in the EPG grid for easier navigation of catch-up history. Enable under `Settings → Live TV → EPG`.
- **Sports enhancements** - Team pages now include Roster, Injuries, Depth Chart, and Leaders tabs. League API and logo caching have also been updated.
- **Save VOD watch progress on app close** - Watch progress for VOD content is now saved automatically when the app is closed.
- **Source-provided VOD trailers** - Trailers supplied directly by the source are now playable from VOD detail pages.
- **Collapse VOD categories on startup** - VOD source categories can be set to collapse automatically on launch. Enable under `Settings → UI → Collapse Source Categories on Startup`.
- **TMDb ID from Xtream Code sources** - TMDb IDs are now retrieved directly from XC sources for VOD content if provided, improving metadata matching accuracy.
- **Quickly Resume VOD Recent watched** - Click the play icon in the poster to resume playback on a Recently watched

### Fixed

- **High idle GPU usage from background animations** - The animated glass bulb background in the v3 UI was continuously re-blurring large layers every frame, even when idle. The bulbs now render statically with the same appearance, reducing idle GPU usage.
- **Channel info overlay not updating when the next program starts** - The channel info overlay will now refresh correctly when the current program ends and the next one begins.
- **Category not loading in EPG when adding a new playlist source** - Categories will now correctly load into the EPG from a newly added source.
- **Subtitle playback, encoding, and retry reliability** - Various fixes applied to subtitle loading, encoding handling, and retry behaviour.
- **Trakt token refresh and scrobble reliability** - Trakt token refreshing and scrobble submission have been made more reliable.
- **VOD episode not being marked complete when over 90% progress** - Episodes will now correctly be marked as complete and show the next episode in Recent tab.

## v2.3.2

### Please also read changelogs for v2.3.0-v2.3.1 if you haven't

### Added

- **Audio visualiser for live audio and radio** - A real-time audio spectrum visualiser is now displayed in the player controls and Now Playing bar for radio stations and audio-only streams.
- **Smart Trim Logos** - Automatically crops baked-in transparent padding from channel logos so they fill the tile edge-to-edge without clipping any content. Enable under `Settings → Live TV → Logos → Smart Trim Logos`. Corrected dimensions are cached per logo for instant rendering on subsequent loads.
- **Logo background detection toggle** - An option to opt out of automatic logo background detection has been added under `Settings → Live TV → Logos → Auto Background Detection`.
- **VOD and TV Series trailers** - A dedicated `Trailer` button is now available on Movie and TV Series detail pages. Requires TMDB to be enabled.
- **Logo configuration caching** - Parsed logo aspect ratios and trimmed bounding boxes are now cached, eliminating redundant layout metric calculations on category loads.
- **SubSource and OpenSubtitles IMDb/TMDb matching** - Subtitle searches now prioritise exact IMDb/TMDb ID lookups for the currently playing title across both SubSource and OpenSubtitles, falling back to text search only when an exact match is not found.
- **Provider TMDb ID syncing** - Xtream playlist sync now extracts and stores provider TMDb IDs in the database, improving accuracy for subtitle search, scrobbling, plot lookups, and movie extras.

### Fixed

- **Sports API 403 errors** - Resolved Forbidden errors affecting the Sports API.
- **Channel info overlay logo appearing cropped** - Fixed a bug causing some logos to appear cropped rather than fitted correctly within the channel info overlay.
- **Xtream VOD multi-category support** - Resolved an issue where VOD movies and series were only syncing to a single category, resulting in genre categories showing no content. Fallback handling has been added for streams with null or empty names.
- **Category Folders not included in Import/Export and cleared by cache wipe** - Category Folders are now included in backup import/export files. Clearing the cache will no longer remove custom Category Folders.
- **Per-source logo shape override not applying** - Setting a square or rectangle logo shape for an individual source now correctly overrides the global setting in both directions across channel rows and search results.
- **Slow category switching with large playlists** - Category loading has been reworked for a faster response when switching between categories in large playlists.

## v2.3.1

### Added v2.3.0

- **Category folders** - Group related categories into folders within an expanded source in the sidebar (e.g. countries, sports, 24/7 channels, etc). Reduces clutter and speeds up navigation. Right-click a source to create a folder and move categories into it. Folders can be pinned to stay visible while scrolling, just like pinned categories. Right-click a folder and select `Manage Folder` to edit it.
- **OpenSubtitles integration** - Search and download subtitles directly from within the player via OpenSubtitles. Sign in under `Settings → Subtitles`.
- **Simkl integration** - Scrobble Movies and Series to Simkl. Configure under `Settings → Simkl`.
- **Discord Rich Presence** - Broadcasts the currently playing live channel, movie, or series episode to your Discord status. Enable under `Settings → Discord`. TMDB must be enabled for movie posters to appear during VOD playback.
- **Play VOD Movies and Series in Popout or External Player** - Use the dropdown next to the Play button to select which player to use for VOD playback.
- **Channel logo cache** - Logo caching can be enabled under `Settings → Live TV → Logos`.
- **Channel logo display options and resizing** - Choose between square or wide rectangle logo shapes, adjust logo size, and toggle rounded edges under `Settings → Live TV → Logos`.
- **Automatic dark logo detection** - Channel logos are automatically analysed to apply a light tile background when a dark logo is detected against a dark theme. Can be manually overridden in the EPG Editor as it might not detect every logo precisely.
- **Logo Editor** - Quickly apply Light, Dark, or Automatic backgrounds and remove padding per category. Access by right-clicking a category in the sidebar and selecting `Logo Editor`.
- **M3U catch-up playback and downloads** - Catch-up streams can now be played directly from the EPG guide history, and catch-up recordings can be downloaded for supported M3U playlists. May require padding to be set to `0`.
- **DVR and custom recording titles** - Completed DVR recordings can be renamed directly in `DVR → Recordings`. Custom titles can also be set before recording.
- **Embedded subtitle scaling and override settings** - Embedded ASS/SSA and WebVTT subtitles now respect player font scaling. An `Override Embedded Styles` option has been added under `Settings → Subtitles` with the following modes: `Yes`, `Force All`, `Scale Only`, and `No`.
- **External subtitle loading** - Local subtitle files (`.srt`, `.vtt`, `.sub`, `.ass`, `.ssa`) can now be loaded from disk during playback.
- **24-hour time format** - Toggle between 12-hour and 24-hour time formatting across the EPG, sports schedules, TV calendar, and DVR timers under `Settings → Live TV`.
- **Keyboard shortcuts overlay and international layout support** - Press `/` to open the interactive Keyboard Shortcuts modal. Shortcut keybinding support has been expanded for non-English keyboard layouts.
- **Mouse wheel volume control** - Player volume can now be adjusted by scrolling the mouse wheel over the video player.
- **Metadata badge customisation in EPG** - Individual stream quality badges (Resolution, FPS, Audio) and the FPS suffix can be toggled on/off independently under `Settings → Live TV`.
- **Media info overlay for VOD, Stremio, and Nuvio** - Movie and series details for the currently playing title are now shown in a clickable Episode/Movie Info pill overlay in the top-left of the player.
- **Settings and Light Theme readability** - Full dynamic CSS variable adoption across settings tabs, improving readability for Light Theme.
- **Enhanced backup and restore** - Import/Export has been expanded to include custom folders, layout preferences, and logo overrides.
- **Volume numeric display** - The numeric volume level can be shown in the media bar by enabling `Show Volume %` under `Settings → UI → Player`.
- **Transparent guide button in media bar** - A transparent guide button has been added to the media bar for quick access to the transparent EPG overlay in Live TV. Can also be opened using the hotkey (Default `Z`)
- **Adjustable scrollbar size** - Scrollbar width can be customised under `Settings → UI → Override Scrollbar Width`.
- **Live TV CC subtitle adjustments** - Closed caption subtitle size and position can now be adjusted via the subtitle overlay.
- **Cyrillic and multi-language search** - Full search support for Cyrillic and non-Latin scripts across Channels, EPG, VOD, and Categories, including accent folding and transliteration (e.g. `"perviy"` matches `"Первый"`).
- **Sports and athlete enhancements:**
  - **Depth Charts tab** - Displays position groups and formation depth charts (Offence, Defence, Special Teams) with starter and backup rankings for NFL, NBA, MLB, NHL, and college sports.
  - **Injury Report tab** - Real-time team injury reports with status badges (`OUT`, `QUESTIONABLE`, `PUP`, `IR`), body location, medical notes, and projected return dates.
  - **Stat Leaders tab** - Statistical leaders across all major categories (passing, rushing, receiving, tackles, points, etc.) per team.
  - **Universal Athlete Profile** - Click any player name or headshot to open a full overlay featuring bio, season stats, year-by-year history, and week-by-week game logs.
  - **League Division and Standings views** - Added By Conference and By Division view toggles to the standings section.

### Fixed v2.3.0

- **VOD details page readability** - A gradient has been added to the VOD details page background to improve text legibility.
- **Playback resume ignoring early progress** - Resume playback was previously skipped if watched progress was below 5%. Playback position will now be restored for any progress greater than 10 seconds.
- **Subtitle track switching resetting style overrides** - Active subtitle style overrides will no longer reset when toggling between embedded subtitle tracks.
- **SubSource ZIP subtitle extraction failures** - Resolved an issue causing SubSource ZIP subtitle files to fail during extraction.
- **Expanded category trees collapsing unexpectedly** - Resolved a race condition that caused expanded category trees to collapse while navigating between views.
- **Xtream VOD sync failing on null stream names** - Resolved a sync failure that occurred when Xtream VOD stream names contained null or non-string data.
- **Nuvio Library not displaying all media** - The Library view has been switched to a grid layout to ensure all media is shown.
- **Minimum window size reduced** - The minimum app window size has been lowered from 960×600 to 400×300.
- **Light Theme contrast and readability** - The Light Theme has been reworked for consistent readability throughout the app.
- **Nuvio rate limiting and excessive API requests** - Nuvio sync architecture has been updated to match NuvioDesktop, eliminating 429 rate limit errors and significantly reducing API request volume.
- **Changed default UA to VLC** - Changed for better compatability with providers. 

### Fixed in v2.3.1

- **Using nondefault font caused font to swap back and forth** - Fixed an issue where using a font other than Inter caused the app to swap between Inter and chosen font when scrolling EPG.

## v2.2.3

### Added

- **Redesigned media player controls** - The media control overlay has been updated with a cleaner, more streamlined layout. The previous layout remains available under `Settings → UI → Player → Control Design: Legacy`.
- **Catch-up support for some MAC portals** - Catch-up stream playback and downloading are now available for supported MAC portal sources.
- **Custom source refresh intervals** - Automatic sync intervals can now be configured individually per source playlist.
- **Persistent volume level** - Volume is now saved and restored automatically between sessions.
- **Auto-expand active source and category** - The active source playlist and category are now automatically expanded in the navigation sidebar upon entering LiveTV.
- **Autoplay next VOD episode** - The next episode in a VOD series will now begin playing automatically upon completion. Disable under `Settings → Playback → VOD`.
- **Pause and resume VOD downloads** - VOD downloads can now be paused and resumed at any time from the Downloads manager.
- **Subtitle downloads for Stalker VODs** - Embedded subtitles can now be downloaded alongside content when downloading Stalker VOD items.
- **World Cup tab hidden by default** - The World Cup tab in the top navigation is now hidden. Can be turned back on by enabling it again in `Sports → Settings`.
- **Source name in failover overlays** - Failover Overlay can also show the source the channel is from by enabling in `Settings → Live TV → Channel Overlay → Show Source for Failover Group`.
- **Show Source Badge for VOD Home/Recent/All** - Shows source badge name on posters for VOD. Can be enabled in `Settings → Playback → VOD→ Show source badge`.
- **Text labels in Player Selector** - Clear text labels (`Embedded`, `Popout`, `External`) have been added to the Player Selector button in the Live TV EPG.
- **M3U category handling for non-ASCII names** - Unicode letters and numbers — including Cyrillic, Greek, Arabic, and accented characters are now preserved when generating M3U category IDs during source syncs. This prevents non-English categories from grouping incorrectly or producing empty IDs, and adds a fallback for symbol-only category names. *(Contributed by @GabrieleElPikaso in #136)*
- **Preview player gradient scrim** - A subtle gradient overlay has been added to the preview player to improve legibility of text and controls.
- **Highlight border on active EPG program** - An optional highlight border around the currently airing program in the EPG grid can be enabled under `Settings → Live TV → EPG → Highlight Border Around Current Playing`.
- **Updated home screen widgets** - Widgets have been resized for a smaller, less intrusive footprint on the home screen.
- **Enhanced channel info overlay settings** - Additional customization options for elements displayed in the channel info overlay are now available under `Settings → UI → Player`.
- **Hardware acceleration enabled by default** - Hardware-accelerated video decoding is now enabled by default (sets `--hwdec=auto` and `--vo=gpu` as MPV parameters). Existing custom `hwdec` or `vo` parameters will take priority over the defaults. Can be disabled under `Settings → Playback`.
- **UI hardware acceleration** - UI rendering now offloaded to the GPU for improved performance. Can be disabled under `Settings → Optimization`.
- **Startup performance optimization** - Auto-sync is now slightly delayed on launch, and several processes that were contributing to high CPU and memory usage at startup have been adjusted.

### Fixed

- **Incorrect episode playback for Stalker VODs** - Resolved an issue where selecting a series episode from a Stalker portal could result in the wrong episode stream being played.
- **Catch-up downloads fetching incorrect time window with EPG timeshift** - Catch-up downloads will now correctly account for any active EPG timeshift offset when determining the time window to fetch.
- **Custom playlists not appearing in Advanced Search** - Resolved an issue preventing channels and content from custom playlists from being returned in Advanced Search results.

## v2.2.2

### Added

- **Catch-up download** — Catch-up programs can now be downloaded directly from the EPG by right-clicking a program and selecting `Download Catch-up`.
- **Catch-up padding** — Padding can be added to catch-up playback to start slightly before or end slightly after the scheduled program time. Configure under `Settings → Playback → Catch-up`.
- **DVR recording retry on stream stall or drop** — If the stream being recorded stalls or disconnects, the DVR will now automatically attempt to reconnect and resume the recording to avoid partial captures.
- **DVR auto-cleanup** — DVR recordings can be configured to automatically clean up when a maximum disk usage threshold is reached, or after a set number of days. Configure under `DVR → Settings`.
- **Dynamic Settings sizing** — The Settings panel now scales dynamically to match the current app window size.
- **VOD Recently Added sort** — VOD Movies and Series can now be sorted by Recently Added, based on the order added by the source.
- **Quick Record custom duration** — When using Quick Record via the channel right-click menu, a custom recording duration can now be specified.

### Fixed

- **App not reopening in fullscreen after closing in fullscreen** — The app will now correctly reopen in fullscreen if it was closed while in fullscreen mode.
- **Disabled source channels appearing in Favourites and Watchlist** — Channels from disabled sources will no longer appear in the Favourites or Watchlist views.
- **Stalker/MAC VOD downloads not working** — Resolved an issue preventing VOD downloads from Stalker and MAC sources from completing correctly.
- **Ministra Portal VOD series compatibility** — Ministra Portal VOD series handling has been reworked for improved compatibility.

## v2.2.1

### Added

- **Lock window aspect ratio for PiP** - The PiP window aspect ratio can be locked to `16:9`, `4:3`, or video-match to prevent black bars when resizing. `Fill` and `Stretch` modes remain freely resizable. *(Contributed by @lanes100 in #113)*
- **State-aware Windows title bar controls** - The Minimize, Maximize, and Close buttons now use proper Windows-style icons and update correctly — for example, showing the Restore Down icon when the window is maximised. *(Contributed by @lanes100 in #113)*
- **Audio device selector** - The active audio output device can be selected via the Audio Selector menu (default hotkey: `A`) or under `Settings → Subtitles & Audio`.
- **VOD Favourites included in Import/Export** - VOD Favourites are now included when importing or exporting app data.
- **Source name toggle in Watchlist and VOD Favourites** - A toggle button allows the source playlist name to be displayed for each entry in the Watchlist and VOD Favourites views.
- **Manage Channels Move to Top / Up / Down buttons** - The same positional controls available in Manage Categories are now available in Manage Channels for faster channel reordering.

### Fixed

- **Lag when resizing the app window** - Window resizing now tracks the cursor much more closely and stops promptly on release, especially noticeable on lower-end systems. *(Contributed by @lanes100 in #113)*
- **Fullscreen exit not restoring window state correctly on Windows** - Exiting fullscreen from a maximised state will now correctly restore the window's previous position and state. *(Contributed by @lanes100 in #113)*
- **Startup window exceeding current monitor bounds** - If you use multiple monitors with different scaling or resolutions, the app window will no longer open off-screen or in an unrecoverable position. *(Contributed by @lanes100 in #113)*
- **Manage Channels displaying incorrect sort order** - The channel list in Manage Channels now reflects the correct active sort order.
- **VOD Watched indicator appearing twice** - The watched indicator for VOD titles will now only appear once.
- **Failover group overlay extending off screen** - A maximum height limit has been applied to the Failover group overlay to keep it within the visible screen area.
- **Deleted Failover group channels blocking reuse** - A cleanup routine has been added to fully remove deleted Failover group channel entries, allowing those channels to be assigned to a new group.


## v2.2.1

### Added

- **VOD Favorites to Import/Export** - Favorites added for VOD will now Import/Export.
- **Toggle in Watchlist & VOD Favorite to show source** - View what source the Watchlist/VOD Favorite came from by using the toggle button.
- **Audio Device Selector** - Select audio device either through the Audio Selector Menu (default hotkey: `A`) or Settings → Subtitles & Audio.
- **Lock window aspect ratio for PiP ** - Lock the window's aspect ratio on for supported Picture-in-Picture modes (16:9, 4:3, or video-match) to prevent black bars when resizing. (Contributed by @lanes100)
- **State-aware Windows window controls** - Custom-drawn, state-aware Minimize, Maximize, and Close title bar buttons for Windows platforms to match native designs. (Contributed by @lanes100)
- Manage channel Move to Top/Up/Down buttons - Same as the manage category buttons for faster customization

### Fixed

- **Lag when resizing app window** - Coalesces resize event messages and caches video geometries to dramatically improve window resizing performance and smoothness. (Contributed by @lanes100)
- **Consistent fullscreen exit behavior (Windows)** - Correctly restores window state and position on Windows when exiting fullscreen mode from a maximized state. (Contributed by @lanes100)
- **Fit saved startup size to current monitor** - Automatically scales down saved window startup dimensions if they exceed the resolution of the current monitor, avoiding off-screen window bugs. (Contributed by @lanes100)
- Manage channels Sort order - Fixed the manage channels not displaying the correct sort order
- **VOD Marked as Watched appearing twice** - Indicator will only appear once now.
- **No height limit for Failover group overlay** - Failover group overlay now has a max height limit so it won't go off screen.
- **Deleted failover group channels not able to be used for new failover group** - Added a cleanup script to completely remove old deleted failover group channels.

## v2.2.0

### Added

- **Global EPG local cache** - The Global EPG can now be cached locally, enabling use of the EPG Editor to search from the Global EPG that weren't matched and allowing searches across its full program data. Enable via the Edit Global EPG menu, can also view and search the full EPG.
- **Per-channel EPG source override** - Using the EPG Editor, a channel's EPG can be overridden to pull data from a different LiveTV source. The override will persist across every subsequent sync.
- **Optimization tab** - Performance optimization options are now available under `Settings → Optimization` for users experiencing reduced smoothness on lower-end hardware.
- **Customize your own themes** - Create entirely new themes or modify existing ones to suit your preference. Custom themes can be saved, imported, and exported.
- **Custom font** - The application font can be changed to any of the available options or replaced with your own by uploading it under `Settings → UI`.
- **DVR repeat scheduling** - When scheduling a Live TV recording, a repeat interval can now be set: `Daily`, `Weekly`, or `Every X Days`.
- **Audio delay adjustment** - Audio delay can be adjusted via the Audio Selector (default hotkey: `A`). The value is saved per channel, and an indicator will appear when a saved audio delay is detected for the active channel.
- **Pin category to top** - Right-click any category to pin it to the top of its source list. Pinned categories remain fixed at the top under the Source while scrolling for quick access. Right-click again to unpin and restore the original position.
- **View Global EPG matched channels** - A new button on the Global EPG source card displays all channels that were matched using the Global EPG, along with their associated program data.
- **EPG logo preference** - An option has been added in the EPG Editor to use the EPG-provided logo in place of the provider logo for individual channels. A global preference to always favour the EPG logo can be enabled under `Settings → Live TV → EPG`.
- **Reworked Live TV EPG preview** - Enables smoother resizing and correct centering of all sources regardless of app/source resolution.
- **Draggable Popout Player media controls** - The media controls overlay for the Popout Player can now be repositioned by dragging. The controls will also auto-hide in sync with the UI overlay.
- **Click-only overlay toggle** - The player overlay can be configured to show and hide on left-click only, rather than on mouse movement. Enable under `Settings → UI → Overlay on Click Only`.
- **Series episode watched toggle** - Episodes in Live TV VOD series can be manually marked as watched or unwatched. Changes are reflected in the Continue Watching catalog.
- **Mouse back button support** - The mouse back button can now be used to navigate back in any view that supports back navigation.
- **Source name badge in VOD search** - A source name badge is now displayed on posters in VOD search results to identify which source each title belongs to. Enable under `Settings → Live TV → Search`.
- **Global user agent** - A global user agent can be configured under `Settings → Sources → Global User Agent`, applying to all sources that do not have a dedicated user agent set.

### Fixed

- **DVR quick recordings not stopping on time** - Quick Recordings will now end at the correct scheduled time.
- **Sync errors for certain providers** - Resolved an issue that prevented some sources from syncing correctly.
- **Check for Update window appearing behind Settings** - The update check dialog will now appear correctly.
- **Transparent title bar in v1/v2 UI designs** - The title bar in v1 and v2 UI designs will no longer be transparent or show the desktop behind it.
- **All Channels per source not populating on restart** - The All Channels category for individual sources now populates correctly after a restart.
- **EPG Editor not showing EPGs with duplicate channel names or TVG-IDs** - Resolved a bug that caused certain EPG entries to be hidden in EPG Editor search results when they shared a channel name and TVG-ID with another entry.
- **Naviation bar clickable area shifting during download** - Download badge will no longer cause navigation bar clickable area to shift.
- **Font Size settings not reflecting in v3 UI** - Editing font size should reflect correctly now for v3 design instead of using hardcoded values. Reset to Default in `Settings → LiveTV → Font Size` 



## v2.1.5

### Added

- **Multiview previews in Live TV** - While in any multiview mode, a preview of each active player is now displayed within the Live TV EPG view.
- **Multiview channel buttons in EPG** - Buttons now appear in the channel panel when multiview is active, visible on hover. Selecting a numbered button sends that channel to the corresponding multiview player slot.
- **Redesigned media bar for Live TV preview** - The media bar in the Live TV EPG preview panel has been updated with a refreshed look.
- **PiP button in LiveTV preview** - The mediabar for LiveTV preview now has a PiP button for quicker access without the need to full screen first.
- **EPG sub-title support** - EPG entries that include `<sub-title>` tags are now supported. Search results will also match against sub-title content.
- **Neutral color themes** - Three new grey-toned themes have been added - `Dark Slate`, `Dark Warm Grey`, and `Dark Steel` - for users who prefer a color-neutral appearance.
- **Lazy loading for Stremio and Nuvio posters** - Posters on the Stremio and Nuvio home pages now load progressively as you scroll, resulting in a smoother browsing experience.
- **Updated source card design** - The visual style of source cards has been updated.
- **Cleaner title bar** - The transparency layer behind the title bar has been removed for a cleaner appearance.
- **NWSL added to Sports** - The National Women's Soccer League is now available in the Sports section.
- **Playlist name toggle in Recent** - A toggle button has been added to the Recently Viewed list to show or hide the source playlist name for each channel.
- **Per-playlist All Channels category** - An `All Channels` category can now be enabled for individual playlists via `Settings → Live TV → Sort Order`.

### Fixed

- **Nuvio sync broken after backend update** - Nuvio sync has been updated to be compatible with their latest backend changes.
- **UI scaling layout bugs** - Various UI elements that were not resizing correctly when UI scaling was applied have been fixed.
- **Nuvio search result navigation** - Previous and next page buttons (`<` `>`) have been added to Nuvio search results.
- **Expanded settings displaying behind title bar** - The expanded settings panel will no longer render beneath the title bar.

## v2.1.4

### Added

- **Picture-in-Picture mode** - Activating PiP mode via the new button in the media bar resizes the player to a compact window with Always on Top enabled. Window size and position are saved on exit and restored when PiP mode is re-entered. Aspect ratio selected in PiP mode will not carry back to Main View when exiting PiP.
- **Watch progress for recordings and downloads** - Playback position is now saved when watching a recording or download, and will be resumed automatically on next playback.
- **VOD playback speed** - Playback speed for VOD content can be set to `1x`, `1.5x`, or `2x`.
- **Widgets menu** - A widgets menu has been added to the home screen for easier access and discovery. The menu auto-hides when any stream is playing and can also be accessed during Live TV playback by right-clicking the home screen.
- **Sports score overlay quick-access button** - A toggle button for the live sports score overlay has been added to `Sports → Live Now`, providing quick access and improving discoverability of the feature.
- **Sports live score progress indicator** - A real-time indicator next to the refresh button now shows when live score data is being fetched by current/total, providing visual feedback during updates.

### Fixed

- **Memory spike on launch** - Resolved a bug that caused all EPGs to be loaded at startup, resulting in a temporary spike in memory usage.
- **UI going transparent when selecting a stream from List Streams Here** - Opening a stream via List Streams Here in Sports will no longer cause the UI to become transparent.
- **Bingecat add-on catalog URLs not resolving** - Resolved an issue where Bingecat add-on URLs were not being resolved correctly for catalog content.
- **Inconsistent VOD resume playback** - Resume playback for VOD content on slower sources has been made more reliable.

## v2.1.3

### Added

- **UI Overhaul v3** - A comprehensive visual refresh delivering a more polished look across the application. Themes have been updated to take advantage of the new design, so existing themes may appear different from previous versions. The prior UI versions remain available under `Settings → UI → UI Design` (v1 or v2) if you wish to opt out.
- **Source selector in media bar for Stremio and Nuvio** - A source selector has been added to the media bar, allowing quick switching between sources without leaving the player.
- **Always on Top toggle in Popout Player** - A toggle button has been added to the Popout Player media bar to control the Always on Top behaviour directly from the player.
- **Playlist name in Favourites** - A toggle button in the Favourites view allows the source playlist name to be displayed inside each channel tile, making it easy to identify which source a channel belongs to.

### Fixed

- **Nuvio API update** - The Nuvio API integration has been updated to align with NuvioDesktop, restoring watchlist sync functionality.
- **Popout Player not staying on top** - Resolved an issue causing the Popout Player to lose its Always on Top state unexpectedly.
- **Alphabetical category sort not applying automatically** - Categories will now sort alphabetically in real time when the sort order is set to Alphabetical, without requiring a visit to Manage Categories.


## v2.1.2

### Added

- **Nuvio integration** - New Nuvio tab in Titlebar Navigation. Sign in to your Nuvio account for two-way sync of add-ons, plugins, collections, settings, watch history, and library. The Nuvio button can be hidden from the title bar under `Settings → Navigation`.
- **UI scaling** - Application UI scale can be adjusted under `Settings → UI → Application UI Scale`. Recommended for users running Windows display scaling or very high-resolution displays. Consider adjusting EPG visible hours alongside this setting.
- **Configurable EPG grid hours** - The number of hours displayed in the EPG grid can be customized under `Settings → Live TV → EPG → EPG Visible Hours`.
- **Channel loading overlay** - A loading overlay is now displayed while a Live TV channel is buffering. Enable under `Settings → Playback → Reconnect`.
- **Move to Top in Manage Categories** - Press `↑↑` on a category in Manage Categories to move it to the top of the list instantly, or use the new `Select to Move to Top` button to multi-select and move multiple categories at once.
- **Shortcut keys for Stremio and Nuvio** - Keyboard shortcuts for Stremio and Nuvio can be configured under `Settings → Shortcuts` (defaults: Stremio `X`, Nuvio `N`).
- **Custom recording end padding** - The end padding applied to recordings can now be set to a custom duration, replacing the previous fixed maximum of 15 minutes. Useful for events that tend to run over their scheduled end time.
- **Expanded settings menu** - A button in the top-right corner of the Settings page allows the settings menu to be expanded to full screen.
- **Poster Scaling for Strem/Nuvio** - Scale poster sizes using the slider scale in top left of navigation bar.
- **Cache Stremio fetch results** - Cache fetch results from addons with set timer. Enable in `Strem → Settings`
- **Hide EPG buttons** - Individual EPG toolbar buttons (`Manage Channels`, `Refresh Source`, `EPG Shift`, `Playlist Editor`, `Failover Group`) can be hidden under `Settings → Navigation → EPG`.
- **Default Language & Subtitles Off** - Added new options for Default Subtitle: Off, and Language:Default. Default language will select the default audio track.
- **Discord button** - Added a Discord button in `Settings → About` to join the ynoTV discord.

### Fixed

- **Late-starting sport matches not auto-refreshing** - Resolved an issue where matches that kicked off after their scheduled start time would fail to refresh automatically every 30 seconds.
- **Default subtitle not being selected** - Fixed an issue where default subtitle language wasn't being correctly selected when subtitle addons were enabled in Strem.

## v2.1.1

### Added

- **Playlist Editor** - A full-featured playlist editor, access by pressing the Playlist Editor button in EPG. Has the following capabilities:
  - Create a new custom playlist using categories and channels from any existing source by either the + button in the Categories sidebar, or using the Playlist Editor button.
  - Merge categories from different sources into one another.
  - Add individual channels from any source into any category.
  - Create custom categories within any source and populate them with channels of your choice.
- **Export to M3U** - Export M3U/XC/Custom playlist, including all modifications done such as disabled channels/categories, custom sort order, and edited EPG data, can be exported to an `.m3u` file. Access via the Playlist Editor and select `Export`.
- **Convert recordings to MKV/MP4** - Live TV recordings can be converted to MKV or MP4 format manually, or automatically upon completion. Auto-conversion can be configured in Settings.
- **Stremio account sync** - Sign in to your Stremio account directly in the app to sync your Watchlist, Watch Progress, and Add-ons. Two-way sync is supported. 
- **Streaming network catalogs** - OTT catalogs for VOD and Stremio are now available, including Top 10 and genre-based collections. Requires a free TMDB API key configured under `Settings → Metadata`.
- **Cast detail pages** - Cast members listed on Movies and Series detail pages are now clickable, opening a page displaying their other works. Available in both VOD and Stremio. Requires a free TMDB API key configured under `Settings → Metadata`.
- **Global EPG channel count** - The Global EPG tab now displays both the number of programs added and the number of channels populated for each source it's linked to.
- **Refreshed default Stremio badges** - The default badge styling for Stremio links has been updated with a new look.
- **Reload button in the media bar** - The current stream can be reloaded directly from the media bar without leaving stream.
- **Automatic download posters** - Cover art is now automatically added to entries in the Downloads section.
- **VOD favourites** - Movies and Series in VOD can now be added to your favourites.
- **Top navigation for Sports, DVR, and Calendar** - Sports, DVR, and Calendar have been moved from the sidebar to a top navigation bar for a cleaner layout.
- **Bold font toggle for Live TV** - The font weight used for Categories and Channels in Live TV can be switched to bold under `Settings → Live TV → EPG`.
- **Show/Hide Cast and Calendar buttons** - The Cast and Calendar buttons in the Title bar can be toggled under `Settings → Navigation`.
- **Playback transition background** - When starting playback of a Movie or Series, a transition screen featuring the title and background art is now displayed.
- **What's New Modal** - Added a What's New popup modal on fresh launch of a new version to display changes that were made, can also check changelogs in `Settings → About`

### Fixed

- **Managed Categories not persisting after cache clear** - Custom category configurations will now be retained when the cache is cleared.
- **Import/Export not functioning correctly** - Resolved an issue affecting playlist import and export operations.
- **Closed captions not appearing in Live TV** - Closed caption support for Live TV channels has been restored.
- **New categories appearing out of sort order** - Newly created categories will now be inserted in the correct position according to the active sort order from source.
- **Stremio search results not applying metadata on detail pages** - Additional metadata will now load correctly when viewing results from Stremio search results.
- **Recent Results in WC2026** - Fixed recent results only showing first 5 results, and not most recent
- **Fix Custom Catgory sort ortder** - Fixed user set custom category sort order -v2.1.1


## v2.0.3

### Added

- **Transparent EPG overlay** - A transparent EPG overlay can be toggled via hotkey (default: `Z`). Height, opacity, and display behaviour on channel zap are configurable under `Settings → Live TV → EPG`.
- **VOD & Strem downloads** - Movies and series can now be downloaded directly from their detail page using the new download button. Active and completed downloads are accessible in the DVR section. The default download location can be changed under `DVR → Settings`.
- **Play while recording** - Recordings currently in progress can now be played back simultaneously. Ideal for users with a single connection limit who want to record and watch the same channel at the same time.
- **M3U catch-up support for custom playlists** - Users with a custom M3U playlist created from an XC source that supports catchup can now enable catch-up playback via `Settings → Source → Edit Source → Xtream Catchup`. Filling in the Xtream Catchup field will also retrieve connection count and expiration details from the XC provider, which are then displayed on the source card.
- **SOCKS5 proxy support** - A SOCKS5 proxy can be configured to route all application traffic through it.
- **Hideable top categories** - The `All Channels`, `Favorites`, `Watchlist`, and `Recently Viewed` categories can now be hidden from the sidebar by right-clicking and selecting `Hide Category`. They can be re-enabled under `Settings → Navigation → Category`.

### Fixed

- **Font size customisation not applied at small resolutions** - Custom font size settings were not being respected on lower-resolution displays. This has been resolved.

## v2.0.2

### Added

- **Metadata badges in search** - Metadata badges are now displayed in search results and populates when a channel is played from results
- **User agent forwarded during EPG fetch** - The source user agent is now passed when retrieving EPG data, ensuring compatibility with providers that require a user agent for EPG requests.
- **Trakt catalogs in Discover** - Catalogs imported from Trakt are now accessible from the Discover page.
- **Popout/External mode persistence** - The selected playback mode (Popout or External) will now be retained across restarts.
- **Settings search bar** - A search bar has been added to the Settings page for quickly locating individual settings.
- **Sync error notification** - If a source fails to sync, a red notification will appear in the bottom-right corner displaying the associated error message.
- **Multiview Stalker support** - Stalker sources can now be used in multiview.

### Fixed

- **Casting reliability for Live TV channels** - Casting to TV from Live TV has been improved for a more consistent experience.
- **VOD custom sort order not being applied** - VOD libraries were incorrectly displaying in alphabetical order regardless of any custom sort order configured by the user.
- **Stalker EPG incomplete program data** - EPG data for Stalker sources now utilises both `get_epg_info` and `get_short_epg` endpoints, ensuring full program guide coverage.

## v2.0.1

### Added

- **Dedicated World Cup tab** - A World Cup tab has been added to the Sports page, including support for live and upcoming match listings.
- **Trakt catalog import** - Your Trakt catalogs can now be imported directly into Strem. Manage catalogs under `Settings → Trakt`. The `Resume Watching` catalog can be used to sync watch progress from Trakt.
- **Xtream Code autofill** - Pasting an Xtream Code M3U link into the source field will now automatically populate the relevant credentials.
- **Nuvio/Fusion badge support** - Custom Badge Filters used for Nuvio/Fusion can now be used in Strem links display. Add Badge configs in `Settings → Strem`
- **Search history** - Live TV and Strem search queries are now saved upon pressing Enter, allowing previous searches to be quickly recalled.
- **Strem add-on link filter** - Add-on links in Strem can now be filtered by addon for easier navigation.

### Fixed

- **LiveTV Metadata badges not appearing on slow streams** - Badges will now display correctly regardless of stream load time.
- **Cinemeta Series Discover page not loading** - Resolved an issue preventing the Cinemeta Series Discover page from displaying correctly.
- **EPG preview resizing at high display scaling** - The EPG preview will no longer resize unexpectedly when display scaling is set to a high amount.
- **Error overlay persisting after stream recovery** - The error overlay will now dismiss correctly once a stream successfully starts following an error.

## v2.0.0

### Added

- **Stremio add-ons support** - A dedicated `Strem.` page has been added for Stremio add-on support. Navigate to the Strem page and click `Manage Add-ons` to add your Stremio add-ons. Strem Tab can be hidden in new `Settings -> Navigations` if you don't plan to use it.
- **HLS multiview** - Multiview now has an option to choose between MPV or HLS container for playback. Use HLS if your system can't handle multi MPV or if you need overlays
- **Cast to TV** - Casting to any Chromecast-compatible device is now supported. Enable under `Settings → Playback → Google Cast`. A Windows firewall prompt will appear on first use to allow local network scanning for available devices.
- **External player support** - Any channel can be sent to an external player of your choice. Configure the player under `Settings → Playback → External/Popout Player`. Access via `Right-click → Send to External Player`, or click the screen icon in the EPG and set it to `External` to route all playback externally.
- **IntroDB integration** - A skip intro button will appear for Series episodes with an entry in IntroDB. Auto-skip can be enabled, and the button display duration is configurable under `Settings → Playback → Skip Intro`.
- **Trakt integration** - Trakt scrobbling is now supported for VOD and Stremio streams. Trakt watchlists can also be imported directly into Strem catalogs.
- **Hide navigation tabs** - Individual tabs can be hidden from the title bar navigation by unchecking them under `Settings → Navigation`. Hide any unnecessary tabs you don't use. 
- **Clear Recent List** - The recent channels list can now be cleared by right-clicking `Recent` in the sidebar and selecting `Clear`.
- **Startup View** - Configure which page is displayed on launch under `Settings → Startup → Startup View`.
- **Live TV sync only** - A new option in Source settings allows syncing Live TV channels exclusively, skipping VOD content entirely. Enable via the checkbox in `Settings → Source Settings`.
- **Rugby support** - Rugby has been added to the Sports page. Enable under `Sports → Settings`.
- **Aspect ratio selector** - A new button on the Now Playing Bar allows the aspect ratio to be changed during playback.
- **Movies & Series detail page overhaul** - The Movies detail page now includes cast headshots. The Series page has been reworked to display episode summaries and screen captures.
- **Improved TMDB metadata matching** - VOD movie metadata matching against TMDB has been refined for greater accuracy.
- **EPG programme overlap prevention** - EPG entries from providers that supply overlapping programme blocks will now be split automatically. When a second programme begins, the preceding block is closed at that point.
- **Borderless popout player** - The title bar has been removed from the popout window for a cleaner display.
- **Default audio and subtitle language** - Preferred audio and subtitle languages can be set under `Settings → Subtitles & Audio`. Applies to VOD and Stremio streams.
- **Disable event-based reconnect** - Event based detection for autoreconnect is disabled by default now as it was too aggressive, causing unstable streams to constantly reconnect.  Can re-enable if it didn't cause issues under `Settings → Playback → Reconnect`.
- **Default user agent** - The default user agent is now set to `ynoTVPlayer` rather than being left blank.

### Fixed

- **SubSource applying incorrect season for Series** - Subtitle lookups via SubSource will now resolve to the correct season.
- **Update popup not scaling correctly** - The update popup now renders properly for users with display scaling applied.
- **Stalker adult channels not appearing** - Resolved an issue preventing adult channels from Stalker sources from being displayed.
- **Quick Record not starting immediately** - Upon clicking the button, recording should start immediately now.

## v1.7.1

### Added

- **Overlay widgets** — Customisable widgets can now be added to the playback screen for additional information and navigation. Right-click the background or stream to add widgets. Size and background opacity are configurable under `Settings → Widgets`.
  - **Live Sports Score widget** — Displays live scores for ongoing matches at the top of the overlay. Click a score to view detailed match information, or right-click to hide specific matches. Available in two modes: `Persistent` (remains visible when the UI overlay auto-hides) and `Autohide` (hides alongside the UI overlay).
  - **Recent Channels widget** — Shows recently watched channels along with their currently airing programme. Click any entry to switch to that channel.
  - **Custom Group widget** — Displays channels and their currently airing programmes from a selected custom group, enabling quick channel switching directly from the overlay.
  - **What's Next widget** — Shows the next scheduled programme on the current channel.
- **Category search** — A search bar has been added to the top of the Category sidebar for faster category navigation.
- **Autohide overlay timer** — The duration of inactivity before the overlay auto-hides is now configurable under `Settings → UI → Autohide Overlay Timer`.

### Fixed

- **Sport match cards not displaying correctly** — Match cards for Racing, Golf, Tennis, and MMA now display correct layout.
- **M3U links with no categories not displaying in sidebar** — Channels from M3U sources with no assigned categories are now correctly shown in the sidebar.


## v1.7.0

### Added

- **Global EPG** — A global EPG source can now be configured to apply across any playlist, automatically filling in missing EPG data without requiring per-source setup. Configurable under `Settings → Source → EPG`.
- **Popout player** — Streams can now be played in a dedicated popout MPV window. Access via `Right-click → Play in Popout`. The window can be set to always stay on top under `Settings → Popout Player`.
- **Popout mode for Live TV EPG** — Activating Popout mode via the new icon on the middle-right of the Live TV EPG will route all channel selections directly to the popout player.

### Fixed

- **Manage Categories saving slowly** — Resolved a performance issue causing category changes to take longer than expected to save.
- **Fullscreen button clipped in Alternate EPG view** — The fullscreen button is now fully visible and accessible in the Alternate EPG layout.
- **Auto-updater popup not rendering Markdown** — The update changelog popup now correctly renders Markdown formatting.


## v1.6.9

### Added

- **Backup DNS per source** — A backup DNS option is now available in Source settings. If the primary source URL becomes unreachable or fails during a sync, the app will automatically fall back to user-configured backup URLs. Backup URLs can be validated at any time using the `Test` button.
- **Failover group overlay** — A new overlay is displayed in the main view when the active channel belongs to a Failover group. The overlay shows all channels in the group alongside the currently playing channel, and allows switching to any group member with a single click.
- **Picture-in-Picture resizing** — The PiP window can now be resized by dragging from its bottom-left corner.
- **Category context menu** — Right-clicking a category in the sidebar now presents the following options: `Rename Category`, `Manage Categories`, and `Hide Category`.
- **Rename channel** — Channels can now be renamed directly via the right-click context menu.
- **Settings menu declutter** — The settings menu has been reorganised for a cleaner, less cluttered layout.
- **Provider channel sort order** — A new `Provider` sort option has been added to the channel list, preserving the order in which channels appear in the source M3U or provider feed. Recommended for use with EPGenius. Configurable under `Settings → Live TV → Sort`.

### Fixed

- **M3U playlists with uncategorised channels not appearing in Live TV** — Channels in M3U playlists that have no assigned category will now be grouped under an `Uncategorized` category and displayed correctly in Live TV.
- **Duplicate channels omitted from playlist** — Resolved an issue where channels sharing the same TVG-ID and playback URL were causing entries to be silently dropped from the playlist.

## v1.6.8

### Added

- **Stream Failover** *(Beta)* — Automatically detects when a channel stalls or drops and seamlessly switches to an alternate channel from a user-defined failover group. Channels can be added to a group via the new `Stream Failover Group` button in Live TV, or through `Right-click → Add to Failover Group`.
- **Automatic stream retry** — Detects stream failures and automatically attempts to reconnect. The maximum number of reconnection attempts can be configured under `Settings → Playback`.
- **EPG shift shortcut** — A quick-access EPG Shift button has been added to the top of the EPG view for faster time offset adjustments.

### Fixed

- **Additional EPG failing for large uncompressed `.gz` files** — Resolved an issue preventing large uncompressed `.gz` EPG files from loading correctly.
- **VOD Manage Categories resetting unsaved changes** — The category list will no longer refresh and discard unsaved changes while managing VOD categories.
- **Double-click to exit Live TV triggering too broadly** — Exiting Live TV to fullscreen via double-click now requires both clicks to occur within 500ms, preventing unintended dismissals.

## v1.6.7

### Added

- **Advanced search** — Access via the search icon at the end of the search bar. Supports filtering by Channels only, EPG only, or specific sources and categories.
- **Multiple EPG support per source** — Additional EPG sources can be added via `Source Settings → Add Additional EPG`. Supplemental EPGs will only populate data absent from the primary EPG.
- **SubSource subtitle integration** — Configure your SubSource API key under `Settings → Subtitles`. The app will automatically search for subtitles by title when the subtitles button is activated during Movies or Series playback.
- **Enhanced subtitle menu** — New controls for Delay, Size, Offset, Background, and Opacity.
- **Additional dark themes** — New variants featuring true black backgrounds in place of grey, available in multiple accent colors.
- **Channel search in EPG Editor** — Enables matching for EPGs that do not rely on TVG-IDs, using a workflow similar to the existing Advanced EPG Matching feature.
- **Resizable EPG sidebar and channel column** — Drag to adjust the width of the Category sidebar and Channel column in the EPG view. Right-click either element to restore default dimensions.
- **Channel info overlay** — Enable under `Settings → Live View`. Relocates channel information from the Now Playing bar to the top-left corner of the screen. Text, logo, box, and background opacity are each individually adjustable.
- **Refreshed sports match cards** — Updated visual design for match cards in the Sports section.
- **Bulk EPG auto-matching** — A new `Automatch Missing` tab in the EPG Editor allows all unmatched channels within a source or category to be matched in a single operation.
- **Adjustable EPG preview text size** — Configurable under `Settings → Live TV`.
- **Sync debug logging** — Detailed logging output is now available to assist with diagnosing synchronisation issues.
- **Hide channel option** — Channels can now be hidden via the right-click context menu.
- **Alphabetical category sorting** — Categories can now be sorted A–Z under `Settings → Channels → Category Display`.

### Fixed

- **Catch-up timezone resolution** — Catch-up channels now correctly retrieve the timezone from the provider, ensuring accurate playback of recorded programmes.
- **Disabled category channels appearing in search** — Channels belonging to disabled categories will no longer appear in search results.
- **Modern UI failing to load on fresh install** — The Modern UI now initialises correctly on a clean installation. Users who prefer the previous appearance may revert via `Settings → Live TV`.

## v1.6.6

### Added

- Bundled ytdlp for better YouTube playback for playlists with youtube links
- Highlight current channel being played in Search Results
- Highlight last clicked stream on Game Card for Sports when using "Show Search Results"
- Setting -> Playback, added Check Loaded MPV Parameters button at the bottom to check if parameters are correctly loaded
- Setting -> Playback added a disable parameter whitelist

### Fixed

- Concurrent sync for multiple sources not updating EPG due to db lock
- Fixed MPV parameters not passing properly to MPV

## v1.6.5

### Added

- Mediabar button on EPG Preview autohides unless mouse is over video
- Added stop button in EPG Preview
- Mediabar buttons added for Sports page Preview
- Double clicking preview on Sports page will full screen video in app
- When leaving Movies/series page and clicking back into Movies/Series again, it will go back to the movies/series page you were on
- Added option to not save resolution on exit in Settings -> UI
- When no TMDB key is provided, uses TVMaze as backup metadata for Series
- Added sizing slider for posters for Movies/Series, removed dead space between posters
- Added a hide category button in LiveTV, to expand category again there will be a button in the middle left to expand. Alternatively you can use the category shortcut instead.
- Added a Refresh Source button in the EPG, so you can refresh the Channels/EPG without having to go back in Settings. Does the same as the sync button.

### Fixed

- Channel number will properly update upon resyncs
- Fixed an error in VOD page display that would incorrectly show zero results for search/category
- Fixed some UI elements
- Parallel api calls for Live Now page for sports instead of sequential for faster loading
- Fixed a bug when in Maximize view from Titlebar, going full screen would not cover Taskbar
- Fixed a bug when using settings and closing, it would reset to the video view
- When clicking a category in Movies/Series and there is text in the Search, it will clear the search before loading into the category
- Fixed text scrolling in Modern UI
- Fixed scrollbar styling to match theme.

## v1.6.4

### Added

- Collapse source categories on startup option in Settings -> LiveTV
- Modern UI Design if you want a different look for LiveTV, enable in Settings -> LiveTV
- Log Retention settings in Settings -> Debug. Choose number of days of logs you want saved, rest will be deleted.
- Option to show search results in Alphabetical order, in Settings -> Channels -> Search Results order
- Option to choose how many sources sync during autosync/Sync button in Settings -> Data Refresh

### Fixed

- Fixed error overlay popping up on local streams
- Fixed sync button in Settings doing sequential syncing instead of parallel
- Padding fixes for UI
- Backend fixes

## v1.6.3

### Fixed

- EPG saving in diff timezone
- EPG Time Shift not working properly, should be reflected instantly now upon saving
- EPG Editor changes should be reflected immediately now
- https epg's not working properly
- Movies not loading when container_extension is null

## v1.6.2

### Added

- EPG Editor, right click any channel and you can delete/edit/add programs, change tvgid, match to a different EPG with search. Can also match EPG from different source
- Source syncing moved to Rust for M3U/Xtream for speed improvement.
- Vod recent watch tab.
- Vod Recent watch carousel on home page
- Saved progress for VOD, will save progress on pressing Stop, switching to LiveTV ch, or gets autoupdated every 30 seconds.
- For Series, the Up and Down button on the bottom media bar will now go to Previous/Next episode
- Clicking a recent watched Series will correctly bring it to the current season being watched

### Fixed

- Dark Theme scrollbar now uses accent color to be more visible.
- Clicking favorites on a channel doesn't bring channel list back to top
- Restricting certain MPV args
- VOD categories loading should be faster, removed lazy loading
- Disabled Source's VOD won't Show
- Backend changes that should make Startup faster
- Documentation updated

## v1.6.1

### Added

- Max Search Limit setting(Settings -> Channels)
- Option to right click a channel and copy stream url if you want to play in external player for M3U and Xtream sources
- Copy Stream URL for Vods of Xtream Code sources
- Draggable Preview resize for EPG and Sports preview video. Bottom Right of preview stream in EPG/LiveTV view is draggable, bottom for Alternate View. Right click the drag part to reset back to default.
- Alternate EPG view, Default shortcut E to swap views, or in Settings -> LiveTV -> EPG View Layout
- Hide Sports Categories button added in top right of Sidebar.
- Better search query for multi words
- New Search Team option in Sports for Live Games, clicking the new Search Teams button on a Match Card will do a search for both team names in your playlist for better matching
- Show Search Results option on Sports Live Now Match cards, clicking it will display all channels with the game inside the card, clicking a channel will play the stream so you can easily swap between Live Games inside Sports View.
- Up/Down channel button in Preview and Now Playing bar
- Channel list will smoothly scroll when using Up/Down shortcut or button
- List Vod Movies/series by sources
- Manage Vod categories, Right click the source in Movies/Series and you can enable/disable categories
- Better debug logging when debug is enabled

### Fixed

- Removed TMDB automatic matching, was causing slowdowns. It will instead display Trending Now, Top Rated, On the Air, and Popular categories in Home view of Movies/Series. Clicking on one of the movies/series will do a search within your playlist for that specific title.
- Removed Genre carousel for Vods as it was causing slowdown in loading the Movies/Series page.
- Vod optimization, categories should show instantly now
- Fixed Stalker/MAC portal VOD so it doesn't display error message for working streams
- Now Playing bar not appearing when text is in search field

## v1.6.0

### Added

- Current watching channel is now highlighted in LiveTV/EPG
- Added new option in Settings -> LiveTV. Enable pause/volume control in the Preview video for EPG. Restart is needed for it to take effect.
- Double clicking preview video now full screens video in app.
- Double clicking anywhere on non UI elements now full screens the app, and the reverse to disable full screen
- Added shortcut key to replay last stream

### Fixed

- Scroll is reset on changing categories.
- Fixed stream starting in paused state when opening after another stream that ended

## v1.5.9

### Added

- EPG matching for some external EPG providers, when adding sources or editing, check Advanced EPG Matching to enable
- Autosync will check in background if EPG is stale to the time set in Data Refresh

### Fixed

- Certain stalker portals weren't saving channels properly
- Clear cache vacuums SQLite database
- db-wal truncates after sync
- Backend changes
- Calendar Add to Watchlist

## v1.5.8

### Added

- Current time indicator in EPG
- When searching in Custom Group Manager and Calendar Change Channel, Source name will be shown as the Main group to differentiate channels from different sources.
- Added 3 new options in settings.
  - Settings -> Channels -> Include source name in search. Enabling this will also show the Source of channel in search results, and show Source in Multiview mini media bars.
  - Settings -> Cache -> Live Now Buffer Offset. Set a buffer offset if when clicking Go Live during Cache Time Shift is causing buffer stall.
  - Settings -> LiveTV -> Make EPG current airing program blocks darker. Enabling this will deepen/darker programs that are live if you are having trouble seeing the highlighted program in certain themes.

### Fixed

- Fixed a bug where Height and Width would increase on every launch
- Fixed EPG preview panel not updating on certain actions.
- Removed some excessive logging while not in debug mode.

## v1.5.7

### Added

- Catchup for providers that provide Catchup Channels
- Cache Time Shift: Uses MPV's --demuxer-max-back-bytes flag to Cache stream while watching, so you can rewind and have instant access/replay that's being cached while watching.
- While watching a live channel that has Catchup and you have cache time shift enabled, you will be able to switch between the two in the Now Playing bar.
- How to enable Cache Time Shift: In Settings -> Cache, Enable Time Shift and select Cache size and restart.
- Auto-Update

### Fixed

- Resizing/Moving while Multiview is selected. It is best to resize/move the app to where you want it before watching for best experience.
