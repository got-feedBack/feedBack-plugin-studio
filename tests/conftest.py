import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# The plugin is a flat module directory; make routes importable from tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routes  # noqa: E402

SONG_FILENAME = "song.sloppak"


class FakeMetaDb:
    """Stands in for the host's song-metadata cache."""

    def __init__(self):
        self.meta = {}

    def get(self, filename, mtime, size):
        return self.meta.get(filename)


@pytest.fixture
def dlc_dir(tmp_path):
    d = tmp_path / "dlc"
    d.mkdir()
    return d


@pytest.fixture
def meta_db():
    return FakeMetaDb()


@pytest.fixture
def config_dir(tmp_path):
    return tmp_path / "config"


@pytest.fixture
def client(config_dir, dlc_dir, meta_db):
    app = FastAPI()
    context = {
        "config_dir": config_dir,
        "get_dlc_dir": lambda: dlc_dir,
        "meta_db": meta_db,
    }
    routes.setup(app, context)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def session(client):
    """A created session; returns its id."""
    r = client.post(
        "/api/plugins/studio/sessions",
        json={"song_filename": SONG_FILENAME, "name": "Jam", "created_by": "pytest"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.fixture
def track(client, session):
    """An empty named track in `session`; returns its id."""
    r = client.post(
        f"/api/plugins/studio/sessions/{session}/add-track",
        json={"name": "Guitar", "color": "#ff0000"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]
