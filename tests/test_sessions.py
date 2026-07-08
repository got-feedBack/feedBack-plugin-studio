"""Session CRUD."""

import sqlite3

from conftest import SONG_FILENAME

BASE = "/api/plugins/studio/sessions"


def test_create_requires_song_and_name(client):
    assert client.post(BASE, json={"name": "x"}).status_code == 400
    assert client.post(BASE, json={"song_filename": "a.sloppak"}).status_code == 400
    assert client.post(BASE, json={}).status_code == 400


def test_create_and_get_session(client, session):
    r = client.get(f"{BASE}/{session}")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Jam"
    assert body["song_filename"] == SONG_FILENAME
    assert body["created_by"] == "pytest"
    assert body["master_volume"] == 1.0
    assert body["master_limiter"] == 1
    assert body["tracks"] == []
    assert body["markers"] == []
    assert body["song_meta"] is None  # not in library


def test_get_missing_session_404(client):
    assert client.get(f"{BASE}/9999").status_code == 404


def test_list_sessions_with_track_count(client, session, track):
    rows = client.get(BASE).json()
    assert len(rows) == 1
    assert rows[0]["id"] == session
    assert rows[0]["track_count"] == 1


def test_delete_session_cascades(client, session, track, config_dir):
    client.post(f"{BASE}/{session}/markers", json={"time": 1.0, "name": "M"})
    assert client.delete(f"{BASE}/{session}").json() == {"ok": True}
    assert client.get(f"{BASE}/{session}").status_code == 404
    assert client.get(BASE).json() == []
    assert client.get(f"{BASE}/{session}/mix-settings").json() == []
    # The deleted session's GET is a 404, so verify marker/track cascade
    # directly in the database.
    db = sqlite3.connect(config_dir / "studio.db")
    try:
        for table in ("studio_markers", "studio_tracks", "studio_mix_settings"):
            count = db.execute(
                f"SELECT COUNT(*) FROM {table} WHERE session_id = ?", (session,)
            ).fetchone()[0]
            assert count == 0, f"{table} rows survived session delete"
    finally:
        db.close()


def test_master_settings_persist(client, session):
    r = client.post(f"{BASE}/{session}/master",
                    json={"master_volume": 0.5, "master_limiter": False})
    assert r.json() == {"ok": True}
    body = client.get(f"{BASE}/{session}").json()
    assert body["master_volume"] == 0.5
    assert body["master_limiter"] == 0
