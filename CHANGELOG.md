  # Changelog
  

  ## v1.6.1
  Added:
  - Max Search Limit setting(Settings -> LiveTV)
  - Playback debug log info
  - Right click for URL on Channels if you want to play in external player for M3U and Xtream sources
  - Copy Stream URL for Vods of Xtream Code sources
  - Better search query for multi words
  - New Search Team option in Sports for Live Games, clicking the new Search Teams button on a Match Card will do a search for both team names in your playlist for better matching
  - Up/Down channel button in Preview and Now Playing bar
  - List Vod Movies/series by sources so its not one big List
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
