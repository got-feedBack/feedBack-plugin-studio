"""Band Studio plugin — collaborative recording & mixing."""

import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time as _time
from pathlib import Path

from fastapi import UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse, Response


def setup(app, context):
    config_dir = context["config_dir"]
    get_dlc_dir = context["get_dlc_dir"]

    STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"
    STUDIO_DIR = config_dir / "studio"

    # ── Database ────────────────────────────────────────────────────────

    _db_path = str(config_dir / "studio.db")
    _conn = None
    _lock = threading.Lock()

    def _get_db():
        nonlocal _conn
        if _conn is None:
            config_dir.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(_db_path, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript("""
                CREATE TABLE IF NOT EXISTS studio_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    song_filename TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_by TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    master_volume REAL NOT NULL DEFAULT 1.0,
                    master_limiter INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS studio_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    instrument TEXT NOT NULL,
                    recorded_by TEXT NOT NULL DEFAULT '',
                    take_number INTEGER NOT NULL DEFAULT 1,
                    audio_path TEXT NOT NULL,
                    duration REAL NOT NULL DEFAULT 0.0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    is_active INTEGER NOT NULL DEFAULT 1,
                    track_name TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    color TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (session_id) REFERENCES studio_sessions(id)
                );

                CREATE TABLE IF NOT EXISTS studio_mix_settings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    track_id INTEGER NOT NULL,
                    volume REAL NOT NULL DEFAULT 1.0,
                    pan REAL NOT NULL DEFAULT 0.0,
                    muted INTEGER NOT NULL DEFAULT 0,
                    solo INTEGER NOT NULL DEFAULT 0,
                    offset_ms REAL NOT NULL DEFAULT 0.0,
                    fade_in_ms REAL NOT NULL DEFAULT 0.0,
                    fade_out_ms REAL NOT NULL DEFAULT 0.0,
                    eq_low REAL NOT NULL DEFAULT 0.0,
                    eq_mid REAL NOT NULL DEFAULT 0.0,
                    eq_high REAL NOT NULL DEFAULT 0.0,
                    reverb_send REAL NOT NULL DEFAULT 0.0,
                    comp_threshold REAL NOT NULL DEFAULT -24.0,
                    comp_ratio REAL NOT NULL DEFAULT 1.0,
                    comp_attack REAL NOT NULL DEFAULT 0.003,
                    comp_release REAL NOT NULL DEFAULT 0.25,
                    UNIQUE(session_id, track_id),
                    FOREIGN KEY (session_id) REFERENCES studio_sessions(id),
                    FOREIGN KEY (track_id) REFERENCES studio_tracks(id)
                );

                CREATE TABLE IF NOT EXISTS studio_markers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    time REAL NOT NULL,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL DEFAULT '#e0a030',
                    FOREIGN KEY (session_id) REFERENCES studio_sessions(id)
                );
            """)
            _conn.commit()

            # Migrate: add columns if missing (existing DBs)
            session_cols = {r[1] for r in _conn.execute("PRAGMA table_info(studio_sessions)").fetchall()}
            if "master_volume" not in session_cols:
                _conn.execute("ALTER TABLE studio_sessions ADD COLUMN master_volume REAL NOT NULL DEFAULT 1.0")
            if "master_limiter" not in session_cols:
                _conn.execute("ALTER TABLE studio_sessions ADD COLUMN master_limiter INTEGER NOT NULL DEFAULT 1")
            cols = {r[1] for r in _conn.execute("PRAGMA table_info(studio_tracks)").fetchall()}
            for col, default in [("track_name", "''"), ("sort_order", "0"), ("color", "''")]:
                if col not in cols:
                    _conn.execute(f"ALTER TABLE studio_tracks ADD COLUMN {col} TEXT NOT NULL DEFAULT {default}")
            mix_cols = {r[1] for r in _conn.execute("PRAGMA table_info(studio_mix_settings)").fetchall()}
            _mix_defaults = {
                "offset_ms": 0.0, "fade_in_ms": 0.0, "fade_out_ms": 0.0,
                "eq_low": 0.0, "eq_mid": 0.0, "eq_high": 0.0,
                "reverb_send": 0.0,
                "comp_threshold": -24.0, "comp_ratio": 1.0,
                "comp_attack": 0.003, "comp_release": 0.25,
            }
            for col, default in _mix_defaults.items():
                if col not in mix_cols:
                    _conn.execute(f"ALTER TABLE studio_mix_settings ADD COLUMN {col} REAL NOT NULL DEFAULT {default}")
            _conn.commit()

        return _conn

    def _row_to_dict(row):
        return dict(row) if row else None

    def _rows_to_list(rows):
        return [dict(r) for r in rows]

    # ── Sessions CRUD ───────────────────────────────────────────────────

    @app.get("/api/plugins/studio/sessions")
    def list_sessions():
        db = _get_db()
        rows = db.execute(
            "SELECT * FROM studio_sessions ORDER BY created_at DESC"
        ).fetchall()
        sessions = _rows_to_list(rows)
        # Attach track counts
        for s in sessions:
            count = db.execute(
                "SELECT COUNT(*) FROM studio_tracks WHERE session_id = ?",
                (s["id"],),
            ).fetchone()[0]
            s["track_count"] = count
        return sessions

    @app.post("/api/plugins/studio/sessions")
    def create_session(data: dict):
        song_filename = data.get("song_filename", "")
        name = data.get("name", "")
        created_by = data.get("created_by", "")
        if not song_filename or not name:
            return JSONResponse({"error": "song_filename and name required"}, 400)
        db = _get_db()
        with _lock:
            cur = db.execute(
                "INSERT INTO studio_sessions (song_filename, name, created_by) VALUES (?, ?, ?)",
                (song_filename, name, created_by),
            )
            db.commit()
            session_id = cur.lastrowid
        # Create storage directory
        (STUDIO_DIR / str(session_id)).mkdir(parents=True, exist_ok=True)
        return {"id": session_id}

    @app.get("/api/plugins/studio/sessions/{session_id}")
    def get_session(session_id: int):
        db = _get_db()
        row = db.execute(
            "SELECT * FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Session not found"}, 404)
        session = _row_to_dict(row)
        # Attach tracks
        tracks = _rows_to_list(
            db.execute(
                "SELECT * FROM studio_tracks WHERE session_id = ? ORDER BY sort_order, id",
                (session_id,),
            ).fetchall()
        )
        session["tracks"] = tracks
        # Attach song metadata if available
        session["song_meta"] = _get_song_meta(session["song_filename"])
        # Attach markers
        session["markers"] = _rows_to_list(
            db.execute(
                "SELECT * FROM studio_markers WHERE session_id = ? ORDER BY time",
                (session_id,),
            ).fetchall()
        )
        return session

    @app.delete("/api/plugins/studio/sessions/{session_id}")
    def delete_session(session_id: int):
        db = _get_db()
        with _lock:
            db.execute("DELETE FROM studio_markers WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM studio_mix_settings WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM studio_tracks WHERE session_id = ?", (session_id,))
            db.execute("DELETE FROM studio_sessions WHERE id = ?", (session_id,))
            db.commit()
        # Remove audio files
        session_dir = STUDIO_DIR / str(session_id)
        if session_dir.exists():
            shutil.rmtree(session_dir, ignore_errors=True)
        return {"ok": True}

    # ── Track Upload & Management ───────────────────────────────────────

    @app.post("/api/plugins/studio/sessions/{session_id}/upload")
    async def upload_track(
        session_id: int,
        file: UploadFile = File(...),
        instrument: str = Form("Lead"),
        recorded_by: str = Form(""),
        expected_duration: float = Form(0.0),
        trim_start: float = Form(0.0),
        input_gain: float = Form(1.0),
    ):
        db = _get_db()
        # Verify session exists
        row = db.execute(
            "SELECT id FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Session not found"}, 404)

        # Determine take number and sort order
        existing = db.execute(
            "SELECT MAX(take_number) FROM studio_tracks WHERE session_id = ? AND instrument = ?",
            (session_id, instrument),
        ).fetchone()
        take_number = (existing[0] or 0) + 1

        max_order = db.execute(
            "SELECT MAX(sort_order) FROM studio_tracks WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        sort_order = (max_order[0] or 0) + 1

        # Track name: use instrument + take number, or custom name if provided
        track_name = instrument
        if take_number > 1:
            track_name = f"{instrument} {take_number}"

        # Save the audio file
        session_dir = STUDIO_DIR / str(session_id)
        session_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(file.filename).suffix if file.filename else ".wav"
        if ext not in (".wav", ".mp3", ".ogg", ".webm"):
            ext = ".wav"

        # Insert track record
        with _lock:
            cur = db.execute(
                """INSERT INTO studio_tracks
                   (session_id, instrument, recorded_by, take_number, audio_path,
                    is_active, track_name, sort_order)
                   VALUES (?, ?, ?, ?, '', 1, ?, ?)""",
                (session_id, instrument, recorded_by, take_number, track_name, sort_order),
            )
            db.commit()
            track_id = cur.lastrowid

        # Save uploaded file (likely webm from browser MediaRecorder)
        raw_filename = f"track_{track_id}_raw{ext}"
        raw_path = session_dir / raw_filename
        content = await file.read()
        raw_path.write_bytes(content)

        # Convert to WAV — webm from MediaRecorder lacks duration metadata
        # and some browsers can't decode it with decodeAudioData().
        # Don't force sample rate — let ffmpeg autodetect from the webm.
        audio_filename = f"track_{track_id}.wav"
        audio_path = session_dir / audio_filename
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(raw_path), str(audio_path)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode == 0 and audio_path.exists():
                raw_path.unlink(missing_ok=True)
                print(f"[Studio] Converted webm→wav: {_get_audio_duration(str(audio_path)):.1f}s"
                      f" (expected {expected_duration:.1f}s)")
            else:
                print(f"[Studio] WAV conversion failed: {result.stderr[-300:]}")
                audio_path = raw_path
                audio_filename = raw_filename
        except Exception as e:
            print(f"[Studio] WAV conversion error: {e}")
            audio_path = raw_path
            audio_filename = raw_filename

        # Get duration
        duration = _get_audio_duration(str(audio_path))

        # ── Trim pre-play silence ───────────────────────────────────
        # When recording on the highway, the MediaRecorder starts before
        # the user presses Play. trim_start is the seconds of dead time
        # before audio playback began. Remove it so the recording aligns
        # with the song timeline.
        if trim_start > 0.1 and duration > trim_start:
            trimmed_path = session_dir / f"track_{track_id}_trimmed.wav"
            try:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-i", str(audio_path),
                     "-ss", f"{trim_start:.3f}", "-acodec", "copy",
                     str(trimmed_path)],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode == 0 and trimmed_path.exists():
                    audio_path.unlink(missing_ok=True)
                    trimmed_path.rename(audio_path)
                    duration = _get_audio_duration(str(audio_path))
                    print(f"[Studio] Trimmed {trim_start:.1f}s from start, "
                          f"new duration: {duration:.1f}s")
                else:
                    print(f"[Studio] Trim failed: {result.stderr[-200:]}")
            except Exception as e:
                print(f"[Studio] Trim error: {e}")

        # ── Input gain ──────────────────────────────────────────────
        # Apply the gain the user set in the recording overlay.
        # Done server-side because the browser records from the raw mic
        # stream (to avoid clock drift from AudioContext routing).
        if input_gain > 0.0 and abs(input_gain - 1.0) > 0.01:
            gained_path = session_dir / f"track_{track_id}_gained.wav"
            try:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-i", str(audio_path),
                     "-filter:a", f"volume={input_gain:.3f}",
                     str(gained_path)],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode == 0 and gained_path.exists():
                    audio_path.unlink(missing_ok=True)
                    gained_path.rename(audio_path)
                    print(f"[Studio] Applied input gain: {input_gain:.2f}")
                else:
                    print(f"[Studio] Gain apply failed: {result.stderr[-200:]}")
            except Exception as e:
                print(f"[Studio] Gain apply error: {e}")

        # ── Drift correction ────────────────────────────────────────
        # The browser's mic clock and audio playback clock drift apart.
        # expected_duration is audio.currentTime when recording stopped.
        # Only correct small drift (< 5%). Anything larger (like 2x) is a
        # conversion bug, not drift — don't mangle the audio.
        if expected_duration > 1.0 and duration > 1.0:
            drift_pct = abs(duration - expected_duration) / expected_duration
            if 0.0005 < drift_pct < 0.05:
                tempo = duration / expected_duration
                corrected_path = session_dir / f"track_{track_id}_corrected.wav"
                try:
                    result = subprocess.run(
                        [
                            "ffmpeg", "-y", "-i", str(audio_path),
                            "-filter:a", f"atempo={tempo:.6f}",
                            str(corrected_path),
                        ],
                        capture_output=True, text=True, timeout=120,
                    )
                    if result.returncode == 0 and corrected_path.exists():
                        audio_path.unlink(missing_ok=True)
                        corrected_path.rename(audio_path)
                        duration = _get_audio_duration(str(audio_path))
                        print(f"[Studio] Drift corrected: {drift_pct*100:.2f}% "
                              f"(atempo={tempo:.6f}, {expected_duration:.1f}s expected)")
                    else:
                        print(f"[Studio] Drift correction failed: {result.stderr[-200:]}")
                except Exception as e:
                    print(f"[Studio] Drift correction error: {e}")
            elif drift_pct >= 0.05:
                print(f"[Studio] WARNING: duration mismatch too large to be drift: "
                      f"{duration:.1f}s vs {expected_duration:.1f}s ({drift_pct*100:.1f}%) — skipping correction")

        with _lock:
            db.execute(
                "UPDATE studio_tracks SET audio_path = ?, duration = ? WHERE id = ?",
                (str(audio_path), duration, track_id),
            )
            # Create default mix settings
            db.execute(
                """INSERT OR IGNORE INTO studio_mix_settings
                   (session_id, track_id, volume, pan, muted, solo)
                   VALUES (?, ?, 1.0, 0.0, 0, 0)""",
                (session_id, track_id),
            )
            db.commit()

        return {
            "id": track_id,
            "instrument": instrument,
            "recorded_by": recorded_by,
            "take_number": take_number,
            "duration": duration,
            "is_active": 1,
        }

    @app.delete("/api/plugins/studio/tracks/{track_id}")
    def delete_track(track_id: int):
        db = _get_db()
        row = db.execute(
            "SELECT * FROM studio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Track not found"}, 404)
        track = _row_to_dict(row)
        with _lock:
            db.execute("DELETE FROM studio_mix_settings WHERE track_id = ?", (track_id,))
            db.execute("DELETE FROM studio_tracks WHERE id = ?", (track_id,))
            db.commit()
        # Remove audio file
        if track["audio_path"] and Path(track["audio_path"]).exists():
            Path(track["audio_path"]).unlink(missing_ok=True)
        return {"ok": True}

    @app.post("/api/plugins/studio/tracks/{track_id}/activate")
    def activate_track(track_id: int):
        db = _get_db()
        row = db.execute(
            "SELECT * FROM studio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Track not found"}, 404)
        track = _row_to_dict(row)
        with _lock:
            # Deactivate other takes of the same instrument in same session
            db.execute(
                "UPDATE studio_tracks SET is_active = 0 WHERE session_id = ? AND instrument = ?",
                (track["session_id"], track["instrument"]),
            )
            db.execute(
                "UPDATE studio_tracks SET is_active = 1 WHERE id = ?", (track_id,)
            )
            db.commit()
        return {"ok": True}

    # ── Track management (custom channels) ─────────────────────────────

    @app.post("/api/plugins/studio/sessions/{session_id}/add-track")
    def add_track(session_id: int, data: dict):
        """Add an empty named track to the session."""
        db = _get_db()
        row = db.execute(
            "SELECT id FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Session not found"}, 404)

        track_name = data.get("name", "New Track").strip()
        color = data.get("color", "")

        max_order = db.execute(
            "SELECT MAX(sort_order) FROM studio_tracks WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        sort_order = (max_order[0] or 0) + 1

        with _lock:
            cur = db.execute(
                """INSERT INTO studio_tracks
                   (session_id, instrument, recorded_by, take_number, audio_path,
                    duration, is_active, track_name, sort_order, color)
                   VALUES (?, ?, '', 1, '', 0.0, 1, ?, ?, ?)""",
                (session_id, track_name, track_name, sort_order, color),
            )
            db.commit()
            track_id = cur.lastrowid

        # Create default mix settings
        with _lock:
            db.execute(
                """INSERT OR IGNORE INTO studio_mix_settings
                   (session_id, track_id, volume, pan, muted, solo)
                   VALUES (?, ?, 1.0, 0.0, 0, 0)""",
                (session_id, track_id),
            )
            db.commit()

        return {"id": track_id, "track_name": track_name, "sort_order": sort_order}

    @app.post("/api/plugins/studio/tracks/{track_id}/rename")
    def rename_track(track_id: int, data: dict):
        """Rename a track."""
        db = _get_db()
        name = data.get("name", "").strip()
        if not name:
            return JSONResponse({"error": "Name required"}, 400)
        with _lock:
            db.execute(
                "UPDATE studio_tracks SET track_name = ? WHERE id = ?",
                (name, track_id),
            )
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/tracks/{track_id}/color")
    def set_track_color(track_id: int, data: dict):
        """Set track color."""
        db = _get_db()
        color = data.get("color", "")
        with _lock:
            db.execute(
                "UPDATE studio_tracks SET color = ? WHERE id = ?",
                (color, track_id),
            )
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/sessions/{session_id}/reorder")
    def reorder_tracks(session_id: int, data: dict):
        """Reorder tracks. Expects {"order": [track_id, track_id, ...]}"""
        db = _get_db()
        order = data.get("order", [])
        with _lock:
            for i, tid in enumerate(order):
                db.execute(
                    "UPDATE studio_tracks SET sort_order = ? WHERE id = ? AND session_id = ?",
                    (i, tid, session_id),
                )
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/tracks/{track_id}/import-audio")
    async def import_audio_to_track(track_id: int, file: UploadFile = File(...)):
        """Import an audio file (WAV/MP3/OGG) into an existing track."""
        db = _get_db()
        row = db.execute(
            "SELECT * FROM studio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Track not found"}, 404)
        track = _row_to_dict(row)

        session_dir = STUDIO_DIR / str(track["session_id"])
        session_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(file.filename).suffix if file.filename else ".wav"
        if ext not in (".wav", ".mp3", ".ogg", ".flac", ".webm"):
            ext = ".wav"

        # Save the uploaded file
        raw_path = session_dir / f"track_{track_id}_import{ext}"
        content = await file.read()
        raw_path.write_bytes(content)

        # Convert to WAV if needed
        audio_path = session_dir / f"track_{track_id}.wav"
        if ext == ".wav":
            raw_path.rename(audio_path)
        else:
            try:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-i", str(raw_path), str(audio_path)],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode == 0 and audio_path.exists():
                    raw_path.unlink(missing_ok=True)
                else:
                    audio_path = raw_path
            except Exception:
                audio_path = raw_path

        duration = _get_audio_duration(str(audio_path))

        with _lock:
            db.execute(
                "UPDATE studio_tracks SET audio_path = ?, duration = ? WHERE id = ?",
                (str(audio_path), duration, track_id),
            )
            db.commit()

        return {"ok": True, "duration": duration}

    # ── Punch-in Splice ─────────────────────────────────────────────────

    @app.post("/api/plugins/studio/tracks/{track_id}/splice")
    async def splice_track(
        track_id: int,
        file: UploadFile = File(...),
        punch_in: float = Form(0.0),
        punch_out: float = Form(0.0),
    ):
        """Splice a recorded section into an existing track at the punch in/out points."""
        db = _get_db()
        row = db.execute(
            "SELECT * FROM studio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Track not found"}, 404)
        track = _row_to_dict(row)

        if not track["audio_path"] or not Path(track["audio_path"]).exists():
            return JSONResponse({"error": "Track has no audio to splice into"}, 400)
        if punch_in >= punch_out:
            return JSONResponse({"error": "Punch in must be before punch out"}, 400)

        session_dir = STUDIO_DIR / str(track["session_id"])
        session_dir.mkdir(parents=True, exist_ok=True)

        # Save the uploaded punch recording
        raw_path = session_dir / f"track_{track_id}_punch_raw.webm"
        content = await file.read()
        raw_path.write_bytes(content)

        # Convert to WAV
        punch_wav = session_dir / f"track_{track_id}_punch.wav"
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(raw_path), str(punch_wav)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode == 0 and punch_wav.exists():
                raw_path.unlink(missing_ok=True)
            else:
                return JSONResponse({"error": f"Punch audio conversion failed"}, 500)
        except Exception as e:
            return JSONResponse({"error": str(e)}, 500)

        # Splice: original[0..in] + punch + original[out..end]
        original_path = track["audio_path"]
        spliced_path = session_dir / f"track_{track_id}_spliced.wav"

        punch_duration = punch_out - punch_in
        punch_audio_dur = _get_audio_duration(str(punch_wav))

        # Trim the punch recording to the exact punch duration
        punch_trimmed = session_dir / f"track_{track_id}_punch_trim.wav"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(punch_wav),
                 "-t", f"{punch_duration:.3f}", str(punch_trimmed)],
                capture_output=True, text=True, timeout=60,
            )
        except Exception:
            punch_trimmed = punch_wav

        # Build the splice filter
        try:
            # 3-way concat: before + punch + after
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", original_path,
                    "-i", str(punch_trimmed),
                    "-filter_complex",
                    f"[0:a]atrim=0:{punch_in:.3f},asetpts=PTS-STARTPTS[before];"
                    f"[1:a]asetpts=PTS-STARTPTS[punch];"
                    f"[0:a]atrim=start={punch_out:.3f},asetpts=PTS-STARTPTS[after];"
                    f"[before][punch][after]concat=n=3:v=0:a=1[out]",
                    "-map", "[out]", str(spliced_path),
                ],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                return JSONResponse({"error": f"Splice failed: {result.stderr[-300:]}"}, 500)
        except Exception as e:
            return JSONResponse({"error": str(e)}, 500)
        finally:
            punch_wav.unlink(missing_ok=True)
            punch_trimmed.unlink(missing_ok=True)

        # Replace original with spliced
        if spliced_path.exists():
            Path(original_path).unlink(missing_ok=True)
            spliced_path.rename(original_path)

        duration = _get_audio_duration(original_path)
        with _lock:
            db.execute(
                "UPDATE studio_tracks SET duration = ? WHERE id = ?",
                (duration, track_id),
            )
            db.commit()

        print(f"[Studio] Punch-in spliced: {punch_in:.1f}s-{punch_out:.1f}s into track {track_id}")
        return {"ok": True, "duration": duration}

    # ── Markers ─────────────────────────────────────────────────────────

    @app.post("/api/plugins/studio/sessions/{session_id}/markers")
    def add_marker(session_id: int, data: dict):
        db = _get_db()
        t = data.get("time", 0.0)
        name = data.get("name", "Marker").strip()
        color = data.get("color", "#e0a030")
        with _lock:
            cur = db.execute(
                "INSERT INTO studio_markers (session_id, time, name, color) VALUES (?, ?, ?, ?)",
                (session_id, t, name, color),
            )
            db.commit()
        return {"id": cur.lastrowid, "time": t, "name": name, "color": color}

    @app.delete("/api/plugins/studio/markers/{marker_id}")
    def delete_marker(marker_id: int):
        db = _get_db()
        with _lock:
            db.execute("DELETE FROM studio_markers WHERE id = ?", (marker_id,))
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/markers/{marker_id}/rename")
    def rename_marker(marker_id: int, data: dict):
        db = _get_db()
        name = data.get("name", "").strip()
        if not name:
            return JSONResponse({"error": "Name required"}, 400)
        with _lock:
            db.execute("UPDATE studio_markers SET name = ? WHERE id = ?", (name, marker_id))
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/sessions/{session_id}/import-markers")
    def import_markers_from_song(session_id: int):
        """Import section markers from the song's metadata."""
        db = _get_db()
        row = db.execute(
            "SELECT song_filename FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Session not found"}, 404)

        meta = _get_song_meta(row["song_filename"])
        if not meta:
            return JSONResponse({"error": "No song metadata available"}, 400)

        sections = []
        if isinstance(meta, dict):
            sections = meta.get("sections", [])

        if not sections:
            return JSONResponse({"error": "No sections found in song"}, 400)

        added = 0
        with _lock:
            for s in sections:
                name = s.get("name", "Section") if isinstance(s, dict) else str(s)
                time_val = s.get("start_time", 0.0) if isinstance(s, dict) else 0.0
                # Skip duplicates
                existing = db.execute(
                    "SELECT id FROM studio_markers WHERE session_id = ? AND abs(time - ?) < 0.5",
                    (session_id, time_val),
                ).fetchone()
                if not existing:
                    db.execute(
                        "INSERT INTO studio_markers (session_id, time, name) VALUES (?, ?, ?)",
                        (session_id, time_val, name),
                    )
                    added += 1
            db.commit()
        return {"ok": True, "added": added}

    # ── Gear Images (from tones plugin assets) ────────────────────────

    @app.get("/api/plugins/studio/gear-image/{name}")
    def get_gear_image(name: str):
        """Serve rack/pedal images for the effect UI."""
        plugin_dir = Path(__file__).resolve().parent.parent
        # Try tones plugin assets
        for subdir in ["racks", "pedals", "amps", "cabs"]:
            for tones_dir in [plugin_dir / "tones" / "assets", plugin_dir / "tones"]:
                img = tones_dir / subdir / f"{name}.png"
                if img.exists():
                    return FileResponse(str(img), media_type="image/png")
        return JSONResponse({"error": "not found"}, 404)

    # ── Audio Serving ───────────────────────────────────────────────────

    @app.get("/api/plugins/studio/tracks/{track_id}/audio")
    def serve_track_audio(track_id: int):
        db = _get_db()
        row = db.execute(
            "SELECT audio_path FROM studio_tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row or not row["audio_path"]:
            return JSONResponse({"error": "Track not found"}, 404)
        path = Path(row["audio_path"])
        if not path.exists():
            return JSONResponse({"error": "Audio file missing"}, 404)
        media_type = {
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".ogg": "audio/ogg",
            ".webm": "audio/webm",
        }.get(path.suffix, "application/octet-stream")
        return FileResponse(str(path), media_type=media_type)

    # ── Mix Settings ────────────────────────────────────────────────────

    @app.get("/api/plugins/studio/sessions/{session_id}/mix-settings")
    def get_mix_settings(session_id: int):
        db = _get_db()
        rows = db.execute(
            "SELECT * FROM studio_mix_settings WHERE session_id = ?",
            (session_id,),
        ).fetchall()
        return _rows_to_list(rows)

    _MIX_FIELDS = {
        "volume": 1.0, "pan": 0.0, "muted": 0, "solo": 0,
        "offset_ms": 0.0, "fade_in_ms": 0.0, "fade_out_ms": 0.0,
        "eq_low": 0.0, "eq_mid": 0.0, "eq_high": 0.0,
        "reverb_send": 0.0,
        "comp_threshold": -24.0, "comp_ratio": 1.0,
        "comp_attack": 0.003, "comp_release": 0.25,
    }

    @app.post("/api/plugins/studio/sessions/{session_id}/mix-settings")
    def save_mix_settings(session_id: int, data: dict):
        db = _get_db()
        settings = data.get("settings", [])
        fields = list(_MIX_FIELDS.keys())
        cols = ", ".join(fields)
        placeholders = ", ".join(["?"] * len(fields))
        updates = ", ".join(f"{f}=?" for f in fields)
        with _lock:
            for s in settings:
                vals = [s.get(f, _MIX_FIELDS[f]) for f in fields]
                db.execute(
                    f"""INSERT INTO studio_mix_settings
                       (session_id, track_id, {cols})
                       VALUES (?, ?, {placeholders})
                       ON CONFLICT(session_id, track_id)
                       DO UPDATE SET {updates}""",
                    (session_id, s["track_id"], *vals, *vals),
                )
            db.commit()
        return {"ok": True}

    @app.post("/api/plugins/studio/sessions/{session_id}/master")
    def save_master_settings(session_id: int, data: dict):
        db = _get_db()
        with _lock:
            db.execute(
                "UPDATE studio_sessions SET master_volume = ?, master_limiter = ? WHERE id = ?",
                (data.get("master_volume", 1.0), 1 if data.get("master_limiter", True) else 0, session_id),
            )
            db.commit()
        return {"ok": True}

    # ── Server-side Mix Export ──────────────────────────────────────────

    @app.post("/api/plugins/studio/sessions/{session_id}/mix")
    async def export_mix(session_id: int, data: dict = None):
        db = _get_db()
        session = db.execute(
            "SELECT * FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not session:
            return JSONResponse({"error": "Session not found"}, 404)

        # Get all tracks with mix settings
        tracks = _rows_to_list(
            db.execute(
                "SELECT t.*, m.volume, m.pan, m.muted, m.solo, m.offset_ms, "
                "m.fade_in_ms, m.fade_out_ms, m.eq_low, m.eq_mid, m.eq_high, "
                "m.reverb_send, m.comp_threshold, m.comp_ratio, m.comp_attack, m.comp_release "
                "FROM studio_tracks t "
                "LEFT JOIN studio_mix_settings m ON m.track_id = t.id "
                "WHERE t.session_id = ? AND t.audio_path != '' AND t.duration > 0",
                (session_id,),
            ).fetchall()
        )

        if not tracks:
            return JSONResponse({"error": "No tracks to mix"}, 400)

        # Also include song audio if requested
        include_original = True
        original_volume = 1.0
        original_pan = 0.0
        original_muted = False
        if data:
            include_original = data.get("include_original", True)
            original_volume = data.get("original_volume", 1.0)
            original_pan = data.get("original_pan", 0.0)
            original_muted = data.get("original_muted", False)

        format_out = "mp3"
        if data:
            format_out = data.get("format", "mp3")

        def _do_mix():
            # Find the original song audio if needed
            original_audio = None
            if include_original and not original_muted:
                song_filename = dict(session)["song_filename"]
                original_audio = _find_song_audio(song_filename)

            # Build ffmpeg command
            inputs = []
            filter_parts = []
            idx = 0

            # Original song audio
            if original_audio and Path(original_audio).exists():
                inputs.extend(["-i", original_audio])
                vol = max(0.0, min(2.0, original_volume))
                pan_val = max(-1.0, min(1.0, original_pan))
                filter_parts.append(
                    f"[{idx}:a]volume={vol:.2f},stereopanner=pan={pan_val:.2f}[a{idx}]"
                )
                idx += 1

            # Recorded tracks
            unmuted_tracks = [t for t in tracks if not t.get("muted", 0)]
            # If any track is soloed, only include soloed tracks
            soloed = [t for t in unmuted_tracks if t.get("solo", 0)]
            if soloed:
                unmuted_tracks = soloed

            for t in unmuted_tracks:
                audio_path = t["audio_path"]
                if not audio_path or not Path(audio_path).exists():
                    continue
                inputs.extend(["-i", audio_path])
                vol = max(0.0, min(2.0, t.get("volume", 1.0)))
                pan_val = max(-1.0, min(1.0, t.get("pan", 0.0)))
                offset_ms = t.get("offset_ms", 0.0) or 0.0
                # Build filter chain: delay → volume → pan
                filters = []
                if offset_ms > 0:
                    filters.append(f"adelay={int(offset_ms)}|{int(offset_ms)}")
                elif offset_ms < 0:
                    # Negative offset = trim from start
                    trim_s = abs(offset_ms) / 1000.0
                    filters.append(f"atrim=start={trim_s:.3f},asetpts=PTS-STARTPTS")
                fade_in = (t.get("fade_in_ms", 0.0) or 0.0) / 1000.0
                fade_out = (t.get("fade_out_ms", 0.0) or 0.0) / 1000.0
                if fade_in > 0:
                    filters.append(f"afade=t=in:d={fade_in:.3f}")
                if fade_out > 0:
                    filters.append(f"afade=t=out:d={fade_out:.3f}")
                # EQ: 3-band (low shelf 200Hz, mid peak 1kHz, high shelf 4kHz)
                eq_low = t.get("eq_low", 0.0) or 0.0
                eq_mid = t.get("eq_mid", 0.0) or 0.0
                eq_high = t.get("eq_high", 0.0) or 0.0
                if eq_low != 0 or eq_mid != 0 or eq_high != 0:
                    eq_parts = []
                    if eq_low != 0:
                        eq_parts.append(f"equalizer=f=200:t=l:w=1:g={eq_low:.1f}")
                    if eq_mid != 0:
                        eq_parts.append(f"equalizer=f=1000:t=q:w=1:g={eq_mid:.1f}")
                    if eq_high != 0:
                        eq_parts.append(f"equalizer=f=4000:t=h:w=1:g={eq_high:.1f}")
                    filters.extend(eq_parts)
                # Reverb send (approximated with aecho for ffmpeg export)
                reverb_send = t.get("reverb_send", 0.0) or 0.0
                if reverb_send > 0.01:
                    # aecho: in_gain|out_gain|delays|decays
                    wet = min(1.0, reverb_send)
                    dry = 1.0
                    filters.append(
                        f"aecho={dry:.2f}:{wet:.2f}:60|120|180:0.4|0.2|0.1"
                    )
                # Compressor (only if ratio > 1, meaning active)
                comp_ratio = t.get("comp_ratio", 1.0) or 1.0
                if comp_ratio > 1.0:
                    comp_thresh = t.get("comp_threshold", -24.0) or -24.0
                    comp_attack = t.get("comp_attack", 0.003) or 0.003
                    comp_release = t.get("comp_release", 0.25) or 0.25
                    filters.append(
                        f"acompressor=threshold={comp_thresh:.1f}dB"
                        f":ratio={comp_ratio:.1f}"
                        f":attack={comp_attack*1000:.0f}"
                        f":release={comp_release*1000:.0f}"
                    )
                filters.append(f"volume={vol:.2f}")
                filters.append(f"stereopanner=pan={pan_val:.2f}")
                filter_parts.append(
                    f"[{idx}:a]{','.join(filters)}[a{idx}]"
                )
                idx += 1

            if idx == 0:
                raise RuntimeError("No audio tracks to mix")

            # Build amix filter + master bus
            mix_inputs = "".join(f"[a{i}]" for i in range(idx))
            filter_complex = "; ".join(filter_parts)
            master_vol = dict(session).get("master_volume", 1.0) or 1.0
            master_lim = dict(session).get("master_limiter", 1)
            master_chain = []
            if abs(master_vol - 1.0) > 0.01:
                master_chain.append(f"volume={master_vol:.2f}")
            if master_lim:
                master_chain.append("alimiter=limit=1:attack=3:release=50")
            if master_chain:
                filter_complex += f"; {mix_inputs}amix=inputs={idx}:duration=longest:normalize=0[mix]; [mix]{','.join(master_chain)}[out]"
            else:
                filter_complex += f"; {mix_inputs}amix=inputs={idx}:duration=longest:normalize=0[out]"

            # Output path
            session_dir = STUDIO_DIR / str(session_id)
            session_dir.mkdir(parents=True, exist_ok=True)
            ext = "mp3" if format_out == "mp3" else "wav"
            output_name = f"mix_{session_id}_{int(_time.time())}.{ext}"
            output_path = session_dir / output_name

            cmd = ["ffmpeg", "-y"] + inputs + [
                "-filter_complex", filter_complex,
                "-map", "[out]",
            ]
            if ext == "mp3":
                cmd.extend(["-b:a", "192k"])
            cmd.append(str(output_path))

            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300
            )
            if result.returncode != 0:
                # stereopanner may not be available in all ffmpeg builds;
                # fall back to the pan filter
                filter_parts2 = []
                idx2 = 0
                input_count = len(inputs) // 2  # each -i is 2 args

                for i in range(input_count):
                    # Determine volume and pan for this input
                    if original_audio and i == 0:
                        vol = max(0.0, min(2.0, original_volume))
                        pan_val = max(-1.0, min(1.0, original_pan))
                    else:
                        t_idx = i - (1 if original_audio else 0)
                        if t_idx < len(unmuted_tracks):
                            t = unmuted_tracks[t_idx]
                            vol = max(0.0, min(2.0, t.get("volume", 1.0)))
                            pan_val = max(-1.0, min(1.0, t.get("pan", 0.0)))
                        else:
                            vol, pan_val = 1.0, 0.0

                    left = min(1.0, 1.0 - pan_val) if pan_val > 0 else 1.0
                    right = min(1.0, 1.0 + pan_val) if pan_val < 0 else 1.0
                    filter_parts2.append(
                        f"[{i}:a]volume={vol:.2f},"
                        f"pan=stereo|c0={left:.2f}*c0|c1={right:.2f}*c0[a{i}]"
                    )

                mix_inputs2 = "".join(f"[a{i}]" for i in range(input_count))
                fc2 = "; ".join(filter_parts2)
                fc2 += f"; {mix_inputs2}amix=inputs={input_count}:duration=longest:normalize=0[out]"

                cmd2 = ["ffmpeg", "-y"] + inputs + [
                    "-filter_complex", fc2,
                    "-map", "[out]",
                ]
                if ext == "mp3":
                    cmd2.extend(["-b:a", "192k"])
                cmd2.append(str(output_path))

                result2 = subprocess.run(
                    cmd2, capture_output=True, text=True, timeout=300
                )
                if result2.returncode != 0:
                    raise RuntimeError(f"ffmpeg failed: {result2.stderr[:500]}")

            # Copy to static for web serving
            safe_name = f"studio_mix_{session_id}_{int(_time.time())}.{ext}"
            static_dest = STATIC_DIR / safe_name
            shutil.copy2(output_path, static_dest)
            return f"/static/{safe_name}"

        try:
            url = await asyncio.get_event_loop().run_in_executor(None, _do_mix)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, 500)

        return {"url": url}

    # ── Song Audio for Playback ─────────────────────────────────────────

    @app.get("/api/plugins/studio/sessions/{session_id}/song-audio")
    async def get_song_audio(session_id: int):
        """Return the URL to the original song audio for playback during recording."""
        db = _get_db()
        row = db.execute(
            "SELECT song_filename FROM studio_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "Session not found"}, 404)

        def _extract():
            return _find_song_audio(row["song_filename"])

        audio_path = await asyncio.get_event_loop().run_in_executor(None, _extract)
        if not audio_path:
            return JSONResponse({"error": "Could not extract song audio"}, 500)

        # Serve from static
        stem = Path(row["song_filename"]).stem.replace(" ", "_")
        ext = Path(audio_path).suffix
        static_name = f"studio_song_{stem}{ext}"
        static_dest = STATIC_DIR / static_name
        if not static_dest.exists():
            shutil.copy2(audio_path, static_dest)

        return {"url": f"/static/{static_name}"}

    # ── Demucs Settings ───────────────────────────────────────────────────

    _demucs_config_path = config_dir / "studio_demucs.json"

    def _get_demucs_config():
        config_dir.mkdir(parents=True, exist_ok=True)
        if _demucs_config_path.exists():
            return json.loads(_demucs_config_path.read_text())
        return {"url": "", "api_key": ""}

    def _save_demucs_config(cfg):
        config_dir.mkdir(parents=True, exist_ok=True)
        _demucs_config_path.write_text(json.dumps(cfg, indent=2))

    @app.get("/api/plugins/studio/demucs/config")
    def get_demucs_config():
        return _get_demucs_config()

    @app.post("/api/plugins/studio/demucs/config")
    def save_demucs_config(data: dict):
        cfg = _get_demucs_config()
        if "url" in data:
            cfg["url"] = data["url"].rstrip("/")
        if "api_key" in data:
            cfg["api_key"] = data["api_key"]
        _save_demucs_config(cfg)
        return {"ok": True}

    @app.post("/api/plugins/studio/demucs/test")
    async def test_demucs_connection():
        """Test connection to the demucs server."""
        import urllib.request
        import urllib.error

        cfg = _get_demucs_config()
        if not cfg.get("url"):
            return JSONResponse({"error": "Demucs server URL not configured"}, 400)

        def _test():
            url = cfg["url"] + "/health"
            req = urllib.request.Request(url)
            if cfg.get("api_key"):
                req.add_header("X-API-Key", cfg["api_key"])
            try:
                resp = urllib.request.urlopen(req, timeout=5)
                return json.loads(resp.read().decode())
            except urllib.error.URLError as e:
                raise RuntimeError(f"Cannot connect: {e.reason}")
            except Exception as e:
                raise RuntimeError(str(e))

        try:
            result = await asyncio.get_event_loop().run_in_executor(None, _test)
            return {"ok": True, "server": result}
        except Exception as e:
            return JSONResponse({"error": str(e)}, 502)

    # ── Drum Extraction via Demucs ──────────────────────────────────────

    @app.post("/api/plugins/studio/sessions/{session_id}/extract-drums")
    async def extract_drums(session_id: int, data: dict = None):
        """Request drum separation via the demucs service."""
        import urllib.request
        import urllib.error

        db = _get_db()
        session_row = db.execute(
            "SELECT * FROM studio_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if not session_row:
            return JSONResponse({"error": "Session not found"}, 404)
        session_data = _row_to_dict(session_row)

        cfg = _get_demucs_config()
        if not cfg.get("url"):
            return JSONResponse({"error": "Demucs server URL not configured. Go to Settings to add it."}, 400)

        # Which stems to extract (default: just drums)
        stems_requested = "drums"
        if data and data.get("stems"):
            stems_requested = data["stems"]

        def _do_extract():
            # Get the song audio URL
            song_filename = session_data["song_filename"]
            audio_path = _find_song_audio(song_filename)
            if not audio_path:
                raise RuntimeError("Could not find song audio")

            # Build the URL that the demucs server can download from.
            # The audio is in the static dir — construct a URL for it.
            # If the audio is already a /static/ URL, use the slopsmith server address.
            audio_basename = Path(audio_path).name
            # The caller may pass the slopsmith base URL
            slopsmith_url = ""
            if data:
                slopsmith_url = data.get("slopsmith_url", "").rstrip("/")

            demucs_url = cfg["url"]
            headers = {}
            if cfg.get("api_key"):
                headers["X-API-Key"] = cfg["api_key"]

            if slopsmith_url:
                # Use separate-url endpoint — demucs server downloads from slopsmith
                song_audio_url = f"{slopsmith_url}/static/{audio_basename}"
                payload = json.dumps({"url": song_audio_url}).encode()
                req = urllib.request.Request(
                    f"{demucs_url}/separate-url?stems={stems_requested}",
                    data=payload,
                    headers={**headers, "Content-Type": "application/json"},
                    method="POST",
                )
            else:
                # Upload the file directly
                import mimetypes
                boundary = uuid.uuid4().hex
                content_type = mimetypes.guess_type(audio_path)[0] or "audio/mpeg"

                audio_data = Path(audio_path).read_bytes()
                body = (
                    f"--{boundary}\r\n"
                    f"Content-Disposition: form-data; name=\"file\"; filename=\"{audio_basename}\"\r\n"
                    f"Content-Type: {content_type}\r\n\r\n"
                ).encode() + audio_data + f"\r\n--{boundary}--\r\n".encode()

                req = urllib.request.Request(
                    f"{demucs_url}/separate?stems={stems_requested}",
                    data=body,
                    headers={**headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
                    method="POST",
                )

            try:
                resp = urllib.request.urlopen(req, timeout=600)
                result = json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                body = e.read().decode()
                raise RuntimeError(f"Demucs server error ({e.code}): {body[:300]}")
            except urllib.error.URLError as e:
                raise RuntimeError(f"Cannot connect to demucs server: {e.reason}")

            # If the job is still processing, we need to poll
            if result.get("status") == "processing":
                job_id = result["job_id"]
                # Poll until complete
                for _ in range(120):  # 10 minutes max (5s intervals)
                    _time.sleep(5)
                    poll_req = urllib.request.Request(
                        f"{demucs_url}/jobs/{job_id}",
                        headers=headers,
                    )
                    try:
                        poll_resp = urllib.request.urlopen(poll_req, timeout=10)
                        job_data = json.loads(poll_resp.read().decode())
                    except Exception:
                        continue

                    if job_data.get("status") == "complete":
                        result = job_data
                        break
                    elif job_data.get("status") == "failed":
                        raise RuntimeError(f"Demucs separation failed: {job_data.get('error', 'Unknown error')}")
                else:
                    raise RuntimeError("Demucs separation timed out")

            # Download stems and save as tracks
            stems_data = result.get("stems", {})
            track_ids = []

            for stem_name, stem_url in stems_data.items():
                # Download the stem from demucs server
                full_url = f"{demucs_url}{stem_url}"
                dl_req = urllib.request.Request(full_url, headers=headers)
                stem_data = urllib.request.urlopen(dl_req, timeout=60).read()

                # Save to session storage
                session_dir = STUDIO_DIR / str(session_id)
                session_dir.mkdir(parents=True, exist_ok=True)

                ext = Path(stem_url).suffix or ".mp3"
                stem_filename = f"demucs_{stem_name}{ext}"
                stem_path = session_dir / stem_filename
                stem_path.write_bytes(stem_data)

                duration = _get_audio_duration(str(stem_path))

                # Map stem name to instrument label
                instrument = stem_name.capitalize()
                if stem_name == "other":
                    instrument = "Other (Separated)"

                # Check if we already have a demucs track for this stem
                with _lock:
                    existing = db.execute(
                        "SELECT id FROM studio_tracks WHERE session_id = ? AND instrument = ? AND recorded_by = 'demucs'",
                        (session_id, instrument),
                    ).fetchone()
                    if existing:
                        # Update existing
                        db.execute(
                            "UPDATE studio_tracks SET audio_path = ?, duration = ? WHERE id = ?",
                            (str(stem_path), duration, existing[0]),
                        )
                        db.commit()
                        track_ids.append(existing[0])
                    else:
                        cur = db.execute(
                            """INSERT INTO studio_tracks
                               (session_id, instrument, recorded_by, take_number, audio_path, duration, is_active)
                               VALUES (?, ?, 'demucs', 1, ?, ?, 1)""",
                            (session_id, instrument, str(stem_path), duration),
                        )
                        db.commit()
                        track_id = cur.lastrowid
                        # Default mix settings
                        db.execute(
                            """INSERT OR IGNORE INTO studio_mix_settings
                               (session_id, track_id, volume, pan, muted, solo)
                               VALUES (?, ?, 1.0, 0.0, 0, 0)""",
                            (session_id, track_id),
                        )
                        db.commit()
                        track_ids.append(track_id)

            return {"ok": True, "track_ids": track_ids, "stems": list(stems_data.keys())}

        try:
            result = await asyncio.get_event_loop().run_in_executor(None, _do_extract)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, 500)

        return result

    # ── Helpers ─────────────────────────────────────────────────────────

    def _get_audio_duration(path):
        """Get audio duration in seconds via ffprobe."""
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    path,
                ],
                capture_output=True, text=True, timeout=10,
            )
            return float(result.stdout.strip())
        except Exception:
            return 0.0

    def _get_song_meta(song_filename):
        """Get song metadata via the library API cache."""
        try:
            meta_db = context.get("meta_db")
            if meta_db:
                dlc_dir = get_dlc_dir()
                if dlc_dir:
                    filepath = dlc_dir / song_filename
                    if filepath.exists():
                        import stat
                        st = filepath.stat()
                        cached = meta_db.get(song_filename, st.st_mtime, st.st_size)
                        if cached:
                            return cached
                        # Extract if not cached
                        extract_meta = context.get("extract_meta")
                        if extract_meta:
                            meta = extract_meta(str(filepath))
                            return meta
        except Exception:
            pass
        return None

    def _find_song_audio(song_filename):
        """Find or extract the song audio file, using static cache."""
        stem = Path(song_filename).stem.replace(" ", "_")
        # Check static cache first
        for ext in (".mp3", ".ogg", ".wav"):
            cached = STATIC_DIR / f"audio_{stem}{ext}"
            if cached.exists():
                return str(cached)
            cached2 = STATIC_DIR / f"studio_song_{stem}{ext}"
            if cached2.exists():
                return str(cached2)

        # No cached audio available. The legacy .psarc extraction path has
        # been removed; only pre-extracted/static-cached audio is supported.
        return None
