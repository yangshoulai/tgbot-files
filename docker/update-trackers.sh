#!/bin/sh
set -e

TRACKER_URL="https://cf.trackerslist.com/best.txt"
OUTPUT_FILE="/tmp/trackers.txt"

echo "Fetching latest tracker list from ${TRACKER_URL}..."

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --max-time 30 "${TRACKER_URL}" -o "${OUTPUT_FILE}"
elif command -v wget >/dev/null 2>&1; then
  wget -q --timeout=30 -O "${OUTPUT_FILE}" "${TRACKER_URL}"
else
  echo "Error: Neither curl nor wget is available"
  exit 1
fi

if [ ! -f "${OUTPUT_FILE}" ] || [ ! -s "${OUTPUT_FILE}" ]; then
  echo "Error: Failed to download tracker list"
  exit 1
fi

TRACKERS=$(grep -v '^$' "${OUTPUT_FILE}" | tr '\n' ',' | sed 's/,$//')

if [ -z "${TRACKERS}" ]; then
  echo "Error: Tracker list is empty"
  exit 1
fi

echo "Successfully fetched $(echo "${TRACKERS}" | tr ',' '\n' | wc -l) trackers"
echo "${TRACKERS}"
