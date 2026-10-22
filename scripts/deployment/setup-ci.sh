#!/usr/bin/env bash
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "$(uname -s)" != Linux ]]; then
  echo 'This script prepares an ephemeral GitHub-hosted Linux runner.' >&2
  exit 1
fi
if ! mountpoint -q /Volumes/Scratch; then
  sudo mkdir -p /Volumes/Scratch
  sudo truncate -s 12G /mnt/entitle-scratch.img
  sudo mkfs.ext4 -q -F /mnt/entitle-scratch.img
  sudo mount -o loop /mnt/entitle-scratch.img /Volumes/Scratch
fi
sudo chown "$(id -u):$(id -g)" /Volumes/Scratch
mkdir -p /Volumes/Scratch/entitle/{build/ci,tmp/ci,cache/pnpm,reports/ci}
