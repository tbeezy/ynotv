  # Changelog

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
