  # Changelog
  
  ## v1.6.6
  Added:
  - Bundled ytdlp for better YouTube playback for playlists with youtube links
  - Highlight current channel being played in Search Results
  - Highlight last clicked stream on Game Card for Sports when using "Show Search Results"
  - Setting -> Playback, added Check Loaded MPV Parameters button at the bottom to check if parameters are correctly loaded
  - Setting -> Playback added a disable parameter whitelist
  
  Fixes:
  - Concurrent sync for multiple sources not updating EPG due to db lock
  - Fixed MPV parameters not passing properly to MPV
  
  ## v1.6.5
  Added:
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
  
  Fixes:
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
  Added:
  - Collapse source categories on startup option in Settings -> LiveTV
  - Modern UI Design if you want a different look for LiveTV, enable in Settings -> LiveTV
  - Log Retention settings in Settings -> Debug. Choose number of days of logs you want saved, rest will be deleted.
  - Option to show search results in Alphabetical order, in Settings -> Channels -> Search Results order
  - Option to choose how many sources sync during autosync/Sync button in Settings -> Data Refresh
  
  Fixes:
  - Fixed error overlay popping up on local streams
  - Fixed sync button in Settings doing sequential syncing instead of parallel
  - Padding fixes for UI
  - Backend fixes

  ## v1.6.3
  Fixes:
  - EPG saving in diff timezone
  - EPG Time Shift not working properly, should be reflected instantly now upon saving
  - EPG Editor changes should be reflected immediately now
  - https epg's not working properly
  - Movies not loading when container_extension is null

  ## v1.6.2
  Added:
  - EPG Editor, right click any channel and you can delete/edit/add programs, change tvgid, match to a different EPG with search. Can also match EPG from different source
  - Source syncing moved to Rust for M3U/Xtream for speed improvement.
  - Vod recent watch tab.
  - Vod Recent watch carousel on home page
  - Saved progress for VOD, will save progress on pressing Stop, switching to LiveTV ch, or gets autoupdated every 30 seconds.
  - For Series, the Up and Down button on the bottom media bar will now go to Previous/Next episode
  - Clicking a recent watched Series will correctly bring it to the current season being watched
  
  Fixes:
  - Dark Theme scrollbar now uses accent color to be more visible.
  - Clicking favorites on a channel doesn't bring channel list back to top
  - Restricting certain MPV args
  - VOD categories loading should be faster, removed lazy loading
  - Disabled Source's VOD won't Show
  - Backend changes that should make Startup faster
  - Documentation updated

  ## v1.6.1
  Added:
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

  Fixes:
  - Removed TMDB automatic matching, was causing slowdowns. It will instead display Trending Now, Top Rated, On the Air, and Popular categories in Home view of Movies/Series. Clicking on one of the movies/series will do a search within your playlist for that specific title.
  - Removed Genre carousel for Vods as it was causing slowdown in loading the Movies/Series page.
  - Vod optimization, categories should show instantly now
  - Fixed Stalker/MAC portal VOD so it doesn't display error message for working streams
  - Now Playing bar not appearing when text is in search field
  
    ## v1.6.0
  Added:
  - Current watching channel is now highlighted in LiveTV/EPG
  - Added new option in Settings -> LiveTV. Enable pause/volume control in the Preview video for EPG. Restart is needed for it to take effect.
  - Double clicking preview video now full screens video in app.
  - Double clicking anywhere on non UI elements now full screens the app, and the reverse to disable full screen
  - Added shortcut key to replay last stream

  Fixes:
  - Scroll is reset on changing categories.
  - Fixed stream starting in paused state when opening after another stream that ended

  ## v1.5.9
  Added:
  - EPG matching for some external EPG providers, when adding sources or editing, check Advanced EPG Matching to enable
  - Autosync will check in background if EPG is stale to the time set in Data Refresh

  Fixes:
  - Certain stalker portals weren't saving channels properly
  - Clear cache vacuums SQLite database
  - db-wal truncates after sync
  - Backend changes
  - Calendar Add to Watchlist
  
  ## v1.5.8
  Added:
  - Current time indicator in EPG
  - When searching in Custom Group Manager and Calendar Change Channel, Source name will be shown as the Main group to differentiate channels from different sources.
  - Added 3 new options in settings.
      - Settings -> Channels -> Include source name in search. Enabling this will also show the Source of channel in search results, and show Source in Multiview mini media bars.
	  - Settings -> Cache -> Live Now Buffer Offset. Set a buffer offset if when clicking Go Live during Cache Time Shift is causing buffer stall. 
      - Settings -> LiveTV -> Make EPG current airing program blocks darker. Enabling this will deepen/darker programs that are live if you are having trouble seeing the highlighted program in certain themes.

  Fixes:
  - Fixed a bug where Height and Width would increase on every launch
  - Fixed EPG preview panel not updating on certain actions.
  - Removed some excessive logging while not in debug mode.

  ## v1.5.7
  Added:
  - Catchup for providers that provide Catchup Channels
  - Cache Time Shift: Uses MPV's --demuxer-max-back-bytes flag to Cache stream while watching, so you can rewind and
  have instant access/replay that's being cached while watching.
  - While watching a live channel that has Catchup and you have cache time shift enabled, you will be able to switch
  between the two in the Now Playing bar.
  - How to enable Cache Time Shift: In Settings -> Cache, Enable Time Shift and select Cache size and restart.
  - Auto-Update

  Fixes:
  - Resizing/Moving while Multiview is selected. It is best to resize/move the app to where you want it before watching
  for best experience.
