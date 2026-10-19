#!/bin/sh
set -eu

mkdir -p /var/data/resumator
chown node:node /var/data/resumator
chmod 700 /var/data/resumator
exec runuser -u node -- npm start
