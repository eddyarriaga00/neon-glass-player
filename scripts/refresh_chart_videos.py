"""Add artist-verified Wikidata video IDs for the Apple charts to the bundled catalog."""
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CATALOG = Path(__file__).resolve().parents[1] / "chart-videos.json"
GENRES = (0, 18, 15, 14, 12, 21, 20, 7, 6)
USER_AGENT = "NeonGlassPlayer/1.0 (https://github.com/eddyarriaga00/neon-glass-player)"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=45) as res:
        return json.load(res)


def chart(genre):
    path = f"genre={genre}/" if genre else ""
    entries = fetch(f"https://itunes.apple.com/us/rss/topsongs/limit=30/{path}json")["feed"]["entry"]
    return {e["id"]["attributes"]["im:id"]: (e["im:name"]["label"], e["im:artist"]["label"]) for e in entries}


def title_label(title):
    return re.sub(r"\s+[(\[]\s*(?:feat\.|ft\.|from\b).*?[)\]]$", "", title, flags=re.I).replace("’", "'")


def words(text):
    folded = unicodedata.normalize("NFKC", text).casefold().replace("&", " and ").replace("’", "'")
    return " ".join(re.findall(r"\w+", folded))


def lookup(labels):
    values = " ".join(f"{json.dumps(label, ensure_ascii=False)}@{lang}" for label in labels for lang in ("en", "mul"))
    query = f"""SELECT DISTINCT ?title ?artist ?video WHERE {{
        VALUES ?title {{ {values} }}
        ?song rdfs:label ?title; wdt:P1651 ?video; wdt:P175 ?performer .
        ?performer rdfs:label ?artist . FILTER (LANG(?artist) IN ("en", "mul"))
    }}"""
    url = "https://query.wikidata.org/sparql?" + urlencode({"format": "json", "query": query})
    return fetch(url)["results"]["bindings"]


def main():
    catalog = json.loads(CATALOG.read_text())
    songs = {}
    for genre in GENRES:
        songs.update(chart(genre))
    missing = {k: song for k, song in songs.items() if k not in catalog}
    labels = sorted({title_label(title) for title, _ in missing.values()})
    candidates = defaultdict(set)
    for start in range(0, len(labels), 18):
        for row in lookup(labels[start:start + 18]):
            video = row["video"]["value"]
            if re.fullmatch(r"[\w-]{11}", video, re.ASCII):
                key = (words(row["title"]["value"]), words(row["artist"]["value"]))
                candidates[key].add(video)
    added = 0
    for track_id, (title, artist) in missing.items():
        lead = re.split(r",\s+| & | feat\. ", artist, maxsplit=1, flags=re.I)[0]
        label = words(title_label(title))
        matches = candidates[(label, words(artist))] or candidates[(label, words(lead))]
        if len(matches) == 1:
            catalog[track_id] = {"title": title, "artist": artist, "youtube": next(iter(matches))}
            added += 1
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"Checked {len(songs)} chart tracks. Added {added} video links; {len(catalog)} saved.")


if __name__ == "__main__":
    main()
