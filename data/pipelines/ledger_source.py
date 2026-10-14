#!/usr/bin/env python3
"""
Where the weekly Auction Results Ledgers come from.

The ingest (ledger_ingest.py) only ever talks to a LedgerSource:

    list_files()      -> [LedgerFile(file_id, title, modified_time), ...]
    read_values(f)    -> [[cell, ...], ...]   header row first, as stored

Three implementations:

  SheetsLedgerSource  the live Drive folder, read-only, through a service
                      account (GOOGLE_APPLICATION_CREDENTIALS). Needs
                      google-api-python-client + google-auth, imported only
                      when this source is built, so the tests and offline
                      builds never need them.
  CsvDirLedgerSource  a directory of <title>.csv files: the test fixtures, or
                      any local export of the sheets.
  CachedLedgerSource  wraps either of the above and keeps every raw pull on
                      disk keyed by (file id, modified time). Unchanged files
                      are read from the cache; offline=True builds from the
                      cache alone and fails if a file is missing from it.

Values are passed through as the source returns them. Nothing here parses,
converts or fills a cell — that is the ingest's job, where it is validated.
"""

import csv
import hashlib
import json
import os
import re
from dataclasses import dataclass

LEDGER_FOLDER_ID = "1UXQTkUXMd6yJR-AlmSQGRr2ss1cqbE5y"
SCOPES = [
    # Listing a folder's files is a Drive call; the Sheets API cannot do it.
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]
SHEET_MIME = "application/vnd.google-apps.spreadsheet"


@dataclass(frozen=True)
class LedgerFile:
    file_id: str
    title: str
    modified_time: str


class LedgerSourceError(RuntimeError):
    pass


class SheetsLedgerSource:
    """Google Sheets in one Drive folder, read with a service account."""

    def __init__(self, folder_id=LEDGER_FOLDER_ID, credentials_path=None):
        credentials_path = credentials_path or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if not credentials_path:
            raise LedgerSourceError(
                "GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at the service-account "
                "JSON key (see data/pipelines/LEDGER_README.md), or build offline from the cache."
            )
        if not os.path.isfile(credentials_path):
            raise LedgerSourceError(f"GOOGLE_APPLICATION_CREDENTIALS points at a missing file: {credentials_path}")
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
        except ImportError as e:
            raise LedgerSourceError(
                "The Sheets source needs google-api-python-client and google-auth: "
                "pip install -r data/pipelines/requirements-ledger.txt"
            ) from e
        creds = service_account.Credentials.from_service_account_file(credentials_path, scopes=SCOPES)
        self._drive = build("drive", "v3", credentials=creds, cache_discovery=False)
        self._sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
        self.folder_id = folder_id

    def list_files(self):
        files, token = [], None
        query = f"'{self.folder_id}' in parents and mimeType = '{SHEET_MIME}' and trashed = false"
        while True:
            resp = self._drive.files().list(
                q=query,
                fields="nextPageToken, files(id, name, modifiedTime)",
                pageSize=100,
                pageToken=token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            ).execute()
            files += [LedgerFile(f["id"], f["name"], f["modifiedTime"]) for f in resp.get("files", [])]
            token = resp.get("nextPageToken")
            if not token:
                return files

    def read_values(self, ledger_file):
        meta = self._sheets.spreadsheets().get(
            spreadsheetId=ledger_file.file_id, fields="sheets.properties.title"
        ).execute()
        tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
        if len(tabs) != 1:
            # The ledgers are single-tab. More than one means the layout
            # changed, and guessing which tab holds the results is not safe.
            raise LedgerSourceError(
                f"'{ledger_file.title}' has {len(tabs)} tabs ({tabs}); expected exactly one."
            )
        resp = self._sheets.spreadsheets().values().get(
            spreadsheetId=ledger_file.file_id,
            range="'" + tabs[0].replace("'", "''") + "'",
            # Cell text exactly as typed: no locale thousands separators,
            # no date serial numbers.
            valueRenderOption="FORMATTED_VALUE",
            majorDimension="ROWS",
        ).execute()
        return resp.get("values", [])


class CsvDirLedgerSource:
    """Every *.csv in a directory is one ledger; its file name minus .csv is
    the title. The file id is the name and the modified time is a hash of the
    bytes, so an edited file reads as modified, as it would in Drive."""

    def __init__(self, directory):
        self.directory = directory

    def list_files(self):
        out = []
        for name in sorted(os.listdir(self.directory)):
            if not name.lower().endswith(".csv"):
                continue
            path = os.path.join(self.directory, name)
            with open(path, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()[:16]
            out.append(LedgerFile(file_id=name, title=name[:-4], modified_time=f"sha256:{digest}"))
        return out

    def read_values(self, ledger_file):
        with open(os.path.join(self.directory, ledger_file.file_id), newline="", encoding="utf-8-sig") as fh:
            return [row for row in csv.reader(fh)]


def _safe(text):
    return re.sub(r"[^A-Za-z0-9._-]", "_", text)


class CachedLedgerSource:
    """Read-through cache of raw pulls under cache_dir (gitignored).

    raw/<file id>__<modified time>.json   one pull, never rewritten
    listing.json                          the folder listing of the last
                                          online run; offline builds use it
    """

    def __init__(self, cache_dir, upstream=None, offline=False):
        if not offline and upstream is None:
            raise ValueError("an online cache needs an upstream source")
        self.cache_dir = cache_dir
        self.upstream = upstream
        self.offline = offline
        self.hits = 0
        self.misses = 0

    @property
    def _listing_path(self):
        return os.path.join(self.cache_dir, "listing.json")

    def _raw_path(self, f):
        return os.path.join(self.cache_dir, "raw", f"{_safe(f.file_id)}__{_safe(f.modified_time)}.json")

    def list_files(self):
        if self.offline:
            if not os.path.exists(self._listing_path):
                raise LedgerSourceError(
                    f"Offline build but no cached listing at {self._listing_path}. Run one online ingest first."
                )
            with open(self._listing_path, encoding="utf-8") as fh:
                return [LedgerFile(**d) for d in json.load(fh)]
        files = self.upstream.list_files()
        os.makedirs(self.cache_dir, exist_ok=True)
        with open(self._listing_path, "w", encoding="utf-8") as fh:
            json.dump([f.__dict__ for f in sorted(files, key=lambda f: f.file_id)], fh, indent=2, ensure_ascii=False)
        return files

    def read_values(self, ledger_file):
        path = self._raw_path(ledger_file)
        if os.path.exists(path):
            self.hits += 1
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)["values"]
        if self.offline:
            raise LedgerSourceError(
                f"Offline build: '{ledger_file.title}' ({ledger_file.file_id} @ {ledger_file.modified_time}) "
                "is not in the cache."
            )
        self.misses += 1
        values = self.upstream.read_values(ledger_file)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"file": ledger_file.__dict__, "values": values}, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        return values
