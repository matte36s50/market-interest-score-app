#!/usr/bin/env bash
# Downloads the private bat.csv for a workflow and names the copy in $BAT_CSV
# for the steps after it (export_online_sales.py, build-bat-lots.js).
#
# Needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (a key allowed
# s3:GetObject on my-mii-reports/bat.csv). Without them, or when the download
# fails, it only warns: the steps then try the bucket URL, which answers only
# while the object is public.
set -uo pipefail

dest="${RUNNER_TEMP:-/tmp}/bat.csv"
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "::warning::AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set; bat.csv will be read from its public URL."
  exit 0
fi
if ! aws s3 cp s3://my-mii-reports/bat.csv "$dest" --region us-east-2 --only-show-errors; then
  echo "::warning::Could not download s3://my-mii-reports/bat.csv with the AWS key."
  exit 0
fi
echo "BAT_CSV=$dest" >> "${GITHUB_ENV:-/dev/null}"
echo "bat.csv: $(($(wc -l < "$dest") - 1)) rows"
