# ADR-0227: Encrypted off-site backup copies

<status>
Accepted on 2026-11-10, after the owner asked for backups that survive losing
the machine, without letting the storage provider read them. Extends the daily
automatic backups of [ADR-0187](0187-daily-automatic-backups.md) and the
verified snapshots of [ADR-0023](0023-consistent-backups-and-inactive-restore.md).
</status>

<context>
- Backups stay on the disk Nocheh runs on. A stolen machine or a failed disk
  loses the data and every backup at once.
- A backup holds everything, including `.env` with every key, so a plain copy in
  someone else's storage would hand them the whole installation.
- The management image already has Python's `cryptography` package and the
  standard library. It has no restic, rclone, age or AWS SDK.
- Many providers offer S3-compatible object storage with a free tier.
</context>

<decision>
- Settings › Privacy & data has "Off-site copies", off by default:
  `NOCHEH_OFFSITE` (`off` or `s3`), the storage address (https only), bucket,
  region (`auto` by default), access key ID, secret access key, a passphrase of
  at least 16 characters and how many copies to keep (default 14). The secret
  key and the passphrase are secrets: saved, never shown again. The settings
  work live, without Apply.
- A copy is the finished backup folder as one tar stream, encrypted on this
  machine and written to `admin/offsite-work` before upload, then deleted. The
  key comes from the passphrase with scrypt (n=2^15, r=8, p=1) and a new random
  salt for every copy. The stream is cut into 4 MiB chunks sealed with
  AES-256-GCM; each chunk's nonce carries its position, and its authenticated
  data binds the header, the position and a last-chunk flag, so a changed,
  reordered, cut-off or extended copy is refused.
- Upload is signed with AWS Signature Version 4 using the standard library,
  as one PUT up to 16 MiB and as a multipart upload above it; a failed
  multipart upload is aborted. Objects are named
  `nocheh-backups/<time>-<backup id>.nocheh-backup`. After a copy is stored,
  copies beyond the number to keep are deleted. A failed delete is reported
  and does not fail the copy, so upload-only credentials still work.
- The dashboard's five-minute check starts a copy, as job `operations.offsite`,
  when copies are on and the newest finished backup has not been tried. Each
  backup is tried once by the schedule, so a failure never loops; "Send copy
  now" in System › Backups retries. Sending reads the finished folder only,
  so writers keep running.
- "Test the off-site copy" (`operations.offsite-check`) downloads the newest
  copy, decrypts it into a temporary folder, runs the same checksum validation
  as a restore, and deletes it. Nothing is restored.
- `admin/offsite.json` records what was sent, the last attempt and the last
  test, with error codes only. It never holds the passphrase or keys.
- On a new machine, `./bin/nocheh offsite list|fetch|decrypt` gets a backup
  folder back from a copy; then the usual `restore` runs. Storage settings come
  from the installation or from `NOCHEH_OFFSITE_*` variables, and the
  passphrase is asked for when it is not set.
</decision>

<consequences>
- Losing the machine no longer loses the data, as long as the owner keeps the
  passphrase somewhere else. Without it no copy can be opened by anyone.
- The storage provider sees only object names, sizes and times.
- Whoever holds the storage keys can delete copies. Credentials limited to one
  bucket, and the provider's own object lock where available, reduce that.
- A changed passphrase applies to new copies; older copies still need the old
  one.
- A copy needs free disk space about the size of the backup while it is made.
</consequences>
