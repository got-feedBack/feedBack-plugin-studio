"""Track management: add, rename, color, reorder, activate, delete."""

SESSIONS = "/api/plugins/studio/sessions"
TRACKS = "/api/plugins/studio/tracks"


def _add(client, session, name, color=""):
    r = client.post(f"{SESSIONS}/{session}/add-track", json={"name": name, "color": color})
    assert r.status_code == 200, r.text
    return r.json()


def test_add_track_to_missing_session_404(client):
    assert client.post(f"{SESSIONS}/9999/add-track", json={"name": "x"}).status_code == 404


def test_add_track_defaults_and_sort_order(client, session):
    t1 = _add(client, session, "Guitar")
    t2 = _add(client, session, "Bass")
    assert t1["sort_order"] == 1
    assert t2["sort_order"] == 2

    tracks = client.get(f"{SESSIONS}/{session}").json()["tracks"]
    assert [t["track_name"] for t in tracks] == ["Guitar", "Bass"]
    assert all(t["is_active"] == 1 for t in tracks)


def test_add_track_creates_default_mix_settings(client, session, track):
    settings = client.get(f"{SESSIONS}/{session}/mix-settings").json()
    assert len(settings) == 1
    s = settings[0]
    assert s["track_id"] == track
    assert s["volume"] == 1.0
    assert s["pan"] == 0.0
    assert s["muted"] == 0
    assert s["solo"] == 0


def test_rename_track(client, session, track):
    assert client.post(f"{TRACKS}/{track}/rename", json={"name": "Lead"}).json() == {"ok": True}
    tracks = client.get(f"{SESSIONS}/{session}").json()["tracks"]
    assert tracks[0]["track_name"] == "Lead"


def test_rename_track_requires_name(client, track):
    assert client.post(f"{TRACKS}/{track}/rename", json={"name": "  "}).status_code == 400
    assert client.post(f"{TRACKS}/{track}/rename", json={}).status_code == 400


def test_set_track_color(client, session, track):
    client.post(f"{TRACKS}/{track}/color", json={"color": "#00ff00"})
    tracks = client.get(f"{SESSIONS}/{session}").json()["tracks"]
    assert tracks[0]["color"] == "#00ff00"


def test_reorder_tracks(client, session):
    t1 = _add(client, session, "A")["id"]
    t2 = _add(client, session, "B")["id"]
    t3 = _add(client, session, "C")["id"]
    client.post(f"{SESSIONS}/{session}/reorder", json={"order": [t3, t1, t2]})
    tracks = client.get(f"{SESSIONS}/{session}").json()["tracks"]
    assert [t["track_name"] for t in tracks] == ["C", "A", "B"]


def test_reorder_ignores_foreign_session_tracks(client, session):
    t1 = _add(client, session, "A")["id"]
    other = client.post(SESSIONS, json={"song_filename": "o.sloppak", "name": "Other"}).json()["id"]
    t_other = _add(client, other, "X")["id"]

    client.post(f"{SESSIONS}/{session}/reorder", json={"order": [t_other, t1]})
    other_tracks = client.get(f"{SESSIONS}/{other}").json()["tracks"]
    assert other_tracks[0]["sort_order"] == 1  # untouched by foreign reorder


def test_activate_deactivates_other_takes(client, session):
    # Same instrument (name doubles as instrument for custom tracks).
    t1 = _add(client, session, "Guitar")["id"]
    t2 = _add(client, session, "Guitar")["id"]

    assert client.post(f"{TRACKS}/{t1}/activate").json() == {"ok": True}
    tracks = {t["id"]: t for t in client.get(f"{SESSIONS}/{session}").json()["tracks"]}
    assert tracks[t1]["is_active"] == 1
    assert tracks[t2]["is_active"] == 0

    client.post(f"{TRACKS}/{t2}/activate")
    tracks = {t["id"]: t for t in client.get(f"{SESSIONS}/{session}").json()["tracks"]}
    assert tracks[t1]["is_active"] == 0
    assert tracks[t2]["is_active"] == 1


def test_activate_missing_track_404(client):
    assert client.post(f"{TRACKS}/9999/activate").status_code == 404


def test_delete_track_removes_mix_settings(client, session, track):
    assert client.delete(f"{TRACKS}/{track}").json() == {"ok": True}
    assert client.get(f"{SESSIONS}/{session}").json()["tracks"] == []
    assert client.get(f"{SESSIONS}/{session}/mix-settings").json() == []


def test_delete_missing_track_404(client):
    assert client.delete(f"{TRACKS}/9999").status_code == 404
