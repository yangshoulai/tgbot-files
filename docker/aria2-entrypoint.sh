#!/bin/sh
set -eu

mkdir -p /data/aria2/downloads
touch /data/aria2/session.txt

exec aria2c "$@"
