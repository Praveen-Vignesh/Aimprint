"""Creates confirmed bot accounts and labels their subjects synthetic, in one
pass, with the service key. Run from model/:

    python -m src.provision_bot_subjects --cohort bot_snap --emails bot01@example.com

Why this exists (Explore-agent trace + CLAUDE.md): email confirmation is ON
with no client bypass, so a bot CANNOT be born through the sign-up form. The
sanctioned path is the Admin API with email_confirm=True, which fires the same
on_auth_user_created trigger a real signup does (subjects + profiles rows,
kind='unknown'). This script then performs the LABELING.md §5.6 write
(kind='synthetic', kind_source='provisioned', cohort=<name>, labeled_at=now())
against subjects via the service key, which bypasses RLS and retains UPDATE on
subjects (only `authenticated` was revoked).

Idempotent: re-running for an email that already exists re-labels it rather
than erroring. A zero-row label write is a HARD FAILURE (per the schema's own
warning), not a shrug.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client


def _client():
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in model/.env")
    return create_client(url, key)


def _find_user_by_email(client, email: str):
    # supabase-py paginates admin.list_users(); scan for the address.
    page = 1
    while True:
        users = client.auth.admin.list_users(page=page, per_page=200)
        if not users:
            return None
        for u in users:
            if (u.email or "").lower() == email.lower():
                return u
        if len(users) < 200:
            return None
        page += 1


def _ensure_user(client, email: str, password: str) -> str:
    """Returns the auth user id, creating a confirmed account if needed."""
    try:
        res = client.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        )
        return res.user.id
    except Exception as exc:  # already-registered is the common, fine case
        existing = _find_user_by_email(client, email)
        if existing is None:
            raise RuntimeError(f"create_user failed for {email} and no existing user found: {exc}")
        print(f"  {email}: already exists, re-labelling")
        return existing.id


def _subject_id_for(client, user_id: str) -> str:
    # The trigger runs in the signup transaction, so the profile should exist
    # immediately; a couple of short retries cover any replica lag.
    for _ in range(5):
        rows = client.table("profiles").select("subject_id").eq("user_id", user_id).execute().data
        if rows:
            return rows[0]["subject_id"]
        time.sleep(0.5)
    raise RuntimeError(f"no profiles row for user {user_id} — on_auth_user_created did not fire")


def _label_synthetic(client, subject_id: str, cohort: str):
    updated = (
        client.table("subjects")
        .update({
            "kind": "synthetic",
            "kind_source": "provisioned",
            "cohort": cohort,
            "labeled_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("subject_id", subject_id)
        .execute()
        .data
    )
    if not updated:
        raise RuntimeError(
            f"label write for subject {subject_id} affected ZERO rows — "
            f"the subject does not exist or the write was rejected. HARD FAILURE."
        )


def main():
    ap = argparse.ArgumentParser(description="Provision + label synthetic bot subjects.")
    ap.add_argument("--cohort", required=True, help="e.g. bot_snap (one cohort per variant)")
    ap.add_argument("--emails", required=True, help="comma-separated bot account emails")
    ap.add_argument("--password", default=None,
                    help="shared password for the batch; generated + printed if omitted")
    args = ap.parse_args()

    emails = [e.strip() for e in args.emails.split(",") if e.strip()]
    if not emails:
        sys.exit("no emails given")
    password = args.password or secrets.token_urlsafe(16)

    client = _client()
    creds = []
    for email in emails:
        user_id = _ensure_user(client, email, password)
        subject_id = _subject_id_for(client, user_id)
        _label_synthetic(client, subject_id, args.cohort)
        creds.append((email, subject_id))
        print(f"  {email}: subject {subject_id} -> synthetic/{args.cohort}")

    print(f"\nProvisioned {len(creds)} bot account(s) in cohort '{args.cohort}'.")
    print(f"Shared password: {password}")
    print("Feed these credentials to the bot driver. Verify with queries/campaign.sql §2.")


if __name__ == "__main__":
    main()
