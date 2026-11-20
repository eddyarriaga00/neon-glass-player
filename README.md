# Neon Glass Player

A neon glass music player that runs entirely in the browser (GitHub Pages, no server, no paid services).

- Search and 30-second previews from the Apple Music catalog (iTunes Search API, no key)
- Synced, scrolling lyrics from LRCLIB (no key)
- Optional full-length Spotify playback: paste your own Spotify app Client ID under "Connect Spotify" (Premium required by Spotify)
- Pick a primary service (Apple Music or Spotify): it leads the list and handles playback when it can
- "Open in" links for Apple Music and Spotify
- In Settings, choose **Animated background → Video** to show a muted YouTube video matched by artist and title using links from Shazam, Wikidata, TheAudioDB, and Wikipedia song articles. GitHub Actions checks Wikidata daily for new chart matches. Settings links to the matched video or opens a YouTube search for songs without an indexed video. You can also paste a YouTube link for the current song. If YouTube is unavailable, the player tries an Apple music video clip, then uses the animated background where supported.
