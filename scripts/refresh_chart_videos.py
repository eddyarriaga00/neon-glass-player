"""Refresh YouTube links published on Shazam's song pages for the player charts."""
import json
import re
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlsplit, parse_qs
from urllib.request import Request, urlopen

CATALOG = Path(__file__).resolve().parents[1] / "chart-videos.json"
GENRES = (0, 18, 15, 14, 12, 21, 20, 7, 6)
USER_AGENT = "NeonGlassPlayer/1.0 (https://github.com/eddyarriaga00/neon-glass-player)"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=15) as res:
        return res.read().decode("utf-8")


class RecordingParser(HTMLParser):
    """Read only the page's structured MusicRecording metadata."""

    reading_json = False
    recording = None

    def handle_starttag(self, tag, attrs):
        self.reading_json = tag == "script" and dict(attrs).get("type") == "application/ld+json"

    def handle_endtag(self, tag):
        if tag == "script":
            self.reading_json = False

    def handle_data(self, data):
        if self.reading_json:
            item = json.loads(data)
            if isinstance(item, dict) and item.get("@type") == "MusicRecording":
                self.recording = item


def chart(genre):
    path = f"genre={genre}/" if genre else ""
    url = f"https://itunes.apple.com/us/rss/topsongs/limit=30/{path}json"
    entries = json.loads(fetch(url))["feed"]["entry"]
    return {e["id"]["attributes"]["im:id"]: (e["im:name"]["label"], e["im:artist"]["label"]) for e in entries}


def video_for(item):
    track_id, (title, artist) = item
    slug = re.sub(r"[^\w]+", "-", unicodedata.normalize("NFKD", title).lower()).strip("-")
    parser = RecordingParser()
    parser.feed(fetch(f"https://www.shazam.com/song/{track_id}/{quote(slug or 'song')}"))
    song = parser.recording
    if not song or not urlsplit(song.get("url", "")).path.startswith(f"/song/{track_id}/"):
        return None
    link = urlsplit((song.get("video") or {}).get("embedUrl", ""))
    if link.hostname == "youtu.be":
        video_id = link.path.strip("/")
    elif link.hostname in ("youtube.com", "www.youtube.com") and link.path == "/watch":
        video_id = parse_qs(link.query).get("v", [""])[0]
    else:
        return None
    if re.fullmatch(r"[\w-]{11}", video_id, re.ASCII):
        return {"title": title, "artist": artist, "youtube": video_id}


def main():
    catalog = json.loads(CATALOG.read_text()) if CATALOG.exists() else {}
    songs = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(chart, GENRES):
            songs.update(result)
        tasks = {track_id: pool.submit(video_for, (track_id, song)) for track_id, song in songs.items()}
        errors = 0
        matches = 0
        for track_id, task in tasks.items():
            try:
                entry = task.result()
                if entry:
                    catalog[track_id] = entry
                    matches += 1
            except (ValueError, OSError) as exc:
                print(f"{track_id}: {exc}", file=sys.stderr)
                errors += 1
    if not matches or errors > len(tasks) / 2:
        sys.exit("Chart sources unavailable. Keeping the previous catalog.")
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"{matches} YouTube links from {len(songs)} chart tracks; {len(catalog)} saved.")


if __name__ == "__main__":
    main()
