"""Markers and mix-settings persistence."""

from conftest import SONG_FILENAME

SESSIONS = "/api/plugins/studio/sessions"
MARKERS = "/api/plugins/studio/markers"


def _marker(client, session, time=1.0, name="M", **kw):
    return client.post(f"{SESSIONS}/{session}/markers",
                       json={"time": time, "name": name, **kw})


# ── Markers ───────────────────────────────────────────────────────────────────

def test_add_marker_defaults(client, session):
    body = _marker(client, session, 12.5, "Chorus").json()
    assert body["time"] == 12.5
    assert body["name"] == "Chorus"
    assert body["color"] == "#e0a030"

    markers = client.get(f"{SESSIONS}/{session}").json()["markers"]
    assert len(markers) == 1


def test_markers_sorted_by_time(client, session):
    _marker(client, session, 30.0, "Late")
    _marker(client, session, 5.0, "Early")
    markers = client.get(f"{SESSIONS}/{session}").json()["markers"]
    assert [m["name"] for m in markers] == ["Early", "Late"]


def test_rename_and_delete_marker(client, session):
    mid = _marker(client, session).json()["id"]
    assert client.post(f"{MARKERS}/{mid}/rename", json={"name": "Bridge"}).json() == {"ok": True}
    assert client.post(f"{MARKERS}/{mid}/rename", json={"name": ""}).status_code == 400
    assert client.delete(f"{MARKERS}/{mid}").json() == {"ok": True}
    assert client.get(f"{SESSIONS}/{session}").json()["markers"] == []


def test_import_markers_from_song_meta(client, session, dlc_dir, meta_db):
    (dlc_dir / SONG_FILENAME).write_bytes(b"x")
    meta_db.meta[SONG_FILENAME] = {"sections": [
        {"name": "Intro", "start_time": 0.0},
        {"name": "Verse", "start_time": 20.0},
    ]}
    r = client.post(f"{SESSIONS}/{session}/import-markers")
    assert r.status_code == 200
    assert r.json()["added"] == 2

    # Re-import dedupes on time proximity.
    assert client.post(f"{SESSIONS}/{session}/import-markers").json()["added"] == 0
    assert len(client.get(f"{SESSIONS}/{session}").json()["markers"]) == 2


def test_import_markers_error_paths(client, session, dlc_dir, meta_db):
    assert client.post(f"{SESSIONS}/9999/import-markers").status_code == 404
    # No metadata available.
    assert client.post(f"{SESSIONS}/{session}/import-markers").status_code == 400
    # Metadata but no sections.
    (dlc_dir / SONG_FILENAME).write_bytes(b"x")
    meta_db.meta[SONG_FILENAME] = {"sections": []}
    assert client.post(f"{SESSIONS}/{session}/import-markers").status_code == 400


# ── Mix settings ──────────────────────────────────────────────────────────────

def test_save_mix_settings_upsert(client, session, track):
    url = f"{SESSIONS}/{session}/mix-settings"
    r = client.post(url, json={"settings": [
        {"track_id": track, "volume": 0.8, "pan": -0.5, "muted": 1, "eq_low": 3.0},
    ]})
    assert r.json() == {"ok": True}

    s = client.get(url).json()[0]
    assert s["volume"] == 0.8
    assert s["pan"] == -0.5
    assert s["muted"] == 1
    assert s["eq_low"] == 3.0
    # Unspecified fields fall back to defaults.
    assert s["comp_threshold"] == -24.0
    assert s["comp_ratio"] == 1.0

    # Second save updates in place — still one row.
    client.post(url, json={"settings": [{"track_id": track, "volume": 0.3}]})
    rows = client.get(url).json()
    assert len(rows) == 1
    assert rows[0]["volume"] == 0.3
    # Partial update resets omitted fields to defaults (documented behavior).
    assert rows[0]["eq_low"] == 0.0


def test_mix_settings_scoped_per_session(client, session, track):
    other = client.post(SESSIONS, json={"song_filename": "o.sloppak", "name": "O"}).json()["id"]
    assert client.get(f"{SESSIONS}/{other}/mix-settings").json() == []
    assert len(client.get(f"{SESSIONS}/{session}/mix-settings").json()) == 1
